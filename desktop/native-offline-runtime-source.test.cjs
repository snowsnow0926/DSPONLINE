const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");
const test = require("node:test");
const vm = require("node:vm");
const { NativeHostClient } = require("./native-host.cjs");
const { NativeOfflineRuntimeSourceBroker, normalizeNativeOfflineSourceIntent,
  MAX_SOURCE_CHUNK_BYTES, SOURCE_CAPABILITY } = require("./native-offline-runtime-source.cjs");

const binaryPath = path.resolve("native/target/release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");
const intent = () => ({ registryFingerprint: "builtin:test", catalog: { protocolVersion: 1,
  registryFingerprint: "builtin:test", items: [{ id: "iron_ore" }], buildings: [], recipes: [], belts: [] },
  sourceSavedAtMs: 1_000, expectedCanonicalSha256: "a".repeat(64), expectedDomainSha256: "b".repeat(64), strategy: "macro-v1" });
const startIntent = () => { const { registryFingerprint, catalog, sourceSavedAtMs } = intent(); return { registryFingerprint, catalog, sourceSavedAtMs }; };
const end = (totalBytes) => ({ sourceEnd: true, totalBytes,
  expectedCanonicalSha256: intent().expectedCanonicalSha256, expectedDomainSha256: intent().expectedDomainSha256 });

class TestPort extends EventEmitter {
  constructor(onPost = () => {}) { super(); this.messages = []; this.onPost = onPost; }
  start() {}
  send(message) { this.emit("message", { data: message }); }
  close() { this.emit("close"); }
  postMessage(message) { this.messages.push(message); queueMicrotask(() => this.onPost(message, this)); }
}

async function environment(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsp-offline-source-test-"));
  const temporaryParent = path.join(root, "temp");
  await fs.promises.mkdir(temporaryParent);
  await fs.promises.writeFile(path.join(temporaryParent, "keep.txt"), "untouched sibling");
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  const clean = () => {
    assert.deepEqual(fs.readdirSync(temporaryParent), ["keep.txt"]);
    assert.equal(fs.readFileSync(path.join(temporaryParent, "keep.txt"), "utf8"), "untouched sibling");
  };
  return { root, temporaryParent, clean };
}

test("runtime source intent contains source proof only and snapshots its catalog", () => {
  const source = intent();
  const normalized = normalizeNativeOfflineSourceIntent(source);
  source.catalog.items.push({ id: "changed" });
  assert.equal(normalized.catalog.items.length, 1);
  for (const field of ["sourcePath", "exportId", "observedNowMs", "expectedRevision", "sessionId"]) {
    assert.throws(() => normalizeNativeOfflineSourceIntent({ ...intent(), [field]: "forged" }), /intent is invalid/);
  }
  assert.throws(() => normalizeNativeOfflineSourceIntent({ ...intent(), sourceSavedAtMs: -1 }));
  assert.throws(() => normalizeNativeOfflineSourceIntent({ ...intent(), expectedDomainSha256: "A".repeat(64) }));
  assert.throws(() => normalizeNativeOfflineSourceIntent({ ...intent(), catalog: { ...intent().catalog, registryFingerprint: "other" } }));
});

test("actual main source handler owns the start clock and cancels on renderer destruction", async () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const start = main.indexOf('ipcMain.on("desktop:native-offline-source-transfer"');
  const end = main.indexOf('// Startup settlement is a read-only candidate transaction.', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const errors = [];
  const sender = new EventEmitter();
  sender.id = 17;
  let handler;
  let finish;
  let close;
  const closed = new Promise(resolve => { close = resolve; });
  const port = new EventEmitter();
  vm.runInNewContext(main.slice(start, end), {
    ipcMain: { on: (channel, listener) => { assert.equal(channel, "desktop:native-offline-source-transfer"); handler = listener; } },
    nativeOfflineRuntimeSourceBroker: {
      run: (options) => { calls.push(options); return new Promise(resolve => { finish = resolve; }); },
      cancelOwner: (ownerId) => calls.push({ cancelledOwner: ownerId }),
    },
    nativeOfflineSourceShutdownRequested: false,
    requireTrustedNativeSender: event => { assert.equal(event.sender, sender); return sender.id; },
    sampleNativeOfflineStartupWallClock: () => 9_000,
    postNativeOfflineStartupTransferError: (_port, error) => errors.push(error),
    closeTransferPort: () => close(),
  });
  const request = startIntent();
  handler({ sender, ports: [port] }, request);
  assert.equal(calls[0].request, request);
  assert.equal(calls[0].observedNowMs, 9_000);
  assert.equal(calls[0].ownerId, 17);
  sender.emit("destroyed");
  assert.equal(calls[1].cancelledOwner, 17);
  finish();
  await closed;
  assert.equal(sender.listenerCount("destroyed"), 0);
  assert.deepEqual(errors, []);
});

test("runtime source rejects malformed upload packets and cleans only its private directory", async (t) => {
  const env = await environment(t);
  const broker = new NativeOfflineRuntimeSourceBroker({ binaryPath, temporaryParent: env.temporaryParent,
    createClient: () => { throw new Error("invalid input must never start Host"); } });
  for (const packet of [
    { sourceChunk: new Uint8Array([1]), offset: 2 },
    { sourceChunk: new Uint8Array(0), offset: 0 },
    { sourceChunk: new Uint8Array(MAX_SOURCE_CHUNK_BYTES + 1), offset: MAX_SOURCE_CHUNK_BYTES + 1 },
    { sourceChunk: "not bytes", offset: 9 },
    { sourceChunk: new Uint8Array([1]), offset: 1, sourcePath: "forged" },
    { sourceEnd: true, totalBytes: 0 },
  ]) {
    const port = new TestPort((message, target) => { if (message.sourceReady) target.send(packet); });
    await assert.rejects(broker.run({ ownerId: 17, request: startIntent(), observedNowMs: 2_000, port }), /chunk is invalid|final length changed/);
    env.clean();
  }
});

test("runtime source detects senders that ignore ACK backpressure", async (t) => {
  const env = await environment(t);
  const broker = new NativeOfflineRuntimeSourceBroker({ binaryPath, temporaryParent: env.temporaryParent });
  const port = new TestPort((message, target) => {
    if (message.sourceReady) {
      target.send({ sourceChunk: new Uint8Array([1]), offset: 1 });
      target.send({ sourceChunk: new Uint8Array([2]), offset: 2 });
    }
  });
  await assert.rejects(broker.run({ ownerId: 17, request: startIntent(), observedNowMs: 2_000, port }));
  env.clean();
});

test("runtime source upload timeout leaves no source file or active transaction", async (t) => {
  const env = await environment(t);
  const broker = new NativeOfflineRuntimeSourceBroker({ binaryPath, temporaryParent: env.temporaryParent, idleTimeoutMs: 30 });
  await assert.rejects(broker.run({ ownerId: 17, request: startIntent(), observedNowMs: 2_000, port: new TestPort() }), /upload timed out/);
  assert.equal(broker.active, null);
  env.clean();
});

test("runtime source restricts cancellation to its owner and drains pending upload", async (t) => {
  const env = await environment(t);
  const broker = new NativeOfflineRuntimeSourceBroker({ binaryPath, temporaryParent: env.temporaryParent });
  const port = new TestPort((message) => {
    if (message.sourceReady) {
      broker.cancelOwner(18);
      assert.equal(broker.active.controller.signal.aborted, false);
      assert.throws(() => broker.run({ ownerId: 18, request: startIntent(), observedNowMs: 2_000, port: new TestPort() }), /busy/);
      broker.cancelOwner(17);
    }
  });
  await assert.rejects(broker.run({ ownerId: 17, request: startIntent(), observedNowMs: 2_000, port }), { name: "AbortError" });
  await broker.close();
  env.clean();
});

test("runtime source kills and observes only its temporary calculation when cancelled", async (t) => {
  const env = await environment(t);
  let kills = 0;
  let requestSeen = false;
  let broker;
  const createClient = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    let rejectRequest;
    child.kill = () => {
      if (child.signalCode !== null) return;
      kills += 1;
      child.signalCode = "SIGTERM";
      queueMicrotask(() => { child.emit("close", null, "SIGTERM"); rejectRequest?.(new Error("owned host exited")); });
    };
    return { child, start: async () => ({ capabilities: [SOURCE_CAPABILITY] }),
      request: (request) => new Promise((_resolve, reject) => {
        assert.equal(request.operation, "corePrepareOfflineSourceExport");
        assert.equal(fs.readFileSync(request.sourcePath, "utf8"), "{} ");
        assert.equal(request.request.sourceByteLength, 3);
        assert.equal(request.request.observedNowMs, 2_000);
        assert.equal(request.request.sourceSha256, createHash("sha256").update("{} ").digest("hex"));
        requestSeen = true;
        rejectRequest = reject;
        queueMicrotask(() => broker.cancelOwner(17));
      }) };
  };
  broker = new NativeOfflineRuntimeSourceBroker({ binaryPath, temporaryParent: env.temporaryParent, createClient });
  const port = new TestPort((message, target) => {
    if (message.sourceReady) target.send({ sourceChunk: new Uint8Array(Buffer.from("{} ")), offset: 3 });
    if (message.sourceAck === 3) target.send(end(3));
  });
  await assert.rejects(broker.run({ ownerId: 17, request: startIntent(), observedNowMs: 2_000, port }));
  assert.equal(requestSeen, true);
  assert.equal(kills, 1);
  env.clean();
});

test("runtime source transfers a real Host candidate and confirms cleanup before completion", {
  skip: !fs.existsSync(binaryPath) ? "release native host has not been built" : false, timeout: 30_000,
}, async (t) => {
  const env = await environment(t);
  const { createServer } = await import("vite");
  const vite = await createServer({ root: path.resolve("."), configFile: false, cacheDir: path.join(env.root, "vite-cache"),
    appType: "custom", logLevel: "silent", server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true } });
  t.after(() => vite.close());
  const [fixture, transfer] = await Promise.all([vite.ssrLoadModule("/tests/fixtures/rust-offline-performance.ts"),
    vite.ssrLoadModule("/src/game/saveTransfer.ts")]);
  const state = fixture.createPublicCatalogOfflineQualificationFixture("quantum-capacity");
  const encoded = transfer.serializeSaveEnvelopeToTransfer(state, { formatVersion: 2, kind: "primary", mode: "normal",
    slot: "main", savedAt: fixture.SAVED_AT });
  const bytes = new Uint8Array(encoded.bytes);
  const proof = fixture.createNativeCoreRevisionProof(state, 0, "0".repeat(64), fixture.runtime.fingerprint);
  const request = { registryFingerprint: fixture.runtime.fingerprint, catalog: fixture.catalog, sourceSavedAtMs: fixture.SAVED_AT };
  const exits = [];
  const broker = new NativeOfflineRuntimeSourceBroker({ binaryPath, temporaryParent: env.temporaryParent,
    createClient: (options) => {
      const client = new NativeHostClient(options);
      const start = client.start.bind(client);
      client.start = (...args) => { const pending = start(...args); client.child.once("close", (code, signal) => exits.push({ code, signal })); return pending; };
      return client;
    } });
  t.after(() => broker.close());
  const received = [];
  let sent = 0;
  const port = new TestPort((message, target) => {
    if (message.sourceReady || Number.isSafeInteger(message.sourceAck)) {
      if (sent === bytes.length) target.send({ sourceEnd: true, totalBytes: sent, expectedCanonicalSha256: proof.canonicalSha256, expectedDomainSha256: proof.domainSha256 });
      else { const next = Math.min(sent + 4096, bytes.length); target.send({ sourceChunk: bytes.slice(sent, next), offset: next }); sent = next; }
    } else if (message.chunk) { received.push(Buffer.from(message.chunk)); target.send({ ack: message.offset }); }
    else if (message.end) target.send({ completeAck: message.envelopeSha256 });
    else if (message.sourceClosed) env.clean();
  });
  const result = await broker.run({ ownerId: 17, request, observedNowMs: fixture.SAVED_AT + 5_000, port });
  assert.equal(result.prepared, true);
  assert.equal(result.settledSeconds, 5);
  const raw = Buffer.concat(received);
  assert.equal(createHash("sha256").update(raw).digest("hex"), result.export.result.envelopeSha256);
  let expected = state;
  for (let second = 0; second < 5; second++) expected = fixture.advanceSimulationBudget(expected, 1, 1);
  assert.deepEqual(JSON.parse(raw.toString("utf8")).state, JSON.parse(JSON.stringify(expected)));
  assert.deepEqual(exits, [{ code: 0, signal: null }]);
  assert.deepEqual(port.messages.at(-1), { sourceClosed: true });
  env.clean();
  await t.test("cancel during verified candidate delivery removes the private source and result", async () => {
    const cancelledPort = new TestPort((message, target) => {
      if (message.sourceReady) target.send({ sourceChunk: bytes, offset: bytes.length });
      else if (message.sourceAck) target.send({ sourceEnd: true, totalBytes: bytes.length,
        expectedCanonicalSha256: proof.canonicalSha256, expectedDomainSha256: proof.domainSha256 });
      else if (message.start) broker.cancelOwner(17);
    });
    await assert.rejects(broker.run({ ownerId: 17, request, observedNowMs: fixture.SAVED_AT + 5_000, port: cancelledPort }), { name: "AbortError" });
    assert.equal(cancelledPort.messages.some(message => message.sourceClosed), false);
    assert.deepEqual(exits, [{ code: 0, signal: null }, { code: 0, signal: null }]);
    env.clean();
  });
});
