"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createValidationSessionDirectory, createWindowsValidationSessionInspector } = require("./native-validation-session.cjs");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const host = path.resolve("native/target/release/dsp-native-host.exe");
const helper = path.resolve("native/target/release/dsp-catalog-verifier.exe");

function owned(t) {
  const session = createValidationSessionDirectory();
  t.after(() => {
    assert.equal(path.dirname(path.resolve(session.directory)), path.resolve(os.tmpdir()));
    assert.equal(path.basename(session.directory), "dspidle-rust-validation-" + session.sessionId);
    assert.ok(!fs.lstatSync(session.directory).isSymbolicLink());
    fs.rmSync(session.directory, { recursive: true, force: true });
  });
  return session;
}

function inspect(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure;
    const stop = (reason) => { failure ??= new Error(reason); child.kill(); };
    const timer = setTimeout(() => stop("inspection deadline"), 15000);
    child.once("spawn", () => { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { stop("priority failed"); } });
    child.stdout.on("data", b => { stdout += b; if (stdout.length > 2048) stop("output bound"); });
    child.stderr.on("data", b => { stderr += b; if (stderr.length > 2048) stop("error bound"); });
    child.once("error", error => { failure ??= error; });
    child.once("close", (code, signal) => { clearTimeout(timer); if (failure) reject(failure); else resolve({ code, signal, stdout, stderr }); });
  });
}

test("actual main helper and Host independently bind the same isolated directory and compiled fixture", { skip: process.platform !== "win32" }, async t => {
  assert.ok(fs.existsSync(host)); assert.ok(fs.existsSync(helper));
  const session = owned(t);
  const native = path.join(session.directory, "native"); fs.mkdirSync(native);
  fs.copyFileSync(helper, path.join(native, "dsp-catalog-verifier.exe"));
  const inspector = createWindowsValidationSessionInspector({ installationRoot: session.directory,
    executableSha256: sha(fs.readFileSync(helper)) });
  const main = await inspector.inspect(session.sessionId);
  const actual = await inspect(host, ["inspect-validation-session", session.sessionId]);
  assert.equal(actual.code, 0, actual.stderr); assert.equal(actual.signal, null);
  assert.deepEqual(JSON.parse(actual.stdout), main);
  assert.equal(main.session.fixtureSha256, sha(fs.readFileSync(path.join(session.directory, "fixture-v47.json"))));
  assert.equal(main.session.cloudWrites, false); assert.equal(main.authorityEligible, false);
  assert.deepEqual(fs.readdirSync(session.userDataPath), []);
  const old = main.session.profileId;
  fs.renameSync(session.userDataPath, path.join(session.directory, "old-profile"));
  fs.mkdirSync(session.userDataPath);
  const replaced = await inspector.inspect(session.sessionId);
  assert.notEqual(old, replaced.session.profileId);
  assert.deepEqual(JSON.parse((await inspect(host, ["inspect-validation-session", session.sessionId])).stdout), replaced);
  fs.appendFileSync(path.join(session.directory, "fixture-v47.json"), " ");
  await assert.rejects(inspector.inspect(session.sessionId));
  assert.notEqual((await inspect(host, ["inspect-validation-session", session.sessionId])).code, 0);
});

test("actual Host and helper reject ordinary paths, extra arguments and profile junctions", { skip: process.platform !== "win32" }, async t => {
  const session = owned(t);
  for (const executable of [host, helper]) {
    for (const args of [["inspect-validation-session", session.userDataPath],
      ["inspect-validation-session", session.sessionId, "--authority=true"],
      ["inspect-validation-session", session.sessionId + "\n"]]) {
      const result = await inspect(executable, args);
      assert.notEqual(result.code, 0); assert.equal(result.stdout, "");
    }
  }
  fs.renameSync(session.userDataPath, path.join(session.directory, "real-profile"));
  fs.symlinkSync(path.join(session.directory, "real-profile"), session.userDataPath, "junction");
  try {
    for (const executable of [host, helper]) {
      const result = await inspect(executable, ["inspect-validation-session", session.sessionId]);
      assert.notEqual(result.code, 0); assert.equal(result.stdout, "");
    }
  } finally { fs.unlinkSync(session.userDataPath); }
});
