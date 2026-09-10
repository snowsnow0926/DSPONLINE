import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { requireDirect } = require("../desktop/desktop-artifact-evidence.cjs");
const { collectValidationMatrixIdentity } = require("../desktop/native-validation-candidate.cjs");

// Offline evidence consistency only. This module does not authenticate a
// producer, promote a Host, or issue a release/player-authority capability.
export const QUALIFICATION_SCOPE = "windows-normal-main-1x-builtin-v1";
export const QUALIFICATION_CHECKS = Object.freeze([
  "single-owner", "first-tick", "command-material-conservation", "pause-resume",
  "persist-reopen", "exit-inflight", "lost-ack-retry", "host-restart",
  "threaded-determinism", "compatibility-roundtrip", "realtime-throughput", "process-tree-memory",
]);
// Keep the installed matrix identity and this actual auditor's fixed roster
// synchronized. The matrix remains TEST_ONLY, never a runtime grant.
const matrix = collectValidationMatrixIdentity();
if (matrix.scope !== QUALIFICATION_SCOPE || JSON.stringify(matrix.requiredChecks) !== JSON.stringify(QUALIFICATION_CHECKS)) {
  throw new Error("qualification-matrix-drift");
}
const IDENTITY_KEYS = [
  "version", "sourceSha", "buildId", "editionId", "channel", "platform", "arch",
  "hostSha256", "asarSha256", "catalogSha256", "rulesSha256", "matrixSha256",
];
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

function reject(code) {
  // Never echo a report's contents, a private path, or an untrusted message.
  throw Object.assign(new Error(`Native evidence rejected: ${code}`), { code });
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Reflect.ownKeys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key))) reject(code);
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateCandidate(candidate) {
  exactKeys(candidate, IDENTITY_KEYS, "candidate-shape");
  if (!IDENTITY_KEYS.every((key) => typeof candidate[key] === "string") ||
      !/^\d+\.\d+\.\d+$/.test(candidate.version) ||
      !/^[a-f0-9]{40}$/.test(candidate.sourceSha) ||
      candidate.buildId !== `${candidate.version}+${candidate.sourceSha.slice(0, 12)}` ||
      candidate.editionId !== "windows-performance-development-v1" ||
      candidate.channel !== "beta" || candidate.platform !== "win32" || candidate.arch !== "x64" ||
      !IDENTITY_KEYS.filter((key) => key.endsWith("Sha256")).every((key) =>
        typeof candidate[key] === "string" && SHA256.test(candidate[key]))) reject("candidate-identity");
}

function sameCandidate(actual, expected) {
  validateCandidate(actual);
  if (!IDENTITY_KEYS.every((key) => actual[key] === expected[key])) reject("candidate-mismatch");
}

function readMetadata(directory, relative, record) {
  let file;
  try { file = requireDirect(directory, relative); } catch { reject("evidence-path"); }
  const descriptor = fs.openSync(file, "r");
  let bytes;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_METADATA_BYTES) reject("evidence-size");
    // Bound the read even if the file grows after fstat. Hash and parse this
    // same snapshot; never verify one read and parse a different later read.
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length !== stat.size) reject("evidence-size");
    bytes = buffer.subarray(0, length);
  } finally { fs.closeSync(descriptor); }
  if (record && (record.size !== bytes.length ||
      record.sha256 !== createHash("sha256").update(bytes).digest("hex"))) reject("evidence-digest");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { reject("evidence-json"); }
}

/**
 * The caller supplies a separately frozen candidate identity and current clock.
 * Reported results remain producer claims until the trusted qualification chain
 * is implemented. Even a fully consistent TEST_ONLY bundle grants no authority.
 */
export function auditNativeQualificationEvidence({ directory, candidate, nowMs, revokedReportSha256 = [] }) {
  validateCandidate(candidate);
  if (!timestamp(nowMs)) reject("clock-invalid");
  if (!Array.isArray(revokedReportSha256) || revokedReportSha256.some((entry) =>
    typeof entry !== "string" || !SHA256.test(entry))) reject("revocations-invalid");
  const manifest = readMetadata(directory, "qualification-evidence.json");
  exactKeys(manifest, ["schemaVersion", "kind", "scope", "evidenceClass", "candidate",
    "issuedAtMs", "expiresAtMs", "checks"], "manifest-shape");
  if (manifest.schemaVersion !== 1 || manifest.kind !== "native-qualification-evidence-v1" ||
      manifest.scope !== QUALIFICATION_SCOPE || manifest.evidenceClass !== "TEST_ONLY") reject("manifest-contract");
  sameCandidate(manifest.candidate, candidate);
  if (!timestamp(manifest.issuedAtMs) || !timestamp(manifest.expiresAtMs) ||
      manifest.issuedAtMs > nowMs || manifest.expiresAtMs <= nowMs ||
      manifest.expiresAtMs <= manifest.issuedAtMs ||
      manifest.expiresAtMs - manifest.issuedAtMs > MAX_VALIDITY_MS) reject("evidence-validity");
  if (!Array.isArray(manifest.checks) || manifest.checks.length !== QUALIFICATION_CHECKS.length) reject("checks-incomplete");

  const ids = new Set();
  const paths = new Set();
  const hashes = new Set();
  const checks = [];
  for (const entry of manifest.checks) {
    exactKeys(entry, ["id", "report"], "check-shape");
    if (!QUALIFICATION_CHECKS.includes(entry.id) || ids.has(entry.id)) reject("check-id");
    ids.add(entry.id);
    exactKeys(entry.report, ["path", "size", "sha256"], "report-reference");
    const record = entry.report;
    if (typeof record.path !== "string" || !record.path.endsWith(".json") ||
        !Number.isSafeInteger(record.size) || record.size < 1 || record.size > MAX_METADATA_BYTES ||
        typeof record.sha256 !== "string" || !SHA256.test(record.sha256)) reject("report-reference");
    if (paths.has(record.path) || hashes.has(record.sha256)) reject("report-reused");
    paths.add(record.path);
    hashes.add(record.sha256);
    if (revokedReportSha256.includes(record.sha256)) reject("report-revoked");
    const report = readMetadata(directory, record.path, record);
    exactKeys(report, ["schemaVersion", "kind", "scope", "evidenceClass", "candidate", "checkId",
      "execution", "startedAtMs", "finishedAtMs", "fixtureSha256", "result", "tests"], "report-shape");
    if (report.schemaVersion !== 1 || report.kind !== "native-qualification-check-v1" ||
        report.scope !== QUALIFICATION_SCOPE || report.evidenceClass !== "TEST_ONLY" ||
        report.checkId !== entry.id) reject("report-contract");
    sameCandidate(report.candidate, candidate);
    if (!["rust-test-host", "rust-player-authority"].includes(report.execution)) reject("native-not-executed");
    if (!timestamp(report.startedAtMs) || !timestamp(report.finishedAtMs) ||
        report.finishedAtMs < report.startedAtMs || report.finishedAtMs > manifest.issuedAtMs ||
        manifest.issuedAtMs - report.startedAtMs > MAX_VALIDITY_MS) reject("report-time");
    if (typeof report.fixtureSha256 !== "string" || !SHA256.test(report.fixtureSha256)) reject("fixture-identity");
    exactKeys(report.tests, ["passed", "failed", "skipped", "flaky"], "test-counts");
    if (!Object.values(report.tests).every((value) => Number.isSafeInteger(value) && value >= 0) ||
        report.result !== "PASS" || report.tests.passed === 0 || report.tests.failed !== 0 ||
        report.tests.skipped !== 0 || report.tests.flaky !== 0) reject("check-not-passed");
    checks.push({ id: entry.id, execution: report.execution, reportSha256: record.sha256, tests: { ...report.tests } });
  }
  return {
    schemaVersion: 1, status: "CONSISTENT", evidenceClass: "TEST_ONLY", scope: QUALIFICATION_SCOPE,
    candidate: { ...candidate }, checkedAtMs: nowMs, checks,
    producerAuthenticated: false, authorityEligible: false, releaseAllowed: false,
  };
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    if (process.argv.length !== 4) reject("usage-candidate-json-evidence-directory");
    const candidatePath = path.resolve(process.argv[2]);
    const candidate = readMetadata(path.dirname(candidatePath), path.basename(candidatePath));
    const result = auditNativeQualificationEvidence({ directory: path.resolve(process.argv[3]), candidate, nowMs: Date.now() });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ status: "REJECTED", code: error.code ?? "evidence-read-failed", authorityEligible: false, releaseAllowed: false }));
    process.exitCode = 1;
  }
}
