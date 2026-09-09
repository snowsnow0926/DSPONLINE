"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createWindowsCatalogVerifier } = require("./native-catalog-verifier.cjs");
const source = path.resolve("native/target/release/dsp-catalog-verifier.exe");
const windows = { skip: process.platform !== "win32" };

test("actual readonly helper rejects missing carrier through the main adapter", windows, async (t) => {
  assert.ok(fs.existsSync(source), "Build the normal release helper before Windows Native tests");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-catalog-helper-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "native"));
  fs.copyFileSync(source, path.join(root, "native", "dsp-catalog-verifier.exe"));
  const verifier = createWindowsCatalogVerifier({ installationRoot: root,
    executableSha256: createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
    publisherCertificateSha256: ["ab".repeat(32)] });
  await assert.rejects(verifier.authenticate(), /carrier-io/);
  // Completion includes actual helper exit, so its executable is no longer held.
  fs.renameSync(path.join(root, "native"), path.join(root, "released-native"));
});

test("actual helper rejects malformed, duplicate and oversized stdin without echoing it", windows, () => {
  assert.ok(fs.existsSync(source));
  for (const input of ["sensitive-invalid-input", " ".repeat(16 * 1024 + 1),
    JSON.stringify({ schemaVersion: 1, requestId: "ab".repeat(32), installationRoot: os.tmpdir(),
      publisherCertificateSha256: ["cd".repeat(32)] }).replace('{', '{"schemaVersion":1,')]) {
    const result = spawnSync(source, [], { input, encoding: "utf8", windowsHide: true, shell: false,
      timeout: 10_000, maxBuffer: 16 * 1024 });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "CATALOG_VERIFIER_REQUEST_REJECTED");
  }
});
