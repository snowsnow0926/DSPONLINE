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
const sha = (b) => createHash("sha256").update(b).digest("hex");
const id = "ab".repeat(16);
const snapshot = () => ({ schemaVersion: 1, kind: "windows-validation-session-snapshot-v1", sessionId: id,
  session: { profileId: "cd".repeat(16), fixtureSha256: sha(fs.readFileSync(path.join(__dirname, "native-validation-fixture-v1.json"))), cloudWrites: false },
  authorityEligible: false, releaseAllowed: false });

function harness(t, respond, { neverClose = false, packaged = false } = {}) {
  const trace = { spawns: 0, kills: 0, priorities: 0 };
  const module = { exports: {} };
  const root = "C:\\validation-installation";
  const executable = root + "\\native\\dsp-catalog-verifier.exe";
  let child;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "native-validation-session.cjs"), "utf8"), {
    module, Buffer, TextDecoder, process: { platform: "win32", env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" } },
    __dirname: packaged ? root + "\\app.asar\\desktop" : __dirname,
    setTimeout: (f, delay) => setTimeout(f, Math.min(delay, 50)), clearTimeout,
    require(name) {
      if (name === "../package.json") return { nativeCatalogVerifierSha256: "ef".repeat(32) };
      if (name === "node:path") return path.win32;
      if (name === "node:fs") return { ...fs, statSync: () => ({ size: 10 }), readFileSync: () => Buffer.from("fixture-v1") };
      if (name === "./native-catalog-verifier.cjs") return { validateCatalogVerifierExecutable: (actualRoot, pin) => {
        assert.equal(actualRoot, root); assert.equal(pin, "ef".repeat(32)); return executable;
      } };
      if (name === "node:os") return { ...os, setPriority: () => { trace.priorities++; } };
      if (name === "node:child_process") return { spawn(program, args, options) {
        trace.spawns++; assert.equal(program, executable);
        assert.deepEqual(Array.from(args), ["inspect-validation-session", id]);
        assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
        assert.equal(options.stdio[0], "ignore");
        assert.deepEqual(Object.keys(options.env).sort(), ["SystemRoot", "TEMP", "TMP", "WINDIR"]);
        child = new EventEmitter(); child.pid = 123;
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        let closed = false;
        const close = (code = 0) => { if (!closed) { closed = true; child.emit("close", code, null); } };
        child.kill = () => { trace.kills++; if (!neverClose) queueMicrotask(() => close(1)); return !neverClose; };
        queueMicrotask(() => { child.emit("spawn"); respond?.({ child, close }); });
        return child;
      } };
      return require(name);
    },
  });
  t.after(() => { child?.stdout.destroy(); child?.stderr.destroy(); });
  return { ...module.exports, trace, policy: { installationRoot: root, executableSha256: "ef".repeat(32) } };
}
function response() { const value = snapshot(); value.session.fixtureSha256 = sha("fixture-v1"); return value; }

test("main independently accepts a bounded helper snapshot without granting authority", async (t) => {
  const h = harness(t, ({ child, close }) => { child.stdout.end(JSON.stringify(response()) + "\n"); close(); });
  const value = await h.createWindowsValidationSessionInspector(h.policy).inspect(id);
  assert.equal(value.session.profileId, response().session.profileId);
  assert.equal(value.authorityEligible, false); assert.equal(value.releaseAllowed, false);
  assert.ok(Object.isFrozen(value.session)); assert.equal(h.trace.priorities, 1);
});

for (const [name, mutate] of [
  ["different selector", v => { v.sessionId = "ef".repeat(16); }],
  ["different fixture", v => { v.session.fixtureSha256 = "ef".repeat(32); }],
  ["cloud permission", v => { v.session.cloudWrites = true; }],
  ["authority", v => { v.authorityEligible = true; }],
  ["release", v => { v.releaseAllowed = true; }],
  ["unknown field", v => { v.extra = true; }],
  ["trailing newline in ID", v => { v.session.profileId += "\n"; }],
  ["array ID coercion", v => { v.session.profileId = [v.session.profileId]; }],
]) test(`main rejects ${name}`, async (t) => {
  const h = harness(t, ({ child, close }) => { const v = response(); mutate(v); child.stdout.end(JSON.stringify(v) + "\n"); close(); });
  await assert.rejects(h.createWindowsValidationSessionInspector(h.policy).inspect(id), /response-rejected/);
});

test("main rejects duplicate JSON, invalid UTF-8, excess output and diagnostics", async (t) => {
  for (const data of [Buffer.from(JSON.stringify(response()).replace("{", '{"schemaVersion":1,') + "\n"),
    Buffer.from([0xff]), Buffer.alloc(2049)]) {
    const h = harness(t, ({ child, close }) => { child.stdout.end(data); close(); });
    await assert.rejects(h.createWindowsValidationSessionInspector(h.policy).inspect(id));
  }
  const h = harness(t, ({ child, close }) => { child.stderr.end("rejected"); close(); });
  await assert.rejects(h.createWindowsValidationSessionInspector(h.policy).inspect(id));
});

test("main rejects paths and suffixes before starting a process", async (t) => {
  const h = harness(t); const inspector = h.createWindowsValidationSessionInspector(h.policy);
  for (const bad of ["", "../profile", "C:\\profile", id + "\n", [id], id.toUpperCase()]) {
    await assert.rejects(inspector.inspect(bad), /id-rejected/);
  }
  assert.equal(h.trace.spawns, 0);
  assert.throws(() => h.createWindowsValidationSessionInspector({ ...h.policy, executableSha256: h.policy.executableSha256 + "\n" }));
});

test("main prevents concurrent inspection and poisons an unconfirmed termination", async (t) => {
  const h = harness(t, undefined, { neverClose: true });
  const inspector = h.createWindowsValidationSessionInspector(h.policy);
  const first = inspector.inspect(id);
  await assert.rejects(inspector.inspect(id), /helper-busy/);
  await assert.rejects(first, /termination-unconfirmed/);
  await assert.rejects(inspector.inspect(id), /helper-unavailable/);
  assert.equal(h.trace.spawns, 1); assert.equal(h.trace.kills, 1);
});

test("packaged inspector derives its own ASAR installation and embedded helper pin", async (t) => {
  const h = harness(t, ({ child, close }) => { child.stdout.end(JSON.stringify(response()) + "\n"); close(); }, { packaged: true });
  await h.createPackagedWindowsValidationSessionInspector().inspect(id);
  assert.equal(h.trace.spawns, 1);
  const workspace = harness(t);
  assert.throws(() => workspace.createPackagedWindowsValidationSessionInspector(), /requires-package/);
});
