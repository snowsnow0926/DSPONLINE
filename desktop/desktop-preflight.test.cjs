"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { preflight } = require("../scripts/desktop-package-preflight.cjs");
const { context, writeFixture } = require("../tests/fixtures/desktop-release.cjs");
const { PERFORMANCE_EDITION_IDENTITY } = require("./performance-edition-identity.cjs");
const { writeDesktopBuildEvidence } = require("./desktop-artifact-evidence.cjs");
const { localResource } = require("./isolated-test-network.cjs");

test("missing package is BLOCKED and real package identity checks gate the driver", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected = context(PERFORMANCE_EDITION_IDENTITY);
  assert.throws(() => preflight(root, { expected }), /BLOCKED/);
  const fixture = await writeFixture(root, "release-performance-edition");
  writeDesktopBuildEvidence(fixture.directory, { expected, identity: PERFORMANCE_EDITION_IDENTITY });
  assert.equal(preflight(root, { expected }).expected.buildId, expected.buildId);
  assert.throws(() => preflight(root, { expected: { ...expected, sourceSha: "b".repeat(40), buildId: `1.2.7+${"b".repeat(12)}` } }));
  fs.appendFileSync(path.join(fixture.directory, "win-unpacked/resources/app.asar"), "wrong application bytes");
  assert.throws(() => preflight(root, { expected }), /digest|size/);
});

test("network allowlist accepts packaged resources and loopback, rejects remote and deceptive hosts", () => {
  for (const url of ["file:///C:/test/app.asar/dist/index.html", "data:text/plain,fixture", "http://127.0.0.1:4318/", "http://[::1]/", "http://localhost/"]) assert.equal(localResource(url), true, url);
  for (const url of ["https://example.test/", "https://localhost.example.test/", "http://127.0.0.1@example.test/", "http://192.168.1.1/", "ftp://localhost/", "invalid"]) assert.equal(localResource(url), false, url);
});
