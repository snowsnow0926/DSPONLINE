"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { STABLE_IDENTITY, selectCompleteDesktopReleaseOutput } = require("./performance-edition-identity.cjs");
const { writeFixture, context } = require("../tests/fixtures/desktop-release.cjs");
const { verifyDesktopBuildEvidence, EVIDENCE_FILE } = require("./desktop-artifact-evidence.cjs");
const { selectDesktopReleaseOutputFromEnvironment } = require("./select-desktop-release-output.cjs");

const version = require("../package.json").version;
const expected = Object.freeze({ version, sourceSha: "a".repeat(40), buildId: `${version}+${"a".repeat(12)}`, editionId: "stable-v1", channel: "stable" });

for (const kind of ["empty", "malformed", "stale", "foreign-edition"]) {
  test(`release collection rejects ${kind} manifests without an installer`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-round3-release-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const output = path.join(root, "release");
    const feed = path.join(output, "update-feed/desktop/stable");
    fs.mkdirSync(feed, { recursive: true });
    fs.writeFileSync(path.join(output, "latest.yml"), kind === "empty" ? "" : kind === "malformed" ? "broken: [" : "version: 0.0.1\npath: missing.exe\n");
    fs.writeFileSync(path.join(feed, "release.json"), kind === "empty" ? "" : kind === "malformed" ? "invalid json" : JSON.stringify({ version: "0.0.1", editionId: "windows-performance-development-v1", files: [] }));
    assert.throws(() => selectCompleteDesktopReleaseOutput({ repositoryRoot: root, identity: STABLE_IDENTITY, channel: "stable", expected }));
  });
}

test("real generated feed, ASAR identity and complete hashes pass the collection entry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-release-positive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await writeFixture(root);
  assert.equal(selectDesktopReleaseOutputFromEnvironment({ repositoryRoot: root, environment: {}, expected }).relativeOutputDirectory, "release");
  assert.equal(verifyDesktopBuildEvidence(path.join(root, "release"), { expected, identity: STABLE_IDENTITY, release: true }).evidence.sourceSha, expected.sourceSha);
});

for (const mutation of ["empty-yaml", "bad-yaml", "bad-json", "missing-installer", "wrong-digest", "old-version", "wrong-source", "wrong-edition", "wrong-channel", "escape", "asar-tamper", "host-tamper", "extra-installer"]) {
  test(`complete release rejects ${mutation}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-release-negative-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await writeFixture(root);
    const evidencePath = path.join(fixture.directory, EVIDENCE_FILE);
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    if (mutation === "empty-yaml") fs.writeFileSync(path.join(fixture.directory, "latest.yml"), "");
    if (mutation === "bad-yaml") fs.writeFileSync(path.join(fixture.directory, "latest.yml"), "broken: [");
    if (mutation === "bad-json") fs.writeFileSync(path.join(fixture.directory, "update-feed/desktop/stable/release.json"), "not-json");
    if (mutation === "missing-installer") fs.unlinkSync(fixture.installer);
    if (mutation === "wrong-digest") fs.writeFileSync(fixture.installer, "wrong bytes");
    if (mutation === "old-version") evidence.version = "0.0.1";
    if (mutation === "wrong-source") evidence.sourceSha = "b".repeat(40);
    if (mutation === "wrong-edition") evidence.editionId = "windows-performance-development-v1";
    if (mutation === "wrong-channel") evidence.channel = "beta";
    if (mutation === "escape") evidence.files[0].path = "../escaped.exe";
    if (mutation === "asar-tamper") fs.appendFileSync(path.join(fixture.directory, "win-unpacked/resources/app.asar"), "tampered");
    if (mutation === "host-tamper") fs.appendFileSync(path.join(fixture.directory, "win-unpacked/resources/native/dsp-native-host.exe"), "tampered");
    if (mutation === "extra-installer") fs.writeFileSync(path.join(fixture.directory, "old-installer.exe"), "old");
    fs.writeFileSync(evidencePath, JSON.stringify(evidence));
    assert.throws(() => selectCompleteDesktopReleaseOutput({ repositoryRoot: root, identity: STABLE_IDENTITY, channel: "stable", expected }));
  });
}

test("two valid outputs fail; a damaged candidate is never silently ignored", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-release-ambiguous-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await writeFixture(root);
  await writeFixture(root, "release-fallback");
  const select = () => selectCompleteDesktopReleaseOutput({ repositoryRoot: root, identity: STABLE_IDENTITY, channel: "stable", expected });
  assert.throws(select, /found 2/);
  fs.writeFileSync(path.join(root, "release-fallback/latest.yml"), "");
  assert.throws(select);
});

test("manifest file junctions are rejected before content reads", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-release-redirect-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = await writeFixture(root);
  const nativePath = path.join(fixture.directory, "win-unpacked/resources/native");
  const retainedPath = path.join(root, "native-target");
  fs.renameSync(nativePath, retainedPath);
  fs.symlinkSync(retainedPath, nativePath, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => verifyDesktopBuildEvidence(fixture.directory, { expected, identity: STABLE_IDENTITY, release: true }), /symlink|reparse/);
});
