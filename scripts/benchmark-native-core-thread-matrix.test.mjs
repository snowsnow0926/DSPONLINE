import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInterleavedSchedule,
  parseArgs,
  percentile,
  runThreadMatrix,
  summarizeThreadSamples,
  validateCrossThreadHashes,
} from "./benchmark-native-core-thread-matrix.mjs";

const ABS = process.platform === "win32" ? "C:\\bench" : "/bench";

function exactMarker(duration, hash = "same-hash") {
  return {
    source: "stdout",
    label: "exact",
    value: {
      nativeCoreExactRealSaveAdvance: {
        exactState: true,
        canonicalSha256: hash,
        expectedCanonicalSha256: hash,
        nativeAdvanceDurationMs: duration,
        jsAdvanceDurationMs: 100,
        processPrivateBytesPeakDuringAdvance: 1000 + duration,
      },
    },
  };
}

function openMarker(duration = 10) {
  return { source: "stdout", label: "open", value: { nativeCore: { openDurationMs: duration } } };
}

function report(duration, hash = "same-hash") {
  return {
    status: "completed",
    runs: [{ benchmarkMarkers: [openMarker(), exactMarker(duration, hash)] }],
  };
}

function identity() {
  return {
    path: `${ABS}/host.exe`, resolvedPath: `${ABS}/host.exe`, sizeBytes: 1,
    mtimeMs: 1, mtimeNs: "1000000", sha256: "a".repeat(64),
  };
}

test("parseArgs accepts a unique supported subset and rejects duplicates", () => {
  const parsed = parseArgs([
    "--binary", `${ABS}/host.exe`, "--fixture", `${ABS}/save.json`,
    "--output", `${ABS}/matrix.json`, "--threads", "1,4,auto", "--runs", "2", "--profile",
  ]);
  assert.deepEqual(parsed.threads, ["1", "4", "auto"]);
  assert.equal(parsed.runs, 2);
  assert.equal(parsed.profile, true);
  assert.throws(() => parseArgs([
    "--binary", `${ABS}/host.exe`, "--fixture", `${ABS}/save.json`,
    "--output", `${ABS}/matrix.json`, "--threads", "1,1",
  ]), /duplicates/);
});

test("schedule rotates and reverses settings without changing per-setting counts", () => {
  const schedule = buildInterleavedSchedule(["1", "2", "4"], 3);
  assert.deepEqual(schedule.map((cell) => cell.threads), ["1", "2", "4", "1", "4", "2", "4", "1", "2"]);
  for (const thread of ["1", "2", "4"]) {
    assert.equal(schedule.filter((cell) => cell.threads === thread).length, 3);
  }
});

test("percentile interpolates and summaries report speedup against one thread", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  const samples = [
    { threads: "1", report: report(20) }, { threads: "1", report: report(22) },
    { threads: "2", report: report(10) }, { threads: "2", report: report(12) },
  ];
  const summary = summarizeThreadSamples(samples, ["1", "2"]);
  assert.equal(summary["1"].nativeAdvanceDurationMs.median, 21);
  assert.equal(summary["2"].nativeAdvanceDurationMs.median, 11);
  assert.equal(summary["2"].speedupVsOneThread, 21 / 11);
});

test("cross-thread validation fails closed for a missing or divergent hash", () => {
  const good = [{ sequence: 1, threads: "1", report: report(10) }, { sequence: 2, threads: "2", report: report(8) }];
  assert.equal(validateCrossThreadHashes(good, "exact").valid, true);
  const divergent = [...good, { sequence: 3, threads: "4", report: report(7, "different") }];
  const validation = validateCrossThreadHashes(divergent, "exact");
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /differ across/);
});

test("runThreadMatrix requires every independent cell and immutable input", () => {
  let clock = 0;
  const result = runThreadMatrix({
    binary: `${ABS}/host.exe`, fixture: `${ABS}/save.json`, output: `${ABS}/matrix.json`,
    runs: 2, threads: ["1", "2"], scenario: "exact", profile: false,
  }, {
    fileIdentity: identity,
    runStress: (options) => report(options.threads === "1" ? 20 : 10),
    now: () => ++clock,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.validation.completedCells, 4);
  assert.equal(result.validation.crossThreadCanonicalHashes.valid, true);
  assert.equal(result.summaryByThreads["2"].speedupVsOneThread, 2);
});
