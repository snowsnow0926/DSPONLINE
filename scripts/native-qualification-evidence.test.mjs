import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { auditNativeQualificationEvidence, QUALIFICATION_CHECKS, QUALIFICATION_SCOPE } from "./native-qualification-evidence.mjs";

const NOW = 1_788_930_000_000;
const CANDIDATE = Object.freeze({
  version: "1.2.7", sourceSha: "a".repeat(40), buildId: `1.2.7+${"a".repeat(12)}`,
  editionId: "windows-performance-development-v1", channel: "beta", platform: "win32", arch: "x64",
  hostSha256: "b".repeat(64), asarSha256: "c".repeat(64), catalogSha256: "d".repeat(64),
  rulesSha256: "e".repeat(64), matrixSha256: "f".repeat(64),
});
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function fixture(t, { mutateReport = () => {}, mutateManifest = () => {}, nowMs = NOW } = {}) {
  const parent = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, "dsp-qualification-test-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("dsp-qualification-test-")) {
      throw new Error("Test cleanup escaped its owned temporary directory");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const manifest = {
    schemaVersion: 1, kind: "native-qualification-evidence-v1", scope: QUALIFICATION_SCOPE,
    evidenceClass: "TEST_ONLY", candidate: { ...CANDIDATE }, issuedAtMs: nowMs - 50,
    expiresAtMs: nowMs + 60_000, checks: [],
  };
  for (const [index, id] of QUALIFICATION_CHECKS.entries()) {
    const report = {
      schemaVersion: 1, kind: "native-qualification-check-v1", scope: QUALIFICATION_SCOPE,
      evidenceClass: "TEST_ONLY", candidate: { ...CANDIDATE }, checkId: id, execution: "rust-test-host",
      startedAtMs: nowMs - 1000, finishedAtMs: nowMs - 100, fixtureSha256: "1".repeat(64),
      result: "PASS", tests: { passed: 1, failed: 0, skipped: 0, flaky: 0 },
    };
    if (index === 0) mutateReport(report);
    const text = JSON.stringify(report);
    fs.writeFileSync(path.join(directory, `${id}.json`), text, { flag: "wx" });
    manifest.checks.push({ id, report: { path: `${id}.json`, size: Buffer.byteLength(text), sha256: sha256(text) } });
  }
  mutateManifest(manifest);
  fs.writeFileSync(path.join(directory, "qualification-evidence.json"), JSON.stringify(manifest), { flag: "wx" });
  fs.writeFileSync(path.join(directory, "candidate.json"), JSON.stringify(CANDIDATE), { flag: "wx" });
  return { directory, manifest, run: (overrides = {}) => auditNativeQualificationEvidence({ directory, candidate: CANDIDATE, nowMs, ...overrides }) };
}

test("complete test evidence is checked without granting producer trust, authority or release", (t) => {
  const { run } = fixture(t);
  const result = run();
  assert.equal(result.status, "CONSISTENT");
  assert.equal(result.evidenceClass, "TEST_ONLY");
  assert.equal(result.producerAuthenticated, false);
  assert.equal(result.authorityEligible, false);
  assert.equal(result.releaseAllowed, false);
  assert.equal(result.checks.length, QUALIFICATION_CHECKS.length);
  result.candidate.hostSha256 = "0".repeat(64);
  assert.equal(CANDIDATE.hostSha256, "b".repeat(64));
});

for (const key of ["hostSha256", "asarSha256", "catalogSha256", "rulesSha256", "matrixSha256"]) {
  test(`reports from a different ${key} cannot reuse a passing manifest`, (t) => {
    const { run } = fixture(t, { mutateReport: (r) => { r.candidate[key] = "0".repeat(64); } });
    assert.throws(run, { code: "candidate-mismatch" });
  });
}

const invalidManifests = [
  ["old source/build", (m) => { m.candidate.sourceSha = "0".repeat(40); m.candidate.buildId = `1.2.7+${"0".repeat(12)}`; }, "candidate-mismatch"],
  ["dirty build", (m) => { m.candidate.buildId += ".dirty"; }, "candidate-identity"],
  ["wrong channel", (m) => { m.candidate.channel = "stable"; }, "candidate-identity"],
  ["wrong platform", (m) => { m.candidate.platform = "linux"; }, "candidate-identity"],
  ["missing identity", (m) => { delete m.candidate.hostSha256; }, "candidate-shape"],
  ["coercible identity", (m) => { m.candidate.version = ["1.2.7"]; }, "candidate-identity"],
  ["test evidence relabeled as release", (m) => { m.evidenceClass = "RELEASE"; }, "manifest-contract"],
  ["broader mode", (m) => { m.scope = "windows-speedrun"; }, "manifest-contract"],
  ["future schema", (m) => { m.schemaVersion = 2; }, "manifest-contract"],
  ["injected authority", (m) => { m.authorityEligible = true; }, "manifest-shape"],
  ["future issuance", (m) => { m.issuedAtMs = NOW + 1; }, "evidence-validity"],
  ["expiry equality", (m) => { m.expiresAtMs = NOW; }, "evidence-validity"],
  ["unbounded validity", (m) => { m.expiresAtMs = NOW + 8 * 24 * 60 * 60 * 1000; }, "evidence-validity"],
  ["missing check", (m) => { m.checks.pop(); }, "checks-incomplete"],
  ["duplicate check", (m) => { m.checks[1].id = m.checks[0].id; }, "check-id"],
  ["unknown check", (m) => { m.checks[0].id = "coverage-implemented"; }, "check-id"],
  ["reused report", (m) => { m.checks[1].report = { ...m.checks[0].report }; }, "report-reused"],
  ["wrong digest", (m) => { m.checks[0].report.sha256 = "0".repeat(64); }, "evidence-digest"],
  ["wrong size", (m) => { m.checks[0].report.size += 1; }, "evidence-digest"],
  ["oversized record", (m) => { m.checks[0].report.size = 256 * 1024 + 1; }, "report-reference"],
  ["path traversal", (m) => { m.checks[0].report.path = "../player-save.json"; }, "evidence-path"],
  ["absolute path", (m) => { m.checks[0].report.path = "C:/private/save.json"; }, "evidence-path"],
];
for (const [name, mutateManifest, code] of invalidManifests) {
  test(`rejects ${name}`, (t) => assert.throws(fixture(t, { mutateManifest }).run, { code }));
}

const invalidReports = [
  ["JavaScript fallback", (r) => { r.execution = "js"; }, "native-not-executed"],
  ["mixed backend", (r) => { r.execution = "mixed"; }, "native-not-executed"],
  ["failed assertions", (r) => { r.tests.failed = 1; }, "check-not-passed"],
  ["skipped checks", (r) => { r.tests.skipped = 1; }, "check-not-passed"],
  ["retry-only success", (r) => { r.tests.flaky = 1; }, "check-not-passed"],
  ["zero tests", (r) => { r.tests.passed = 0; }, "check-not-passed"],
  ["negative count", (r) => { r.tests.failed = -1; }, "check-not-passed"],
  ["fractional count", (r) => { r.tests.passed = 1.5; }, "check-not-passed"],
  ["string count", (r) => { r.tests.passed = "1"; }, "check-not-passed"],
  ["failed result", (r) => { r.result = "FAIL"; }, "check-not-passed"],
  ["not run result", (r) => { r.result = "NOT_RUN"; }, "check-not-passed"],
  ["absent test accounting", (r) => { delete r.tests.skipped; }, "test-counts"],
  ["wrong report ID", (r) => { r.checkId = "first-tick"; }, "report-contract"],
  ["release report in test bundle", (r) => { r.evidenceClass = "RELEASE"; }, "report-contract"],
  ["report after manifest", (r) => { r.finishedAtMs = NOW; }, "report-time"],
  ["reversed report time", (r) => { r.startedAtMs = r.finishedAtMs + 1; }, "report-time"],
  ["stale measurement", (r) => { r.startedAtMs = NOW - 8 * 24 * 60 * 60 * 1000; }, "report-time"],
  ["no fixture identity", (r) => { r.fixtureSha256 = ""; }, "fixture-identity"],
];
for (const [name, mutateReport, code] of invalidReports) {
  test(`rejects ${name}`, (t) => assert.throws(fixture(t, { mutateReport }).run, { code }));
}

test("revoked report is rejected even when all files still match", (t) => {
  const { run, manifest } = fixture(t);
  assert.throws(() => run({ revokedReportSha256: [manifest.checks[0].report.sha256] }), { code: "report-revoked" });
  assert.throws(() => run({ revokedReportSha256: ["invalid"] }), { code: "revocations-invalid" });
  assert.throws(() => run({ nowMs: Number.NaN }), { code: "clock-invalid" });
});

test("a report edited after hashing cannot pass", (t) => {
  const { directory, run } = fixture(t);
  const target = path.join(directory, "single-owner.json");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("rust-test-host", "rust-fake-host"));
  assert.throws(run, { code: "evidence-digest" });
});

test("hash verification and result parsing use the same bytes when a report changes during reading", (t) => {
  const { directory, run } = fixture(t, { mutateReport: (r) => { r.tests.failed = 1; } });
  const target = path.join(directory, "single-owner.json");
  const replacement = fs.readFileSync(target, "utf8").replace('"failed":1', '"failed":0');
  const open = fs.openSync;
  const read = fs.readSync;
  let watchedDescriptor;
  let rewritten = false;
  t.mock.method(fs, "openSync", (...args) => {
    const descriptor = open(...args);
    if (args[0] === target && args[1] === "r") watchedDescriptor = descriptor;
    return descriptor;
  });
  t.mock.method(fs, "readSync", (...args) => {
    const length = read(...args);
    if (args[0] === watchedDescriptor && length > 0 && !rewritten) {
      rewritten = true;
      fs.writeFileSync(target, replacement);
    }
    return length;
  });
  assert.throws(run, { code: "check-not-passed" });
  assert.equal(rewritten, true);
});

test("missing and oversized metadata are rejected without printing their content", (t) => {
  const { directory, run } = fixture(t);
  fs.unlinkSync(path.join(directory, "single-owner.json"));
  assert.throws(run, { code: "evidence-path" });
  fs.writeFileSync(path.join(directory, "qualification-evidence.json"), "private-content".repeat(30_000));
  assert.throws(run, { code: "evidence-size" });
});

test("a junction/symlink cannot supply a report directory", (t) => {
  const { directory, run } = fixture(t, { mutateManifest: (m) => { m.checks[0].report.path = "linked/single-owner.json"; } });
  const target = path.join(directory, "direct");
  fs.mkdirSync(target);
  fs.copyFileSync(path.join(directory, "single-owner.json"), path.join(target, "single-owner.json"));
  fs.symlinkSync(target, path.join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(run, { code: "evidence-path" });
});

test("malformed UTF-8 is rejected even when it could decode to replacement characters", (t) => {
  const { directory, run } = fixture(t);
  const manifest = fs.readFileSync(path.join(directory, "qualification-evidence.json"));
  const value = Buffer.concat([manifest.subarray(0, manifest.length - 1), Buffer.from(',"extra":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  fs.writeFileSync(path.join(directory, "qualification-evidence.json"), value);
  assert.throws(run, { code: "evidence-json" });
});

test("CLI reports TEST_ONLY consistency and exits nonzero for failed evidence", (t) => {
  const { directory } = fixture(t, { nowMs: Date.now() });
  const script = path.resolve("scripts/native-qualification-evidence.mjs");
  const invoke = () => spawnSync(process.execPath, [script, path.join(directory, "candidate.json"), directory],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  const accepted = invoke();
  assert.equal(accepted.status, 0, accepted.stderr);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result.status, "CONSISTENT");
  assert.equal(result.authorityEligible, false);
  assert.equal(result.releaseAllowed, false);
  fs.writeFileSync(path.join(directory, "qualification-evidence.json"), "private-malformed-json");
  const rejected = invoke();
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stderr).code, "evidence-json");
  assert.ok(!rejected.stderr.includes("private-malformed-json"));
});
