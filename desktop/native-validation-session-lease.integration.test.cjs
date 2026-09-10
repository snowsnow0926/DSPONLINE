"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const { createValidationSessionDirectory } = require("./native-validation-session.cjs");
const { createWindowsValidationSessionLeaseBroker } = require("./native-validation-session-lease.cjs");
const host = path.resolve("native/target/release/dsp-native-host.exe");
const helper = path.resolve("native/target/release/dsp-catalog-verifier.exe");
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function scope(t) {
  const session = createValidationSessionDirectory(), cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    assert.equal(path.dirname(path.resolve(session.directory)), path.resolve(os.tmpdir()));
    assert.equal(path.basename(session.directory), "dspidle-rust-validation-" + session.sessionId);
    assert.equal(fs.lstatSync(session.directory).isSymbolicLink(), false);
    fs.rmSync(session.directory, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(session.directory, "native"));
  fs.copyFileSync(helper, path.join(session.directory, "native", "dsp-catalog-verifier.exe"));
  return { ...session, cleanup, broker: createWindowsValidationSessionLeaseBroker({ installationRoot: session.directory, executableSha256: sha(helper) }) };
}

function startRaw(session, executable = host) {
  const challenge = randomBytes(32).toString("hex");
  const child = spawn(executable, ["hold-validation-session", session.sessionId, challenge],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", stderr = "", total = 0, waiting, terminal = false, failure;
  const messages = [];
  const next = () => {
    if (messages.length) return Promise.resolve(messages.shift());
    if (terminal) return Promise.reject(new Error("lease already closed"));
    return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
  };
  const done = new Promise(resolve => child.once("close", (code, signal) => {
    terminal = true; waiting?.reject(new Error("lease closed before response")); waiting = undefined;
    resolve({ code, signal, stderr, failure });
  }));
  child.once("spawn", () => { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { failure = "priority"; child.kill(); } });
  child.once("error", () => { failure = "spawn"; });
  child.stdin.on("error", () => { failure = "input"; });
  child.stdout.on("data", bytes => {
    total += bytes.length;
    if (total > 16 * 1024) { failure = "output bound"; child.kill(); return; }
    output += bytes.toString("utf8");
    for (let end; (end = output.indexOf("\n")) >= 0;) {
      const line = output.slice(0, end); output = output.slice(end + 1);
      const message = JSON.parse(line);
      if (waiting) { const current = waiting; waiting = undefined; current.resolve(message); } else messages.push(message);
    }
  });
  child.stderr.on("data", bytes => { stderr += bytes; if (stderr.length > 2048) { failure = "diagnostic bound"; child.kill(); } });
  const deadline = setTimeout(() => { failure = "process deadline"; child.kill(); }, 25000);
  done.then(() => clearTimeout(deadline));
  session.cleanup.push(async () => { if (!terminal) child.stdin.end(); const result = await done; assert.notEqual(result.failure, "process deadline"); });
  let sequence = 0;
  return { child, done, challenge, ready: next(), next,
    async request(command) {
      const request = { schemaVersion: 1, sequence: ++sequence, challenge: randomBytes(32).toString("hex"), command };
      const response = next(); child.stdin.write(JSON.stringify(request) + "\n");
      const result = await response; assert.equal(result.sequence, request.sequence); assert.equal(result.challenge, request.challenge);
      return result;
    } };
}

function assertLocked(session) {
  assert.throws(() => fs.renameSync(session.userDataPath, path.join(session.directory, "moved")));
  assert.throws(() => fs.writeFileSync(path.join(session.directory, "fixture-v47.json"), "replacement"));
}

test("actual independent main/Host leases keep identity pinned until both processes release", { skip: process.platform !== "win32" }, async t => {
  const s = scope(t); let token = await s.broker.acquire(s.sessionId);
  s.cleanup.push(async () => { await s.broker.release(token).catch(() => {}); await s.broker.closed(token); });
  const raw = startRaw(s), ready = await raw.ready;
  assert.equal(ready.event, "ready"); assert.equal(ready.challenge, raw.challenge);
  const first = await s.broker.probe(token);
  assert.deepEqual(ready.snapshot, first); assertLocked(s);
  fs.writeFileSync(path.join(s.userDataPath, "synthetic-progress"), "test");
  assert.deepEqual((await raw.request("probe")).snapshot, first);
  assert.equal((await s.broker.release(token)).released, true); assertLocked(s);
  assert.equal((await raw.request("release")).event, "released");
  const result = await raw.done; assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.stderr, ""); assert.equal(result.failure, undefined);
  fs.renameSync(s.userDataPath, path.join(s.directory, "old-profile")); fs.mkdirSync(s.userDataPath);
  token = await s.broker.acquire(s.sessionId);
  assert.notEqual((await s.broker.probe(token)).session.profileId, first.session.profileId);
  await s.broker.release(token);
});

test("actual parent pipe loss and abrupt process death release the directory without accepting old credentials", { skip: process.platform !== "win32" }, async t => {
  const s = scope(t);
  for (const mode of ["eof", "kill"]) {
    const raw = startRaw(s, helper); await raw.ready; assertLocked(s);
    if (mode === "eof") raw.child.stdin.end(); else raw.child.kill();
    const result = await raw.done; assert.notEqual(result.code, 0); assert.equal(result.failure, undefined);
    fs.renameSync(s.userDataPath, path.join(s.directory, "moved")); fs.renameSync(path.join(s.directory, "moved"), s.userDataPath);
  }
});

test("actual idle deadline expires while the parent pipe remains open", { skip: process.platform !== "win32" }, async t => {
  const s = scope(t), started = performance.now(), raw = startRaw(s);
  await raw.ready; assertLocked(s);
  const result = await raw.done;
  assert.notEqual(result.code, 0); assert.equal(result.failure, undefined);
  assert.ok(performance.now() - started >= 15000, "must actually exercise the unmodified 15-second idle deadline");
  assert.equal(raw.child.stdin.writableEnded, false);
  assert.equal(result.stderr.trim(), "dsp-native-host: validation-session-lease-rejected");
  fs.renameSync(s.userDataPath, path.join(s.directory, "moved"));
});

test("actual main heartbeat renews the held session beyond the unchanged Native idle deadline", { skip: process.platform !== "win32" }, async t => {
  const s = scope(t), token = await s.broker.acquire(s.sessionId), started = performance.now();
  s.cleanup.push(async () => { await s.broker.release(token).catch(() => {}); await s.broker.closed(token); });
  const before = await s.broker.probe(token);
  // No manual renewal during this interval: the broker's real 5-second timer
  // must keep the actual helper alive past its real 15-second idle deadline.
  await new Promise(resolve => setTimeout(resolve, 17000));
  assert.ok(performance.now() - started >= 17000);
  assert.deepEqual(await s.broker.probe(token), before); assertLocked(s);
  assert.equal((await s.broker.release(token)).released, true);
  fs.renameSync(s.userDataPath, path.join(s.directory, "moved"));
});

test("actual held session rejects replayed sequence and malformed control without changing fixture", { skip: process.platform !== "win32" }, async t => {
  const s = scope(t), file = path.join(s.directory, "fixture-v47.json"), before = sha(file);
  for (const control of ["replay", "unknown", "oversize"]) {
    const raw = startRaw(s); await raw.ready;
    await raw.request("probe");
    raw.child.stdin.write(control === "replay" ? JSON.stringify({ schemaVersion: 1, sequence: 1, challenge: "aa".repeat(32), command: "probe" }) + "\n"
      : control === "unknown" ? '{"authorityEligible":true}\n' : " ".repeat(257));
    const result = await raw.done; assert.notEqual(result.code, 0); assert.equal(result.failure, undefined);
    assert.equal(sha(file), before);
  }
});
