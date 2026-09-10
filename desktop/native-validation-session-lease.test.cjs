"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createHash } = require("node:crypto");
const id = "ab".repeat(16), root = "C:\\validation-installation";
const snapshot = () => ({ schemaVersion: 1, kind: "windows-validation-session-snapshot-v1", sessionId: id,
  session: { profileId: "cd".repeat(16), fixtureSha256: createHash("sha256").update(fs.readFileSync(path.join(__dirname, "native-validation-fixture-v1.json"))).digest("hex"), cloudWrites: false },
  authorityEligible: false, releaseAllowed: false });
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(t, options = {}) {
  const module = { exports: {} }, timers = new Map(), trace = { spawns: 0, kills: 0, requests: [], children: [] };
  let timerId = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "native-validation-session-lease.cjs"), "utf8"), {
    module, Buffer, TextDecoder, AbortController, process: { platform: "win32", env: {} },
    __dirname: options.packaged ? root + "\\app.asar\\desktop" : __dirname,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: timer => timers.delete(timer),
    require(name) {
      if (name === "node:path") return path.win32;
      if (name === "../package.json") return { nativeCatalogVerifierSha256: "ef".repeat(32) };
      if (name === "./native-catalog-verifier.cjs") return { validateCatalogVerifierExecutable: (directory, digest) => {
        assert.equal(directory, root); assert.equal(digest, "ef".repeat(32)); return root + "\\native\\dsp-catalog-verifier.exe";
      } };
      if (name === "node:os") return { ...os, setPriority: () => { trace.priority = true; } };
      if (name === "node:child_process") return { spawn(executable, args, config) {
        trace.spawns++; assert.equal(executable, root + "\\native\\dsp-catalog-verifier.exe");
        assert.equal(args[0], "hold-validation-session"); assert.equal(args[1], id); assert.match(args[2], /^[a-f0-9]{64}$/);
        assert.equal(config.windowsHide, true); assert.equal(config.shell, false);
        assert.deepEqual(Object.keys(config.env).sort(), ["SystemRoot", "TEMP", "TMP", "WINDIR"]);
        const child = new EventEmitter(); child.pid = 123;
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        let closed = false;
        const close = (code = 0, signal = null) => { if (!closed) { closed = true; child.emit("close", code, signal); } };
        const emit = response => child.stdout.write(typeof response === "string" || Buffer.isBuffer(response) ? response : JSON.stringify(response) + "\n");
        const response = (event, sequence, challenge) => ({ schemaVersion: 1, kind: "windows-validation-session-lease-v1", event, sequence, challenge, snapshot: snapshot() });
        const context = { child, close, emit, response, challenge: args[2] };
        trace.children.push(context);
        child.kill = () => { trace.kills++; if (!options.neverClose) queueMicrotask(() => close(1)); return !options.neverClose; };
        child.stdin.on("data", bytes => queueMicrotask(() => {
          const request = JSON.parse(bytes); trace.requests.push(request);
          if (options.request) options.request(context, request);
          else { emit(response(request.command === "release" ? "released" : "live", request.sequence, request.challenge)); if (request.command === "release" && !options.delayClose) queueMicrotask(() => close()); }
        }));
        queueMicrotask(() => { child.emit("spawn"); if (options.ready) options.ready(context); else emit(response("ready", 0, args[2])); });
        return child;
      } };
      return require(name);
    },
  });
  t.after(() => { for (const c of trace.children) { c.close(1); c.child.stdin.destroy(); c.child.stdout.destroy(); c.child.stderr.destroy(); } });
  return { ...module.exports, trace, policy: { installationRoot: root, executableSha256: "ef".repeat(32) },
    tick(ms) { const found = [...timers].find(([, timer]) => timer.ms === ms); assert.ok(found, "expected timer " + ms); timers.delete(found[0]); found[1].fn(); } };
}

test("opaque lease keeps one helper, probes, heartbeats and waits for actual release close", async t => {
  const h = harness(t, { delayClose: true }); const broker = h.createWindowsValidationSessionLeaseBroker(h.policy);
  const token = await broker.acquire(id);
  assert.deepEqual(Object.keys(token), []); assert.ok(Object.isFrozen(token));
  await assert.rejects(broker.acquire(id), /helper-busy/);
  assert.deepEqual(await broker.probe(token), snapshot());
  h.tick(5000); await flush(); assert.equal(h.trace.requests.length, 2);
  let done = false; const released = broker.release(token).then(r => { done = true; return r; });
  await flush(); assert.equal(done, false, "a release ACK alone must not complete release");
  await assert.rejects(broker.probe(token), /not-live/);
  h.trace.children[0].close(); assert.equal((await released).released, true);
  assert.equal((await broker.closed(token)).released, true);
  await assert.rejects(broker.probe(token), /not-live/);
  const second = await broker.acquire(id); assert.notEqual(token, second);
  const releaseSecond = broker.release(second); await flush(); h.trace.children[1].close(); await releaseSecond;
  assert.equal(h.trace.priority, true); assert.equal(h.trace.kills, 0);
});

test("copied token, receipt, foreign broker and invalid selectors never acquire authority", async t => {
  const h = harness(t); const broker = h.createWindowsValidationSessionLeaseBroker(h.policy);
  for (const bad of ["../profile", id + "\n", [id], id.toUpperCase()]) await assert.rejects(broker.acquire(bad));
  const token = await broker.acquire(id);
  for (const bad of [{}, { ...token }, snapshot(), null]) await assert.rejects(broker.probe(bad), /token-rejected/);
  await assert.rejects(h.createWindowsValidationSessionLeaseBroker(h.policy).probe(token), /token-rejected/);
  await broker.release(token);
});

for (const [label, change] of [
  ["stale sequence", r => { r.sequence--; }], ["wrong challenge", r => { r.challenge = "aa".repeat(32); }],
  ["changed profile", r => { r.snapshot.session.profileId = "aa".repeat(16); }],
  ["authority", r => { r.snapshot.authorityEligible = true; }], ["unknown field", r => { r.extra = true; }],
]) test(`heartbeat rejects ${label} and makes the token unusable`, async t => {
  const h = harness(t, { request(c, request) { const r = c.response("live", request.sequence, request.challenge); change(r); c.emit(r); } });
  const broker = h.createWindowsValidationSessionLeaseBroker(h.policy), token = await broker.acquire(id);
  await assert.rejects(broker.probe(token), /response-rejected/);
  assert.equal((await broker.closed(token)).released, false);
  await assert.rejects(broker.probe(token), /not-live/);
});

test("ready rejection and unsolicited/partial/oversized output cannot leave a live token", async t => {
  const h = harness(t, { ready(c) { c.emit(c.response("ready", 0, "bad")); } });
  await assert.rejects(h.createWindowsValidationSessionLeaseBroker(h.policy).acquire(id), /response-rejected/);
  for (const data of ["partial", "{}\n", Buffer.alloc(2049), Buffer.from([0xff, 10])]) {
    const k = harness(t), broker = k.createWindowsValidationSessionLeaseBroker(k.policy), token = await broker.acquire(id);
    k.trace.children[0].emit(data);
    assert.equal((await broker.closed(token)).released, false);
    await assert.rejects(broker.probe(token));
  }
});

test("missing heartbeat ACK stops the lease, and unconfirmed termination poisons the broker", async t => {
  const h = harness(t, { request() {}, neverClose: true });
  const broker = h.createWindowsValidationSessionLeaseBroker(h.policy), token = await broker.acquire(id);
  const rejected = assert.rejects(broker.probe(token), /response-timeout/);
  h.tick(5000); await rejected; h.tick(2000);
  assert.equal((await broker.closed(token)).errorCode, "validation-lease-termination-unconfirmed");
  await assert.rejects(broker.acquire(id), /helper-unavailable/);
  assert.equal(h.trace.spawns, 1); assert.equal(h.trace.kills, 1);
});

test("unexpected process exit invalidates a pending request but permits a fresh confirmed acquisition", async t => {
  const h = harness(t, { request() {} }); const broker = h.createWindowsValidationSessionLeaseBroker(h.policy);
  const token = await broker.acquire(id), pending = assert.rejects(broker.probe(token), /lease-lost/);
  h.trace.children[0].close(1); await pending;
  assert.equal((await broker.closed(token)).released, false);
  const next = await broker.acquire(id); h.trace.children[1].close(1);
  assert.equal((await broker.closed(next)).released, false);
});

test("packaged broker derives its own installation, not an outer launcher resource root", async t => {
  const h = harness(t, { packaged: true }); const broker = h.createPackagedWindowsValidationSessionLeaseBroker();
  const token = await broker.acquire(id); await broker.release(token);
  assert.throws(() => harness(t).createPackagedWindowsValidationSessionLeaseBroker(), /requires-package/);
});

test("failed startup waits for confirmed termination or an explicit unconfirmed result", async t => {
  const h = harness(t, { ready() {}, neverClose: true });
  const broker = h.createWindowsValidationSessionLeaseBroker(h.policy);
  let result;
  const acquisition = broker.acquire(id).then(() => { result = "accepted"; }, error => { result = error.code; });
  h.tick(15000); await flush();
  assert.equal(result, undefined, "startup must not return before helper termination is confirmed or declared unconfirmed");
  h.tick(2000); await acquisition;
  assert.equal(result, "validation-lease-termination-unconfirmed");
  await assert.rejects(broker.acquire(id), /helper-unavailable/);

  const confirmed = harness(t, { ready() {} }), retry = confirmed.createWindowsValidationSessionLeaseBroker(confirmed.policy);
  const failed = assert.rejects(retry.acquire(id), /start-timeout/);
  confirmed.tick(15000); await failed;
  assert.equal(confirmed.trace.kills, 1);
});

test("valid ready followed by malformed output in one callback cannot return a dead token", async t => {
  const h = harness(t, { ready(c) { c.emit(JSON.stringify(c.response("ready", 0, c.challenge)) + "\npartial"); }, neverClose: true });
  const broker = h.createWindowsValidationSessionLeaseBroker(h.policy);
  let result;
  const acquisition = broker.acquire(id).then(() => { result = "accepted"; }, error => { result = error.code; });
  await flush(); assert.equal(result, undefined);
  h.tick(2000); await acquisition;
  assert.equal(result, "validation-lease-termination-unconfirmed");
});

test("valid probe followed by malformed output in one callback cannot return a live snapshot", async t => {
  const h = harness(t, { request(c, request) { c.emit(JSON.stringify(c.response("live", request.sequence, request.challenge)) + "\n{}\n"); } });
  const broker = h.createWindowsValidationSessionLeaseBroker(h.policy), token = await broker.acquire(id);
  await assert.rejects(broker.probe(token), /response-rejected/);
  assert.equal((await broker.closed(token)).released, false);
});

test("release ACK without process close cannot be accepted as successful release", async t => {
  const h = harness(t, { delayClose: true, neverClose: true });
  const broker = h.createWindowsValidationSessionLeaseBroker(h.policy), token = await broker.acquire(id);
  const rejected = assert.rejects(broker.release(token), /termination-unconfirmed/);
  await flush(); h.tick(5000); h.tick(2000); await rejected;
  await assert.rejects(broker.acquire(id), /helper-unavailable/);
});

test("lifetime signal aborts immediately on lost output while helper close is still unconfirmed", async t => {
  const h = harness(t, { neverClose: true }), broker = h.createWindowsValidationSessionLeaseBroker(h.policy);
  const token = await broker.acquire(id), signal = broker.signal(token);
  assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false);
  assert.equal(broker.signal(token), signal); assert.throws(() => broker.signal({}), /token-rejected/);
  h.trace.children[0].emit("partial"); assert.equal(signal.aborted, true);
  let closed = false; const completion = broker.closed(token).then(() => { closed = true; });
  await flush(); assert.equal(closed, false); h.tick(2000); await completion;
  assert.equal(signal.aborted, true);
});

test("release ends lifetime before ACK and a reentrant probe cannot displace the release", async t => {
  const h = harness(t, { delayClose: true }), broker = h.createWindowsValidationSessionLeaseBroker(h.policy);
  const token = await broker.acquire(id), signal = broker.signal(token);
  let probeRejected;
  signal.addEventListener("abort", () => { probeRejected = assert.rejects(broker.probe(token), /not-live/); }, { once: true });
  const releasing = broker.release(token); assert.equal(signal.aborted, true);
  await probeRejected; await flush();
  assert.deepEqual(h.trace.requests.map(r => r.command), ["release"]);
  h.trace.children[0].close(); await releasing;
  const fresh = await broker.acquire(id); assert.equal(broker.signal(fresh).aborted, false); assert.equal(signal.aborted, true);
  const finish = broker.release(fresh); await flush(); h.trace.children[1].close(); await finish;
});
