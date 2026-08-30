import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_SECONDS,
  REQUIRED_THREADS,
  matrixCellFileName,
  parseConflictProfileValue,
  verifyMatrixDocuments,
} from "./verify-native-belt-conflict-profile-matrix.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

function identity(kind) {
  return {
    path: `C:\\fixture\\${kind}`,
    resolvedPath: `C:\\fixture\\${kind}`,
    sizeBytes: kind === "save.json" ? 44_566_548 : 13_000_000,
    mtimeMs: 123,
    mtimeNs: "123000000",
    sha256: kind === "save.json" ? SHA_D : SHA_A,
  };
}

function conflictValue({
  pass,
  groups,
  routes,
  components,
  parallelComponents,
  serialComponents,
  total,
  largest,
  parallel,
  serial,
  quantum,
  opaque,
  loads,
  serialEquivalent,
}) {
  const fraction = (numerator) => (numerator / total).toFixed(6);
  return [
    `pass=${pass}`,
    `groups=${groups}`,
    `candidate-routes=${routes}`,
    `components=${components}`,
    `parallel-components=${parallelComponents}`,
    `serial-components=${serialComponents}`,
    `total-work=${total}`,
    `largest-work=${largest}`,
    `largest-share=${fraction(largest)}`,
    `parallel-work=${parallel}`,
    `parallel-share=${fraction(parallel)}`,
    `serial-fallback-work=${serial}`,
    `serial-fallback-share=${fraction(serial)}`,
    `quantum-fallback-work=${quantum}`,
    `quantum-fallback-share=${fraction(quantum)}`,
    `opaque-fallback-work=${opaque}`,
    `opaque-fallback-share=${fraction(opaque)}`,
    `greedy8-loads=${loads.join(",")}`,
    `greedy8-serial-equivalent-work=${serialEquivalent}`,
    `greedy8-serial-fraction=${fraction(serialEquivalent)}`,
  ].join("\t");
}

const PRE = conflictValue({
  pass: "pre-production",
  groups: 30,
  routes: 40,
  components: 10,
  parallelComponents: 8,
  serialComponents: 2,
  total: 100,
  largest: 20,
  parallel: 80,
  serial: 20,
  quantum: 20,
  opaque: 0,
  loads: [10, 10, 10, 10, 10, 10, 10, 10],
  serialEquivalent: 30,
});

const POST = conflictValue({
  pass: "post-production",
  groups: 50,
  routes: 60,
  components: 20,
  parallelComponents: 10,
  serialComponents: 10,
  total: 200,
  largest: 50,
  parallel: 100,
  serial: 100,
  quantum: 80,
  opaque: 20,
  loads: [13, 13, 13, 13, 12, 12, 12, 12],
  serialEquivalent: 113,
});

function profileMarkers(profile) {
  if (!profile) return [];
  return [
    { label: "belt-transfer-stable-apply", rawValue: "40", value: 40 },
    { label: "belt-conflict-components", rawValue: PRE, value: null },
    { label: "belt-transfer-stable-apply", rawValue: "60", value: 60 },
    { label: "belt-conflict-components", rawValue: POST, value: null },
  ];
}

function stressReport(profile, threads, seconds) {
  const hash = seconds === "1" ? SHA_A : seconds === "5" ? SHA_B : SHA_C;
  const exact = {
    exactState: true,
    simulationSeconds: Number(seconds),
    requestedThreadSetting: threads,
    canonicalSha256: hash,
    expectedCanonicalSha256: hash,
    domainSha256: SHA_D,
    conservationSummarySha256: SHA_C,
    conservationCaptureFailure: null,
    conservationValidationFailure: null,
    fieldMismatches: [],
    nativeAdvanceDurationMs: profile ? 540 : 500,
  };
  return {
    status: "completed",
    command: { scenario: "exact", threads, seconds, profile },
    immutableInputs: {
      binary: { initial: identity("host.exe") },
      fixture: { initial: identity("save.json") },
    },
    validation: { fixtureUnchanged: true, binaryUnchanged: true, allRunsExact: true },
    runs: [{
      benchmarkMarkers: [{ label: "exact", value: { nativeCoreExactRealSaveAdvance: exact } }],
      nativeProfileMarkers: profileMarkers(profile),
    }],
  };
}

function matrixDocuments() {
  const documents = [];
  for (const seconds of REQUIRED_SECONDS) {
    for (const threads of REQUIRED_THREADS) {
      for (const profile of [false, true]) {
        documents.push({
          fileName: matrixCellFileName(profile, threads, seconds),
          sha256: profile ? SHA_A : SHA_B,
          report: stressReport(profile, threads, seconds),
        });
      }
    }
  }
  return documents;
}

test("conflict parser preserves integer accounting and stable greedy loads", () => {
  const parsed = parseConflictProfileValue(PRE);
  assert.equal(parsed.pass, "pre-production");
  assert.equal(parsed.componentCount, 10);
  assert.equal(parsed.parallelWorkUnits, 80);
  assert.deepEqual(parsed.greedy8Loads, [10, 10, 10, 10, 10, 10, 10, 10]);
});

test("complete on/off duration and thread matrix qualifies the component experiment", () => {
  const verified = verifyMatrixDocuments(matrixDocuments(), "2026-08-30T00:00:00.000Z");
  assert.equal(verified.status, "completed");
  assert.equal(verified.matrix.valid, true);
  assert.equal(verified.matrix.completedCells, 24);
  assert.equal(verified.conflictProfile.combined.componentCount, 30);
  assert.equal(verified.conflictProfile.combined.parallelWorkShare, 0.6);
  assert.deepEqual(verified.conflictProfile.combined.largestComponent, {
    pass: "post-production",
    workUnits: 50,
    share: 0.25,
  });
  assert.equal(verified.qualification.theoreticalWholeStepBenefitPercent, 10.82);
  assert.equal(verified.qualification.qualifiedForImplementationExperiment, true);
});

test("profile toggle hash divergence invalidates the evidence", () => {
  const documents = matrixDocuments();
  const target = documents.find((document) => document.fileName === matrixCellFileName(true, "4", "5"));
  target.report.runs[0].benchmarkMarkers[0].value.nativeCoreExactRealSaveAdvance.domainSha256 = SHA_A;
  const verified = verifyMatrixDocuments(documents);
  assert.equal(verified.status, "failed");
  assert.match(verified.matrix.errors.join("\n"), /5s: domainSha256 differs/);
  assert.equal(verified.qualification.decision, "invalid-evidence");
});

test("stable native and JavaScript oracle divergence remains explicit observer evidence", () => {
  const documents = matrixDocuments();
  for (const document of documents) {
    if (!document.fileName.endsWith("-60s.json")) continue;
    const exact = document.report.runs[0].benchmarkMarkers[0]
      .value.nativeCoreExactRealSaveAdvance;
    exact.exactState = false;
    exact.expectedCanonicalSha256 = SHA_D;
    exact.fieldMismatches = ["dysonEngineering"];
    document.report.validation = {
      ...document.report.validation,
      allRunsExact: false,
      allRequestedValidationValid: true,
    };
  }

  const verified = verifyMatrixDocuments(documents);
  assert.equal(verified.status, "completed");
  assert.equal(verified.matrix.durationProofs["60"].nativeMatchesJavascript, false);
  assert.deepEqual(verified.matrix.durationProofs["60"].fieldMismatches, ["dysonEngineering"]);
});

test("inconsistent profiler arithmetic fails closed", () => {
  const documents = matrixDocuments();
  const source = documents.find((document) => document.fileName === matrixCellFileName(true, "8", "1"));
  const marker = source.report.runs[0].nativeProfileMarkers.find(
    (candidate) => candidate.label === "belt-conflict-components",
  );
  marker.rawValue = marker.rawValue.replace("greedy8-loads=10,10,10,10,10,10,10,10", "greedy8-loads=9,10,10,10,10,10,10,10");
  const verified = verifyMatrixDocuments(documents);
  assert.equal(verified.status, "failed");
  assert.match(verified.matrix.errors.join("\n"), /greedy loads do not close/);
});
