"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const vm = require("node:vm");
const { test } = require("node:test");

function loadPreload() {
  const transfers = [];
  const channels = [];
  let exposed = null;
  class FakeMessageChannel {
    constructor() {
      const messages = [];
      this.port1 = {
        messages,
        onmessage: null,
        onmessageerror: null,
        closed: false,
        start() {},
        close() { this.closed = true; },
        postMessage(value) { messages.push(value); },
      };
      this.port2 = { kind: "fake-transfer-port" };
      channels.push(this);
    }
  }
  const ipcRenderer = {
    invoke() { return Promise.resolve({ ok: true }); },
    postMessage(channel, request, ports) { transfers.push({ channel, request, ports }); },
    on() {},
    removeListener() {},
    send() {},
  };
  const filename = path.join(__dirname, "preload.cjs");
  const sandbox = {
    Buffer,
    MessageChannel: FakeMessageChannel,
    clearTimeout,
    console,
    globalThis: null,
    performance,
    require(specifier) {
      if (specifier === "electron") {
        return {
          contextBridge: { exposeInMainWorld(_name, value) { exposed = value; } },
          ipcRenderer,
        };
      }
      if (specifier === "node:crypto") return require("node:crypto");
      if (specifier === "./native-renderer-boundary.cjs") {
        return require(path.join(__dirname, "native-renderer-boundary.cjs"));
      }
      if (specifier === "./native-player-authority-handoff-ipc.cjs") {
        return { subscribeRendererToNativePlayerAuthorityHandoff: () => () => undefined };
      }
      throw new Error(`unexpected preload dependency: ${specifier}`);
    },
    setTimeout,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  const toRealm = (value) => {
    sandbox.__testJson = JSON.stringify(value);
    return vm.runInContext("JSON.parse(__testJson)", context);
  };
  const bytesToRealm = (value) => {
    sandbox.__testBytes = Array.from(value);
    return vm.runInContext("Uint8Array.from(__testBytes)", context);
  };
  return { api: exposed, bytesToRealm, channels, transfers, toRealm };
}

function subscriptionRequest(overrides = {}) {
  return {
    sessionId: "session-1",
    channel: "telemetry",
    projectionType: "statistics-v1",
    payload: {
      runId: "run-1",
      expectedRevision: 17,
      expectedRegistryFingerprint: "registry-1",
      minElapsedSeconds: 0,
      maxElapsedSeconds: 60,
      cursor: 0,
      limit: 16,
      planetId: null,
      itemId: null,
    },
    ...overrides,
  };
}

test("preload subscription exposes one persistent bounded port with update and close", () => {
  const loaded = loadPreload();
  const events = [];
  const handle = loaded.api.subscribeNativeCoreProjection(
    loaded.toRealm(subscriptionRequest()),
    (event) => events.push(event),
  );
  assert.equal(loaded.transfers.length, 1);
  assert.equal(loaded.transfers[0].channel, "desktop:native-core-projection-subscribe");
  assert.match(loaded.transfers[0].request.subscriptionId, /^projection-[A-Za-z0-9-]+$/);
  assert.equal(loaded.transfers[0].request.sequence >= 1, true);
  const port = loaded.channels[0].port1;
  handle.update(loaded.toRealm({ ...subscriptionRequest().payload, expectedRevision: 18 }));
  assert.equal(port.messages[0].update.payload.expectedRevision, 18);
  handle.close();
  assert.equal(port.messages[1].close.subscriptionId, loaded.transfers[0].request.subscriptionId);
  assert.equal(port.closed, true);
  assert.deepEqual(events, []);
});

test("preload validates digest, awaits install, then ACKs the exact subscription frame", async () => {
  const loaded = loadPreload();
  const installed = [];
  loaded.api.subscribeNativeCoreProjection(
    loaded.toRealm(subscriptionRequest()),
    async (event) => { installed.push(event); return true; },
  );
  const dispatched = loaded.transfers[0].request;
  const body = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    projectionType: "statistics-v1",
    revision: 17,
  }));
  const sha256 = createHash("sha256").update(body).digest("hex");
  const port = loaded.channels[0].port1;
  await port.onmessage({ data: {
    subscription: loaded.toRealm({
      schemaVersion: 1,
      subscriptionId: dispatched.subscriptionId,
      channel: "telemetry",
      coalescedCount: 2,
      readMs: 0.5,
      encodeMs: 0.25,
    }),
    header: loaded.toRealm({
      schemaVersion: 1,
      sessionId: "session-1",
      revision: 17,
      sequence: dispatched.sequence,
      projectionType: "statistics-v1",
      payloadLength: body.length,
      sha256,
    }),
    payload: loaded.bytesToRealm(body),
  } });
  assert.equal(installed.length, 1);
  assert.equal(installed[0].kind, "frame", installed[0].error?.message);
  assert.equal(installed[0].metrics.coalescedCount, 2);
  assert.equal(port.messages[0].projectionAck.subscriptionId, dispatched.subscriptionId);
  assert.equal(port.messages[0].projectionAck.sequence, dispatched.sequence);
  assert.equal(port.messages[0].projectionAck.sha256, sha256);
  assert.equal(Number.isFinite(port.messages[0].projectionAck.validationMs), true);
  assert.equal(Number.isFinite(port.messages[0].projectionAck.installMs), true);
});

test("preload rejects channel/projection mismatch and smuggled session fields before IPC", () => {
  for (const value of [
    subscriptionRequest({ channel: "inventory" }),
    subscriptionRequest({ payload: { sessionId: "smuggled" } }),
    { ...subscriptionRequest(), extra: true },
  ]) {
    const loaded = loadPreload();
    assert.throws(() => loaded.api.subscribeNativeCoreProjection(
      loaded.toRealm(value),
      () => undefined,
    ), /原生投影订阅请求无效/);
    assert.equal(loaded.transfers.length, 0);
  }
});
