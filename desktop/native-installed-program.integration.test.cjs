"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { extractFile, uncache } = require("@electron/asar");
const fixture = require("../native/fixtures/installed-program-v1.json");
const binary = path.resolve("native/target/release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-installed-host-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^dsp-installed-host-test-[A-Za-z0-9]+$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function inspect(executable, cwd, args = ["inspect-program"]) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false,
      env: { ...process.env, DSP_NATIVE_INSTALLATION_ROOT: "Z:\\forged-installation", DSP_NATIVE_SOURCE_SHA: "f".repeat(40) },
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure;
    const stop = (reason) => { failure ??= new Error(reason); child.kill(); };
    const timer = setTimeout(() => stop("inspection deadline"), 15_000);
    child.once("spawn", () => {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
      catch { stop("inspection priority failed"); }
    });
    child.stdout.on("data", (data) => { stdout += data; if (stdout.length > 16 * 1024) stop("stdout limit"); });
    child.stderr.on("data", (data) => { stderr += data; if (stderr.length > 16 * 1024) stop("stderr limit"); });
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure); else resolve({ code, signal, stdout, stderr });
    });
  });
}

test("shared synthetic archive is accepted by the independent Electron ASAR reader", (t) => {
  const root = temporary(t); const file = path.join(root, "app.asar");
  const bytes = Buffer.from(fixture.asarHex, "hex"); fs.writeFileSync(file, bytes);
  assert.equal(sha(bytes), fixture.asarSha256);
  assert.deepEqual(JSON.parse(extractFile(file, "package.json")), fixture.packageInfo);
  assert.deepEqual(JSON.parse(extractFile(file, "dist/version.json")), fixture.renderer);
  uncache(file);
});

test("actual Host independently inspects its own installation without creating a save store", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  assert.ok(fs.existsSync(binary), "Build the actual release Host before its integration tests");
  const root = temporary(t); const resources = path.join(root, "resources");
  const native = path.join(resources, "native"); fs.mkdirSync(native, { recursive: true });
  const executable = path.join(native, "dsp-native-host.exe");
  fs.copyFileSync(binary, executable);
  fs.writeFileSync(path.join(resources, "app.asar"), Buffer.from(fixture.asarHex, "hex"));
  const unrelated = path.join(root, "unrelated-working-directory"); fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, "sentinel.txt"), "must remain unchanged");
  const expected = { ...fixture.program, hostSha256: sha(fs.readFileSync(executable)), asarSha256: fixture.asarSha256 };
  for (let round = 0; round < 2; round++) {
    const actual = await inspect(executable, unrelated);
    assert.equal(actual.code, 0, actual.stderr); assert.equal(actual.signal, null); assert.equal(actual.stderr, "");
    const receipt = JSON.parse(actual.stdout);
    assert.equal(JSON.stringify(receipt) + "\n", actual.stdout);
    assert.deepEqual(receipt, { authorityEligible: false, kind: "installed-program-identity-v1", program: expected, schemaVersion: 1 });
    assert.deepEqual(fs.readdirSync(unrelated), ["sentinel.txt"]);
    assert.equal(fs.readFileSync(path.join(unrelated, "sentinel.txt"), "utf8"), "must remain unchanged");
    assert.deepEqual(fs.readdirSync(resources).sort(), ["app.asar", "native"]);
    assert.deepEqual(fs.readdirSync(native), ["dsp-native-host.exe"]);
  }
  for (const args of [["inspect-program", "--root", unrelated], ["inspect-program", resources]]) {
    const actual = await inspect(executable, unrelated, args);
    assert.equal(actual.code, 1); assert.equal(actual.stdout, "");
    assert.match(actual.stderr, /^dsp-native-host: installed-program-rejected\r?\n$/);
  }
  // Ignored ASAR integrity fields must still be valid UTF-8. The main provider
  // reads valid ASAR metadata; a Rust skip-value parser must not accept bytes
  // that cannot represent the same JSON directory in Electron.
  const invalidUtf8 = Buffer.from(fixture.asarHex, "hex");
  const marker = Buffer.from('"algorithm":"SHA256"');
  const markerAt = invalidUtf8.indexOf(marker);
  assert.ok(markerAt >= 16 && markerAt < invalidUtf8.readUInt32LE(4) + 8);
  invalidUtf8[markerAt + '"algorithm":"'.length] = 0xff;
  fs.writeFileSync(path.join(resources, "app.asar"), invalidUtf8);
  const invalid = await inspect(executable, unrelated);
  assert.equal(invalid.code, 1, "malformed UTF-8 in an ignored header field must be rejected");
  assert.equal(invalid.stdout, "");
  fs.writeFileSync(path.join(resources, "app.asar"), "malformed archive");
  const bad = await inspect(executable, unrelated);
  assert.equal(bad.code, 1); assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /^dsp-native-host: installed-program-rejected\r?\n$/);
});

test("actual development Host refuses program inspection outside an installation", { timeout: 30_000 }, async (t) => {
  assert.ok(fs.existsSync(binary), "Build the actual release Host before its integration tests");
  const root = temporary(t); const result = await inspect(binary, root);
  assert.equal(result.code, 1); assert.equal(result.stdout, "");
  assert.match(result.stderr, /^dsp-native-host: installed-program-rejected\r?\n$/);
  assert.deepEqual(fs.readdirSync(root), []);
});
