import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  main,
  parseFixedAffinityArgs,
  runFixedAffinityAb,
  runPinnedFixedAffinitySample,
} from "./benchmark-native-core-fixed-affinity-ab.mjs";
import {
  computeV47StateChecksum,
  generateAndPersistFixedV47Fixture,
  readFixedV47Fixture,
} from "./native-fixed-v47-fixture.mjs";

const ABS = process.platform === "win32" ? "C:\\bench" : "/bench";

function fixtureBytes() {
  const state = { version: 47, mode: "normal", entities: [], belts: [] };
  return Buffer.from(JSON.stringify({
    formatVersion: 2,
    kind: "snapshot",
    savedAt: 1,
    mode: "normal",
    slot: "main",
    state,
    checksum: computeV47StateChecksum(state),
  }), "utf8");
}

function record(fixtureSha256, overrides = {}) {
  const node = { Id: 1001, PriorityClass: "High", ProcessorAffinity: "0xFFFF" };
  const nativeHost = { Id: 2002, PriorityClass: "Normal", ProcessorAffinity: "0xFFFF" };
  return {
    fixtureSha256,
    openCanonicalSha256: "b".repeat(64),
    preStepCanonicalSha256: "c".repeat(64),
    preStepDomainSha256: "d".repeat(64),
    measuredCanonicalSha256: "e".repeat(64),
    measuredDomainSha256: "f".repeat(64),
    nodePriority: "High",
    nodeAffinity: "0xFFFF",
    nativePriority: "Normal",
    nativeAffinity: "0xFFFF",
    requestedThreads: "8",
    profileEnabled: true,
    effectiveWorkerLimit: 8,
    observedWorkerCount: 8,
    writeBackWorkers: 4,
    processPolicy: {
      requested: { affinity: "0XFFFF", nodePriority: "High", nativePriority: "Normal" },
      before: { node, nativeHost },
      after: { node: { ...node }, nativeHost: { ...nativeHost } },
    },
    durationMs: 10,
    ...overrides,
  };
}

function binaryEvidence(binary) {
  const binarySha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  return { binarySha256, hostBinarySha256: binarySha256 };
}

function options(root) {
  return {
    baseline: path.join(root, "baseline.exe"),
    candidate: path.join(root, "candidate.exe"),
    fixture: path.join(root, "fixed.json"),
    output: path.join(root, "report.json"),
    runs: 3,
    threads: 8,
    affinity: "0XFFFF",
    nodePriority: "High",
    nativePriority: "Normal",
    timeoutMs: 60_000,
  };
}

function prepare() {
  const root = mkdtempSync(path.join(tmpdir(), "dsp-fixed-affinity-runner-"));
  const configured = options(root);
  writeFileSync(configured.baseline, "baseline");
  writeFileSync(configured.candidate, "candidate");
  generateAndPersistFixedV47Fixture({ outputPath: configured.fixture, generate: fixtureBytes });
  const harnessRoot = path.join(root, "harness-source");
  const harnessSnapshotPaths = [
    "scripts",
    "src",
    "desktop",
    "node_modules",
    "package.json",
    "package-lock.json",
    "vitest.config.ts",
  ];
  for (const [relativePath, contents] of [
    ["scripts/native-fixed-affinity-workload.mjs", "export const workload = true;\n"],
    ["scripts/native-fixed-v47-fixture.mjs", "export const fixture = true;\n"],
    ["scripts/benchmark-native-core-fixed-affinity-ab.mjs", "export const runner = true;\n"],
    ["src/game/nativeCoreRealSaveBenchmark.test.ts", "export const benchmark = true;\n"],
    ["desktop/native-host.cjs", "module.exports = {};\n"],
    ["node_modules/vitest/vitest.mjs", "export const vitest = true;\n"],
    ["package.json", "{\"type\":\"module\"}\n"],
    ["package-lock.json", "{\"lockfileVersion\":3}\n"],
    ["vitest.config.ts", "export default {};\n"],
  ]) {
    const destination = path.join(harnessRoot, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  const nodeExecutable = path.join(root, "node.exe");
  writeFileSync(nodeExecutable, "node-runtime");
  const stageParent = path.join(root, "stages");
  const runnerPath = path.join(harnessRoot, "scripts", "benchmark-native-core-fixed-affinity-ab.mjs");
  return { root, configured, harnessRoot, harnessSnapshotPaths, nodeExecutable, runnerPath, stageParent };
}

function dependencies(prepared, overrides = {}) {
  return {
    platform: "win32",
    harnessRoot: prepared.harnessRoot,
    harnessSnapshotPaths: prepared.harnessSnapshotPaths,
    nodeExecutable: prepared.nodeExecutable,
    runnerPath: prepared.runnerPath,
    stageParent: prepared.stageParent,
    ...overrides,
  };
}

test("argument parser names the evidence fixed-affinity and requires safe numeric settings", () => {
  const parsed = parseFixedAffinityArgs([
    "--baseline", `${ABS}${path.sep}baseline.exe`,
    "--candidate", `${ABS}${path.sep}candidate.exe`,
    "--fixture", `${ABS}${path.sep}fixed.json`,
    "--output", `${ABS}${path.sep}report.json`,
    "--runs", "3", "--threads", "8", "--affinity", "00FFFF",
    "--node-priority", "High", "--native-priority", "Normal",
  ]);
  assert.equal(parsed.affinity, "0XFFFF");
  assert.equal(parsed.runs * 2, 6);
  for (const value of ["0", "NaN", "1.5"]) {
    assert.throws(() => parseFixedAffinityArgs([
      "--baseline", `${ABS}${path.sep}baseline.exe`,
      "--candidate", `${ABS}${path.sep}candidate.exe`,
      "--fixture", `${ABS}${path.sep}fixed.json`,
      "--output", `${ABS}${path.sep}report.json`,
      "--threads", value,
    ]), /threads/);
  }
});

test("pinned launcher executes only staged paths and forwards the complete process policy", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dsp-fixed-affinity-launcher-"));
  try {
    mkdirSync(path.join(root, "harness"), { recursive: true });
    mkdirSync(path.join(root, "scratch"), { recursive: true });
    const captured = {};
    const times = [100, 125];
    const sample = runPinnedFixedAffinitySample({
      binary: path.join(root, "hosts", "candidate.exe"),
      fixture: path.join(root, "fixed.json"),
      fixtureSha256: "a".repeat(64),
      harnessRoot: path.join(root, "harness"),
      workloadPath: path.join(root, "harness", "scripts", "native-fixed-affinity-workload.mjs"),
      nodeExecutable: path.join(root, "node", "node.exe"),
      scratchRoot: path.join(root, "scratch"),
      threads: 8,
      affinity: "0000ffff",
      nodePriority: "High",
      nativePriority: "Normal",
      timeoutMs: 60_000,
    }, {
      platform: "win32",
      now: () => times.shift(),
      spawnSync: (executable, args, spawnOptions) => {
        Object.assign(captured, { executable, args, spawnOptions });
        return {
          status: 0,
          stdout: `DSP_NATIVE_FIXED_AFFINITY_SAMPLE\t${JSON.stringify({ durationMs: 10 })}\n`,
          stderr: "",
        };
      },
    });
    assert.equal(sample.elapsedWallMs, 25);
    assert.equal(captured.executable, "powershell.exe");
    assert.equal(captured.spawnOptions.cwd, path.join(root, "harness"));
    assert.equal(captured.spawnOptions.env.DSP_FIXED_AFFINITY_AFFINITY, "0XFFFF");
    assert.equal(captured.spawnOptions.env.DSP_FIXED_AFFINITY_NODE_PRIORITY, "High");
    assert.equal(captured.spawnOptions.env.DSP_FIXED_AFFINITY_NATIVE_PRIORITY, "Normal");
    assert.equal(captured.spawnOptions.env.DSP_FIXED_AFFINITY_STAGE_SCRATCH_ROOT, path.join(root, "scratch"));
    assert.equal(captured.spawnOptions.killSignal, "SIGKILL");
    const encodedIndex = captured.args.indexOf("-EncodedCommand");
    const powershell = Buffer.from(captured.args[encodedIndex + 1], "base64").toString("utf16le");
    assert.match(powershell, /DspFixedAffinityKillOnCloseJob/);
    assert.match(powershell, /AttachCurrentProcess/);
    assert.match(powershell, /DSP_FIXED_AFFINITY_JOB_ROOT_PID/);
    const encodedPayloads = [...powershell.matchAll(/FromBase64String\('([^']+)'\)/g)]
      .map((match) => Buffer.from(match[1], "base64").toString("utf8"));
    const jobSource = encodedPayloads.find((payload) => payload.includes("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE"));
    const command = encodedPayloads.find((payload) => payload.includes("start \"\" /b /wait"));
    assert.ok(jobSource);
    assert.match(jobSource, /AssignProcessToJobObject/);
    assert.ok(command);
    assert.match(command, /\/high \/affinity FFFF/);
    assert.ok(command.includes(`"${path.join(root, "node", "node.exe")}"`));
    assert.ok(command.includes(`"${path.join(root, "harness", "scripts", "native-fixed-affinity-workload.mjs")}"`));
    assert.equal(command.includes(process.execPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner accepts six interleaved samples only when fixture and all process evidence stay identical", () => {
  const prepared = prepare();
  const { root, configured } = prepared;
  try {
    const fixture = readFixedV47Fixture(configured.fixture);
    const observed = [];
    const sampleArguments = [];
    const report = runFixedAffinityAb(configured, dependencies(prepared, {
      runSample: (sampleOptions) => {
        sampleArguments.push(sampleOptions);
        return record(fixture.sha256, {
          ...binaryEvidence(sampleOptions.binary),
          durationMs: sampleOptions.binary.endsWith("candidate.exe") ? 8 : 10,
          privateDiagnostic: "SENSITIVE_SUCCESS_SAMPLE_FRAGMENT inventory=[do-not-persist]",
        });
      },
      onStageReady: (stage) => observed.push(stage),
    }));
    assert.equal(report.status, "RESULT");
    assert.deepEqual(report.reasonCodes, []);
    assert.equal(report.samples.length, 6);
    assert.deepEqual(report.configuration.order, ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate"]);
    assert.ok(Math.abs(report.summary.candidateReductionPercent - 20) < 1e-9);
    assert.match(report.claimBoundary, /not attested as P-core/);
    assert.match(report.claimBoundary, /non-malicious concurrent replacement/);
    assert.equal(observed.length, 1);
    assert.equal(sampleArguments.length, 8);
    assert.ok(sampleArguments.every((sample) =>
      sample.binary.startsWith(observed[0].root) &&
      sample.harnessRoot === observed[0].harness.stagedRoot &&
      sample.workloadPath === path.join(observed[0].harness.stagedRoot, "scripts", "native-fixed-affinity-workload.mjs") &&
      sample.nodeExecutable === observed[0].node.staged.path &&
      sample.affinity === "0XFFFF" && sample.nodePriority === "High" && sample.nativePriority === "Normal"));
    assert.notEqual(report.binaries.baseline.source.identity, report.binaries.baseline.staged.identity);
    assert.equal(report.binaries.baseline.source.sha256, report.binaries.baseline.staged.sha256);
    assert.equal(report.staging.harness.source.sha256, report.staging.harness.immediateStaged.sha256);
    assert.match(report.staging.harness.source.sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.staging.harness.source.entries.length, report.staging.harness.source.fileCount);
    assert.ok(report.staging.harness.source.entries.some((entry) =>
      entry.path === "scripts/benchmark-native-core-fixed-affinity-ab.mjs"));
    assert.equal(report.staging.outerRunner.source.sha256, report.staging.outerRunner.staged.sha256);
    assert.equal(report.staging.outerRunner.source.sha256, report.staging.outerRunner.finalSource.sha256);
    assert.equal(report.configuration.stagingExcludedFromMeasuredDurations, true);
    assert.equal(report.staging.cleanup.succeeded, true);
    assert.equal(existsSync(observed[0].root), false);
    assert.doesNotMatch(JSON.stringify(report), /\"type\":\"Buffer\"/);
    assert.equal(JSON.stringify(report).includes("SENSITIVE_SUCCESS_SAMPLE_FRAGMENT"), false);
    assert.equal(JSON.stringify(report).includes("do-not-persist"), false);
    assert.equal(JSON.stringify(report).includes(path.basename(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner emits NO_RESULT for child evidence drift and final fixture revalidation failure", () => {
  const prepared = prepare();
  const { root, configured } = prepared;
  try {
    const fixture = readFixedV47Fixture(configured.fixture);
    let calls = 0;
    const drift = runFixedAffinityAb(configured, dependencies(prepared, {
      runSample: ({ binary }) => {
        calls += 1;
        return record(fixture.sha256, {
          ...binaryEvidence(binary),
          ...(calls === 8 ? { observedWorkerCount: 4 } : {}),
        });
      },
    }));
    assert.equal(drift.status, "NO_RESULT");
    assert.ok(drift.reasonCodes.includes("worker-metadata-mismatch"));

    let reads = 0;
    const finalMismatch = runFixedAffinityAb(configured, dependencies(prepared, {
      readFixture: (filePath, expectedSha256) => {
        reads += 1;
        if (expectedSha256) throw new Error("changed after measured samples");
        return readFixedV47Fixture(filePath);
      },
      runSample: ({ binary }) => record(fixture.sha256, binaryEvidence(binary)),
    }));
    assert.ok(reads >= 2);
    assert.equal(finalMismatch.status, "NO_RESULT");
    assert.ok(finalMismatch.reasonCodes.includes("fixture-final-sha-mismatch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner fails closed when Windows processor groups make one affinity mask ambiguous", () => {
  const prepared = prepare();
  const { root, configured } = prepared;
  try {
    const report = runFixedAffinityAb(configured, dependencies(prepared, {
      logicalProcessorCount: 65,
      runSample: () => { throw new Error("must not launch"); },
    }));
    assert.equal(report.status, "NO_RESULT");
    assert.deepEqual(report.reasonCodes, ["unsupported-processor-groups"]);
    assert.equal(report.samples.length, 0);
    assert.equal(report.host.processorGroupPolicy, "unsupported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner binds every child Host SHA and rechecks both binaries after all samples", () => {
  const first = prepare();
  try {
    const fixture = readFixedV47Fixture(first.configured.fixture);
    const sampleMismatch = runFixedAffinityAb(first.configured, dependencies(first, {
      runSample: ({ binary }) => record(fixture.sha256, {
        ...binaryEvidence(binary),
        ...(binary.endsWith("candidate.exe") ? { hostBinarySha256: "0".repeat(64) } : {}),
      }),
    }));
    assert.equal(sampleMismatch.status, "NO_RESULT");
    assert.ok(sampleMismatch.reasonCodes.includes("binary-sha-mismatch"));
    assert.equal(sampleMismatch.samples.length, 0);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
  }

  const second = prepare();
  try {
    const fixture = readFixedV47Fixture(second.configured.fixture);
    let calls = 0;
    const finalMismatch = runFixedAffinityAb(second.configured, dependencies(second, {
      runSample: ({ binary }) => {
        calls += 1;
        const evidence = binaryEvidence(binary);
        if (calls === 8) writeFileSync(second.configured.baseline, "replaced-after-last-sample");
        return record(fixture.sha256, evidence);
      },
    }));
    assert.equal(finalMismatch.status, "NO_RESULT");
    assert.ok(finalMismatch.reasonCodes.includes("binary-final-sha-mismatch"));
    assert.notEqual(finalMismatch.finalBinaries.baseline.source.sha256, finalMismatch.binaries.baseline.sha256);
    assert.equal(finalMismatch.finalBinaries.baseline.staged.sha256, finalMismatch.binaries.baseline.sha256);
    assert.equal(finalMismatch.reasonCodes.includes("binary-staged-final-sha-mismatch"), false);
  } finally {
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("runner rejects symbolic-link or junction sources and removes the incomplete private stage", (context) => {
  const prepared = prepare();
  try {
    const realBaseline = path.join(prepared.root, "baseline-real.exe");
    writeFileSync(realBaseline, "baseline");
    rmSync(prepared.configured.baseline);
    let linkedHarnessRoot = prepared.harnessRoot;
    try {
      symlinkSync(realBaseline, prepared.configured.baseline, "file");
    } catch (error) {
      if (!["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) throw error;
      writeFileSync(prepared.configured.baseline, "baseline");
      linkedHarnessRoot = path.join(prepared.root, "harness-junction");
      try {
        symlinkSync(prepared.harnessRoot, linkedHarnessRoot, "junction");
      } catch (junctionError) {
        if (["EPERM", "EACCES", "UNKNOWN"].includes(junctionError?.code)) {
          context.skip(`symbolic-link and junction creation are unavailable: ${junctionError.code}`);
          return;
        }
        throw junctionError;
      }
    }
    let sampleCalls = 0;
    const report = runFixedAffinityAb(prepared.configured, dependencies(prepared, {
      harnessRoot: linkedHarnessRoot,
      runSample: () => { sampleCalls += 1; throw new Error("must not launch"); },
    }));
    assert.equal(report.status, "NO_RESULT");
    assert.ok(report.reasonCodes.includes("staging-failed"));
    assert.equal(report.staging.error.category, "staging");
    assert.equal(report.staging.error.code, "staging-failed");
    assert.equal(report.staging.error.redacted, true);
    assert.equal(sampleCalls, 0);
    assert.deepEqual(existsSync(prepared.stageParent) ? readdirSync(prepared.stageParent) : [], []);
  } finally {
    rmSync(prepared.root, { recursive: true, force: true });
  }
});

test("runner detects staged Host drift even when the original source remains unchanged", () => {
  const prepared = prepare();
  try {
    const fixture = readFixedV47Fixture(prepared.configured.fixture);
    let calls = 0;
    const report = runFixedAffinityAb(prepared.configured, dependencies(prepared, {
      runSample: ({ binary }) => {
        calls += 1;
        const evidence = binaryEvidence(binary);
        if (calls === 8) writeFileSync(binary, "staged-host-mutated-after-last-sample");
        return record(fixture.sha256, evidence);
      },
    }));
    assert.equal(report.status, "NO_RESULT");
    assert.ok(report.reasonCodes.includes("binary-staged-final-sha-mismatch"));
    assert.equal(report.finalBinaries.candidate.source.sha256, report.binaries.candidate.sha256);
    assert.notEqual(report.finalBinaries.candidate.staged.sha256, report.binaries.candidate.sha256);
    assert.equal(report.staging.cleanup.succeeded, true);
    assert.deepEqual(readdirSync(prepared.stageParent), []);
  } finally {
    rmSync(prepared.root, { recursive: true, force: true });
  }
});

test("runner binds the whole harness manifest and fails closed on source or staged closure drift", () => {
  const sourceDrift = prepare();
  try {
    const fixture = readFixedV47Fixture(sourceDrift.configured.fixture);
    let calls = 0;
    const report = runFixedAffinityAb(sourceDrift.configured, dependencies(sourceDrift, {
      runSample: ({ binary }) => {
        calls += 1;
        const evidence = binaryEvidence(binary);
        if (calls === 8) {
          writeFileSync(path.join(sourceDrift.harnessRoot, "src", "game", "nativeCoreRealSaveBenchmark.test.ts"),
            "export const benchmark = 'source-drift';\n");
        }
        return record(fixture.sha256, evidence);
      },
    }));
    assert.equal(report.status, "NO_RESULT");
    assert.ok(report.reasonCodes.includes("harness-final-manifest-mismatch"));
    assert.equal(report.reasonCodes.includes("harness-staged-final-manifest-mismatch"), false);
    assert.notEqual(report.staging.harness.finalSource.sha256, report.staging.harness.source.sha256);
    assert.equal(report.staging.harness.finalStaged.sha256, report.staging.harness.source.sha256);
    assert.deepEqual(readdirSync(sourceDrift.stageParent), []);
  } finally {
    rmSync(sourceDrift.root, { recursive: true, force: true });
  }

  const stagedDrift = prepare();
  try {
    const fixture = readFixedV47Fixture(stagedDrift.configured.fixture);
    let calls = 0;
    const report = runFixedAffinityAb(stagedDrift.configured, dependencies(stagedDrift, {
      runSample: ({ binary, harnessRoot }) => {
        calls += 1;
        const evidence = binaryEvidence(binary);
        if (calls === 8) {
          writeFileSync(path.join(harnessRoot, "node_modules", "vitest", "vitest.mjs"),
            "export const vitest = 'staged-drift';\n");
        }
        return record(fixture.sha256, evidence);
      },
    }));
    assert.equal(report.status, "NO_RESULT");
    assert.ok(report.reasonCodes.includes("harness-staged-final-manifest-mismatch"));
    assert.equal(report.reasonCodes.includes("harness-final-manifest-mismatch"), false);
    assert.equal(report.staging.harness.finalSource.sha256, report.staging.harness.source.sha256);
    assert.notEqual(report.staging.harness.finalStaged.sha256, report.staging.harness.source.sha256);
    assert.deepEqual(readdirSync(stagedDrift.stageParent), []);
  } finally {
    rmSync(stagedDrift.root, { recursive: true, force: true });
  }
});

test("runner binds the staged Node executable and treats cleanup failure as NO_RESULT", () => {
  const nodeDrift = prepare();
  try {
    const fixture = readFixedV47Fixture(nodeDrift.configured.fixture);
    let calls = 0;
    const report = runFixedAffinityAb(nodeDrift.configured, dependencies(nodeDrift, {
      runSample: ({ binary, nodeExecutable }) => {
        calls += 1;
        const evidence = binaryEvidence(binary);
        if (calls === 8) writeFileSync(nodeExecutable, "staged-node-drift");
        return record(fixture.sha256, evidence);
      },
    }));
    assert.equal(report.status, "NO_RESULT");
    assert.ok(report.reasonCodes.includes("node-staged-final-sha-mismatch"));
    assert.equal(report.staging.node.finalSource.sha256, report.staging.node.source.sha256);
    assert.notEqual(report.staging.node.finalStaged.sha256, report.staging.node.source.sha256);
    assert.deepEqual(readdirSync(nodeDrift.stageParent), []);
  } finally {
    rmSync(nodeDrift.root, { recursive: true, force: true });
  }

  const cleanupFailure = prepare();
  let leakedStage = null;
  try {
    const fixture = readFixedV47Fixture(cleanupFailure.configured.fixture);
    const report = runFixedAffinityAb(cleanupFailure.configured, dependencies(cleanupFailure, {
      runSample: ({ binary }) => record(fixture.sha256, binaryEvidence(binary)),
      cleanupStage: (stageRoot) => {
        leakedStage = stageRoot;
        return { attempted: true, succeeded: false, error: "synthetic-lock" };
      },
    }));
    assert.equal(report.status, "NO_RESULT");
    assert.ok(report.reasonCodes.includes("stage-cleanup-failed"));
    assert.equal(report.staging.cleanup.error.code, "stage-cleanup-failed");
    assert.equal(report.staging.cleanup.error.redacted, true);
    assert.equal(existsSync(leakedStage), true);
  } finally {
    if (leakedStage) rmSync(leakedStage, { recursive: true, force: true });
    rmSync(cleanupFailure.root, { recursive: true, force: true });
  }
});

test("runner records its already-loaded orchestration source and rejects final source drift", () => {
  const prepared = prepare();
  try {
    const fixture = readFixedV47Fixture(prepared.configured.fixture);
    let calls = 0;
    const report = runFixedAffinityAb(prepared.configured, dependencies(prepared, {
      runSample: ({ binary }) => {
        calls += 1;
        const evidence = binaryEvidence(binary);
        if (calls === 8) writeFileSync(prepared.runnerPath, "export const runner = 'drift';\n");
        return record(fixture.sha256, evidence);
      },
    }));
    assert.equal(report.status, "NO_RESULT");
    assert.ok(report.reasonCodes.includes("runner-final-sha-mismatch"));
    assert.ok(report.reasonCodes.includes("harness-final-manifest-mismatch"));
    assert.notEqual(report.staging.outerRunner.source.sha256, report.staging.outerRunner.finalSource.sha256);
    assert.equal(report.staging.outerRunner.staged.sha256, report.staging.outerRunner.source.sha256);
    assert.deepEqual(readdirSync(prepared.stageParent), []);
  } finally {
    rmSync(prepared.root, { recursive: true, force: true });
  }
});

test("CLI-level runner failure persists a non-overwriting NO_RESULT report", () => {
  const prepared = prepare();
  const { root, configured } = prepared;
  try {
    const exitCode = main([
      "--baseline", configured.baseline,
      "--candidate", configured.candidate,
      "--fixture", configured.fixture,
      "--output", configured.output,
      "--runs", "3", "--threads", "8", "--affinity", "FFFF",
      "--node-priority", "High", "--native-priority", "Normal",
      "--timeout-ms", "60000",
    ], dependencies(prepared, {
      runSample: () => {
        throw new Error("SENSITIVE_INVENTORY_SENTINEL entity-42 inputs=[player-material-fragment]");
      },
      logger: { log() {}, error() {} },
    }));
    assert.equal(exitCode, 1);
    const report = JSON.parse(readFileSync(configured.output, "utf8"));
    assert.equal(report.status, "NO_RESULT");
    assert.ok(report.reasonCodes.includes("preflight-process-failed"));
    assert.equal(report.preflight[0].failure.category, "child-process");
    assert.equal(report.preflight[0].failure.code, "child-process-failed");
    assert.equal(report.preflight[0].failure.redacted, true);
    assert.equal(JSON.stringify(report).includes("SENSITIVE_INVENTORY_SENTINEL"), false);
    assert.equal(JSON.stringify(report).includes("player-material-fragment"), false);
    assert.equal(JSON.stringify(report).includes(path.basename(root)), false);
    assert.equal(main([
      "--baseline", configured.baseline,
      "--candidate", configured.candidate,
      "--fixture", configured.fixture,
      "--output", configured.output,
    ], dependencies(prepared, { logger: { log() {}, error() {} } })), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("child exit reports never persist raw Vitest output or mismatch fragments", () => {
  const prepared = prepare();
  try {
    const report = runFixedAffinityAb(prepared.configured, dependencies(prepared, {
      runSample: (sampleOptions) => runPinnedFixedAffinitySample(sampleOptions, {
        platform: "win32",
        spawnSync: () => ({
          status: 1,
          signal: null,
          stdout: "SENSITIVE_VITEST_TAIL inventory=[rocket:999] entity=player-entity",
          stderr: "mismatchDetails inputs.outputs.private-player-fragment",
        }),
      }),
    }));
    assert.equal(report.status, "NO_RESULT");
    assert.equal(report.preflight[0].failure.code, "child-exit-nonzero");
    const persisted = JSON.stringify(report);
    for (const sentinel of [
      "SENSITIVE_VITEST_TAIL", "rocket:999", "player-entity",
      "mismatchDetails", "private-player-fragment", path.basename(prepared.root),
    ]) {
      assert.equal(persisted.includes(sentinel), false);
    }
  } finally {
    rmSync(prepared.root, { recursive: true, force: true });
  }
});

test("Windows timeout closes the Job Object tree and removes its private stage", { timeout: 20_000 }, (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows Job Object integration requires Windows");
    return;
  }
  const prepared = prepare();
  const pidFile = path.join(prepared.root, "job-tree-pids.json");
  const workloadPath = path.join(prepared.harnessRoot, "scripts", "native-fixed-affinity-workload.mjs");
  const nestedPath = path.join(prepared.harnessRoot, "scripts", "hanging-vitest.mjs");
  writeFileSync(workloadPath, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    `const pidFile = ${JSON.stringify(pidFile)};`,
    "const nested = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hanging-vitest.mjs');",
    "const vitest = spawn(process.execPath, [nested], {",
    "  stdio: 'ignore', windowsHide: true, env: { ...process.env, DSP_JOB_TREE_PID_FILE: pidFile },",
    "});",
    "fs.writeFileSync(pidFile, JSON.stringify({",
    "  powershell: Number(process.env.DSP_FIXED_AFFINITY_JOB_ROOT_PID),",
    "  cmd: process.ppid, workload: process.pid, vitest: vitest.pid,",
    "}));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  writeFileSync(nestedPath, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "const pidFile = process.env.DSP_JOB_TREE_PID_FILE;",
    "while (!fs.existsSync(pidFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
    "const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    "const sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'while ($true) { Start-Sleep -Milliseconds 100 }'], { stdio: 'ignore', windowsHide: true });",
    "const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));",
    "fs.writeFileSync(pidFile, JSON.stringify({ ...pids, vitest: process.pid, host: host.pid, sampler: sampler.pid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  prepared.configured.timeoutMs = 2_000;
  let stageRoot = null;
  try {
    const report = runFixedAffinityAb(prepared.configured, dependencies(prepared, {
      nodeExecutable: process.execPath,
      onStageReady: (stage) => { stageRoot = stage.root; },
      runSample: (sampleOptions) => runPinnedFixedAffinitySample(sampleOptions, {
        platform: "win32",
        timeoutGraceMs: 250,
      }),
    }));
    assert.equal(report.status, "NO_RESULT");
    assert.ok(report.reasonCodes.includes("preflight-process-failed"));
    assert.equal(report.preflight[0].failure.code, "child-timeout");
    assert.equal(report.preflight[0].failure.timedOut, true);
    assert.ok(stageRoot);
    assert.equal(existsSync(stageRoot), false);
    assert.deepEqual(readdirSync(prepared.stageParent), []);

    assert.equal(existsSync(pidFile), true);
    const recorded = JSON.parse(readFileSync(pidFile, "utf8"));
    const pids = Object.values(recorded).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    assert.equal(pids.length, 6);
    const isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error?.code !== "ESRCH";
      }
    };
    const deadline = Date.now() + 5_000;
    let alive = pids.filter(isAlive);
    while (alive.length > 0 && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      alive = pids.filter(isAlive);
    }
    assert.deepEqual(alive, []);
  } finally {
    rmSync(prepared.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
