#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const MARKER = /DSP_NATIVE_CORE_BENCHMARK\t([^\t\r\n]+)\t(\{[^\r\n]*\})/g;
const SUPPORTED_THREAD_SETTINGS = new Set(["auto", "1", "2", "4", "8"]);
const SYNC_RECORD_DROP_ENV = "DSP_NATIVE_CORE_SYNC_RECORD_DROP";
const METRICS = {
  openDurationMs: ["open", "nativeCore", "openDurationMs"],
  openPrivateBytesDelta: ["open", "nativeCore", "processPrivateBytesDelta"],
  openPeakPrivateBytes: ["open", "nativeCore", "processPrivateBytesPeakDuringOpen"],
  openPeakPrivateBytesDelta: ["open", "nativeCore", "processPrivateBytesPeakDeltaDuringOpen"],
  commandDurationMs: ["admission", "nativeCoreAdmission", "commandDurationMs"],
  commandPrivateBytesDelta: ["admission", "nativeCoreAdmission", "commandPrivateBytesDelta"],
  nativeAdvanceDurationMs: ["exact", "nativeCoreExactRealSaveAdvance", "nativeAdvanceDurationMs"],
  nativeAdvancePeakPrivateBytes: ["exact", "nativeCoreExactRealSaveAdvance", "processPrivateBytesPeakDuringAdvance"],
  nativeAdvancePeakPrivateBytesDelta: ["exact", "nativeCoreExactRealSaveAdvance", "processPrivateBytesPeakDeltaDuringAdvance"],
  nativeBurst3DurationMs: ["burst", "nativeCoreExactBurst", "durationMs"],
  nativeBurst3PeakPrivateBytes: ["burst", "nativeCoreExactBurst", "processPrivateBytesPeakDuringBurst"],
  nativeBurst3PeakPrivateBytesDelta: ["burst", "nativeCoreExactBurst", "processPrivateBytesPeakDeltaDuringBurst"],
  nativeMeasuredWorkflowPeakPrivateBytes: ["burst", "nativeCoreExactBurst", "processPrivateBytesPeakAcrossMeasuredPhases"],
  javascriptAdvanceDurationMs: ["exact", "nativeCoreExactRealSaveAdvance", "jsAdvanceDurationMs"],
  deferredDiagnosticsDurationMs: ["exact", "nativeCoreExactRealSaveAdvance", "deferredDiagnosticsDurationMs"],
  cachedDiagnosticsDurationMs: ["exact", "nativeCoreExactRealSaveAdvance", "cachedDiagnosticsDurationMs"],
  integratedAdvanceAndProofDurationMs: ["integrated", "nativeCoreIntegratedDiagnostics", "advanceAndProofDurationMs"],
  cachedIntegratedStatusDurationMs: ["integrated", "nativeCoreIntegratedDiagnostics", "cachedStatusDurationMs"],
  durableAuthorityDurationMs: ["durable", "nativeCoreDurableAuthority", "durationMs"],
  durableAuthorityPrivateBytesDelta: ["durable", "nativeCoreDurableAuthority", "privateBytesDelta"],
  durableDuplicateRetryDurationMs: ["durable", "nativeCoreDurableAuthority", "duplicateRetryDurationMs"],
  incrementalCheckpointDurationMs: ["checkpoint", "nativeCoreIncrementalCheckpoint", "durationMs"],
  incrementalCheckpointChangedBytes: ["checkpoint", "nativeCoreIncrementalCheckpoint", "changedBytes"],
};

function usage(message) {
  if (message) console.error(message);
  console.error([
    "Usage:",
    "  node scripts/benchmark-native-core-ab.mjs \\",
    "    --baseline <absolute-host-path> --candidate <absolute-host-path> \\",
    "    --fixture <absolute-save-path> --output <absolute-json-path> [options]",
    "",
    "Options:",
    "  --runs <n>          Interleaved samples per binary (default: 3, range: 1..20)",
    "  --threads <value>   DSP_NATIVE_CORE_THREADS (default: auto)",
    "  --scenario <name>   open, exact, or full (default: full)",
    "  --baseline-sync-record-drop  Set exact sync record drop only for baseline children",
    "  --candidate-sync-record-drop Set exact sync record drop only for candidate children",
    "  --timeout-ms <n>    Timeout for each benchmark process (default: 600000)",
    "  --force             Replace an existing output file",
  ].join("\n"));
  process.exitCode = 2;
}

function parseArgs(argv) {
  const options = {
    runs: 3,
    threads: "auto",
    scenario: "full",
    timeoutMs: 600_000,
    force: false,
    baselineSyncRecordDrop: false,
    candidateSyncRecordDrop: false,
  };
  const valueFlags = new Map([
    ["--baseline", "baseline"],
    ["--candidate", "candidate"],
    ["--fixture", "fixture"],
    ["--output", "output"],
    ["--runs", "runs"],
    ["--threads", "threads"],
    ["--scenario", "scenario"],
    ["--timeout-ms", "timeoutMs"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--baseline-sync-record-drop") {
      options.baselineSyncRecordDrop = true;
      continue;
    }
    if (argument === "--candidate-sync-record-drop") {
      options.candidateSyncRecordDrop = true;
      continue;
    }
    const key = valueFlags.get(argument);
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    options[key] = value;
    index += 1;
  }
  options.runs = Number(options.runs);
  options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 20) {
    throw new Error("--runs must be an integer in the range 1..20");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 60_000) {
    throw new Error("--timeout-ms must be an integer of at least 60000");
  }
  if (!SUPPORTED_THREAD_SETTINGS.has(String(options.threads))) {
    throw new Error("--threads must be one of: auto, 1, 2, 4, 8");
  }
  if (!["open", "exact", "full"].includes(String(options.scenario))) {
    throw new Error("--scenario must be one of: open, exact, full");
  }
  for (const key of ["baseline", "candidate", "fixture", "output"]) {
    if (!options[key]) throw new Error(`Missing required --${key}`);
    if (!path.isAbsolute(options[key])) throw new Error(`--${key} must be an absolute path`);
    options[key] = path.normalize(options[key]);
  }
  return options;
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function identity(filePath) {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: hashFile(filePath),
  };
}

function systemSnapshot() {
  const snapshot = {
    capturedAt: new Date().toISOString(),
    freeMemoryBytes: os.freemem(),
    totalMemoryBytes: os.totalmem(),
    loadAverage: os.loadavg(),
  };
  if (process.platform !== "win32") return snapshot;
  const script = [
    "$ErrorActionPreference='Stop'",
    "Get-Process | Sort-Object PrivateMemorySize64 -Descending | Select-Object -First 12 Id,ProcessName,CPU,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status === 0 && result.stdout.trim()) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      snapshot.topProcessesByPrivateBytes = Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      snapshot.processSnapshotError = `invalid-json: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    snapshot.processSnapshotError = result.error?.message ?? result.stderr?.trim() ?? `exit-${result.status}`;
  }
  return snapshot;
}

function parseRecords(output) {
  const records = {};
  for (const match of output.matchAll(MARKER)) {
    const [, label, json] = match;
    if (Object.hasOwn(records, label)) throw new Error(`Duplicate benchmark record: ${label}`);
    records[label] = JSON.parse(json);
  }
  return records;
}

function assertExact(records, binaryIdentity, scenario) {
  const open = records.open?.nativeCore;
  const admission = records.admission?.nativeCoreAdmission;
  const exact = records.exact?.nativeCoreExactRealSaveAdvance;
  const integrated = records.integrated?.nativeCoreIntegratedDiagnostics;
  const durable = records.durable?.nativeCoreDurableAuthority;
  const checkpoint = records.checkpoint?.nativeCoreIncrementalCheckpoint;
  const burst = records.burst?.nativeCoreExactBurst;
  const required = scenario === "open"
    ? ["open"]
    : scenario === "exact"
      ? ["open", "admission", "exact"]
      : ["open", "admission", "exact", "integrated", "durable", "checkpoint", "burst"];
  if (required.some((key) => !records[key])) {
    throw new Error(`Missing required benchmark records: ${required.filter((key) => !records[key]).join(", ")}`);
  }
  if (open.hostBinarySha256 !== binaryIdentity.sha256) throw new Error("Host binary changed during benchmark run");
  if (open.exactRoundTrip !== true) throw new Error("Native open/round-trip hash is not exact");
  if (scenario !== "open") {
    if (admission.supported !== true) throw new Error(`Native authority admission rejected: ${admission.reason ?? "unknown"}`);
    if (exact.exactState !== true || !Array.isArray(exact.fieldMismatches) || exact.fieldMismatches.length !== 0) {
      throw new Error("One-second native result differs from the JavaScript authority result");
    }
  }
  if (scenario === "full") {
    if (integrated.exactState !== true) throw new Error("Integrated advance/proof result is not exact");
    if (durable.exactState !== true || durable.duplicateRetry !== true) {
      throw new Error("Durable native authority result or idempotent retry is not exact");
    }
    if (checkpoint.exactState !== true) throw new Error("Incremental checkpoint changed the authoritative state");
    if (burst.exactState !== true || burst.steps !== 3) throw new Error("Back-to-back native exact burst differs from JavaScript authority");
  }
  if (process.platform === "win32") {
    const samplers = [["open", open.privatePeakSampler]];
    if (scenario !== "open") samplers.push(["advance", exact.privatePeakSampler]);
    if (scenario === "full") samplers.push(["burst", burst.privatePeakSampler]);
    for (const [phase, sampler] of samplers) {
      if (sampler?.error !== null || sampler?.samplingCadenceValid !== true
        || !Number.isInteger(sampler?.intervalSampleCount) || sampler.intervalSampleCount < 1
        || !Number.isFinite(sampler?.intervalP95Ms) || sampler.intervalP95Ms > sampler.intervalMs * 2
        || !Number.isFinite(sampler?.intervalMaxMs) || sampler.intervalMaxMs > sampler.intervalMs * 5
        || !Number.isSafeInteger(sampler?.pid) || !Number.isSafeInteger(sampler?.samplerPid)
        || sampler.pid === sampler.samplerPid || !Number.isFinite(sampler?.peakBytes) || sampler.peakBytes <= 0
        || !Number.isInteger(sampler?.sampleCount) || sampler.sampleCount < 2) {
        throw new Error(`Windows ${phase} Private Bytes peak sampler is incomplete: ${JSON.stringify(sampler ?? null)}`);
      }
    }
  }
}

function valueAt(records, pathParts) {
  let value = records;
  for (const key of pathParts) value = value?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function runOne({
  label,
  binary,
  binaryIdentity,
  fixture,
  threads,
  scenario,
  timeoutMs,
  sequence,
  syncRecordDrop,
}) {
  const before = systemSnapshot();
  const startedAt = Date.now();
  const vitest = path.resolve("node_modules", "vitest", "vitest.mjs");
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== SYNC_RECORD_DROP_ENV),
  );
  if (syncRecordDrop) childEnvironment[SYNC_RECORD_DROP_ENV] = "1";
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "src/game/nativeCoreRealSaveBenchmark.test.ts",
    "--reporter=verbose",
    "--maxWorkers=1",
    "--fileParallelism=false",
  ], {
    cwd: process.cwd(),
    env: {
      ...childEnvironment,
      DSP_RUN_NATIVE_CORE_BENCHMARK: "1",
      DSP_NATIVE_CORE_HOST_BINARY: binary,
      DSP_NATIVE_CORE_FIXTURE: fixture,
      DSP_NATIVE_CORE_THREADS: String(threads),
      DSP_NATIVE_CORE_BENCHMARK_OPEN_ONLY: scenario === "open" ? "1" : "0",
      DSP_NATIVE_CORE_BENCHMARK_EXACT_ONLY: scenario === "exact" ? "1" : "0",
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error) throw new Error(`${label} run ${sequence} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const tail = combinedOutput.slice(-12_000);
    throw new Error(`${label} run ${sequence} exited ${result.status}${result.signal ? ` (${result.signal})` : ""}:\n${tail}`);
  }
  const records = parseRecords(combinedOutput);
  assertExact(records, binaryIdentity, scenario);
  const metrics = Object.fromEntries(Object.entries(METRICS).map(([name, pathParts]) => [name, valueAt(records, pathParts)]));
  return {
    sequence,
    label,
    syncRecordDrop,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    systemBefore: before,
    systemAfter: systemSnapshot(),
    metrics,
    records,
  };
}

function quantileNearestRank(values, percentile) {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function median(values) {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(samples) {
  const result = {};
  for (const metric of Object.keys(METRICS)) {
    const values = samples.map((sample) => sample.metrics[metric]).filter((value) => value !== null);
    result[metric] = {
      samples: values,
      median: median(values),
      p95NearestRank: quantileNearestRank(values, 0.95),
      minimum: values.length ? Math.min(...values) : null,
      maximum: values.length ? Math.max(...values) : null,
    };
  }
  return result;
}

function compare(baselineSummary, candidateSummary) {
  const result = {};
  for (const metric of Object.keys(METRICS)) {
    const baseline = baselineSummary[metric].median;
    const candidate = candidateSummary[metric].median;
    result[metric] = baseline !== null && candidate !== null && baseline !== 0 && candidate !== 0
      ? {
          baselineMedian: baseline,
          candidateMedian: candidate,
          baselineOverCandidate: baseline / candidate,
          candidateReductionPercent: ((baseline - candidate) / baseline) * 100,
        }
      : null;
  }
  return result;
}

function writeAtomic(outputPath, document, force) {
  const parent = path.dirname(outputPath);
  fs.mkdirSync(parent, { recursive: true });
  if (!force && fs.existsSync(outputPath)) throw new Error(`Output already exists (pass --force to replace): ${outputPath}`);
  const temporary = path.join(parent, `.${path.basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (force && fs.existsSync(outputPath)) fs.rmSync(outputPath);
    fs.renameSync(temporary, outputPath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
    return;
  }
  if (options.help) {
    usage();
    process.exitCode = 0;
    return;
  }
  for (const key of ["baseline", "candidate", "fixture"]) {
    if (!fs.existsSync(options[key]) || !fs.statSync(options[key]).isFile()) throw new Error(`${key} is not a file: ${options[key]}`);
  }
  if (!options.force && fs.existsSync(options.output)) {
    throw new Error(`Output already exists (pass --force to replace): ${options.output}`);
  }
  const modesDiffer = options.baselineSyncRecordDrop !== options.candidateSyncRecordDrop;
  if (!modesDiffer
    && path.normalize(options.baseline).toLowerCase() === path.normalize(options.candidate).toLowerCase()) {
    throw new Error("Baseline and candidate paths must be different");
  }
  const baseline = identity(options.baseline);
  const candidate = identity(options.candidate);
  if (!modesDiffer && baseline.sha256 === candidate.sha256) {
    throw new Error("Baseline and candidate binaries have the same SHA-256");
  }
  const fixtureBefore = identity(options.fixture);
  const host = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    totalMemoryBytes: os.totalmem(),
  };
  const samples = [];
  let sequence = 0;
  let activeLabel = null;
  try {
    for (let round = 0; round < options.runs; round += 1) {
      const order = round % 2 === 0
        ? ["baseline", "candidate"]
        : ["candidate", "baseline"];
      for (const label of order) {
        const binaryIdentity = label === "baseline" ? baseline : candidate;
        const syncRecordDrop = label === "baseline"
          ? options.baselineSyncRecordDrop
          : options.candidateSyncRecordDrop;
        sequence += 1;
        activeLabel = label;
        console.error(
          `[${sequence}/${options.runs * 2}] ${label} ${binaryIdentity.sha256.slice(0, 12)}`
          + ` record-drop=${syncRecordDrop ? "joined" : "deferred"}...`,
        );
        samples.push(runOne({
          label,
          binary: binaryIdentity.path,
          binaryIdentity,
          fixture: options.fixture,
          threads: options.threads,
          scenario: options.scenario,
          timeoutMs: options.timeoutMs,
          sequence,
          syncRecordDrop,
        }));
      }
    }
  } catch (error) {
    let fixtureAfter = null;
    let fixtureIdentityError = null;
    try {
      fixtureAfter = identity(options.fixture);
    } catch (identityError) {
      fixtureIdentityError = identityError instanceof Error ? identityError.message : String(identityError);
    }
    const fixtureUnchanged = fixtureAfter !== null
      && fixtureBefore.sha256 === fixtureAfter.sha256
      && fixtureBefore.sizeBytes === fixtureAfter.sizeBytes
      && fixtureBefore.mtimeMs === fixtureAfter.mtimeMs;
    const failure = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      benchmark: "native-core-real-save-interleaved-ab",
      status: "failed",
      command: {
        runsPerBinary: options.runs,
        threads: String(options.threads),
        scenario: options.scenario,
        timeoutMsPerRun: options.timeoutMs,
        baselineSyncRecordDrop: options.baselineSyncRecordDrop,
        candidateSyncRecordDrop: options.candidateSyncRecordDrop,
        plannedSamples: options.runs * 2,
        completedOrder: samples.map((sample) => sample.label),
      },
      host,
      binaries: { baseline, candidate },
      fixture: {
        before: fixtureBefore,
        after: fixtureAfter,
        unchanged: fixtureUnchanged,
        identityError: fixtureIdentityError,
      },
      validation: {
        allProcessesExitedZero: false,
        fixtureUnchanged,
      },
      failedSample: { sequence, label: activeLabel },
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      samples,
    };
    writeAtomic(options.output, failure, options.force);
    throw new Error(`A/B benchmark failed; partial evidence written to ${options.output}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fixtureAfter = identity(options.fixture);
  const fixtureUnchanged = fixtureBefore.sha256 === fixtureAfter.sha256
    && fixtureBefore.sizeBytes === fixtureAfter.sizeBytes
    && fixtureBefore.mtimeMs === fixtureAfter.mtimeMs;
  if (!fixtureUnchanged) throw new Error("Fixture changed during the read-only A/B benchmark");
  const baselineSummary = summarize(samples.filter((sample) => sample.label === "baseline"));
  const candidateSummary = summarize(samples.filter((sample) => sample.label === "candidate"));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    benchmark: "native-core-real-save-interleaved-ab",
    status: "completed",
    command: {
      runsPerBinary: options.runs,
      threads: String(options.threads),
      scenario: options.scenario,
      timeoutMsPerRun: options.timeoutMs,
      baselineSyncRecordDrop: options.baselineSyncRecordDrop,
      candidateSyncRecordDrop: options.candidateSyncRecordDrop,
      order: samples.map((sample) => sample.label),
    },
    host,
    binaries: { baseline, candidate },
    fixture: { before: fixtureBefore, after: fixtureAfter, unchanged: fixtureUnchanged },
    validation: {
      allProcessesExitedZero: true,
      allOpenRoundTripsExact: true,
      allNativeAdvancesMatchJavascript: options.scenario === "open" ? "not-run" : true,
      allIntegratedProofsExact: options.scenario === "full" ? true : "not-run",
      allDurableAuthorityCommitsExactAndIdempotent: options.scenario === "full" ? true : "not-run",
      allIncrementalCheckpointsExact: options.scenario === "full" ? true : "not-run",
      allBackToBackNativeBurstsExact: options.scenario === "full" ? true : "not-run",
      allWindowsPrivatePeakSamplesValid: process.platform !== "win32" || samples.every((sample) =>
        sample.records.open?.nativeCore?.privatePeakSampler?.error === null
        && (options.scenario === "open" || sample.records.exact?.nativeCoreExactRealSaveAdvance?.privatePeakSampler?.error === null)
        && (options.scenario !== "full" || sample.records.burst?.nativeCoreExactBurst?.privatePeakSampler?.error === null)),
    },
    summary: { baseline: baselineSummary, candidate: candidateSummary },
    comparison: compare(baselineSummary, candidateSummary),
    samples,
  };
  writeAtomic(options.output, report, options.force);
  console.log(JSON.stringify({ output: options.output, comparison: report.comparison, fixtureUnchanged }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
