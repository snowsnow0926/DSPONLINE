#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.dirname(path.dirname(SCRIPT_PATH));
const SUPPORTED_THREADS = new Set(["auto", "1", "2", "4", "8"]);
const SUPPORTED_SCENARIOS = new Set(["exact", "full"]);
const SUPPORTED_EXACT_SECONDS = new Set(["1", "5", "60"]);
const OUTPUT_TAIL_BYTES = 12 * 1024;
const RUN_TIMEOUT_MS = 600_000;

export const CHILD_ENV_ALLOWLIST = Object.freeze([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
]);

const MANAGED_CHILD_ENV = Object.freeze([
  "DSP_RUN_NATIVE_CORE_BENCHMARK",
  "DSP_NATIVE_CORE_HOST_BINARY",
  "DSP_NATIVE_CORE_FIXTURE",
  "DSP_NATIVE_CORE_THREADS",
  "DSP_NATIVE_CORE_BENCHMARK_OPEN_ONLY",
  "DSP_NATIVE_CORE_BENCHMARK_EXACT_ONLY",
  "DSP_NATIVE_CORE_BENCHMARK_EXACT_SECONDS",
  "DSP_NATIVE_CORE_BENCHMARK_PROFILE_EQUIVALENCE",
  "NO_COLOR",
  "FORCE_COLOR",
]);

export const SYNC_RECORD_DROP_ENV = "DSP_NATIVE_CORE_SYNC_RECORD_DROP";

export function usageText() {
  return [
    "Usage:",
    "  node scripts/stress-native-core-real-save.mjs \\",
    "    --binary <absolute-host-path> --fixture <absolute-save-path> \\",
    "    --output <absolute-json-path> [options]",
    "",
    "Options:",
    "  --runs <n>          Independent Vitest processes (default: 5, range: 1..50)",
    "  --scenario <name>   exact or full (default: exact)",
    "  --threads <value>   DSP_NATIVE_CORE_THREADS: auto, 1, 2, 4, or 8 (default: auto)",
    "  --seconds <value>   Exact advance seconds: 1, 5, or 60 (default: 1)",
    `  --sync-record-drop  Set only ${SYNC_RECORD_DROP_ENV}=1 in benchmark children`,
    "  --profile           Record native phase timings in every run",
    "  --profile-equivalence",
    "                      Record native and JavaScript hashes without requiring",
    "                      them to equal; exact scenario only, for observer A/B",
    "",
    "The output path must not already exist. The fixture and binary are hashed before",
    "and after every run; any identity change aborts the remaining runs fail-closed.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    runs: 5,
    scenario: "exact",
    threads: "auto",
    seconds: "1",
    syncRecordDrop: false,
    profile: false,
    profileEquivalence: false,
  };
  const valueFlags = new Map([
    ["--binary", "binary"],
    ["--fixture", "fixture"],
    ["--output", "output"],
    ["--runs", "runs"],
    ["--scenario", "scenario"],
    ["--threads", "threads"],
    ["--seconds", "seconds"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--sync-record-drop") {
      if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
      seen.add(argument);
      options.syncRecordDrop = true;
      continue;
    }
    if (argument === "--profile") {
      if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
      seen.add(argument);
      options.profile = true;
      continue;
    }
    if (argument === "--profile-equivalence") {
      if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
      seen.add(argument);
      options.profileEquivalence = true;
      continue;
    }
    const key = valueFlags.get(argument);
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    options[key] = value;
    index += 1;
  }
  options.runs = Number(options.runs);
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 50) {
    throw new Error("--runs must be an integer in the range 1..50");
  }
  if (!SUPPORTED_SCENARIOS.has(String(options.scenario))) {
    throw new Error("--scenario must be one of: exact, full");
  }
  if (!SUPPORTED_THREADS.has(String(options.threads))) {
    throw new Error("--threads must be one of: auto, 1, 2, 4, 8");
  }
  if (!SUPPORTED_EXACT_SECONDS.has(String(options.seconds))) {
    throw new Error("--seconds must be one of: 1, 5, 60");
  }
  if (options.scenario !== "exact" && options.seconds !== "1") {
    throw new Error("--seconds other than 1 requires --scenario exact");
  }
  if (options.profileEquivalence && options.scenario !== "exact") {
    throw new Error("--profile-equivalence requires --scenario exact");
  }
  for (const key of ["binary", "fixture", "output"]) {
    if (!options[key]) throw new Error(`Missing required --${key}`);
    if (!path.isAbsolute(options[key])) throw new Error(`--${key} must be an absolute path`);
    options[key] = path.normalize(options[key]);
  }
  if (samePath(options.binary, options.fixture)
    || samePath(options.binary, options.output)
    || samePath(options.fixture, options.output)) {
    throw new Error("--binary, --fixture, and --output must be different paths");
  }
  return options;
}

function samePath(left, right, platform = process.platform) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function fileIdentity(filePath) {
  const before = fs.statSync(filePath, { bigint: true });
  if (!before.isFile()) throw new Error(`Not a file: ${filePath}`);
  const resolvedPath = fs.realpathSync.native(filePath);
  const sha256 = hashFile(filePath);
  const after = fs.statSync(filePath, { bigint: true });
  if (!after.isFile()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs) {
    throw new Error(`File identity changed while hashing: ${filePath}`);
  }
  return {
    path: filePath,
    resolvedPath,
    sizeBytes: Number(after.size),
    mtimeMs: Number(after.mtimeNs) / 1_000_000,
    mtimeNs: String(after.mtimeNs),
    sha256,
  };
}

export function sameIdentity(left, right) {
  return Boolean(left && right
    && samePath(left.resolvedPath, right.resolvedPath)
    && left.sizeBytes === right.sizeBytes
    && left.mtimeNs === right.mtimeNs
    && left.sha256 === right.sha256);
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: typeof error.name === "string" ? error.name : "Error",
    message: typeof error.message === "string" ? error.message : String(error),
    code: typeof error.code === "string" ? error.code : null,
  };
}

export function captureSystemSnapshot({
  platform = process.platform,
  spawn = spawnSync,
  capturedAt = new Date().toISOString(),
} = {}) {
  const snapshot = {
    capturedAt,
    freeMemoryBytes: os.freemem(),
    totalMemoryBytes: os.totalmem(),
    loadAverage: os.loadavg(),
  };
  if (platform !== "win32") return snapshot;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$os=Get-CimInstance Win32_OperatingSystem",
    "$top=@(Get-Process | Sort-Object PrivateMemorySize64 -Descending | Select-Object -First 12 Id,ProcessName,CPU,WorkingSet64,PrivateMemorySize64)",
    "[pscustomobject]@{FreePhysicalMemoryKiB=[uint64]$os.FreePhysicalMemory;FreeVirtualMemoryKiB=[uint64]$os.FreeVirtualMemory;TotalVisibleMemorySizeKiB=[uint64]$os.TotalVisibleMemorySize;TotalVirtualMemorySizeKiB=[uint64]$os.TotalVirtualMemorySize;TopProcessesByPrivateBytes=$top}|ConvertTo-Json -Depth 4 -Compress",
  ].join("; ");
  const result = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status === 0 && result.stdout?.trim()) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      snapshot.windows = {
        freePhysicalMemoryKiB: parsed.FreePhysicalMemoryKiB,
        freeVirtualMemoryKiB: parsed.FreeVirtualMemoryKiB,
        totalVisibleMemorySizeKiB: parsed.TotalVisibleMemorySizeKiB,
        totalVirtualMemorySizeKiB: parsed.TotalVirtualMemorySizeKiB,
        topProcessesByPrivateBytes: Array.isArray(parsed.TopProcessesByPrivateBytes)
          ? parsed.TopProcessesByPrivateBytes
          : parsed.TopProcessesByPrivateBytes ? [parsed.TopProcessesByPrivateBytes] : [],
      };
    } catch (error) {
      snapshot.windowsSnapshotError = `invalid-json: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    snapshot.windowsSnapshotError = result.error?.message ?? result.stderr?.trim() ?? `exit-${result.status}`;
  }
  return snapshot;
}

export function buildChildEnvironment(parentEnvironment, options, platform = process.platform) {
  const child = {};
  const inheritedKeys = [];
  const sourceKeys = Object.keys(parentEnvironment);
  for (const allowed of CHILD_ENV_ALLOWLIST) {
    const sourceKey = platform === "win32"
      ? sourceKeys.find((key) => key.toUpperCase() === allowed)
      : sourceKeys.find((key) => key === allowed);
    if (sourceKey && parentEnvironment[sourceKey] !== undefined) {
      child[sourceKey] = parentEnvironment[sourceKey];
      inheritedKeys.push(sourceKey);
    }
  }
  Object.assign(child, {
    DSP_RUN_NATIVE_CORE_BENCHMARK: "1",
    DSP_NATIVE_CORE_HOST_BINARY: options.binary,
    DSP_NATIVE_CORE_FIXTURE: options.fixture,
    DSP_NATIVE_CORE_THREADS: String(options.threads),
    DSP_NATIVE_CORE_BENCHMARK_OPEN_ONLY: "0",
    DSP_NATIVE_CORE_BENCHMARK_EXACT_ONLY: options.scenario === "exact" ? "1" : "0",
    DSP_NATIVE_CORE_BENCHMARK_EXACT_SECONDS: String(options.seconds ?? "1"),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  });
  if (options.syncRecordDrop) child[SYNC_RECORD_DROP_ENV] = "1";
  if (options.profile) child.DSP_NATIVE_CORE_PROFILE = "1";
  if (options.profileEquivalence) child.DSP_NATIVE_CORE_BENCHMARK_PROFILE_EQUIVALENCE = "1";
  return {
    environment: child,
    inheritedKeys: inheritedKeys.sort((left, right) => left.localeCompare(right)),
    managedKeys: [
      ...MANAGED_CHILD_ENV,
      ...(options.syncRecordDrop ? [SYNC_RECORD_DROP_ENV] : []),
      ...(options.profile ? ["DSP_NATIVE_CORE_PROFILE"] : []),
      ...(options.profileEquivalence ? ["DSP_NATIVE_CORE_BENCHMARK_PROFILE_EQUIVALENCE"] : []),
    ],
  };
}

export function parseBenchmarkMarkers(stdout = "", stderr = "") {
  const markers = [];
  const parseStream = (source, value) => {
    const pattern = /DSP_NATIVE_CORE_BENCHMARK\t([^\t\r\n]+)\t([^\r\n]*)/g;
    for (const match of String(value).matchAll(pattern)) {
      const label = match[1];
      const rawJson = match[2].trim();
      try {
        markers.push({ source, label, value: JSON.parse(rawJson) });
      } catch (error) {
        markers.push({
          source,
          label,
          rawJson,
          parseError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  parseStream("stdout", stdout);
  parseStream("stderr", stderr);
  return markers;
}

export function parseProfileMarkers(stdout = "", stderr = "") {
  const markers = [];
  const parseStream = (source, value) => {
    const pattern = /DSP_NATIVE_CORE_PROFILE\t([^\t\r\n]+)\t([^\r\n]*)/g;
    for (const match of String(value).matchAll(pattern)) {
      const rawValue = match[2].trim();
      const numericValue = Number(rawValue);
      markers.push({
        source,
        label: match[1],
        rawValue,
        value: rawValue !== "" && Number.isFinite(numericValue) ? numericValue : null,
      });
    }
  };
  parseStream("stdout", stdout);
  parseStream("stderr", stderr);
  return markers;
}

function validateSampler(phase, sampler) {
  const errors = [];
  if (sampler?.error !== null) errors.push(`${phase}: sampler error is not null`);
  if (sampler?.samplingCadenceValid !== true) errors.push(`${phase}: sampling cadence is invalid`);
  if (!Number.isFinite(sampler?.intervalMs) || sampler.intervalMs <= 0) errors.push(`${phase}: intervalMs is invalid`);
  if (!Number.isInteger(sampler?.intervalSampleCount) || sampler.intervalSampleCount < 1) {
    errors.push(`${phase}: intervalSampleCount is incomplete`);
  }
  if (!Number.isFinite(sampler?.intervalP95Ms)
    || !Number.isFinite(sampler?.intervalMs)
    || sampler.intervalP95Ms > sampler.intervalMs * 2) {
    errors.push(`${phase}: intervalP95Ms exceeds the cadence limit`);
  }
  if (!Number.isFinite(sampler?.intervalMaxMs)
    || !Number.isFinite(sampler?.intervalMs)
    || sampler.intervalMaxMs > sampler.intervalMs * 5) {
    errors.push(`${phase}: intervalMaxMs exceeds the cadence limit`);
  }
  if (!Number.isSafeInteger(sampler?.pid) || !Number.isSafeInteger(sampler?.samplerPid)
    || sampler.pid === sampler.samplerPid) {
    errors.push(`${phase}: sampler/target PIDs are invalid`);
  }
  if (!Number.isFinite(sampler?.peakBytes) || sampler.peakBytes <= 0) errors.push(`${phase}: peakBytes is invalid`);
  if (!Number.isInteger(sampler?.sampleCount) || sampler.sampleCount < 2) {
    errors.push(`${phase}: sampleCount is incomplete`);
  }
  return errors;
}

export function validateBenchmarkMarkers(
  markers,
  binaryIdentity,
  scenario,
  platform = process.platform,
  exactSeconds = 1,
) {
  const markerErrors = [];
  const records = {};
  for (const marker of markers) {
    if (marker.parseError) {
      markerErrors.push(`${marker.label}: invalid JSON (${marker.parseError})`);
      continue;
    }
    if (Object.hasOwn(records, marker.label)) {
      markerErrors.push(`${marker.label}: duplicate benchmark marker`);
      continue;
    }
    records[marker.label] = marker.value;
  }
  const required = scenario === "exact"
    ? ["open", "admission", "exact"]
    : ["open", "admission", "exact", "integrated", "durable", "checkpoint", "burst"];
  for (const label of required) {
    if (!Object.hasOwn(records, label)) markerErrors.push(`${label}: required benchmark marker is missing`);
  }

  const observerErrors = [];
  const oracleErrors = [];
  const open = records.open?.nativeCore;
  const admission = records.admission?.nativeCoreAdmission;
  const exact = records.exact?.nativeCoreExactRealSaveAdvance;
  const integrated = records.integrated?.nativeCoreIntegratedDiagnostics;
  const durable = records.durable?.nativeCoreDurableAuthority;
  const checkpoint = records.checkpoint?.nativeCoreIncrementalCheckpoint;
  const burst = records.burst?.nativeCoreExactBurst;
  if (!open) {
    observerErrors.push("open: nativeCore payload is missing");
  } else {
    if (String(open.hostBinarySha256 ?? "").toLowerCase() !== binaryIdentity.sha256.toLowerCase()) {
      observerErrors.push("open: host binary SHA-256 does not match the immutable binary identity");
    }
    if (open.exactRoundTrip !== true) observerErrors.push("open: canonical round-trip is not exact");
  }
  if (!admission) {
    observerErrors.push("admission: nativeCoreAdmission payload is missing");
  } else if (admission.supported !== true) {
    observerErrors.push(`admission: native exact scope rejected (${admission.reason ?? "unknown"})`);
  }
  if (!exact) {
    observerErrors.push("exact: nativeCoreExactRealSaveAdvance payload is missing");
  } else {
    if (!Array.isArray(exact.fieldMismatches)) {
      observerErrors.push("exact: field mismatch evidence is missing");
    }
    if (exact.simulationSeconds !== Number(exactSeconds)) {
      observerErrors.push(
      `exact: simulationSeconds ${exact.simulationSeconds ?? "missing"} differs from requested ${exactSeconds}`,
      );
    }
    for (const field of [
      "canonicalSha256",
      "expectedCanonicalSha256",
      "domainSha256",
      "conservationSummarySha256",
    ]) {
      if (!/^[a-f0-9]{64}$/.test(exact[field] ?? "")) {
        observerErrors.push(`exact: ${field} is missing or invalid`);
      }
    }
    if (exact.conservationCaptureFailure !== null || exact.conservationValidationFailure !== null) {
      observerErrors.push("exact: aggregate conservation validation failed");
    }
    if (exact.exactState !== true
      || !Array.isArray(exact.fieldMismatches)
      || exact.fieldMismatches.length !== 0
      || exact.canonicalSha256 !== exact.expectedCanonicalSha256) {
      oracleErrors.push("exact: native state differs from the JavaScript authority state");
    }
  }
  if (scenario === "full") {
    if (!integrated) observerErrors.push("integrated: nativeCoreIntegratedDiagnostics payload is missing");
    else if (integrated.exactState !== true) oracleErrors.push("integrated: advance/proof state is not exact");
    if (!durable) observerErrors.push("durable: nativeCoreDurableAuthority payload is missing");
    else if (durable.exactState !== true || durable.duplicateRetry !== true) {
      oracleErrors.push("durable: authority state or duplicate retry is not exact");
    }
    if (!checkpoint) observerErrors.push("checkpoint: nativeCoreIncrementalCheckpoint payload is missing");
    else if (checkpoint.exactState !== true) oracleErrors.push("checkpoint: checkpoint state is not exact");
    if (!burst) observerErrors.push("burst: nativeCoreExactBurst payload is missing");
    else if (burst.exactState !== true || burst.steps !== 3) {
      oracleErrors.push("burst: three-step native state differs from JavaScript authority");
    }
  }

  const samplerErrors = [];
  const samplerRequired = platform === "win32";
  if (samplerRequired) {
    samplerErrors.push(...validateSampler("open", open?.privatePeakSampler));
    samplerErrors.push(...validateSampler("exact", exact?.privatePeakSampler));
    if (scenario === "full") samplerErrors.push(...validateSampler("burst", burst?.privatePeakSampler));
  }
  return {
    records,
    markerValid: markerErrors.length === 0,
    observerValid: markerErrors.length === 0 && observerErrors.length === 0,
    oracleEqual: markerErrors.length === 0 && observerErrors.length === 0 && oracleErrors.length === 0,
    exactValid: markerErrors.length === 0 && observerErrors.length === 0 && oracleErrors.length === 0,
    samplerRequired,
    samplerValid: samplerErrors.length === 0,
    errors: {
      marker: markerErrors,
      observer: observerErrors,
      oracle: oracleErrors,
      exact: [...observerErrors, ...oracleErrors],
      sampler: samplerErrors,
    },
  };
}

export function tailUtf8(value, maximumBytes = OUTPUT_TAIL_BYTES) {
  const bytes = Buffer.from(String(value), "utf8");
  let start = Math.max(0, bytes.length - maximumBytes);
  while (start < bytes.length && (bytes[start] & 0b1100_0000) === 0b1000_0000) start += 1;
  const tail = bytes.subarray(start);
  return {
    byteLimit: maximumBytes,
    sourceBytes: bytes.length,
    retainedBytes: tail.length,
    text: tail.toString("utf8"),
  };
}

function defaultSpawnVitest(options, environment) {
  const vitest = path.join(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs");
  return spawnSync(process.execPath, [
    vitest,
    "run",
    "src/game/nativeCoreRealSaveBenchmark.test.ts",
    "--reporter=verbose",
    "--maxWorkers=1",
    "--fileParallelism=false",
  ], {
    cwd: PROJECT_ROOT,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 128 * 1024 * 1024,
  });
}

function safeIdentity(identity, filePath) {
  try {
    return { value: identity(filePath), error: null };
  } catch (error) {
    return { value: null, error: serializeError(error) };
  }
}

function hostIdentity(platform = process.platform) {
  return {
    platform,
    arch: process.arch,
    node: process.version,
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    totalMemoryBytes: os.totalmem(),
  };
}

export function runStress(options, dependencies = {}) {
  const identity = dependencies.identity ?? fileIdentity;
  const snapshot = dependencies.snapshot ?? (() => captureSystemSnapshot());
  const spawnVitest = dependencies.spawnVitest ?? defaultSpawnVitest;
  const now = dependencies.now ?? (() => Date.now());
  const platform = dependencies.platform ?? process.platform;
  const exactSeconds = String(options.seconds ?? "1");
  const validationMode = options.profileEquivalence
    ? "profile-observer-equivalence"
    : "strict-oracle-equality";
  const logger = dependencies.logger ?? (() => {});
  const initialBinary = identity(options.binary);
  const initialFixture = identity(options.fixture);
  const childEnvironment = buildChildEnvironment(
    dependencies.parentEnvironment ?? process.env,
    options,
    platform,
  );
  const startedAtMs = now();
  const samples = [];
  let abortReason = null;

  for (let sequence = 1; sequence <= options.runs; sequence += 1) {
    logger(`[${sequence}/${options.runs}] ${options.scenario} seconds=${exactSeconds} threads=${options.threads}`);
    const binaryBefore = safeIdentity(identity, options.binary);
    const fixtureBefore = safeIdentity(identity, options.fixture);
    if (!sameIdentity(initialBinary, binaryBefore.value)) {
      abortReason = binaryBefore.error ? "binary-identity-unreadable" : "binary-identity-changed";
      break;
    }
    if (!sameIdentity(initialFixture, fixtureBefore.value)) {
      abortReason = fixtureBefore.error ? "fixture-identity-unreadable" : "fixture-identity-changed";
      break;
    }

    const systemBefore = snapshot();
    const runStartedAtMs = now();
    let processResult;
    try {
      processResult = spawnVitest(options, childEnvironment.environment, sequence);
    } catch (error) {
      processResult = { status: null, signal: null, stdout: "", stderr: "", error };
    }
    if (!processResult || typeof processResult !== "object") {
      processResult = {
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        error: new Error("Vitest process launcher returned no result"),
      };
    }
    const runCompletedAtMs = now();
    const systemAfter = snapshot();
    const binaryAfter = safeIdentity(identity, options.binary);
    const fixtureAfter = safeIdentity(identity, options.fixture);
    const binaryUnchanged = sameIdentity(initialBinary, binaryAfter.value);
    const fixtureUnchanged = sameIdentity(initialFixture, fixtureAfter.value);
    const stdout = String(processResult.stdout ?? "");
    const stderr = String(processResult.stderr ?? "");
    const markers = parseBenchmarkMarkers(stdout, stderr);
    const profileMarkers = options.profile ? parseProfileMarkers(stdout, stderr) : [];
    const benchmark = validateBenchmarkMarkers(
      markers,
      initialBinary,
      options.scenario,
      platform,
      exactSeconds,
    );
    const exitedZero = processResult.status === 0 && !processResult.error;
    const requestedValidationValid = options.profileEquivalence
      ? benchmark.observerValid
      : benchmark.exactValid;
    const passed = exitedZero && requestedValidationValid && benchmark.samplerValid
      && binaryUnchanged && fixtureUnchanged;
    const timedOut = processResult.error?.code === "ETIMEDOUT";
    const processStatus = passed
      ? "passed"
      : timedOut ? "timed-out" : processResult.error ? "spawn-error" : "failed";
    const combinedOutput = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`;
    samples.push({
      sequence,
      status: processStatus,
      startedAt: new Date(runStartedAtMs).toISOString(),
      completedAt: new Date(runCompletedAtMs).toISOString(),
      durationMs: Math.max(0, runCompletedAtMs - runStartedAtMs),
      process: {
        exitCode: Number.isInteger(processResult.status) ? processResult.status : null,
        signal: processResult.signal ?? null,
        error: serializeError(processResult.error),
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      },
      benchmarkMarkers: markers,
      nativeProfileMarkers: profileMarkers,
      benchmarkValidation: {
        markerValid: benchmark.markerValid,
        observerValid: benchmark.observerValid,
        oracleEqual: benchmark.oracleEqual,
        exactValid: benchmark.exactValid,
        requestedValidationValid,
        validationMode,
        samplerRequired: benchmark.samplerRequired,
        samplerValid: benchmark.samplerValid,
        errors: benchmark.errors,
      },
      systemBefore,
      systemAfter,
      immutableInputs: {
        binaryBefore: binaryBefore.value,
        binaryAfter: binaryAfter.value,
        binaryIdentityError: binaryBefore.error ?? binaryAfter.error,
        binaryUnchanged,
        fixtureBefore: fixtureBefore.value,
        fixtureAfter: fixtureAfter.value,
        fixtureIdentityError: fixtureBefore.error ?? fixtureAfter.error,
        fixtureUnchanged,
      },
      ...(passed ? {} : { outputTail: tailUtf8(combinedOutput) }),
    });
    if (!fixtureUnchanged) {
      abortReason = fixtureAfter.error ? "fixture-identity-unreadable" : "fixture-identity-changed";
      break;
    }
    if (!binaryUnchanged) {
      abortReason = binaryAfter.error ? "binary-identity-unreadable" : "binary-identity-changed";
      break;
    }
  }

  const finalBinary = safeIdentity(identity, options.binary);
  const finalFixture = safeIdentity(identity, options.fixture);
  const binaryUnchanged = sameIdentity(initialBinary, finalBinary.value);
  const fixtureUnchanged = sameIdentity(initialFixture, finalFixture.value);
  if (!abortReason && !fixtureUnchanged) {
    abortReason = finalFixture.error ? "fixture-identity-unreadable" : "fixture-identity-changed";
  }
  if (!abortReason && !binaryUnchanged) {
    abortReason = finalBinary.error ? "binary-identity-unreadable" : "binary-identity-changed";
  }
  const allRequestedRunsCompleted = samples.length === options.runs;
  const allProcessesExitedZero = allRequestedRunsCompleted
    && samples.every((sample) => sample.process.exitCode === 0 && sample.process.error === null);
  const allRunsExact = allRequestedRunsCompleted
    && samples.every((sample) => sample.benchmarkValidation.exactValid === true);
  const allRequestedValidationValid = allRequestedRunsCompleted
    && samples.every((sample) => sample.benchmarkValidation.requestedValidationValid === true);
  const allSamplersValid = allRequestedRunsCompleted
    && samples.every((sample) => sample.benchmarkValidation.samplerValid === true);
  const allRunInputsImmutable = allRequestedRunsCompleted
    && samples.every((sample) => sample.immutableInputs.binaryUnchanged && sample.immutableInputs.fixtureUnchanged);
  const completed = allProcessesExitedZero && allRequestedValidationValid && allSamplersValid
    && allRunInputsImmutable && binaryUnchanged && fixtureUnchanged && !abortReason;
  const completedAtMs = now();
  return {
    schemaVersion: 1,
    benchmark: "native-core-real-save-stability",
    status: completed ? "completed" : "failed",
    generatedAt: new Date(completedAtMs).toISOString(),
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: Math.max(0, completedAtMs - startedAtMs),
    command: {
      runs: options.runs,
      scenario: options.scenario,
      threads: String(options.threads),
      seconds: exactSeconds,
      timeoutMsPerRun: RUN_TIMEOUT_MS,
      syncRecordDrop: options.syncRecordDrop,
      profile: options.profile,
      profileEquivalence: options.profileEquivalence ?? false,
      validationMode,
      childEnvironment: {
        inheritedAllowlist: [...CHILD_ENV_ALLOWLIST],
        inheritedKeysPresent: childEnvironment.inheritedKeys,
        managedKeys: childEnvironment.managedKeys,
        valuesRecorded: false,
      },
    },
    host: hostIdentity(platform),
    immutableInputs: {
      binary: {
        initial: initialBinary,
        final: finalBinary.value,
        finalIdentityError: finalBinary.error,
        unchanged: binaryUnchanged,
      },
      fixture: {
        initial: initialFixture,
        final: finalFixture.value,
        finalIdentityError: finalFixture.error,
        unchanged: fixtureUnchanged,
      },
    },
    validation: {
      requestedRuns: options.runs,
      completedRunProcesses: samples.length,
      allRequestedRunsCompleted,
      allProcessesExitedZero,
      allRunsExact,
      allRequestedValidationValid,
      allSamplersValid,
      allRunInputsImmutable,
      binaryUnchanged,
      fixtureUnchanged,
    },
    abortReason,
    failedRuns: samples.filter((sample) => sample.status !== "passed").length,
    runs: samples,
  };
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!(["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(error?.code))) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function writeJsonAtomic(outputPath, document) {
  const directory = path.dirname(outputPath);
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  const temporary = path.join(
    directory,
    `.${path.basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, outputPath);
    fs.rmSync(temporary);
    fsyncDirectory(directory);
    const readback = fs.readFileSync(outputPath, "utf8");
    if (readback !== serialized) throw new Error(`Atomic report readback mismatch: ${outputPath}`);
    JSON.parse(readback);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

function outputLockPath(outputPath) {
  return path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.lock`);
}

function acquireOutputLock(outputPath) {
  const directory = path.dirname(outputPath);
  fs.mkdirSync(directory, { recursive: true });
  const lockPath = outputLockPath(outputPath);
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
    created = true;
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    fs.fsyncSync(descriptor);
    return { descriptor, lockPath };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created && fs.existsSync(lockPath)) fs.rmSync(lockPath);
    throw error;
  }
}

function releaseOutputLock(lock) {
  if (!lock) return;
  fs.closeSync(lock.descriptor);
  if (fs.existsSync(lock.lockPath)) fs.rmSync(lock.lockPath);
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usageText());
    return 2;
  }
  if (options.help) {
    console.log(usageText());
    return 0;
  }
  for (const key of ["binary", "fixture"]) {
    if (!fs.existsSync(options[key]) || !fs.statSync(options[key]).isFile()) {
      console.error(`${key} is not a file: ${options[key]}`);
      return 2;
    }
  }
  if (fs.existsSync(options.output)) {
    console.error(`Output already exists: ${options.output}`);
    return 2;
  }
  let lock;
  try {
    lock = acquireOutputLock(options.output);
    const report = runStress(options, { logger: (message) => console.error(message) });
    writeJsonAtomic(options.output, report);
    console.log(JSON.stringify({
      output: options.output,
      status: report.status,
      completedRuns: report.validation.completedRunProcesses,
      requestedRuns: report.validation.requestedRuns,
      fixtureUnchanged: report.validation.fixtureUnchanged,
    }, null, 2));
    return report.status === "completed" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    if (lock && !fs.existsSync(options.output)) {
      try {
        writeJsonAtomic(options.output, {
          schemaVersion: 1,
          benchmark: "native-core-real-save-stability",
          status: "failed",
          generatedAt: new Date().toISOString(),
          command: {
            runs: options.runs,
            scenario: options.scenario,
            threads: String(options.threads),
            seconds: String(options.seconds ?? "1"),
            timeoutMsPerRun: RUN_TIMEOUT_MS,
            syncRecordDrop: options.syncRecordDrop,
            profile: options.profile,
            profileEquivalence: options.profileEquivalence ?? false,
          },
          validation: {
            requestedRuns: options.runs,
            completedRunProcesses: 0,
            allRequestedRunsCompleted: false,
            allProcessesExitedZero: false,
            allRunsExact: false,
            allSamplersValid: false,
            binaryUnchanged: false,
            fixtureUnchanged: false,
          },
          abortReason: "runner-error",
          error: message,
          runs: [],
        });
      } catch (reportError) {
        console.error(`Unable to write failed report: ${reportError instanceof Error ? reportError.message : String(reportError)}`);
      }
    }
    return 1;
  } finally {
    releaseOutputLock(lock);
  }
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), SCRIPT_PATH)) {
  process.exitCode = main();
}
