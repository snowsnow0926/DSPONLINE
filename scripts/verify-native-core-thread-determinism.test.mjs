import assert from "node:assert/strict";
import test from "node:test";

import {
  evidenceFromReport,
  parseArgs,
  runDeterminismMatrix,
  validateDeterminismEvidence,
} from "./verify-native-core-thread-determinism.mjs";

const ABS = process.platform === "win32" ? "C:\\matrix" : "/matrix";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function identity(filePath = `${ABS}/host.exe`) {
  return {
    path: filePath,
    resolvedPath: filePath,
    sizeBytes: 10,
    mtimeMs: 20,
    mtimeNs: "20000000",
    sha256: SHA_A,
  };
}

function report(threads, overrides = {}) {
  const exact = {
    exactState: true,
    revision: 3,
    expectedRevision: 3,
    canonicalSha256: SHA_A,
    expectedCanonicalSha256: SHA_A,
    domainSha256: SHA_B,
    conservationSummarySha256: SHA_C,
    conservationCaptureFailure: null,
    conservationValidationFailure: null,
    conservationItemCounts: { totals: 1 },
    requestedThreadSetting: threads,
    effectiveWorkerLimit: Number(threads),
    observedWorkerCount: Number(threads),
    ...overrides,
  };
  return {
    status: "completed",
    runs: [{
      benchmarkMarkers: [{
        source: "stdout",
        label: "exact",
        value: { nativeCoreExactRealSaveAdvance: exact },
      }],
    }],
  };
}

test("parseArgs requires distinct absolute inputs and bounds runs", () => {
  const parsed = parseArgs([
    "--binary", `${ABS}/host.exe`,
    "--fixture", `${ABS}/save.json`,
    "--output", `${ABS}/report.json`,
    "--runs", "2",
  ]);
  assert.equal(parsed.runs, 2);
  assert.throws(() => parseArgs([
    "--binary", `${ABS}/host.exe`,
    "--fixture", `${ABS}/save.json`,
    "--output", `${ABS}/report.json`,
    "--runs", "6",
  ]), /1\.\.5/);
});

test("evidenceFromReport preserves actual worker and full-state proof fields", () => {
  const evidence = evidenceFromReport(report("4"), "4");
  assert.equal(evidence.requestedThreads, 4);
  assert.equal(evidence.effectiveWorkerLimit, 4);
  assert.equal(evidence.observedWorkerCount, 4);
  assert.equal(evidence.revision, 3);
  assert.equal(evidence.canonicalSha256, SHA_A);
  assert.equal(evidence.domainSha256, SHA_B);
  assert.equal(evidence.conservationSummarySha256, SHA_C);
  assert.equal(evidence.conservationCaptureReported, true);
  assert.equal(evidence.conservationValidationReported, true);
});

test("validation fails closed on an unobserved pool or divergent conservation digest", () => {
  const cells = ["1", "2", "4", "8"].map((threads, index) => ({
    sequence: index + 1,
    threads,
    reportStatus: "completed",
    evidence: evidenceFromReport(report(threads), threads),
  }));
  assert.equal(validateDeterminismEvidence(cells).valid, true);

  const badWorkers = structuredClone(cells);
  badWorkers[2].evidence.observedWorkerCount = 2;
  assert.match(validateDeterminismEvidence(badWorkers).errors.join("\n"), /observed worker count/);

  const badConservation = structuredClone(cells);
  badConservation[3].evidence.conservationSummarySha256 = "d".repeat(64);
  assert.match(validateDeterminismEvidence(badConservation).errors.join("\n"), /conservationSummarySha256 differs/);

  const unbalanced = [...cells, structuredClone(cells[0])];
  assert.match(validateDeterminismEvidence(unbalanced).errors.join("\n"), /not balanced/);

  const consistentlyInvalidConservation = structuredClone(cells);
  for (const cell of consistentlyInvalidConservation) {
    cell.evidence.conservationValidationFailure = "missing private construction receipt";
  }
  const invalidConservation = validateDeterminismEvidence(consistentlyInvalidConservation);
  assert.equal(invalidConservation.valid, false);
  assert.match(invalidConservation.errors.join("\n"), /conservation validation failed/);
});

test("runDeterminismMatrix launches every thread cell independently with profiling enabled", () => {
  let clock = 0;
  const calls = [];
  const result = runDeterminismMatrix({
    binary: `${ABS}/host.exe`,
    fixture: `${ABS}/save.json`,
    output: `${ABS}/report.json`,
    runs: 2,
  }, {
    fileIdentity: (filePath) => identity(filePath),
    runStress: (options) => {
      calls.push(options);
      return report(options.threads);
    },
    now: () => ++clock,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.validation.requestedCells, 8);
  assert.equal(result.validation.completedCells, 8);
  assert.equal(result.validation.determinism.valid, true);
  assert.deepEqual(calls.map((call) => call.threads).sort(), ["1", "1", "2", "2", "4", "4", "8", "8"]);
  assert.ok(calls.every((call) => call.runs === 1 && call.scenario === "exact" && call.profile === true));
  assert.equal(result.scope.authorityParallelismClaimed, false);
});
