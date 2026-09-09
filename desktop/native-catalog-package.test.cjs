"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { extractFile, uncache } = require("@electron/asar");
const { createCompletedAsar } = require("../tests/fixtures/complete-asar.cjs");
const { writeFixture } = require("../tests/fixtures/desktop-release.cjs");
const { EVIDENCE_FILE, CATALOG_VERIFIER, catalogVerifierBuildMetadata, verifyPackagedCatalogVerifier,
  writeDesktopBuildEvidence, verifyDesktopBuildEvidence } = require("./desktop-artifact-evidence.cjs");

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-catalog-package-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const value = await writeFixture(root);
  const asar = path.join(value.directory, "win-unpacked/resources/app.asar");
  const metadata = JSON.parse(extractFile(asar, "package.json"));
  return { ...value, root, asar, metadata };
}

test("new package evidence binds helper bytes to the identity embedded inside app.asar", async (t) => {
  const f = await fixture(t);
  const options = { expected: f.expected, identity: f.identity, release: true, requireCatalogVerifier: true };
  assert.equal(verifyDesktopBuildEvidence(f.directory, options).evidence.schemaVersion, 2);
  fs.appendFileSync(path.join(f.directory, CATALOG_VERIFIER), "tampered");
  assert.throws(() => verifyPackagedCatalogVerifier(f.directory, f.metadata), /embedded identity/);
  assert.throws(() => writeDesktopBuildEvidence(f.directory, options), /embedded identity/);
  assert.throws(() => verifyDesktopBuildEvidence(f.directory, options), /digest or size mismatch/);
});

test("new package writer refuses a missing helper or a helper from another build", async (t) => {
  const f = await fixture(t);
  const repository = path.join(f.root, "build-input");
  const native = path.join(repository, "native/target/release");
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, "dsp-native-host.exe"), "synthetic native host");
  fs.writeFileSync(path.join(native, "dsp-catalog-verifier.exe"), "different build");
  assert.match(catalogVerifierBuildMetadata(repository).nativeCatalogVerifierSha256, /^[a-f0-9]{64}$/);
  assert.throws(() => writeDesktopBuildEvidence(f.directory, { expected: f.expected, identity: f.identity,
    release: true, repositoryRoot: repository }), /this build's helper/);
  fs.unlinkSync(path.join(f.directory, CATALOG_VERIFIER));
  assert.throws(() => verifyPackagedCatalogVerifier(f.directory, f.metadata), /ENOENT/);
});

test("Cargo hardlinked build output is accepted while an installed hardlink remains rejected", async (t) => {
  const f = await fixture(t);
  const repository = path.join(f.root, "cargo-build");
  const native = path.join(repository, "native/target/release");
  fs.mkdirSync(path.join(native, "deps"), { recursive: true });
  const source = path.join(native, "dsp-catalog-verifier.exe");
  fs.copyFileSync(path.join(f.directory, CATALOG_VERIFIER), source);
  fs.linkSync(source, path.join(native, "deps/helper.exe"));
  assert.equal(fs.statSync(source).nlink, 2);
  assert.equal(catalogVerifierBuildMetadata(repository).nativeCatalogVerifierSha256, f.metadata.nativeCatalogVerifierSha256);
  fs.linkSync(path.join(f.directory, CATALOG_VERIFIER), path.join(f.root, "unexpected-installed-alias.exe"));
  assert.throws(() => verifyPackagedCatalogVerifier(f.directory, f.metadata), /single-link/);
});

test("legacy V1 artifacts remain readable but cannot satisfy a current helper requirement", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "asar-input-release");
  delete f.metadata.nativeCatalogVerifierSha256;
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify(f.metadata));
  await createCompletedAsar(source, f.asar);
  uncache(f.asar);
  fs.unlinkSync(path.join(f.directory, CATALOG_VERIFIER));
  const manifestPath = path.join(f.directory, EVIDENCE_FILE);
  const old = JSON.parse(fs.readFileSync(manifestPath));
  old.schemaVersion = 1;
  old.files = old.files.filter((file) => file.path !== CATALOG_VERIFIER);
  const asarRecord = old.files.find((file) => file.path.endsWith("/app.asar"));
  asarRecord.size = fs.statSync(f.asar).size;
  asarRecord.sha256 = require("./desktop-artifact-evidence.cjs").digestFile(f.asar);
  fs.writeFileSync(manifestPath, JSON.stringify(old));
  const options = { expected: f.expected, identity: f.identity, release: true };
  assert.equal(verifyDesktopBuildEvidence(f.directory, options).evidence.schemaVersion, 1);
  assert.throws(() => verifyDesktopBuildEvidence(f.directory, { ...options, requireCatalogVerifier: true }), /requires the catalog verifier/);
  assert.throws(() => writeDesktopBuildEvidence(f.directory, options), /Missing packaged catalog verifier identity/);
});
