const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function request(overrides = {}) {
  return {
    sessionId: "core-session-7",
    expectedGeneration: 3,
    expectedRootHash: SHA_A,
    expectedRevision: 9,
    expectedRegistryFingerprint: "registry-7",
    expectedCanonicalSha256: SHA_A,
    expectedDomainSha256: SHA_B,
    strategy: "macro-v1",
    ...overrides,
  };
}

function fnvChecksum(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function loadPreload() {
  let exposed = null;
  const transfers = [];
  const rendererAcks = [];
  class FakeMessageChannel {
    constructor() {
      const port1 = {
        closed: false,
        onmessage: null,
        onmessageerror: null,
        start() {},
        close() { this.closed = true; },
        postMessage(message) { rendererAcks.push(message); },
      };
      this.port1 = port1;
      this.port2 = {
        deliver(message) {
          queueMicrotask(() => port1.onmessage?.({ data: message }));
        },
        fail() {
          queueMicrotask(() => port1.onmessageerror?.());
        },
      };
    }
  }
  const ipcRenderer = {
    invoke() { return Promise.resolve({}); },
    on() {},
    removeListener() {},
    send() {},
    postMessage(channel, payload, ports) {
      transfers.push({ channel, payload, port: ports[0] });
    },
  };
  const filename = path.join(__dirname, "preload.cjs");
  const source = fs.readFileSync(filename, "utf8");
  const realBoundary = require("./native-renderer-boundary.cjs");
  const sandbox = {
    ArrayBuffer,
    Buffer,
    MessageChannel: FakeMessageChannel,
    Uint8Array,
    clearTimeout() {},
    console,
    globalThis: null,
    queueMicrotask,
    require(specifier) {
      if (specifier === "electron") {
        return {
          contextBridge: { exposeInMainWorld(_name, value) { exposed = value; } },
          ipcRenderer,
        };
      }
      if (specifier === "node:crypto") return require("node:crypto");
      if (specifier === "./native-renderer-boundary.cjs") {
        return {
          ...realBoundary,
          normalizeRendererNativeResult(kind, value) {
            if (kind !== "coreOfflineCandidateExport") {
              return realBoundary.normalizeRendererNativeResult(kind, value);
            }
            return value;
          },
        };
      }
      if (specifier === "./native-player-authority-handoff-ipc.cjs") {
        return { subscribeRendererToNativePlayerAuthorityHandoff: () => () => undefined };
      }
      throw new Error(`unexpected preload dependency: ${specifier}`);
    },
    setTimeout() { return 1; },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename });
  const toRealm = (value) => {
    sandbox.__testJson = JSON.stringify(value);
    return vm.runInContext("JSON.parse(__testJson)", context);
  };
  const toRealmChunk = (bytes, offset) => {
    sandbox.__testBytes = Array.from(bytes);
    sandbox.__testOffset = offset;
    return vm.runInContext(
      "({ chunk: new Uint8Array(__testBytes), offset: __testOffset })",
      context,
    );
  };
  return { api: exposed, rendererAcks, transfers, toRealm, toRealmChunk };
}

function candidate(payload) {
  const envelopeSha256 = createHash("sha256").update(payload).digest("hex");
  return {
    prepared: true,
    strategy: "macro-v1",
    sourceSavedAtMs: 1_000,
    settledAtMs: 61_000,
    settledSeconds: 60,
    sourceSummary: { revision: 9 },
    candidateSummary: { revision: 10 },
    advance: {
      supported: true,
      exactScope: "offline-macro-v1",
      previousRevision: 9,
      revision: 10,
    },
    export: {
      exportId: "offlinecandidatefixed",
      mode: "normal",
      result: {
        revision: 10,
        savedAtMs: 61_000,
        byteLength: payload.byteLength,
        envelopeSha256,
        stateChecksum: "1234abcd",
      },
    },
  };
}

test("preload assembles and verifies one native offline candidate with bounded ACKs", async () => {
  const loaded = loadPreload();
  const payload = Buffer.from("verified-native-offline-envelope", "utf8");
  const pending = loaded.api.prepareNativeOfflineStartup(loaded.toRealm(request()));
  assert.equal(loaded.transfers.length, 1);
  const transfer = loaded.transfers[0];
  assert.equal(transfer.channel, "desktop:native-offline-startup-transfer");
  assert.deepEqual(Reflect.ownKeys(transfer.payload).sort(), Reflect.ownKeys(request()).sort());

  const result = candidate(payload);
  transfer.port.deliver(loaded.toRealm({ start: result, payloadByteLength: payload.byteLength }));
  transfer.port.deliver(loaded.toRealmChunk(payload, payload.byteLength));
  transfer.port.deliver(loaded.toRealm({
    end: true,
    totalBytes: payload.byteLength,
    envelopeSha256: result.export.result.envelopeSha256,
  }));
  const settled = await pending;
  assert.deepEqual(Buffer.from(settled.payloadBytes), payload);
  assert.equal(settled.payloadChecksum, fnvChecksum(payload));
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.rendererAcks)), [
    { ack: payload.byteLength },
    { completeAck: result.export.result.envelopeSha256 },
  ]);
});

test("preload accepts an unavailable native candidate without allocating a body", async () => {
  const loaded = loadPreload();
  const pending = loaded.api.prepareNativeOfflineStartup(loaded.toRealm(request()));
  const unavailable = {
    prepared: false,
    strategy: "macro-v1",
    sourceSavedAtMs: 1_000,
    settledAtMs: 1_000,
    settledSeconds: 0,
    sourceSummary: { revision: 9 },
    reason: "interval-too-short",
  };
  loaded.transfers[0].port.deliver(loaded.toRealm({ start: unavailable, payloadByteLength: 0 }));
  loaded.transfers[0].port.deliver(loaded.toRealm({ end: true, totalBytes: 0, envelopeSha256: null }));
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), unavailable);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.rendererAcks)), [{ completeAck: null }]);
});

test("preload rejects renderer-owned time/path/export fields before IPC", () => {
  for (const invalid of [
    { ...request(), observedNowMs: 61_000 },
    { ...request(), exportId: "forged" },
    { ...request(), exportPath: "C:\\private.json" },
    request({ expectedGeneration: 0 }),
    request({ expectedDomainSha256: "B".repeat(64) }),
  ]) {
    const loaded = loadPreload();
    assert.throws(
      () => loaded.api.prepareNativeOfflineStartup(loaded.toRealm(invalid)),
      (error) => error?.name === "TypeError",
    );
    assert.equal(loaded.transfers.length, 0);
  }
});

test("preload discards an out-of-order native offline chunk", async () => {
  const loaded = loadPreload();
  const payload = Buffer.from("candidate", "utf8");
  const pending = loaded.api.prepareNativeOfflineStartup(loaded.toRealm(request()));
  const result = candidate(payload);
  loaded.transfers[0].port.deliver(loaded.toRealm({ start: result, payloadByteLength: payload.byteLength }));
  loaded.transfers[0].port.deliver(loaded.toRealmChunk(payload, payload.byteLength + 1));
  await assert.rejects(pending, (error) => error?.code === "NATIVE_PROTOCOL_INVALID");
  assert.deepEqual(loaded.rendererAcks, []);
});
