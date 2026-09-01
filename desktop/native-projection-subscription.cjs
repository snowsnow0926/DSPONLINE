"use strict";

const SUBSCRIPTION_SCHEMA_VERSION = 1;
const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_RELIABLE_QUEUE_LIMIT = 32;
const MAX_TIMING_SAMPLES = 64;
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

const CHANNEL_PROJECTION_TYPES = Object.freeze({
  "viewport-topology": new Set(["viewport-v2", "factory-read-model-v1"]),
  telemetry: new Set(["statistics-v1", "operations-workspace-v1"]),
  "belt-geometry": new Set(["viewport-v2"]),
  "belt-flow": new Set(["viewport-v2"]),
  inventory: new Set(["factory-inventory-v1", "construction-inventory-v1"]),
  workspace: new Set(["technology-v1", "operations-workspace-v1"]),
  notification: new Set(["operations-workspace-v1"]),
});

const COALESCIBLE_CHANNELS = new Set(["telemetry", "belt-flow"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return isRecord(value) && Reflect.ownKeys(value).length === expected.length &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && expected.includes(key)) &&
    expected.every((key) => Object.hasOwn(value, key));
}

function validLogicalId(value, maximumLength = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    LOGICAL_ID_PATTERN.test(value);
}

function normalizeSubscriptionRequest(value, expectedIdentity = null) {
  if (!hasExactKeys(value, [
    "subscriptionId", "sessionId", "channel", "projectionType", "sequence", "payload",
  ]) || !validLogicalId(value.subscriptionId) || !validLogicalId(value.sessionId) ||
      !Object.hasOwn(CHANNEL_PROJECTION_TYPES, value.channel) ||
      !CHANNEL_PROJECTION_TYPES[value.channel].has(value.projectionType) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !isRecord(value.payload) || Object.hasOwn(value.payload, "sessionId")) {
    throw new TypeError("native projection subscription request is invalid");
  }
  if (expectedIdentity && (value.subscriptionId !== expectedIdentity.subscriptionId ||
      value.sessionId !== expectedIdentity.sessionId || value.channel !== expectedIdentity.channel ||
      value.projectionType !== expectedIdentity.projectionType)) {
    throw new TypeError("native projection subscription identity changed");
  }
  return Object.freeze({
    subscriptionId: value.subscriptionId,
    sessionId: value.sessionId,
    channel: value.channel,
    projectionType: value.projectionType,
    sequence: value.sequence,
    payload: Object.freeze({ ...value.payload }),
  });
}

function boundedDuration(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(60_000, value);
}

function percentile(samples, fraction) {
  if (samples.length === 0) return 0;
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
}

function safeErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
    ? error.code
    : "NATIVE_PROJECTION_SUBSCRIPTION_READ_FAILED";
}

/**
 * One persistent MessagePort subscription. Reads and ACKs are serialized so
 * a slow renderer can never accumulate unbounded binary frames. Routine
 * telemetry keeps only the newest pending request; topology, inventory and
 * workspace channels use a bounded lossless queue and fail closed on overflow.
 */
class NativeProjectionSubscription {
  constructor({
    port,
    initialRequest,
    readProjection,
    encodeProjection,
    now = () => performance.now(),
    schedule = setTimeout,
    cancel = clearTimeout,
    ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
    reliableQueueLimit = DEFAULT_RELIABLE_QUEUE_LIMIT,
    onClosed = () => undefined,
  }) {
    if (!port || typeof port.on !== "function" || typeof port.postMessage !== "function" ||
        typeof port.close !== "function" || typeof readProjection !== "function" ||
        typeof encodeProjection !== "function" || typeof now !== "function" ||
        typeof schedule !== "function" || typeof cancel !== "function" ||
        typeof onClosed !== "function") {
      throw new TypeError("native projection subscription dependencies are invalid");
    }
    this.identity = normalizeSubscriptionRequest(initialRequest);
    this.port = port;
    this.readProjection = readProjection;
    this.encodeProjection = encodeProjection;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.ackTimeoutMs = Math.max(250, Math.min(60_000, Number(ackTimeoutMs) || DEFAULT_ACK_TIMEOUT_MS));
    this.reliableQueueLimit = Math.max(1, Math.min(256,
      Number(reliableQueueLimit) || DEFAULT_RELIABLE_QUEUE_LIMIT));
    this.onClosed = onClosed;
    this.queue = [this.identity];
    this.awaitingAck = null;
    this.ackTimer = null;
    this.running = false;
    this.closed = false;
    this.coalescedCount = 0;
    this.deliveredCount = 0;
    this.acknowledgedCount = 0;
    this.readTimings = [];
    this.encodeTimings = [];
    this.validationTimings = [];
    this.installTimings = [];
    this.handleMessage = this.handleMessage.bind(this);
    this.handlePortClose = this.handlePortClose.bind(this);
  }

  start() {
    if (this.closed) throw new Error("native projection subscription is closed");
    this.port.on("message", this.handleMessage);
    this.port.on("close", this.handlePortClose);
    this.port.start?.();
    void this.drain();
    return this;
  }

  handleMessage(event) {
    const data = event?.data;
    if (hasExactKeys(data, ["close"]) && hasExactKeys(data.close, ["subscriptionId"]) &&
        data.close.subscriptionId === this.identity.subscriptionId) {
      this.close("renderer-closed");
      return;
    }
    if (hasExactKeys(data, ["projectionAck"])) {
      this.acceptAck(data.projectionAck);
      return;
    }
    if (!hasExactKeys(data, ["update"]) || !hasExactKeys(data.update, ["sequence", "payload"])) {
      this.fail("NATIVE_PROJECTION_SUBSCRIPTION_PROTOCOL_INVALID");
      return;
    }
    let update;
    try {
      update = normalizeSubscriptionRequest({
        ...this.identity,
        sequence: data.update.sequence,
        payload: data.update.payload,
      }, this.identity);
    } catch {
      this.fail("NATIVE_PROJECTION_SUBSCRIPTION_PROTOCOL_INVALID");
      return;
    }
    const lastSequence = this.queue.at(-1)?.sequence ?? this.awaitingAck?.sequence ?? 0;
    if (update.sequence <= lastSequence) {
      this.fail("NATIVE_PROJECTION_SUBSCRIPTION_SEQUENCE_INVALID");
      return;
    }
    if (COALESCIBLE_CHANNELS.has(this.identity.channel)) {
      if (this.queue.length > 0) this.coalescedCount += this.queue.length;
      this.queue = [update];
    } else {
      if (this.queue.length >= this.reliableQueueLimit) {
        this.fail("NATIVE_PROJECTION_SUBSCRIPTION_BACKPRESSURE_EXCEEDED");
        return;
      }
      this.queue.push(update);
    }
    void this.drain();
  }

  handlePortClose() {
    this.close("renderer-disconnected");
  }

  acceptAck(value) {
    const pending = this.awaitingAck;
    if (!pending || !hasExactKeys(value, [
      "subscriptionId", "sequence", "sha256", "validationMs", "installMs",
    ]) ||
        value.subscriptionId !== this.identity.subscriptionId || value.sequence !== pending.sequence ||
        value.sha256 !== pending.sha256 || !Number.isFinite(value.installMs) ||
        value.installMs < 0 || value.installMs > 60_000 ||
        !Number.isFinite(value.validationMs) || value.validationMs < 0 || value.validationMs > 60_000) {
      this.fail("NATIVE_PROJECTION_SUBSCRIPTION_ACK_INVALID");
      return;
    }
    if (this.ackTimer !== null) this.cancel(this.ackTimer);
    this.ackTimer = null;
    this.awaitingAck = null;
    this.acknowledgedCount += 1;
    this.recordTiming(this.validationTimings, value.validationMs);
    this.recordTiming(this.installTimings, value.installMs);
    void this.drain();
  }

  async drain() {
    if (this.closed || this.running || this.awaitingAck || this.queue.length === 0) return;
    const request = this.queue.shift();
    this.running = true;
    try {
      const readStartedAt = this.now();
      const result = await this.readProjection(request);
      const readMs = boundedDuration(this.now() - readStartedAt);
      if (this.closed) return;
      const encodeStartedAt = this.now();
      const transfer = this.encodeProjection({
        sessionId: request.sessionId,
        sequence: request.sequence,
        projectionType: request.projectionType,
        result,
      });
      const encodeMs = boundedDuration(this.now() - encodeStartedAt);
      if (!transfer?.header || !transfer.payload ||
          transfer.header.sequence !== request.sequence ||
          transfer.header.sessionId !== request.sessionId ||
          transfer.header.projectionType !== request.projectionType) {
        throw Object.assign(new Error("native projection subscription encoder returned the wrong frame"), {
          code: "NATIVE_PROJECTION_SUBSCRIPTION_ENCODE_INVALID",
        });
      }
      this.recordTiming(this.readTimings, readMs);
      this.recordTiming(this.encodeTimings, encodeMs);
      this.deliveredCount += 1;
      this.awaitingAck = {
        sequence: request.sequence,
        sha256: transfer.header.sha256,
      };
      const payload = new Uint8Array(transfer.payload);
      this.port.postMessage({
        subscription: {
          schemaVersion: SUBSCRIPTION_SCHEMA_VERSION,
          subscriptionId: request.subscriptionId,
          channel: request.channel,
          coalescedCount: this.coalescedCount,
          readMs,
          encodeMs,
        },
        header: transfer.header,
        payload,
      });
      this.ackTimer = this.schedule(() => {
        this.ackTimer = null;
        this.fail("NATIVE_PROJECTION_SUBSCRIPTION_ACK_TIMEOUT");
      }, this.ackTimeoutMs);
    } catch (error) {
      if (this.closed) return;
      const code = safeErrorCode(error);
      try {
        this.port.postMessage({
          subscriptionError: {
            schemaVersion: SUBSCRIPTION_SCHEMA_VERSION,
            subscriptionId: this.identity.subscriptionId,
            sequence: request.sequence,
            code,
          },
        });
      } catch {
        this.close("renderer-disconnected");
        return;
      }
      if (!COALESCIBLE_CHANNELS.has(this.identity.channel)) {
        this.close(code);
        return;
      }
    } finally {
      this.running = false;
      if (!this.closed && !this.awaitingAck) void this.drain();
    }
  }

  recordTiming(target, value) {
    target.push(boundedDuration(value));
    if (target.length > MAX_TIMING_SAMPLES) target.splice(0, target.length - MAX_TIMING_SAMPLES);
  }

  fail(code) {
    if (this.closed) return;
    try {
      this.port.postMessage({
        subscriptionError: {
          schemaVersion: SUBSCRIPTION_SCHEMA_VERSION,
          subscriptionId: this.identity.subscriptionId,
          sequence: this.awaitingAck?.sequence ?? this.queue.at(0)?.sequence ?? null,
          code,
        },
      });
    } catch {
      // Closing below is the only state transition required after disconnect.
    }
    this.close(code);
  }

  snapshot() {
    const timing = (samples) => ({
      sampleCount: samples.length,
      p50Ms: percentile(samples, 0.50),
      p95Ms: percentile(samples, 0.95),
      maxMs: samples.length === 0 ? 0 : Math.max(...samples),
    });
    return Object.freeze({
      schemaVersion: SUBSCRIPTION_SCHEMA_VERSION,
      subscriptionId: this.identity.subscriptionId,
      sessionId: this.identity.sessionId,
      channel: this.identity.channel,
      projectionType: this.identity.projectionType,
      closed: this.closed,
      queuedFrames: this.queue.length,
      awaitingAck: this.awaitingAck !== null,
      coalescedCount: this.coalescedCount,
      deliveredCount: this.deliveredCount,
      acknowledgedCount: this.acknowledgedCount,
      read: timing(this.readTimings),
      encode: timing(this.encodeTimings),
      validation: timing(this.validationTimings),
      install: timing(this.installTimings),
    });
  }

  close(reason = "closed") {
    if (this.closed) return;
    this.closed = true;
    if (this.ackTimer !== null) this.cancel(this.ackTimer);
    this.ackTimer = null;
    this.queue = [];
    this.awaitingAck = null;
    this.port.removeListener?.("message", this.handleMessage);
    this.port.removeListener?.("close", this.handlePortClose);
    try { this.port.close(); } catch { /* the peer may already be closed */ }
    this.onClosed(this.snapshot(), reason);
  }
}

function summarizeNativeProjectionSubscriptions(active, retained) {
  const activeSnapshots = Array.isArray(active) ? active : [];
  const retainedSnapshots = Array.isArray(retained) ? retained.slice(-64) : [];
  const snapshots = [...retainedSnapshots, ...activeSnapshots];
  const channelRows = new Map();
  let transportP95Ms = 0;
  for (const snapshot of snapshots) {
    const row = channelRows.get(snapshot.channel) ?? {
      channel: snapshot.channel,
      subscriptions: 0,
      deliveredFrames: 0,
      acknowledgedFrames: 0,
      coalescedFrames: 0,
      maximumQueuedFrames: 0,
      readP95Ms: 0,
      encodeP95Ms: 0,
      validationP95Ms: 0,
      installP95Ms: 0,
    };
    row.subscriptions += 1;
    row.deliveredFrames += snapshot.deliveredCount;
    row.acknowledgedFrames += snapshot.acknowledgedCount;
    row.coalescedFrames += snapshot.coalescedCount;
    row.maximumQueuedFrames = Math.max(row.maximumQueuedFrames, snapshot.queuedFrames);
    row.readP95Ms = Math.max(row.readP95Ms, snapshot.read.p95Ms);
    row.encodeP95Ms = Math.max(row.encodeP95Ms, snapshot.encode.p95Ms);
    row.validationP95Ms = Math.max(row.validationP95Ms, snapshot.validation.p95Ms);
    row.installP95Ms = Math.max(row.installP95Ms, snapshot.install.p95Ms);
    channelRows.set(snapshot.channel, row);
    transportP95Ms = Math.max(transportP95Ms,
      snapshot.encode.p95Ms + snapshot.validation.p95Ms + snapshot.install.p95Ms);
  }
  const acknowledgedFrames = snapshots.reduce(
    (total, snapshot) => total + snapshot.acknowledgedCount,
    0,
  );
  const frameBudgetMs = 1000 / 60;
  const frameBudgetRatio = transportP95Ms / frameBudgetMs;
  const decision = acknowledgedFrames < 30
    ? "insufficient-samples"
    : frameBudgetRatio <= 0.20
      ? "bounded-message-port-retained"
      : "shared-memory-evaluation-required";
  return Object.freeze({
    schemaVersion: SUBSCRIPTION_SCHEMA_VERSION,
    activeSubscriptions: activeSnapshots.length,
    retainedClosedSubscriptions: retainedSnapshots.length,
    acknowledgedFrames,
    deliveredFrames: snapshots.reduce((total, snapshot) => total + snapshot.deliveredCount, 0),
    coalescedFrames: snapshots.reduce((total, snapshot) => total + snapshot.coalescedCount, 0),
    queuedFrames: activeSnapshots.reduce((total, snapshot) => total + snapshot.queuedFrames, 0),
    channels: [...channelRows.values()].sort((left, right) => left.channel.localeCompare(right.channel)),
    gateC: {
      frameBudgetMs,
      maximumRatio: 0.20,
      transportP95Ms,
      frameBudgetRatio,
      decision,
    },
  });
}

module.exports = {
  CHANNEL_PROJECTION_TYPES,
  COALESCIBLE_CHANNELS,
  DEFAULT_RELIABLE_QUEUE_LIMIT,
  NativeProjectionSubscription,
  SUBSCRIPTION_SCHEMA_VERSION,
  normalizeSubscriptionRequest,
  summarizeNativeProjectionSubscriptions,
};
