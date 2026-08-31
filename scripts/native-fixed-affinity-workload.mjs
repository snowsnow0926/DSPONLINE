#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildFixedAffinityChildEnvironment,
  normalizeAffinity,
  readFixedV47Fixture,
} from "./native-fixed-v47-fixture.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const MARKER = /DSP_NATIVE_CORE_BENCHMARK\t([^\t\r\n]+)\t(\{[^\r\n]*\})/g;
const PRIORITY_CLASSES = new Set(["Idle", "BelowNormal", "Normal", "AboveNormal", "High", "RealTime"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM = 35_000;
const LOCAL_DISPATCH_INSTRUMENTATION_VERSION = "local-dispatch-profile-v3";
const LOCAL_DISPATCH_WORK_SCOPE = "shape-proxy-only-not-time-or-speedup";
const LOCAL_DISPATCH_PRODUCT_GATE = "full-advance-stage-share-times-parallelizable-share-at-least-3.5-percent";
const DURATION_ROUNDING_TOLERANCE_NS = 5_100;

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function ratioPpm(numerator, denominator) {
  if (denominator === 0) return 0;
  return Number((BigInt(numerator) * 1_000_000n) / BigInt(denominator));
}

function localDispatchShapeSha256(profile) {
  return createHash("sha256").update(JSON.stringify([
    profile.instrumentationVersion,
    profile.workScope,
    profile.selectedDemands,
    profile.totalDemands,
    profile.planetShards,
    profile.demandSlots,
    profile.peerEdges,
    profile.sortWorkUnits,
    profile.totalWorkUnits,
    profile.largestShardWorkUnits,
    profile.largestShardRatioPpm,
    profile.parallelizableWorkUnits,
    profile.parallelizableRatioPpm,
    profile.routeEvents,
    profile.shardWorkSha256,
    profile.planetIdentityProven,
    profile.scanFallback,
    profile.parallelFallback,
  ])).digest("hex");
}

function exactStructuredOperation(evidence, purpose, recordType) {
  const operation = evidence?.localDispatchProfileOperations?.[purpose === "local-dispatch-timing-v1" ? "timing" : "shape"];
  const channel = operation?.profileChannel;
  const binding = operation?.operationBinding;
  if (!channel || typeof channel !== "object" || Array.isArray(channel) ||
      channel.responseBound !== true ||
      channel.dropped !== false || channel.malformedCount !== 0 || channel.incomplete !== false ||
      channel.quiescent !== true || channel.timedOut !== false || !Array.isArray(channel.records) ||
      !binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error(`native benchmark structured ${purpose} profile operation is invalid`);
  }
  if (channel.records.length !== 1) {
    throw new Error(`native benchmark must emit exactly one ${purpose} profile record`);
  }
  const entry = channel.records[0];
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= 0) {
    throw new Error("native benchmark local-dispatch profile sequence is invalid");
  }
  const record = entry.record;
  const recordBinding = record?.operationBinding;
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      record.schemaVersion !== 2 || record.recordType !== recordType ||
      record.instrumentationVersion !== LOCAL_DISPATCH_INSTRUMENTATION_VERSION ||
      !recordBinding || typeof recordBinding !== "object" || Array.isArray(recordBinding) ||
      binding.protocol !== "native-core-advance-profile-v1" ||
      recordBinding.protocol !== binding.protocol ||
      !Number.isSafeInteger(binding.requestId) || binding.requestId <= 0 ||
      recordBinding.requestId !== binding.requestId ||
      !SHA256_PATTERN.test(binding.sessionIdSha256 ?? "") ||
      recordBinding.sessionIdSha256 !== binding.sessionIdSha256 ||
      !Number.isSafeInteger(binding.baseRevision) || binding.baseRevision < 0 ||
      recordBinding.baseRevision !== binding.baseRevision ||
      !Number.isSafeInteger(binding.measuredRevision) || binding.measuredRevision !== binding.baseRevision + 1 ||
      recordBinding.expectedMeasuredRevision !== binding.measuredRevision ||
      binding.profilePurpose !== purpose || recordBinding.profilePurpose !== purpose) {
    throw new Error(`native benchmark ${purpose} operation binding is inconsistent`);
  }
  return { record, binding };
}

export function normalizeLocalDispatchProfileEvidence(evidence, exact) {
  const timing = exactStructuredOperation(evidence, "local-dispatch-timing-v1", "local-dispatch-timing");
  const shape = exactStructuredOperation(evidence, "local-dispatch-shape-v1", "local-dispatch-planet-shards");
  if (timing.binding.requestId === shape.binding.requestId ||
      timing.binding.sessionIdSha256 === shape.binding.sessionIdSha256 ||
      timing.binding.baseRevision !== shape.binding.baseRevision ||
      timing.binding.measuredRevision !== shape.binding.measuredRevision ||
      evidence.shapeMeasuredCanonicalSha256 !== evidence.measuredCanonicalSha256 ||
      evidence.shapeMeasuredDomainSha256 !== evidence.measuredDomainSha256) {
    throw new Error("native benchmark timing and shape operations do not prove the same candidate state");
  }
  const fullAdvanceDurationNs = nonNegativeSafeInteger(
    evidence.fullAdvanceDurationNs,
    "native benchmark full advance duration",
  );
  if (fullAdvanceDurationNs === 0 || exact.nativeAdvanceDurationNs !== fullAdvanceDurationNs ||
      !Number.isFinite(exact.nativeAdvanceDurationMs) || exact.nativeAdvanceDurationMs <= 0 ||
      Math.abs(exact.nativeAdvanceDurationMs * 1_000_000 - fullAdvanceDurationNs) > DURATION_ROUNDING_TOLERANCE_NS) {
    throw new Error("native benchmark rounded and exact full advance durations are inconsistent");
  }
  if (timing.record.measurementScope !== "production-dispatch-only-observer-excluded") {
    throw new Error("native benchmark local-dispatch timing scope includes observer work");
  }
  const stageDurationNs = nonNegativeSafeInteger(
    timing.record.stageDurationNs,
    "local-dispatch production stage duration",
  );
  if (stageDurationNs > fullAdvanceDurationNs) {
    throw new Error("native benchmark local-dispatch duration exceeds full advance duration");
  }
  const profile = shape.record;
  if (profile.workScope !== LOCAL_DISPATCH_WORK_SCOPE || profile.productGate !== LOCAL_DISPATCH_PRODUCT_GATE) {
    throw new Error("native benchmark local-dispatch profile schema is unsupported");
  }
  const counters = {};
  for (const key of [
    "selectedDemands", "totalDemands", "planetShards", "demandSlots", "peerEdges", "sortWorkUnits", "totalWorkUnits",
    "largestShardWorkUnits", "largestShardRatioPpm", "parallelizableWorkUnits",
    "parallelizableRatioPpm", "routeEvents",
  ]) {
    counters[key] = nonNegativeSafeInteger(profile[key], `local-dispatch profile ${key}`);
  }
  if (counters.selectedDemands > counters.totalDemands ||
      counters.planetShards > counters.selectedDemands ||
      counters.totalWorkUnits !== counters.selectedDemands + counters.demandSlots + counters.peerEdges +
        counters.sortWorkUnits + counters.routeEvents ||
      counters.largestShardWorkUnits > counters.totalWorkUnits ||
      counters.largestShardRatioPpm !== ratioPpm(counters.largestShardWorkUnits, counters.totalWorkUnits) ||
      counters.parallelizableRatioPpm !== ratioPpm(counters.parallelizableWorkUnits, counters.totalWorkUnits)) {
    throw new Error("native benchmark local-dispatch profile work accounting is inconsistent");
  }
  if (typeof profile.planetIdentityProven !== "boolean" ||
      typeof profile.scanFallback !== "string" ||
      typeof profile.parallelFallback !== "string" ||
      !SHA256_PATTERN.test(profile.shardWorkSha256 ?? "")) {
    throw new Error("native benchmark local-dispatch profile shape is malformed");
  }
  if (!["none", "forced-full-scan", "directory", "dense"].includes(profile.scanFallback)) {
    throw new Error("native benchmark local-dispatch scan fallback is unsupported");
  }
  const expectedParallelizable = profile.planetIdentityProven
    ? counters.totalWorkUnits - counters.largestShardWorkUnits
    : 0;
  if (counters.parallelizableWorkUnits !== expectedParallelizable ||
      (!profile.planetIdentityProven && counters.largestShardWorkUnits !== counters.totalWorkUnits)) {
    throw new Error("native benchmark local-dispatch shard accounting is inconsistent");
  }
  const expectedParallelFallback = counters.selectedDemands === 0
    ? "no-selected-demand"
    : !profile.planetIdentityProven
      ? "unproven-planet"
      : counters.planetShards < 2
        ? "single-planet"
        : "shape-only-requires-full-advance-gate";
  if (profile.parallelFallback !== expectedParallelFallback) {
    throw new Error("native benchmark local-dispatch fallback is inconsistent");
  }
  const stageSharePpm = Number((BigInt(stageDurationNs) * 1_000_000n) / BigInt(fullAdvanceDurationNs));
  const parallelBenefitUpperBoundPpm = Number(
    (BigInt(stageSharePpm) * BigInt(counters.parallelizableRatioPpm)) / 1_000_000n,
  );
  const reasonCodes = [];
  if (profile.scanFallback !== "none") reasonCodes.push("local-dispatch-scan-fallback");
  if (!profile.planetIdentityProven) reasonCodes.push("local-dispatch-planet-identity-unproven");
  if (counters.planetShards < 2) reasonCodes.push("local-dispatch-planet-shards-insufficient");
  if (profile.parallelFallback !== "shape-only-requires-full-advance-gate") {
    reasonCodes.push("local-dispatch-parallel-fallback");
  }
  if (stageSharePpm < LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM) {
    reasonCodes.push("local-dispatch-stage-share-below-3.5-percent");
  }
  if (parallelBenefitUpperBoundPpm < LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM) {
    reasonCodes.push("local-dispatch-parallel-benefit-upper-bound-below-3.5-percent");
  }
  const normalized = {
    schemaVersion: 2,
    instrumentationVersion: profile.instrumentationVersion,
    workScope: profile.workScope,
    productGate: profile.productGate,
    ...counters,
    stageDurationNs,
    stageDurationMicros: Math.floor(stageDurationNs / 1_000),
    fullAdvanceDurationNs,
    stageSharePpm,
    parallelBenefitUpperBoundPpm,
    parallelBenefitUpperBoundScope: "theoretical-before-coordination-and-merge-overhead",
    shardWorkSha256: profile.shardWorkSha256,
    planetIdentityProven: profile.planetIdentityProven,
    scanFallback: profile.scanFallback,
    parallelFallback: profile.parallelFallback,
  };
  return {
    ...normalized,
    shapeSha256: localDispatchShapeSha256(normalized),
    gateStatus: reasonCodes.length === 0 ? "ELIGIBLE_FOR_FIXED_AB" : "NO_GO",
    gateReasonCodes: reasonCodes,
  };
}

function workloadFailure(code) {
  const error = new Error(code);
  error.fixedAffinityWorkloadFailureCode = code;
  return error;
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function parseBenchmarkRecords(output) {
  const records = {};
  for (const match of String(output).matchAll(MARKER)) {
    const [, label, json] = match;
    if (Object.hasOwn(records, label)) throw new Error(`duplicate native benchmark record: ${label}`);
    records[label] = JSON.parse(json);
  }
  return records;
}

export function fixedAffinityRecordFromBenchmark(records, expectedFixtureSha256) {
  const open = records.open?.nativeCore;
  const exact = records.exact?.nativeCoreExactRealSaveAdvance;
  const evidence = exact?.fixedAffinityEvidence;
  if (!open || !exact || !evidence?.processPolicy) {
    throw new Error("native benchmark did not emit fixed-affinity process-policy evidence");
  }
  if (open.exactRoundTrip !== true || exact.exactState !== true) {
    throw new Error("native benchmark semantic proof failed");
  }
  if (evidence.fixtureSha256 !== expectedFixtureSha256) {
    throw new Error(`workload fixture SHA-256 mismatch: expected ${expectedFixtureSha256}, received ${String(evidence.fixtureSha256)}`);
  }
  if (!Number.isFinite(exact.nativeAdvanceDurationMs) || exact.nativeAdvanceDurationMs <= 0) {
    throw new Error("native benchmark did not emit a positive measured duration");
  }
  const localDispatchProfile = normalizeLocalDispatchProfileEvidence(evidence, exact);
  const { localDispatchProfileOperations: _structuredOperations, ...boundedEvidence } = evidence;
  return {
    ...boundedEvidence,
    durationMs: exact.nativeAdvanceDurationMs,
    hostBinarySha256: open.hostBinarySha256,
    evidenceStatus: "RESULT",
    profileGate: {
      status: localDispatchProfile.gateStatus,
      thresholdPpm: LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM,
      theoreticalUpperBoundPpm: localDispatchProfile.parallelBenefitUpperBoundPpm,
      reasonCodes: localDispatchProfile.gateReasonCodes,
    },
    performanceDecision: {
      status: "NOT_EVALUATED",
      reasonCode: "profile-shape-and-stage-share-are-not-performance-benefit",
    },
    localDispatchProfile,
  };
}

export function runFixedAffinityWorkload({
  binary,
  fixture,
  fixtureSha256,
  threads,
  affinity,
  nodePriority,
  nativePriority,
  scratchRoot,
  timeoutMs = 600_000,
}, dependencies = {}) {
  if (!Number.isSafeInteger(threads) || threads <= 0) {
    throw new Error("fixed-affinity workload threads must be a positive safe integer");
  }
  const normalizedAffinity = normalizeAffinity(affinity);
  if (!PRIORITY_CLASSES.has(nodePriority)) {
    throw new Error("fixed-affinity workload Node priority is unsupported");
  }
  if (!PRIORITY_CLASSES.has(nativePriority)) {
    throw new Error("fixed-affinity workload Native Host priority is unsupported");
  }
  if (typeof scratchRoot !== "string" || !path.isAbsolute(scratchRoot)) {
    throw new Error("fixed-affinity workload scratch root must be an absolute path");
  }
  const scratchStat = fs.lstatSync(scratchRoot);
  if (scratchStat.isSymbolicLink() || !scratchStat.isDirectory()) {
    throw new Error("fixed-affinity workload scratch root must be a non-symbolic-link directory");
  }
  const spawn = dependencies.spawnSync ?? spawnSync;
  const readFixture = dependencies.readFixture ?? readFixedV47Fixture;
  const before = readFixture(fixture, fixtureSha256);
  const binarySha256 = sha256File(binary);
  const result = spawn(process.execPath, [
    path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
    "run",
    path.join(ROOT, "src", "game", "nativeCoreRealSaveBenchmark.test.ts"),
    "--reporter=dot",
    "--no-cache",
    "--maxWorkers=1",
    "--fileParallelism=false",
  ], {
    cwd: ROOT,
    env: buildFixedAffinityChildEnvironment(process.env, {
      DSP_RUN_NATIVE_CORE_BENCHMARK: "1",
      DSP_NATIVE_CORE_HOST_BINARY: binary,
      DSP_NATIVE_CORE_FIXTURE: fixture,
      DSP_NATIVE_CORE_EXPECTED_FIXTURE_SHA256: fixtureSha256,
      DSP_NATIVE_CORE_THREADS: String(threads),
      DSP_NATIVE_CORE_PROFILE: "1",
      DSP_NATIVE_CORE_BENCHMARK_AFFINITY: normalizedAffinity,
      DSP_NATIVE_CORE_BENCHMARK_NODE_PRIORITY: nodePriority,
      DSP_NATIVE_CORE_BENCHMARK_NATIVE_PRIORITY: nativePriority,
      DSP_NATIVE_CORE_BENCHMARK_SCRATCH_ROOT: scratchRoot,
      DSP_NATIVE_CORE_BENCHMARK_OPEN_ONLY: "0",
      DSP_NATIVE_CORE_BENCHMARK_EXACT_ONLY: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    }),
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error) {
    throw workloadFailure(result.error.code === "ETIMEDOUT" ? "vitest-timeout" :
      result.error.code === "ENOBUFS" ? "vitest-output-limit" : "vitest-launch-failed");
  }
  if (result.status !== 0) throw workloadFailure("vitest-exit-nonzero");
  const record = fixedAffinityRecordFromBenchmark(parseBenchmarkRecords(output), fixtureSha256);
  if (record.hostBinarySha256 !== binarySha256) throw new Error("native Host binary changed during fixed-affinity workload");
  const after = readFixture(fixture, fixtureSha256);
  if (before.sha256 !== after.sha256 || before.sizeBytes !== after.sizeBytes || !before.bytes.equals(after.bytes)) {
    throw new Error("fixed fixture changed during workload");
  }
  return { ...record, fixtureBytes: before.sizeBytes, binarySha256 };
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function main() {
  try {
    const record = runFixedAffinityWorkload({
      binary: path.resolve(requiredEnvironment("DSP_FIXED_AFFINITY_BINARY")),
      fixture: path.resolve(requiredEnvironment("DSP_FIXED_AFFINITY_FIXTURE")),
      fixtureSha256: requiredEnvironment("DSP_FIXED_AFFINITY_FIXTURE_SHA256"),
      threads: Number(requiredEnvironment("DSP_FIXED_AFFINITY_THREADS")),
      affinity: requiredEnvironment("DSP_FIXED_AFFINITY_AFFINITY"),
      nodePriority: requiredEnvironment("DSP_FIXED_AFFINITY_NODE_PRIORITY"),
      nativePriority: requiredEnvironment("DSP_FIXED_AFFINITY_NATIVE_PRIORITY"),
      scratchRoot: path.resolve(requiredEnvironment("DSP_FIXED_AFFINITY_STAGE_SCRATCH_ROOT")),
      timeoutMs: Number(process.env.DSP_FIXED_AFFINITY_TIMEOUT_MS ?? 600_000),
    });
    console.log(`DSP_NATIVE_FIXED_AFFINITY_SAMPLE\t${JSON.stringify(record)}`);
    return 0;
  } catch (error) {
    const code = typeof error?.fixedAffinityWorkloadFailureCode === "string"
      ? error.fixedAffinityWorkloadFailureCode
      : "workload-failed";
    console.error(`DSP_NATIVE_FIXED_AFFINITY_FAILURE\t${JSON.stringify({ code, redacted: true })}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SCRIPT_PATH.toLowerCase()) {
  process.exitCode = main();
}
