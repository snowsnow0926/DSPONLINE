import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  fixedAffinityRecordFromBenchmark,
  parseBenchmarkRecords,
  runFixedAffinityWorkload,
} from "./native-fixed-affinity-workload.mjs";

function processPolicy() {
  const snapshot = (Id, PriorityClass) => ({ Id, PriorityClass, ProcessorAffinity: "0xFFFF" });
  return {
    requested: { affinity: "0XFFFF", nodePriority: "High", nativePriority: "Normal" },
    before: { node: snapshot(101, "High"), nativeHost: snapshot(202, "Normal") },
    after: { node: snapshot(101, "High"), nativeHost: snapshot(202, "Normal") },
  };
}

function operationBinding(purpose, requestId = purpose === "local-dispatch-timing-v1" ? 7 : 8) {
  return {
    protocol: "native-core-advance-profile-v1",
    requestId,
    sessionIdSha256: (purpose === "local-dispatch-timing-v1" ? "2" : "3").repeat(64),
    baseRevision: 2,
    measuredRevision: 3,
    profilePurpose: purpose,
  };
}

function recordOperationBinding(binding) {
  return {
    ...binding,
    expectedMeasuredRevision: binding.measuredRevision,
  };
}

function localDispatchTiming(overrides = {}) {
  const binding = operationBinding("local-dispatch-timing-v1");
  return {
    schemaVersion: 2,
    recordType: "local-dispatch-timing",
    instrumentationVersion: "local-dispatch-profile-v3",
    measurementScope: "production-dispatch-only-observer-excluded",
    stageDurationNs: 1_000_000,
    operationBinding: recordOperationBinding(binding),
    ...overrides,
  };
}

function localDispatchProfile(overrides = {}) {
  const binding = operationBinding("local-dispatch-shape-v1");
  return {
    schemaVersion: 2,
    recordType: "local-dispatch-planet-shards",
    instrumentationVersion: "local-dispatch-profile-v3",
    workScope: "shape-proxy-only-not-time-or-speedup",
    productGate: "full-advance-stage-share-times-parallelizable-share-at-least-3.5-percent",
    selectedDemands: 2,
    totalDemands: 2,
    planetShards: 2,
    demandSlots: 2,
    peerEdges: 2,
    sortWorkUnits: 0,
    totalWorkUnits: 8,
    largestShardWorkUnits: 4,
    largestShardRatioPpm: 500_000,
    parallelizableWorkUnits: 4,
    parallelizableRatioPpm: 500_000,
    routeEvents: 2,
    shardWorkSha256: "2".repeat(64),
    planetIdentityProven: true,
    scanFallback: "none",
    parallelFallback: "shape-only-requires-full-advance-gate",
    operationBinding: recordOperationBinding(binding),
    ...overrides,
  };
}

function localDispatchProfileChannel(profile, overrides = {}) {
  return {
    responseBound: true,
    dropped: false,
    malformedCount: 0,
    incomplete: false,
    quiescent: true,
    timedOut: false,
    records: [{ sequence: 1, record: profile }],
    ...overrides,
  };
}

function localDispatchProfileOperations({
  timingBinding = operationBinding("local-dispatch-timing-v1"),
  shapeBinding = operationBinding("local-dispatch-shape-v1"),
  timingRecord = localDispatchTiming(),
  shapeRecord = localDispatchProfile(),
  timingChannelOverrides = {},
  shapeChannelOverrides = {},
} = {}) {
  return {
    timing: {
      operationBinding: timingBinding,
      profileChannel: localDispatchProfileChannel(timingRecord, timingChannelOverrides),
    },
    shape: {
      operationBinding: shapeBinding,
      profileChannel: localDispatchProfileChannel(shapeRecord, shapeChannelOverrides),
    },
  };
}

function benchmarkOutput(evidence = {}, hostBinarySha256 = "b".repeat(64)) {
  const fixtureSha256 = "a".repeat(64);
  const open = {
    nativeCore: {
      hostBinarySha256,
      exactRoundTrip: true,
    },
  };
  const exact = {
    nativeCoreExactRealSaveAdvance: {
      exactState: true,
      nativeAdvanceDurationMs: 12.5,
      nativeAdvanceDurationNs: 12_500_000,
      fixedAffinityEvidence: {
        fixtureSha256,
        openCanonicalSha256: "c".repeat(64),
        preStepCanonicalSha256: "d".repeat(64),
        preStepDomainSha256: "e".repeat(64),
        measuredCanonicalSha256: "f".repeat(64),
        measuredDomainSha256: "1".repeat(64),
        shapeMeasuredCanonicalSha256: "f".repeat(64),
        shapeMeasuredDomainSha256: "1".repeat(64),
        nodePriority: "High",
        nodeAffinity: "0xFFFF",
        nativePriority: "Normal",
        nativeAffinity: "0xFFFF",
        requestedThreads: "8",
        profileEnabled: true,
        effectiveWorkerLimit: 8,
        observedWorkerCount: 8,
        writeBackWorkers: 4,
        fullAdvanceDurationNs: 12_500_000,
        localDispatchProfileOperations: localDispatchProfileOperations(),
        processPolicy: processPolicy(),
        ...evidence,
      },
    },
  };
  return {
    fixtureSha256,
    output: [
      `DSP_NATIVE_CORE_BENCHMARK\topen\t${JSON.stringify(open)}`,
      `DSP_NATIVE_CORE_BENCHMARK\texact\t${JSON.stringify(exact)}`,
    ].join("\n"),
  };
}

test("workload extracts the exact child fixture and fixed-affinity evidence", () => {
  const fixture = benchmarkOutput();
  const record = fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(fixture.output), fixture.fixtureSha256);
  assert.equal(record.fixtureSha256, fixture.fixtureSha256);
  assert.equal(record.hostBinarySha256, "b".repeat(64));
  assert.equal(record.durationMs, 12.5);
  assert.equal(record.observedWorkerCount, 8);
  assert.equal(record.evidenceStatus, "RESULT");
  assert.equal(record.profileGate.status, "ELIGIBLE_FOR_FIXED_AB");
  assert.equal(record.localDispatchProfile.stageSharePpm, 80_000);
  assert.equal(record.localDispatchProfile.parallelBenefitUpperBoundPpm, 40_000);
  assert.match(record.localDispatchProfile.shapeSha256, /^[a-f0-9]{64}$/);
  assert.equal(record.performanceDecision.status, "NOT_EVALUATED");
  assert.equal(Object.hasOwn(record, "localDispatchProfileOperations"), false);
});

test("workload passes the complete process policy to the real Vitest benchmark command", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dsp-fixed-affinity-workload-"));
  try {
    const binary = path.join(root, "dsp-native-host.exe");
    const fixture = path.join(root, "fixed.json");
    const scratchRoot = path.join(root, "scratch");
    const binaryBytes = Buffer.from("native-host-snapshot", "utf8");
    const fixtureBytes = Buffer.from("immutable-fixture", "utf8");
    const fixtureSha256 = "a".repeat(64);
    const binarySha256 = createHash("sha256").update(binaryBytes).digest("hex");
    writeFileSync(binary, binaryBytes);
    writeFileSync(fixture, fixtureBytes);
    mkdirSync(scratchRoot);
    const calls = [];
    const result = runFixedAffinityWorkload({
      binary,
      fixture,
      fixtureSha256,
      threads: 8,
      affinity: "0000ffff",
      nodePriority: "High",
      nativePriority: "Normal",
      scratchRoot,
      timeoutMs: 60_000,
    }, {
      readFixture(receivedPath, expectedSha256) {
        assert.equal(receivedPath, fixture);
        if (expectedSha256 !== undefined) assert.equal(expectedSha256, fixtureSha256);
        return { path: fixture, sha256: fixtureSha256, sizeBytes: fixtureBytes.length, bytes: Buffer.from(fixtureBytes) };
      },
      spawnSync(executable, args, options) {
        calls.push({ executable, args, options });
        return { status: 0, stdout: benchmarkOutput({}, binarySha256).output, stderr: "" };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, process.execPath);
    assert.ok(calls[0].args.some((argument) => argument.endsWith("nativeCoreRealSaveBenchmark.test.ts")));
    assert.ok(calls[0].args.includes("--no-cache"));
    assert.equal(calls[0].options.env.DSP_NATIVE_CORE_BENCHMARK_AFFINITY, "0XFFFF");
    assert.equal(calls[0].options.env.DSP_NATIVE_CORE_BENCHMARK_NODE_PRIORITY, "High");
    assert.equal(calls[0].options.env.DSP_NATIVE_CORE_BENCHMARK_NATIVE_PRIORITY, "Normal");
    assert.equal(calls[0].options.env.DSP_NATIVE_CORE_BENCHMARK_SCRATCH_ROOT, scratchRoot);
    assert.equal(calls[0].options.env.DSP_NATIVE_CORE_THREADS, "8");
    assert.equal(result.binarySha256, binarySha256);
    assert.deepEqual(result.processPolicy.before, processPolicy().before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workload refuses to launch when Native Host priority is absent", () => {
  assert.throws(() => runFixedAffinityWorkload({
    binary: "unused",
    fixture: "unused",
    fixtureSha256: "a".repeat(64),
    threads: 8,
    affinity: "FFFF",
    nodePriority: "High",
    nativePriority: undefined,
  }), /Native Host priority is unsupported/);
});

test("workload rejects duplicate records, semantic failure, and wrong child fixture", () => {
  const fixture = benchmarkOutput();
  assert.throws(
    () => parseBenchmarkRecords(`${fixture.output}\n${fixture.output.split("\n")[0]}`),
    /duplicate native benchmark record/,
  );
  assert.throws(
    () => fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(fixture.output), "0".repeat(64)),
    /workload fixture SHA-256 mismatch/,
  );
  const failed = fixture.output.replace('"exactState":true', '"exactState":false');
  assert.throws(
    () => fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(failed), fixture.fixtureSha256),
    /semantic proof failed/,
  );
  const missingDuration = fixture.output.replace('"nativeAdvanceDurationMs":12.5', '"nativeAdvanceDurationMs":null');
  assert.throws(
    () => fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(missingDuration), fixture.fixtureSha256),
    /positive measured duration/,
  );
  const missingPolicy = fixture.output.replace(`,"processPolicy":${JSON.stringify(processPolicy())}`, "");
  assert.throws(
    () => fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(missingPolicy), fixture.fixtureSha256),
    /process-policy evidence/,
  );
});

test("workload fails closed on missing, malformed, truncated, or inconsistent structured profile evidence", () => {
  const invalidEvidence = [
    { localDispatchProfileOperations: undefined },
    { localDispatchProfileOperations: localDispatchProfileOperations({ timingChannelOverrides: { responseBound: false } }) },
    { localDispatchProfileOperations: localDispatchProfileOperations({ timingChannelOverrides: { dropped: true } }) },
    { localDispatchProfileOperations: localDispatchProfileOperations({ shapeChannelOverrides: { malformedCount: 1 } }) },
    { localDispatchProfileOperations: localDispatchProfileOperations({ shapeChannelOverrides: { incomplete: true } }) },
    { localDispatchProfileOperations: localDispatchProfileOperations({ shapeChannelOverrides: { quiescent: false, timedOut: true } }) },
    { localDispatchProfileOperations: localDispatchProfileOperations({ shapeRecord: localDispatchProfile({ totalWorkUnits: 9 }) }) },
    { localDispatchProfileOperations: localDispatchProfileOperations({ shapeRecord: localDispatchProfile({ instrumentationVersion: "old" }) }) },
    { localDispatchProfileOperations: localDispatchProfileOperations({
      timingChannelOverrides: { records: [
        { sequence: 1, record: localDispatchTiming() },
        { sequence: 2, record: localDispatchTiming() },
      ] },
    }) },
  ];
  for (const evidence of invalidEvidence) {
    const fixture = benchmarkOutput(evidence);
    assert.throws(
      () => fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(fixture.output), fixture.fixtureSha256),
      /profile|structured|operation binding/i,
    );
  }
});

test("workload reports low stage share, one shard, and scan fallback as NO_GO without claiming benefit", () => {
  const cases = [
    {
      evidence: { localDispatchProfileOperations: localDispatchProfileOperations({
        timingRecord: localDispatchTiming({ stageDurationNs: 100_000 }),
      }) },
      reason: "local-dispatch-stage-share-below-3.5-percent",
    },
    {
      evidence: { localDispatchProfileOperations: localDispatchProfileOperations({ shapeRecord: localDispatchProfile({
        planetShards: 1,
        largestShardWorkUnits: 8,
        largestShardRatioPpm: 1_000_000,
        parallelizableWorkUnits: 0,
        parallelizableRatioPpm: 0,
        parallelFallback: "single-planet",
      }) }) },
      reason: "local-dispatch-planet-shards-insufficient",
    },
    {
      evidence: { localDispatchProfileOperations: localDispatchProfileOperations({
        shapeRecord: localDispatchProfile({ scanFallback: "dense" }),
      }) },
      reason: "local-dispatch-scan-fallback",
    },
    {
      evidence: { localDispatchProfileOperations: localDispatchProfileOperations({ shapeRecord: localDispatchProfile({
        totalWorkUnits: 1_000_001,
        largestShardWorkUnits: 1_000_000,
        largestShardRatioPpm: 999_999,
        parallelizableWorkUnits: 1,
        parallelizableRatioPpm: 0,
        sortWorkUnits: 999_993,
      }) }) },
      reason: "local-dispatch-parallel-benefit-upper-bound-below-3.5-percent",
    },
  ];
  for (const { evidence, reason } of cases) {
    const fixture = benchmarkOutput(evidence);
    const record = fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(fixture.output), fixture.fixtureSha256);
    assert.equal(record.evidenceStatus, "RESULT");
    assert.equal(record.profileGate.status, "NO_GO");
    assert.ok(record.profileGate.reasonCodes.includes(reason));
    assert.equal(record.performanceDecision.status, "NOT_EVALUATED");
  }
});

test("workload cross-binds rounded duration, exact nanoseconds, operation identity, and candidate hashes", () => {
  for (const evidence of [
    { fullAdvanceDurationNs: 1_000_000_000 },
    { shapeMeasuredCanonicalSha256: "9".repeat(64) },
    { localDispatchProfileOperations: localDispatchProfileOperations({
      shapeBinding: { ...operationBinding("local-dispatch-shape-v1"), requestId: 7 },
    }) },
  ]) {
    const fixture = benchmarkOutput(evidence);
    assert.throws(
      () => fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(fixture.output), fixture.fixtureSha256),
      /duration|candidate state|operation binding/i,
    );
  }
});
