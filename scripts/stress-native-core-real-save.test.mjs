import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHILD_ENV_ALLOWLIST,
  SYNC_RECORD_DROP_ENV,
  buildChildEnvironment,
  captureSystemSnapshot,
  fileIdentity,
  parseArgs,
  parseBenchmarkMarkers,
  parseProfileMarkers,
  runStress,
  tailUtf8,
  validateBenchmarkMarkers,
  writeJsonAtomic,
} from "./stress-native-core-real-save.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(PROJECT_ROOT, "scripts", "stress-native-core-real-save.mjs");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-stress-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixturePaths(t) {
  const directory = temporaryDirectory(t);
  const binary = path.join(directory, "dsp-native-host.exe");
  const fixture = path.join(directory, "real-save.json");
  const output = path.join(directory, "report.json");
  fs.writeFileSync(binary, "synthetic-binary");
  fs.writeFileSync(fixture, "synthetic-fixture");
  return { directory, binary, fixture, output };
}

function validSampler(overrides = {}) {
  return {
    error: null,
    intervalMs: 25,
    intervalSampleCount: 4,
    intervalP95Ms: 28,
    intervalMaxMs: 34,
    samplingCadenceValid: true,
    pid: 100,
    samplerPid: 101,
    peakBytes: 4096,
    sampleCount: 5,
    ...overrides,
  };
}

function benchmarkOutput(binarySha256, scenario = "exact", overrides = {}) {
  const records = {
    open: {
      nativeCore: {
        hostBinarySha256: binarySha256,
        exactRoundTrip: true,
        privatePeakSampler: validSampler(),
      },
    },
    admission: { nativeCoreAdmission: { supported: true } },
    exact: {
      nativeCoreExactRealSaveAdvance: {
        exactState: true,
        simulationSeconds: 1,
        canonicalSha256: SHA_A,
        expectedCanonicalSha256: SHA_A,
        domainSha256: SHA_B,
        conservationSummarySha256: SHA_C,
        conservationCaptureFailure: null,
        conservationValidationFailure: null,
        fieldMismatches: [],
        privatePeakSampler: validSampler({ pid: 200, samplerPid: 201 }),
      },
    },
    ...(scenario === "full" ? {
      integrated: { nativeCoreIntegratedDiagnostics: { exactState: true } },
      durable: { nativeCoreDurableAuthority: { exactState: true, duplicateRetry: true } },
      checkpoint: { nativeCoreIncrementalCheckpoint: { exactState: true } },
      burst: {
        nativeCoreExactBurst: {
          exactState: true,
          steps: 3,
          privatePeakSampler: validSampler({ pid: 300, samplerPid: 301 }),
        },
      },
    } : {}),
    ...overrides,
  };
  return Object.entries(records)
    .map(([label, value]) => `DSP_NATIVE_CORE_BENCHMARK\t${label}\t${JSON.stringify(value)}`)
    .join("\n");
}

function stressOptions(paths, overrides = {}) {
  return {
    binary: paths.binary,
    fixture: paths.fixture,
    output: paths.output,
    runs: 2,
    scenario: "exact",
    threads: "auto",
    seconds: "1",
    syncRecordDrop: false,
    profile: false,
    profileEquivalence: false,
    ...overrides,
  };
}

function deterministicDependencies(paths, spawnVitest, overrides = {}) {
  let clock = Date.UTC(2026, 7, 27, 0, 0, 0);
  let snapshotSequence = 0;
  return {
    platform: "win32",
    parentEnvironment: {
      Path: "C:\\Windows\\System32",
      TEMP: paths.directory,
      DSP_NATIVE_CORE_PROFILE: "ambient-must-not-pass",
      [SYNC_RECORD_DROP_ENV]: "ambient-must-not-pass",
      SECRET_TOKEN: "ambient-must-not-pass",
    },
    now: () => {
      clock += 10;
      return clock;
    },
    snapshot: () => ({ sequence: ++snapshotSequence }),
    spawnVitest,
    ...overrides,
  };
}

test("CLI help is low-cost and does not require a real save", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--help"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--runs <n>/);
  assert.match(result.stdout, /--sync-record-drop/);
  assert.match(result.stdout, /must not already exist/);
});

test("parseArgs accepts only the bounded stability matrix", (t) => {
  const paths = fixturePaths(t);
  const parsed = parseArgs([
    "--binary", paths.binary,
    "--fixture", paths.fixture,
    "--output", paths.output,
    "--runs", "50",
    "--scenario", "exact",
    "--threads", "8",
    "--seconds", "60",
    "--sync-record-drop",
    "--profile",
    "--profile-equivalence",
  ]);
  assert.equal(parsed.runs, 50);
  assert.equal(parsed.scenario, "exact");
  assert.equal(parsed.threads, "8");
  assert.equal(parsed.seconds, "60");
  assert.equal(parsed.syncRecordDrop, true);
  assert.equal(parsed.profile, true);
  assert.equal(parsed.profileEquivalence, true);
});

test("parseArgs rejects unsafe, ambiguous, or unbounded arguments", (t) => {
  const paths = fixturePaths(t);
  const base = ["--binary", paths.binary, "--fixture", paths.fixture, "--output", paths.output];
  for (const argv of [
    [...base, "--runs", "0"],
    [...base, "--runs", "51"],
    [...base, "--scenario", "open"],
    [...base, "--threads", "16"],
    [...base, "--seconds", "2"],
    [...base, "--scenario", "full", "--seconds", "5"],
    [...base, "--scenario", "full", "--profile-equivalence"],
    [...base, "--env", "DSP_NATIVE_CORE_PROFILE=1"],
    [...base, "--output", `${paths.output}.duplicate`],
  ]) {
    assert.throws(() => parseArgs(argv));
  }
  assert.throws(() => parseArgs([
    "--binary", "relative.exe",
    "--fixture", paths.fixture,
    "--output", paths.output,
  ]), /absolute path/);
  assert.throws(() => parseArgs([
    "--binary", paths.binary,
    "--fixture", paths.fixture,
    "--output", paths.fixture,
  ]), /different paths/);
});

test("child environment uses a fixed allowlist and strips ambient DSP variables", (t) => {
  const paths = fixturePaths(t);
  const options = stressOptions(paths);
  const parent = {
    Path: "C:\\Windows\\System32",
    TEMP: paths.directory,
    LANG: "zh_CN.UTF-8",
    DSP_NATIVE_CORE_THREADS: "999",
    DSP_NATIVE_CORE_PROFILE: "1",
    DSP_NATIVE_CORE_BENCHMARK_PROFILE_EQUIVALENCE: "ambient",
    [SYNC_RECORD_DROP_ENV]: "ambient",
    SECRET_TOKEN: "secret",
    NODE_OPTIONS: "--inspect",
  };
  const regular = buildChildEnvironment(parent, options, "win32");
  assert.equal(regular.environment.Path, parent.Path);
  assert.equal(regular.environment.TEMP, parent.TEMP);
  assert.equal(regular.environment.DSP_NATIVE_CORE_THREADS, "auto");
  assert.equal(regular.environment.DSP_NATIVE_CORE_BENCHMARK_EXACT_SECONDS, "1");
  assert.equal(regular.environment.DSP_NATIVE_CORE_PROFILE, undefined);
  assert.equal(regular.environment.DSP_NATIVE_CORE_BENCHMARK_PROFILE_EQUIVALENCE, undefined);
  assert.equal(regular.environment.SECRET_TOKEN, undefined);
  assert.equal(regular.environment.NODE_OPTIONS, undefined);
  assert.equal(regular.environment[SYNC_RECORD_DROP_ENV], undefined);
  assert.deepEqual(regular.inheritedKeys, ["LANG", "Path", "TEMP"]);
  assert.equal(regular.managedKeys.includes(SYNC_RECORD_DROP_ENV), false);
  assert.ok(CHILD_ENV_ALLOWLIST.includes("PATH"));

  const diagnostic = buildChildEnvironment(parent, { ...options, syncRecordDrop: true }, "win32");
  assert.equal(diagnostic.environment[SYNC_RECORD_DROP_ENV], "1");
  assert.equal(diagnostic.managedKeys.filter((key) => key === SYNC_RECORD_DROP_ENV).length, 1);

  const profiled = buildChildEnvironment(parent, { ...options, profile: true }, "win32");
  assert.equal(profiled.environment.DSP_NATIVE_CORE_PROFILE, "1");
  assert.equal(profiled.managedKeys.filter((key) => key === "DSP_NATIVE_CORE_PROFILE").length, 1);

  const legacyCaller = buildChildEnvironment(parent, { ...options, seconds: undefined }, "win32");
  assert.equal(legacyCaller.environment.DSP_NATIVE_CORE_BENCHMARK_EXACT_SECONDS, "1");

  const observer = buildChildEnvironment(parent, { ...options, profileEquivalence: true }, "win32");
  assert.equal(observer.environment.DSP_NATIVE_CORE_BENCHMARK_PROFILE_EQUIVALENCE, "1");
});

test("profile parser preserves ordered duplicate phase timings from both streams", () => {
  const markers = parseProfileMarkers(
    [
      "DSP_NATIVE_CORE_PROFILE\tstate-parse-records\t146.597",
      "DSP_NATIVE_CORE_PROFILE\tstate-parse-records\t141.25",
    ].join("\n"),
    "DSP_NATIVE_CORE_PROFILE\tfactory-power-probe-workers\t1",
  );
  assert.deepEqual(markers, [
    { source: "stdout", label: "state-parse-records", rawValue: "146.597", value: 146.597 },
    { source: "stdout", label: "state-parse-records", rawValue: "141.25", value: 141.25 },
    { source: "stderr", label: "factory-power-probe-workers", rawValue: "1", value: 1 },
  ]);
});

test("marker parser retains every valid, duplicate, and malformed marker", (t) => {
  const paths = fixturePaths(t);
  const binary = fileIdentity(paths.binary);
  const stdout = [
    benchmarkOutput(binary.sha256),
    "DSP_NATIVE_CORE_BENCHMARK\texact\t{\"duplicate\":true}",
    "DSP_NATIVE_CORE_BENCHMARK\tbroken\t{not-json}",
  ].join("\n");
  const markers = parseBenchmarkMarkers(stdout, "DSP_NATIVE_CORE_BENCHMARK\tstderr-record\t{\"ok\":true}");
  assert.equal(markers.length, 6);
  assert.equal(markers.at(-1).source, "stderr");
  assert.match(markers.find((marker) => marker.label === "broken").parseError, /JSON/);
  const validation = validateBenchmarkMarkers(markers, binary, "exact", "win32");
  assert.equal(validation.markerValid, false);
  assert.ok(validation.errors.marker.some((error) => error.includes("duplicate")));
  assert.ok(validation.errors.marker.some((error) => error.includes("invalid JSON")));
});

test("full validation requires exact durable, checkpoint, burst, and Windows samplers", (t) => {
  const paths = fixturePaths(t);
  const binary = fileIdentity(paths.binary);
  const valid = validateBenchmarkMarkers(
    parseBenchmarkMarkers(benchmarkOutput(binary.sha256, "full")),
    binary,
    "full",
    "win32",
  );
  assert.equal(valid.exactValid, true);
  assert.equal(valid.samplerValid, true);

  const invalidOutput = benchmarkOutput(binary.sha256, "full", {
    burst: {
      nativeCoreExactBurst: {
        exactState: false,
        steps: 3,
        privatePeakSampler: validSampler({ samplingCadenceValid: false }),
      },
    },
  });
  const invalid = validateBenchmarkMarkers(
    parseBenchmarkMarkers(invalidOutput),
    binary,
    "full",
    "win32",
  );
  assert.equal(invalid.exactValid, false);
  assert.equal(invalid.samplerValid, false);
});

test("exact validation fails when the child reports a different duration", (t) => {
  const paths = fixturePaths(t);
  const binary = fileIdentity(paths.binary);
  const validation = validateBenchmarkMarkers(
    parseBenchmarkMarkers(benchmarkOutput(binary.sha256)),
    binary,
    "exact",
    "win32",
    "5",
  );
  assert.equal(validation.exactValid, false);
  assert.match(validation.errors.exact.join("\n"), /simulationSeconds 1 differs from requested 5/);
});

test("observer validation preserves a reported oracle divergence without calling it exact", (t) => {
  const paths = fixturePaths(t);
  const binary = fileIdentity(paths.binary);
  const output = benchmarkOutput(binary.sha256, "exact", {
    exact: {
      nativeCoreExactRealSaveAdvance: {
        exactState: false,
        simulationSeconds: 60,
        canonicalSha256: SHA_A,
        expectedCanonicalSha256: SHA_B,
        domainSha256: SHA_C,
        conservationSummarySha256: SHA_C,
        conservationCaptureFailure: null,
        conservationValidationFailure: null,
        fieldMismatches: ["dysonEngineering"],
        privatePeakSampler: validSampler({ pid: 200, samplerPid: 201 }),
      },
    },
  });
  const validation = validateBenchmarkMarkers(
    parseBenchmarkMarkers(output),
    binary,
    "exact",
    "win32",
    "60",
  );
  assert.equal(validation.observerValid, true);
  assert.equal(validation.oracleEqual, false);
  assert.equal(validation.exactValid, false);
});

test("all exact runs with valid samplers produce a completed report", (t) => {
  const paths = fixturePaths(t);
  const binary = fileIdentity(paths.binary);
  const seenEnvironments = [];
  const report = runStress(
    stressOptions(paths, { runs: 3, threads: "4", syncRecordDrop: true, profile: true }),
    deterministicDependencies(paths, (_options, environment, sequence) => {
      seenEnvironments.push({ environment, sequence });
      return {
        status: 0,
        signal: null,
        stdout: benchmarkOutput(binary.sha256),
        stderr: "DSP_NATIVE_CORE_PROFILE\tstate-simulate-steps\t123.5",
      };
    }),
  );
  assert.equal(report.status, "completed");
  assert.equal(report.runs.length, 3);
  assert.equal(report.validation.allRunsExact, true);
  assert.equal(report.validation.allSamplersValid, true);
  assert.equal(report.validation.fixtureUnchanged, true);
  assert.deepEqual(report.runs.map((run) => run.systemBefore.sequence), [1, 3, 5]);
  assert.deepEqual(report.runs.map((run) => run.systemAfter.sequence), [2, 4, 6]);
  assert.ok(seenEnvironments.every(({ environment }) => environment[SYNC_RECORD_DROP_ENV] === "1"));
  assert.ok(seenEnvironments.every(({ environment }) => environment.DSP_NATIVE_CORE_PROFILE === "1"));
  assert.ok(seenEnvironments.every(({ environment }) => environment.SECRET_TOKEN === undefined));
  assert.ok(report.runs.every((run) => run.nativeProfileMarkers[0]?.value === 123.5));
});

test("profile-equivalence mode completes on structurally valid divergent oracle evidence", (t) => {
  const paths = fixturePaths(t);
  const binary = fileIdentity(paths.binary);
  const stdout = benchmarkOutput(binary.sha256, "exact", {
    exact: {
      nativeCoreExactRealSaveAdvance: {
        exactState: false,
        simulationSeconds: 60,
        canonicalSha256: SHA_A,
        expectedCanonicalSha256: SHA_B,
        domainSha256: SHA_C,
        conservationSummarySha256: SHA_C,
        conservationCaptureFailure: null,
        conservationValidationFailure: null,
        fieldMismatches: ["dysonEngineering"],
        privatePeakSampler: validSampler({ pid: 200, samplerPid: 201 }),
      },
    },
  });
  const report = runStress(
    stressOptions(paths, { runs: 1, seconds: "60", profileEquivalence: true }),
    deterministicDependencies(paths, () => ({ status: 0, signal: null, stdout, stderr: "" })),
  );
  assert.equal(report.status, "completed");
  assert.equal(report.validation.allRunsExact, false);
  assert.equal(report.validation.allRequestedValidationValid, true);
  assert.equal(report.runs[0].benchmarkValidation.validationMode, "profile-observer-equivalence");
  assert.equal(report.runs[0].benchmarkValidation.oracleEqual, false);
});

test("a failed child does not prevent later independent runs", (t) => {
  const paths = fixturePaths(t);
  const binary = fileIdentity(paths.binary);
  const sequences = [];
  const report = runStress(
    stressOptions(paths, { runs: 3 }),
    deterministicDependencies(paths, (_options, _environment, sequence) => {
      sequences.push(sequence);
      if (sequence === 2) {
        return {
          status: 9,
          signal: null,
          stdout: benchmarkOutput(binary.sha256),
          stderr: `failure-prefix-${"x".repeat(20_000)}`,
        };
      }
      return { status: 0, signal: null, stdout: benchmarkOutput(binary.sha256), stderr: "" };
    }),
  );
  assert.deepEqual(sequences, [1, 2, 3]);
  assert.equal(report.status, "failed");
  assert.equal(report.failedRuns, 1);
  assert.equal(report.runs[1].process.exitCode, 9);
  assert.equal(report.runs[1].outputTail.retainedBytes, 12 * 1024);
  assert.ok(Buffer.byteLength(report.runs[1].outputTail.text) <= 12 * 1024);
  assert.equal(report.runs[2].status, "passed");
});

test("fixture mutation aborts immediately and records both identities", (t) => {
  const paths = fixturePaths(t);
  const binary = fileIdentity(paths.binary);
  let processes = 0;
  const report = runStress(
    stressOptions(paths, { runs: 5 }),
    deterministicDependencies(paths, () => {
      processes += 1;
      fs.appendFileSync(paths.fixture, "mutated");
      return { status: 0, signal: null, stdout: benchmarkOutput(binary.sha256), stderr: "" };
    }),
  );
  assert.equal(processes, 1);
  assert.equal(report.status, "failed");
  assert.equal(report.abortReason, "fixture-identity-changed");
  assert.equal(report.validation.completedRunProcesses, 1);
  assert.equal(report.validation.fixtureUnchanged, false);
  assert.equal(report.runs[0].immutableInputs.fixtureUnchanged, false);
  assert.notEqual(
    report.runs[0].immutableInputs.fixtureBefore.sha256,
    report.runs[0].immutableInputs.fixtureAfter.sha256,
  );
});

test("invalid sampler fails the report while later runs still execute", (t) => {
  const paths = fixturePaths(t);
  const binary = fileIdentity(paths.binary);
  let processes = 0;
  const report = runStress(
    stressOptions(paths, { runs: 2 }),
    deterministicDependencies(paths, (_options, _environment, sequence) => {
      processes += 1;
      const exact = sequence === 1
        ? {
            nativeCoreExactRealSaveAdvance: {
              exactState: true,
              simulationSeconds: 1,
              canonicalSha256: SHA_A,
              expectedCanonicalSha256: SHA_A,
              domainSha256: SHA_B,
              conservationSummarySha256: SHA_C,
              conservationCaptureFailure: null,
              conservationValidationFailure: null,
              fieldMismatches: [],
              privatePeakSampler: validSampler({ intervalSampleCount: 0 }),
            },
          }
        : undefined;
      return {
        status: 0,
        signal: null,
        stdout: benchmarkOutput(binary.sha256, "exact", exact ? { exact } : {}),
        stderr: "",
      };
    }),
  );
  assert.equal(processes, 2);
  assert.equal(report.status, "failed");
  assert.equal(report.validation.allRunsExact, true);
  assert.equal(report.validation.allSamplersValid, false);
  assert.equal(report.runs[0].benchmarkValidation.samplerValid, false);
  assert.equal(report.runs[1].status, "passed");
});

test("spawn errors are serialized, tailed, and do not stop the matrix", (t) => {
  const paths = fixturePaths(t);
  const binary = fileIdentity(paths.binary);
  let processes = 0;
  const error = Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" });
  const report = runStress(
    stressOptions(paths, { runs: 2 }),
    deterministicDependencies(paths, () => {
      processes += 1;
      if (processes === 1) return { status: null, signal: "SIGTERM", stdout: "partial", stderr: "timeout", error };
      return { status: 0, signal: null, stdout: benchmarkOutput(binary.sha256), stderr: "" };
    }),
  );
  assert.equal(processes, 2);
  assert.equal(report.runs[0].status, "timed-out");
  assert.equal(report.runs[0].process.error.code, "ETIMEDOUT");
  assert.equal(report.runs[1].status, "passed");
});

test("tailUtf8 retains at most 12 KiB of failure evidence", () => {
  const tail = tailUtf8(`prefix-${"测".repeat(10_000)}`);
  assert.equal(tail.byteLimit, 12 * 1024);
  assert.ok(tail.retainedBytes <= 12 * 1024);
  assert.ok(Buffer.byteLength(tail.text) <= 12 * 1024);
  assert.ok(tail.sourceBytes > tail.retainedBytes);
});

test("Windows snapshot records physical, virtual, and top private-memory data", () => {
  const payload = {
    FreePhysicalMemoryKiB: 111,
    FreeVirtualMemoryKiB: 222,
    TotalVisibleMemorySizeKiB: 333,
    TotalVirtualMemorySizeKiB: 444,
    TopProcessesByPrivateBytes: [{ Id: 7, ProcessName: "native", PrivateMemorySize64: 555 }],
  };
  const snapshot = captureSystemSnapshot({
    platform: "win32",
    capturedAt: "2026-08-27T00:00:00.000Z",
    spawn: () => ({ status: 0, stdout: JSON.stringify(payload), stderr: "" }),
  });
  assert.equal(snapshot.capturedAt, "2026-08-27T00:00:00.000Z");
  assert.equal(snapshot.windows.freePhysicalMemoryKiB, 111);
  assert.equal(snapshot.windows.freeVirtualMemoryKiB, 222);
  assert.equal(snapshot.windows.topProcessesByPrivateBytes[0].PrivateMemorySize64, 555);
});

test("file identity records SHA-256, size, resolved path, and nanosecond mtime", (t) => {
  const paths = fixturePaths(t);
  const identity = fileIdentity(paths.fixture);
  assert.equal(identity.sizeBytes, Buffer.byteLength("synthetic-fixture"));
  assert.equal(identity.sha256, crypto.createHash("sha256").update("synthetic-fixture").digest("hex"));
  assert.equal(identity.resolvedPath, fs.realpathSync.native(paths.fixture));
  assert.match(identity.mtimeNs, /^\d+$/);
});

test("atomic report writer reads back JSON and never replaces an existing report", (t) => {
  const paths = fixturePaths(t);
  const document = { schemaVersion: 1, status: "completed" };
  writeJsonAtomic(paths.output, document);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.output, "utf8")), document);
  const before = fs.readFileSync(paths.output);
  assert.throws(() => writeJsonAtomic(paths.output, { status: "failed" }), /already exists/);
  assert.deepEqual(fs.readFileSync(paths.output), before);
  assert.deepEqual(
    fs.readdirSync(paths.directory).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("CLI refuses an existing output without starting a benchmark or replacing bytes", (t) => {
  const paths = fixturePaths(t);
  const sentinel = "existing-report-must-survive\n";
  fs.writeFileSync(paths.output, sentinel);
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--binary", paths.binary,
    "--fixture", paths.fixture,
    "--output", paths.output,
    "--runs", "1",
  ], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: { ...process.env, DSP_RUN_NATIVE_CORE_BENCHMARK: "must-not-run" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Output already exists/);
  assert.equal(fs.readFileSync(paths.output, "utf8"), sentinel);
});
