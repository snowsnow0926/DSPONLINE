"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  NativeProjectionSubscription,
  normalizeSubscriptionRequest,
  summarizeNativeProjectionSubscriptions,
} = require("./native-projection-subscription.cjs");

class FakePort extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.closed = false;
    this.started = false;
  }

  start() { this.started = true; }
  postMessage(value) { this.messages.push(value); }
  close() { this.closed = true; }
  receive(data) { this.emit("message", { data }); }
}

function request(overrides = {}) {
  return {
    subscriptionId: "projection-subscription-1",
    sessionId: "native-session-1",
    channel: "telemetry",
    projectionType: "statistics-v1",
    sequence: 1,
    payload: { expectedRevision: 10 },
    ...overrides,
  };
}

function encodeProjection({ sessionId, sequence, projectionType, result }) {
  const payload = Buffer.from(JSON.stringify(result));
  return {
    header: {
      schemaVersion: 1,
      sessionId,
      revision: result.revision,
      sequence,
      projectionType,
      payloadLength: payload.length,
      sha256: `hash-${sequence}`,
    },
    payload,
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("subscription request binds each channel to a bounded projection kind", () => {
  assert.equal(normalizeSubscriptionRequest(request()).channel, "telemetry");
  assert.throws(() => normalizeSubscriptionRequest(request({
    channel: "inventory",
    projectionType: "statistics-v1",
  })), /request is invalid/);
  assert.throws(() => normalizeSubscriptionRequest(request({
    payload: { sessionId: "smuggled" },
  })), /request is invalid/);
});

test("coalescible telemetry retains only the newest pending revision behind one ACK", async () => {
  const port = new FakePort();
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const reads = [];
  const subscription = new NativeProjectionSubscription({
    port,
    initialRequest: request(),
    readProjection: async (entry) => {
      reads.push(entry.sequence);
      if (entry.sequence === 1) await first;
      return { schemaVersion: 1, projectionType: entry.projectionType, revision: entry.payload.expectedRevision };
    },
    encodeProjection,
  }).start();

  port.receive({ update: { sequence: 2, payload: { expectedRevision: 11 } } });
  port.receive({ update: { sequence: 3, payload: { expectedRevision: 12 } } });
  releaseFirst();
  await tick();
  assert.deepEqual(reads, [1]);
  assert.equal(port.messages[0].subscription.coalescedCount, 1);
  port.receive({ projectionAck: {
    subscriptionId: "projection-subscription-1",
    sequence: 1,
    sha256: "hash-1",
    validationMs: 0.1,
    installMs: 0.25,
  } });
  await tick();
  assert.deepEqual(reads, [1, 3]);
  assert.equal(port.messages[1].header.revision, 12);
  subscription.close();
});

test("reliable channels never silently drop queued topology and fail closed on overflow", async () => {
  const port = new FakePort();
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const subscription = new NativeProjectionSubscription({
    port,
    initialRequest: request({ channel: "viewport-topology", projectionType: "viewport-v2" }),
    readProjection: async (entry) => {
      if (entry.sequence === 1) await first;
      return { schemaVersion: 2, projectionType: "viewport-v2", revision: entry.payload.expectedRevision };
    },
    encodeProjection,
    reliableQueueLimit: 2,
  }).start();

  port.receive({ update: { sequence: 2, payload: { expectedRevision: 11 } } });
  port.receive({ update: { sequence: 3, payload: { expectedRevision: 12 } } });
  port.receive({ update: { sequence: 4, payload: { expectedRevision: 13 } } });
  assert.equal(subscription.snapshot().closed, true);
  assert.equal(port.closed, true);
  assert.equal(port.messages.at(-1).subscriptionError.code,
    "NATIVE_PROJECTION_SUBSCRIPTION_BACKPRESSURE_EXCEEDED");
  releaseFirst();
});

test("ACK validation records install cost and close releases listeners and queues", async () => {
  const port = new FakePort();
  let closedSnapshot = null;
  const subscription = new NativeProjectionSubscription({
    port,
    initialRequest: request(),
    readProjection: async (entry) => ({
      schemaVersion: 1,
      projectionType: entry.projectionType,
      revision: entry.payload.expectedRevision,
    }),
    encodeProjection,
    onClosed: (snapshot) => { closedSnapshot = snapshot; },
  }).start();
  await tick();
  port.receive({ projectionAck: {
    subscriptionId: "projection-subscription-1",
    sequence: 1,
    sha256: "hash-1",
    validationMs: 0.5,
    installMs: 1.5,
  } });
  await tick();
  assert.equal(subscription.snapshot().acknowledgedCount, 1);
  assert.equal(subscription.snapshot().validation.sampleCount, 1);
  assert.equal(subscription.snapshot().install.sampleCount, 1);

  port.receive({ close: { subscriptionId: "projection-subscription-1" } });
  assert.equal(port.listenerCount("message"), 0);
  assert.equal(closedSnapshot.closed, true);
  assert.equal(closedSnapshot.queuedFrames, 0);
});

function diagnosticsSnapshot({
  channel = "telemetry",
  acknowledgedCount = 30,
  encodeP95Ms = 0.5,
  validationP95Ms = 0.25,
  installP95Ms = 0.5,
} = {}) {
  const timing = (p95Ms) => ({ sampleCount: acknowledgedCount, p50Ms: p95Ms / 2, p95Ms, maxMs: p95Ms });
  return {
    schemaVersion: 1,
    subscriptionId: `subscription-${channel}`,
    sessionId: "native-session-1",
    channel,
    projectionType: "statistics-v1",
    closed: true,
    queuedFrames: 0,
    awaitingAck: false,
    coalescedCount: 2,
    deliveredCount: acknowledgedCount,
    acknowledgedCount,
    read: timing(1),
    encode: timing(encodeP95Ms),
    validation: timing(validationP95Ms),
    install: timing(installP95Ms),
  };
}

test("Gate C retains bounded MessagePort only after enough fast acknowledged frames", () => {
  const summary = summarizeNativeProjectionSubscriptions([], [diagnosticsSnapshot()]);
  assert.equal(summary.acknowledgedFrames, 30);
  assert.equal(summary.gateC.transportP95Ms, 1.25);
  assert.ok(summary.gateC.frameBudgetRatio < 0.20);
  assert.equal(summary.gateC.decision, "bounded-message-port-retained");
});

test("Gate C requests shared-memory evaluation when transport exceeds the frame budget", () => {
  const summary = summarizeNativeProjectionSubscriptions([], [diagnosticsSnapshot({
    encodeP95Ms: 1.5,
    validationP95Ms: 1,
    installP95Ms: 1.5,
  })]);
  assert.ok(summary.gateC.frameBudgetRatio > 0.20);
  assert.equal(summary.gateC.decision, "shared-memory-evaluation-required");
});

test("Gate C never promotes a transport from an undersized sample", () => {
  const summary = summarizeNativeProjectionSubscriptions([diagnosticsSnapshot({
    acknowledgedCount: 29,
  })], []);
  assert.equal(summary.activeSubscriptions, 1);
  assert.equal(summary.gateC.decision, "insufficient-samples");
});
