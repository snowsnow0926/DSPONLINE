"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { collectBuiltinCatalogIdentity } = require("./native-builtin-catalog.cjs");
const binary = path.resolve("native/target/release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");

function inspect(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DSP_NATIVE_CATALOG_SHA256: "f".repeat(64), DSP_NATIVE_REGISTRY_FINGERPRINT: "forged" } });
    let stdout = "", stderr = "", failure;
    const stop = reason => { failure ??= new Error(reason); child.kill(); };
    const timer = setTimeout(() => stop("builtin catalog inspection deadline"), 15_000);
    child.once("spawn", () => { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
      catch { stop("priority unavailable"); } });
    child.once("error", error => { failure ??= error; });
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 4096) stop("stdout limit"); });
    child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 4096) stop("stderr limit"); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure); else resolve({ code, signal, stdout, stderr });
    });
  });
}

test("actual Host compiled directory agrees with main and ignores working directory and environment", { timeout: 60_000 }, async t => {
  assert.ok(fs.existsSync(binary), "Build the actual release Host before integration tests");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-builtin-catalog-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^dsp-builtin-catalog-[A-Za-z0-9]+$/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(directory, "native-builtin-catalog-v1.json"), "forged");
  const result = await inspect(directory, ["inspect-builtin-catalog"]);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null); assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, kind: "builtin-catalog-identity-v1",
    content: collectBuiltinCatalogIdentity(), authorityEligible: false });
  const rejected = await inspect(directory, ["inspect-builtin-catalog", "--root", directory]);
  assert.equal(rejected.code, 1); assert.equal(rejected.signal, null); assert.equal(rejected.stdout, "");
  assert.equal(rejected.stderr.trim(), "dsp-native-host: builtin-catalog-arguments");
  assert.deepEqual(fs.readdirSync(directory), ["native-builtin-catalog-v1.json"]);
  assert.equal(fs.readFileSync(path.join(directory, "native-builtin-catalog-v1.json"), "utf8"), "forged");
});
