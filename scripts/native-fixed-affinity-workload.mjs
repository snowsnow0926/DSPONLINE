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
  return {
    ...evidence,
    durationMs: exact.nativeAdvanceDurationMs,
    hostBinarySha256: open.hostBinarySha256,
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
