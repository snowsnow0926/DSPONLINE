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
import { buildInterleavedSchedule } from "./benchmark-native-core-thread-matrix.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REQUIRED_THREAD_SETTINGS = Object.freeze(["1", "2", "4", "8"]);
const SHA256 = /^[a-f0-9]{64}$/;

export function usageText() {
  return [
    "Usage:",
    "  node scripts/verify-native-core-thread-determinism.mjs \\",
    "    --binary <absolute-host-path> --fixture <absolute-save-path> \\",
    "    --output <absolute-json-path> [--runs <n>]",
    "",
    "Runs one independent native Host process for every 1/2/4/8 thread cell.",
    "Every cell must report the requested and observed worker count, then match",
    "revision, complete canonical SHA-256, domain SHA-256, and the aggregate",
    "material-conservation summary SHA-256; exact conservation must also pass.",
    "This is still a determinism gate;",
    "it does not claim that every authoritative simulation domain is parallel.",
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
  const options = { runs: 1 };
  const valueFlags = new Map([
    ["--binary", "binary"],
    ["--fixture", "fixture"],
    ["--output", "output"],
    ["--runs", "runs"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
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
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 5) {
    throw new Error("--runs must be an integer in the range 1..5");
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

function benchmarkRecord(report, label, field) {
  return report?.runs?.[0]?.benchmarkMarkers
    ?.find((candidate) => candidate.label === label && !candidate.parseError)
    ?.value?.[field] ?? null;
}

export function evidenceFromReport(report, threads) {
  const exact = benchmarkRecord(report, "exact", "nativeCoreExactRealSaveAdvance");
  return {
    requestedThreads: Number(threads),
    reportedThreadSetting: exact?.requestedThreadSetting ?? null,
    effectiveWorkerLimit: exact?.effectiveWorkerLimit ?? null,
    observedWorkerCount: exact?.observedWorkerCount ?? null,
    exactState: exact?.exactState === true,
    revision: exact?.revision ?? null,
    expectedRevision: exact?.expectedRevision ?? null,
    canonicalSha256: exact?.canonicalSha256 ?? null,
    expectedCanonicalSha256: exact?.expectedCanonicalSha256 ?? null,
    domainSha256: exact?.domainSha256 ?? null,
    conservationSummarySha256: exact?.conservationSummarySha256 ?? null,
    conservationCaptureReported: exact !== null && Object.hasOwn(exact, "conservationCaptureFailure"),
    conservationCaptureFailure: exact?.conservationCaptureFailure ?? null,
    conservationValidationReported: exact !== null && Object.hasOwn(exact, "conservationValidationFailure"),
    conservationValidationFailure: exact?.conservationValidationFailure ?? null,
    conservationItemCounts: exact?.conservationItemCounts ?? null,
  };
}

function unique(values) {
  return [...new Set(values)];
}

export function validateDeterminismEvidence(cells, requiredThreads = REQUIRED_THREAD_SETTINGS) {
  const errors = [];
  const countsByThread = Object.fromEntries(requiredThreads.map((thread) => [
    thread,
    cells.filter((cell) => cell.threads === thread).length,
  ]));
  const runCounts = unique(Object.values(countsByThread));
  if (runCounts.length !== 1 || runCounts[0] < 1) errors.push("thread matrix cell counts are not balanced");
  if (cells.some((cell) => !requiredThreads.includes(cell.threads))) errors.push("thread matrix contains an unsupported setting");
  for (const thread of requiredThreads) {
    if (!cells.some((cell) => cell.threads === thread)) errors.push(`threads=${thread}: cell is missing`);
  }
  for (const cell of cells) {
    const evidence = cell.evidence ?? {};
    const requested = Number(cell.threads);
    const prefix = `sequence ${cell.sequence} threads=${cell.threads}`;
    if (cell.reportStatus !== "completed") errors.push(`${prefix}: child report did not complete`);
    if (evidence.reportedThreadSetting !== cell.threads) errors.push(`${prefix}: child reported a different thread setting`);
    if (evidence.effectiveWorkerLimit !== requested) errors.push(`${prefix}: effective worker limit was ${evidence.effectiveWorkerLimit}`);
    if (evidence.observedWorkerCount !== requested) errors.push(`${prefix}: observed worker count was ${evidence.observedWorkerCount}`);
    if (evidence.exactState !== true) errors.push(`${prefix}: complete native state did not match the JavaScript oracle`);
    if (!Number.isSafeInteger(evidence.revision) || evidence.revision < 1
      || evidence.revision !== evidence.expectedRevision) {
      errors.push(`${prefix}: revision proof is missing or divergent`);
    }
    for (const key of ["canonicalSha256", "expectedCanonicalSha256", "domainSha256", "conservationSummarySha256"]) {
      if (!SHA256.test(evidence[key] ?? "")) errors.push(`${prefix}: ${key} is missing or invalid`);
    }
    if (evidence.canonicalSha256 !== evidence.expectedCanonicalSha256) {
      errors.push(`${prefix}: canonical SHA-256 differs from the JavaScript oracle`);
    }
    if (evidence.conservationCaptureReported !== true || evidence.conservationCaptureFailure !== null) {
      errors.push(`${prefix}: conservation capture failed`);
    }
    if (evidence.conservationValidationReported !== true) {
      errors.push(`${prefix}: conservation validation result is missing`);
    } else if (evidence.conservationValidationFailure !== null) {
      errors.push(`${prefix}: conservation validation failed: ${evidence.conservationValidationFailure}`);
    }
    if (!evidence.conservationItemCounts || typeof evidence.conservationItemCounts !== "object") {
      errors.push(`${prefix}: conservation item counts are missing`);
    }
  }
  const equalityFields = ["revision", "canonicalSha256", "domainSha256", "conservationSummarySha256"];
  for (const field of equalityFields) {
    const values = unique(cells.map((cell) => cell.evidence?.[field]));
    if (values.length !== 1) errors.push(`${field} differs across thread settings/runs (${values.length} values)`);
  }
  const conservationValidationFailures = unique(cells.map((cell) => cell.evidence?.conservationValidationFailure ?? null));
  if (conservationValidationFailures.length !== 1) {
    errors.push("conservation validation result differs across thread settings/runs");
  }
  return {
    valid: errors.length === 0,
    errors,
    common: errors.length === 0 ? Object.fromEntries(equalityFields.map((field) => [field, cells[0].evidence[field]])) : null,
    conservationValidationFailure: conservationValidationFailures.length === 1
      ? conservationValidationFailures[0]
      : "divergent",
  };
}

export function runDeterminismMatrix(options, dependencies = {}) {
  const identity = dependencies.fileIdentity ?? fileIdentity;
  const runCell = dependencies.runStress ?? runStress;
  const now = dependencies.now ?? Date.now;
  const logger = dependencies.logger ?? (() => {});
  const initialBinary = identity(options.binary);
  const initialFixture = identity(options.fixture);
  const startedAtMs = now();
  const schedule = buildInterleavedSchedule(REQUIRED_THREAD_SETTINGS, options.runs);
  const cells = [];
  let abortReason = null;
  for (const cell of schedule) {
    logger(`[${cell.sequence}/${schedule.length}] round=${cell.round} threads=${cell.threads}`);
    if (!sameIdentity(initialBinary, identity(options.binary))) {
      abortReason = "binary-identity-changed";
      break;
    }
    if (!sameIdentity(initialFixture, identity(options.fixture))) {
      abortReason = "fixture-identity-changed";
      break;
    }
    const report = runCell({
      binary: options.binary,
      fixture: options.fixture,
      output: options.output,
      runs: 1,
      scenario: "exact",
      threads: cell.threads,
      syncRecordDrop: false,
      profile: true,
    }, { logger: () => {} });
    const binaryAfter = identity(options.binary);
    const fixtureAfter = identity(options.fixture);
    const immutableInputs = sameIdentity(initialBinary, binaryAfter) && sameIdentity(initialFixture, fixtureAfter);
    cells.push({
      ...cell,
      immutableInputs,
      reportStatus: report?.status ?? "missing",
      evidence: evidenceFromReport(report, cell.threads),
      report,
    });
    if (!immutableInputs) {
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
  const evidence = validateDeterminismEvidence(cells);
  const completed = cells.length === schedule.length
    && cells.every((cell) => cell.reportStatus === "completed" && cell.immutableInputs)
    && evidence.valid && binaryUnchanged && fixtureUnchanged && !abortReason;
  const completedAtMs = now();
  return {
    schemaVersion: 1,
    verification: "native-core-complete-state-thread-determinism-v1",
    status: completed ? "completed" : "failed",
    generatedAt: new Date(completedAtMs).toISOString(),
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: Math.max(0, completedAtMs - startedAtMs),
    scope: {
      requestedThreadSettings: REQUIRED_THREAD_SETTINGS,
      runsPerThread: options.runs,
      scenario: "one-second-exact-full-state",
      proof: ["revision", "canonicalSha256", "domainSha256", "conservationSummarySha256"],
      authorityParallelismClaimed: false,
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
      completedCells: cells.filter((cell) => cell.reportStatus === "completed").length,
      allInputsImmutable: cells.every((cell) => cell.immutableInputs) && binaryUnchanged && fixtureUnchanged,
      determinism: evidence,
    },
    abortReason,
    schedule,
    cells,
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
    const report = runDeterminismMatrix(options, { logger: (message) => console.error(message) });
    writeJsonAtomic(options.output, report);
    console.log(JSON.stringify({
      output: options.output,
      status: report.status,
      completedCells: report.validation.completedCells,
      requestedCells: report.validation.requestedCells,
      proof: report.validation.determinism.common,
    }, null, 2));
    return report.status === "completed" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), SCRIPT_PATH)) {
  process.exitCode = main();
}
