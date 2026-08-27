#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  fileIdentity,
  runStress,
  sameIdentity,
  writeJsonAtomic,
} from "./stress-native-core-real-save.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SUPPORTED_THREADS = Object.freeze(["1", "2", "4", "8", "auto"]);
const SUPPORTED_SCENARIOS = new Set(["exact", "full"]);

export function usageText() {
  return [
    "Usage:",
    "  node scripts/benchmark-native-core-thread-matrix.mjs \\",
    "    --binary <absolute-host-path> --fixture <absolute-save-path> \\",
    "    --output <absolute-json-path> [options]",
    "",
    "Options:",
    "  --runs <n>          Samples per thread setting (default: 3, range: 1..10)",
    "  --threads <list>    Comma-separated subset of 1,2,4,8,auto (default: all)",
    "  --scenario <name>   exact or full (default: exact)",
    "  --profile           Capture native phase markers in every child process",
    "",
    "Each cell runs in an independent process. Settings are rotated and reversed",
    "between rounds. Every result must match the JavaScript oracle and all reported",
    "native canonical hashes must match across thread settings.",
  ].join("\n");
}

function samePath(left, right, platform = process.platform) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function parseArgs(argv) {
  const options = {
    runs: 3,
    threads: [...SUPPORTED_THREADS],
    scenario: "exact",
    profile: false,
  };
  const valueFlags = new Map([
    ["--binary", "binary"],
    ["--fixture", "fixture"],
    ["--output", "output"],
    ["--runs", "runs"],
    ["--threads", "threads"],
    ["--scenario", "scenario"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--profile") {
      if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
      seen.add(argument);
      options.profile = true;
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
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) {
    throw new Error("--runs must be an integer in the range 1..10");
  }
  if (typeof options.threads === "string") {
    options.threads = options.threads.split(",").map((value) => value.trim()).filter(Boolean);
  }
  if (!Array.isArray(options.threads) || options.threads.length === 0) {
    throw new Error("--threads must contain at least one setting");
  }
  const uniqueThreads = [...new Set(options.threads)];
  if (uniqueThreads.length !== options.threads.length) throw new Error("--threads must not contain duplicates");
  for (const thread of uniqueThreads) {
    if (!SUPPORTED_THREADS.includes(thread)) {
      throw new Error("--threads values must be selected from: 1,2,4,8,auto");
    }
  }
  options.threads = uniqueThreads;
  if (!SUPPORTED_SCENARIOS.has(String(options.scenario))) {
    throw new Error("--scenario must be one of: exact, full");
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

export function buildInterleavedSchedule(threads, runs) {
  const result = [];
  for (let round = 0; round < runs; round += 1) {
    const rotated = threads.map((_, index) => threads[(index + round) % threads.length]);
    const ordered = round % 2 === 0 ? rotated : [...rotated].reverse();
    ordered.forEach((thread, orderInRound) => result.push({
      sequence: result.length + 1,
      round: round + 1,
      orderInRound: orderInRound + 1,
      threads: thread,
    }));
  }
  return result;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function percentile(values, fraction) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function statistics(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { count: 0, min: null, median: null, p95: null, max: null };
  return {
    count: finite.length,
    min: Math.min(...finite),
    median: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: Math.max(...finite),
  };
}

function recordFor(sample, label, field) {
  const marker = sample.report?.runs?.[0]?.benchmarkMarkers
    ?.find((candidate) => candidate.label === label && !candidate.parseError);
  return marker?.value?.[field] ?? null;
}

function canonicalEvidence(sample, scenario) {
  const exact = recordFor(sample, "exact", "nativeCoreExactRealSaveAdvance");
  const burst = scenario === "full" ? recordFor(sample, "burst", "nativeCoreExactBurst") : null;
  return {
    exact: typeof exact?.canonicalSha256 === "string" ? exact.canonicalSha256 : null,
    exactExpected: typeof exact?.expectedCanonicalSha256 === "string" ? exact.expectedCanonicalSha256 : null,
    burst: typeof burst?.canonicalSha256 === "string" ? burst.canonicalSha256 : null,
    burstExpected: typeof burst?.expectedCanonicalSha256 === "string" ? burst.expectedCanonicalSha256 : null,
  };
}

export function validateCrossThreadHashes(samples, scenario) {
  const errors = [];
  const evidence = samples.map((sample) => ({
    sequence: sample.sequence,
    threads: sample.threads,
    ...canonicalEvidence(sample, scenario),
  }));
  for (const item of evidence) {
    if (!item.exact || !item.exactExpected) {
      errors.push(`sequence ${item.sequence} threads=${item.threads}: exact canonical hash is missing`);
    } else if (item.exact !== item.exactExpected) {
      errors.push(`sequence ${item.sequence} threads=${item.threads}: exact canonical hash differs from oracle`);
    }
    if (scenario === "full") {
      if (!item.burst || !item.burstExpected) {
        errors.push(`sequence ${item.sequence} threads=${item.threads}: burst canonical hash is missing`);
      } else if (item.burst !== item.burstExpected) {
        errors.push(`sequence ${item.sequence} threads=${item.threads}: burst canonical hash differs from oracle`);
      }
    }
  }
  const exactHashes = [...new Set(evidence.map((item) => item.exact).filter(Boolean))];
  if (exactHashes.length > 1) errors.push(`exact canonical hashes differ across runs/settings (${exactHashes.length} values)`);
  const burstHashes = [...new Set(evidence.map((item) => item.burst).filter(Boolean))];
  if (scenario === "full" && burstHashes.length > 1) {
    errors.push(`burst canonical hashes differ across runs/settings (${burstHashes.length} values)`);
  }
  return {
    valid: errors.length === 0,
    errors,
    exactCanonicalSha256: exactHashes.length === 1 ? exactHashes[0] : null,
    burstCanonicalSha256: burstHashes.length === 1 ? burstHashes[0] : null,
    evidence,
  };
}

export function summarizeThreadSamples(samples, threads) {
  const grouped = Object.fromEntries(threads.map((thread) => [thread, []]));
  for (const sample of samples) grouped[sample.threads]?.push(sample);
  const summaries = {};
  for (const thread of threads) {
    const cells = grouped[thread];
    const exactRecords = cells.map((sample) => recordFor(sample, "exact", "nativeCoreExactRealSaveAdvance"));
    const openRecords = cells.map((sample) => recordFor(sample, "open", "nativeCore"));
    summaries[thread] = {
      requestedRuns: cells.length,
      passedRuns: cells.filter((sample) => sample.report?.status === "completed").length,
      openDurationMs: statistics(openRecords.map((record) => finiteNumber(record?.openDurationMs))),
      nativeAdvanceDurationMs: statistics(exactRecords.map((record) => finiteNumber(record?.nativeAdvanceDurationMs))),
      javascriptAdvanceDurationMs: statistics(exactRecords.map((record) => finiteNumber(record?.jsAdvanceDurationMs))),
      processPrivateBytesPeakDuringAdvance: statistics(
        exactRecords.map((record) => finiteNumber(record?.processPrivateBytesPeakDuringAdvance)),
      ),
    };
  }
  const oneThreadMedian = summaries["1"]?.nativeAdvanceDurationMs?.median ?? null;
  for (const thread of threads) {
    const current = summaries[thread].nativeAdvanceDurationMs.median;
    summaries[thread].speedupVsOneThread = Number.isFinite(oneThreadMedian) && Number.isFinite(current) && current > 0
      ? oneThreadMedian / current
      : null;
  }
  return summaries;
}

export function runThreadMatrix(options, dependencies = {}) {
  const identity = dependencies.fileIdentity ?? fileIdentity;
  const runCell = dependencies.runStress ?? runStress;
  const now = dependencies.now ?? Date.now;
  const logger = dependencies.logger ?? (() => {});
  const startedAtMs = now();
  const initialBinary = identity(options.binary);
  const initialFixture = identity(options.fixture);
  const schedule = buildInterleavedSchedule(options.threads, options.runs);
  const samples = [];
  let abortReason = null;
  for (const cell of schedule) {
    logger(`[${cell.sequence}/${schedule.length}] round=${cell.round} threads=${cell.threads}`);
    const binaryBefore = identity(options.binary);
    const fixtureBefore = identity(options.fixture);
    if (!sameIdentity(initialBinary, binaryBefore)) {
      abortReason = "binary-identity-changed";
      break;
    }
    if (!sameIdentity(initialFixture, fixtureBefore)) {
      abortReason = "fixture-identity-changed";
      break;
    }
    const report = runCell({
      binary: options.binary,
      fixture: options.fixture,
      output: options.output,
      runs: 1,
      scenario: options.scenario,
      threads: cell.threads,
      syncRecordDrop: false,
      profile: options.profile,
    }, { logger: () => {} });
    const binaryAfter = identity(options.binary);
    const fixtureAfter = identity(options.fixture);
    const immutable = sameIdentity(initialBinary, binaryAfter) && sameIdentity(initialFixture, fixtureAfter);
    samples.push({ ...cell, immutableInputs: immutable, report });
    if (!immutable) {
      abortReason = sameIdentity(initialBinary, binaryAfter)
        ? "fixture-identity-changed"
        : "binary-identity-changed";
      break;
    }
  }
  const finalBinary = identity(options.binary);
  const finalFixture = identity(options.fixture);
  const binaryUnchanged = sameIdentity(initialBinary, finalBinary);
  const fixtureUnchanged = sameIdentity(initialFixture, finalFixture);
  const hashes = validateCrossThreadHashes(samples, options.scenario);
  const completedCells = samples.filter((sample) => sample.report?.status === "completed").length;
  const completed = samples.length === schedule.length
    && completedCells === schedule.length
    && samples.every((sample) => sample.immutableInputs)
    && hashes.valid && binaryUnchanged && fixtureUnchanged && !abortReason;
  const completedAtMs = now();
  return {
    schemaVersion: 1,
    benchmark: "native-core-real-save-thread-matrix",
    status: completed ? "completed" : "failed",
    generatedAt: new Date(completedAtMs).toISOString(),
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: Math.max(0, completedAtMs - startedAtMs),
    command: {
      runsPerThread: options.runs,
      threads: options.threads,
      scenario: options.scenario,
      profile: options.profile,
    },
    host: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    immutableInputs: {
      binary: { initial: initialBinary, final: finalBinary, unchanged: binaryUnchanged },
      fixture: { initial: initialFixture, final: finalFixture, unchanged: fixtureUnchanged },
    },
    validation: {
      requestedCells: schedule.length,
      completedCells,
      allCellsCompleted: samples.length === schedule.length && completedCells === schedule.length,
      allRunInputsImmutable: samples.every((sample) => sample.immutableInputs),
      binaryUnchanged,
      fixtureUnchanged,
      crossThreadCanonicalHashes: hashes,
    },
    abortReason,
    schedule,
    summaryByThreads: summarizeThreadSamples(samples, options.threads),
    samples,
  };
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
  try {
    const report = runThreadMatrix(options, { logger: (message) => console.error(message) });
    writeJsonAtomic(options.output, report);
    console.log(JSON.stringify({
      output: options.output,
      status: report.status,
      completedCells: report.validation.completedCells,
      requestedCells: report.validation.requestedCells,
      crossThreadHashesValid: report.validation.crossThreadCanonicalHashes.valid,
    }, null, 2));
    return report.status === "completed" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    try {
      if (!fs.existsSync(options.output)) {
        writeJsonAtomic(options.output, {
          schemaVersion: 1,
          benchmark: "native-core-real-save-thread-matrix",
          status: "failed",
          generatedAt: new Date().toISOString(),
          command: {
            runsPerThread: options.runs,
            threads: options.threads,
            scenario: options.scenario,
            profile: options.profile,
          },
          abortReason: "runner-error",
          error: message,
          samples: [],
        });
      }
    } catch (reportError) {
      console.error(`Unable to write failed report: ${reportError instanceof Error ? reportError.message : String(reportError)}`);
    }
    return 1;
  }
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), SCRIPT_PATH)) {
  process.exitCode = main();
}
