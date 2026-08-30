#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./stress-native-core-real-save.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REQUIRED_THREADS = Object.freeze(["1", "2", "4", "8"]);
export const REQUIRED_SECONDS = Object.freeze(["1", "5", "60"]);
export const QUALIFICATION_THRESHOLD = 0.03;
const SHA256 = /^[a-f0-9]{64}$/;
const INTEGER_FIELDS = Object.freeze([
  "groups",
  "candidate-routes",
  "components",
  "parallel-components",
  "serial-components",
  "total-work",
  "largest-work",
  "parallel-work",
  "serial-fallback-work",
  "quantum-fallback-work",
  "opaque-fallback-work",
  "greedy8-serial-equivalent-work",
]);

function samePath(left, right, platform = process.platform) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function round(value, digits = 9) {
  return Number(value.toFixed(digits));
}

function share(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function matrixCellFileName(profile, threads, seconds) {
  return `profile-${profile ? "on" : "off"}-${threads}t-${seconds}s.json`;
}

export function usageText() {
  return [
    "Usage:",
    "  node scripts/verify-native-belt-conflict-profile-matrix.mjs \\",
    "    --input-dir <absolute-report-directory> --output <absolute-json-path>",
    "",
    "The input directory must contain exactly named stress reports for profile",
    "on/off at 1/2/4/8 threads and 1/5/60 exact seconds. The verifier proves",
    "canonical/domain/conservation/JavaScript hash equality and immutable fixture",
    "identity, then derives the eight-worker zero-overhead component upper bound",
    "from profile-on 8-thread/1-second evidence.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {};
  const valueFlags = new Map([
    ["--input-dir", "inputDir"],
    ["--output", "output"],
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
  for (const key of ["inputDir", "output"]) {
    if (!options[key]) throw new Error(`Missing required --${key === "inputDir" ? "input-dir" : key}`);
    if (!path.isAbsolute(options[key])) throw new Error(`--${key === "inputDir" ? "input-dir" : key} must be absolute`);
    options[key] = path.normalize(options[key]);
  }
  if (samePath(options.inputDir, options.output)) {
    throw new Error("--input-dir and --output must be different paths");
  }
  return options;
}

function parseFiniteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not finite`);
  return parsed;
}

export function parseConflictProfileValue(rawValue) {
  const fields = {};
  for (const entry of String(rawValue).split("\t")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`invalid conflict profile field: ${entry}`);
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (Object.hasOwn(fields, key)) throw new Error(`duplicate conflict profile field: ${key}`);
    fields[key] = value;
  }
  const required = [
    "pass",
    ...INTEGER_FIELDS,
    "largest-share",
    "parallel-share",
    "serial-fallback-share",
    "quantum-fallback-share",
    "opaque-fallback-share",
    "greedy8-loads",
    "greedy8-serial-fraction",
  ];
  for (const key of required) {
    if (!Object.hasOwn(fields, key)) throw new Error(`missing conflict profile field: ${key}`);
  }
  const integers = Object.fromEntries(INTEGER_FIELDS.map((key) => {
    const parsed = parseFiniteNumber(fields[key], key);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${key} is not a non-negative safe integer`);
    return [key, parsed];
  }));
  const greedyLoads = fields["greedy8-loads"].split(",").map((value, index) => {
    const parsed = parseFiniteNumber(value, `greedy8-loads[${index}]`);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`greedy8-loads[${index}] is not a non-negative safe integer`);
    }
    return parsed;
  });
  if (greedyLoads.length !== 8) throw new Error("greedy8-loads must contain exactly eight values");
  return {
    pass: fields.pass,
    selectedGroups: integers.groups,
    candidateRoutes: integers["candidate-routes"],
    componentCount: integers.components,
    parallelComponentCount: integers["parallel-components"],
    serialComponentCount: integers["serial-components"],
    totalWorkUnits: integers["total-work"],
    largestComponentWorkUnits: integers["largest-work"],
    largestShareReported: parseFiniteNumber(fields["largest-share"], "largest-share"),
    parallelWorkUnits: integers["parallel-work"],
    parallelShareReported: parseFiniteNumber(fields["parallel-share"], "parallel-share"),
    serialFallbackWorkUnits: integers["serial-fallback-work"],
    serialFallbackShareReported: parseFiniteNumber(fields["serial-fallback-share"], "serial-fallback-share"),
    quantumFallbackWorkUnits: integers["quantum-fallback-work"],
    quantumFallbackShareReported: parseFiniteNumber(fields["quantum-fallback-share"], "quantum-fallback-share"),
    opaqueFallbackWorkUnits: integers["opaque-fallback-work"],
    opaqueFallbackShareReported: parseFiniteNumber(fields["opaque-fallback-share"], "opaque-fallback-share"),
    greedy8Loads: greedyLoads,
    greedy8SerialEquivalentWorkUnits: integers["greedy8-serial-equivalent-work"],
    greedy8SerialFractionReported: parseFiniteNumber(fields["greedy8-serial-fraction"], "greedy8-serial-fraction"),
  };
}

function exactRecord(report) {
  return report?.runs?.[0]?.benchmarkMarkers
    ?.find((marker) => marker.label === "exact" && !marker.parseError)
    ?.value?.nativeCoreExactRealSaveAdvance ?? null;
}

function identityKey(identity) {
  if (!identity) return null;
  return JSON.stringify({
    resolvedPath: identity.resolvedPath ?? null,
    sizeBytes: identity.sizeBytes ?? null,
    mtimeNs: identity.mtimeNs ?? null,
    sha256: identity.sha256 ?? null,
  });
}

function validateConflictPass(profile, errors) {
  const prefix = profile.pass || "unknown-pass";
  if (!profile.totalWorkUnits) errors.push(`${prefix}: total work is zero`);
  if (profile.parallelComponentCount + profile.serialComponentCount !== profile.componentCount) {
    errors.push(`${prefix}: component accounting does not close`);
  }
  if (profile.parallelWorkUnits + profile.serialFallbackWorkUnits !== profile.totalWorkUnits) {
    errors.push(`${prefix}: work accounting does not close`);
  }
  if (profile.largestComponentWorkUnits > profile.totalWorkUnits) {
    errors.push(`${prefix}: largest component exceeds total work`);
  }
  if (profile.quantumFallbackWorkUnits > profile.serialFallbackWorkUnits) {
    errors.push(`${prefix}: quantum fallback exceeds serial fallback`);
  }
  if (profile.opaqueFallbackWorkUnits > profile.serialFallbackWorkUnits) {
    errors.push(`${prefix}: opaque fallback exceeds serial fallback`);
  }
  const loadTotal = profile.greedy8Loads.reduce((sum, value) => sum + value, 0);
  if (loadTotal !== profile.parallelWorkUnits) errors.push(`${prefix}: greedy loads do not close to parallel work`);
  const maximumLoad = Math.max(...profile.greedy8Loads);
  if (profile.serialFallbackWorkUnits + maximumLoad !== profile.greedy8SerialEquivalentWorkUnits) {
    errors.push(`${prefix}: greedy serial-equivalent work is inconsistent`);
  }
  const fractions = [
    ["largest-share", profile.largestShareReported, share(profile.largestComponentWorkUnits, profile.totalWorkUnits)],
    ["parallel-share", profile.parallelShareReported, share(profile.parallelWorkUnits, profile.totalWorkUnits)],
    ["serial-fallback-share", profile.serialFallbackShareReported, share(profile.serialFallbackWorkUnits, profile.totalWorkUnits)],
    ["quantum-fallback-share", profile.quantumFallbackShareReported, share(profile.quantumFallbackWorkUnits, profile.totalWorkUnits)],
    ["opaque-fallback-share", profile.opaqueFallbackShareReported, share(profile.opaqueFallbackWorkUnits, profile.totalWorkUnits)],
    ["greedy8-serial-fraction", profile.greedy8SerialFractionReported, share(profile.greedy8SerialEquivalentWorkUnits, profile.totalWorkUnits)],
  ];
  for (const [label, reported, calculated] of fractions) {
    if (Math.abs(reported - calculated) > 0.000001) errors.push(`${prefix}: ${label} is inconsistent`);
  }
}

function conflictEvidence(report, errors) {
  const markers = report?.runs?.[0]?.nativeProfileMarkers ?? [];
  const passes = [];
  let lastStableApplyDurationMs = null;
  for (const marker of markers) {
    if (marker.label === "belt-transfer-stable-apply" && Number.isFinite(marker.value)) {
      lastStableApplyDurationMs = marker.value;
      continue;
    }
    if (marker.label !== "belt-conflict-components") continue;
    try {
      const parsed = parseConflictProfileValue(marker.rawValue);
      if (!Number.isFinite(lastStableApplyDurationMs) || lastStableApplyDurationMs < 0) {
        errors.push(`${parsed.pass}: preceding stable-apply duration is missing`);
      }
      parsed.stableApplyDurationMs = lastStableApplyDurationMs;
      validateConflictPass(parsed, errors);
      passes.push(parsed);
    } catch (error) {
      errors.push(`belt-conflict-components: ${error instanceof Error ? error.message : String(error)}`);
    }
    lastStableApplyDurationMs = null;
  }
  const names = passes.map((profile) => profile.pass);
  if (passes.length !== 2 || names[0] !== "pre-production" || names[1] !== "post-production") {
    errors.push(`profile source must contain pre-production and post-production passes (${names.join(",") || "none"})`);
  }
  return passes;
}

function summarizePass(profile) {
  const greedy8SerialFraction = share(
    profile.greedy8SerialEquivalentWorkUnits,
    profile.totalWorkUnits,
  );
  const theoreticalSerialDurationMs = profile.stableApplyDurationMs * greedy8SerialFraction;
  return {
    pass: profile.pass,
    selectedGroups: profile.selectedGroups,
    candidateRoutes: profile.candidateRoutes,
    componentCount: profile.componentCount,
    parallelComponentCount: profile.parallelComponentCount,
    serialComponentCount: profile.serialComponentCount,
    totalWorkUnits: profile.totalWorkUnits,
    largestComponentWorkUnits: profile.largestComponentWorkUnits,
    largestComponentShare: round(share(profile.largestComponentWorkUnits, profile.totalWorkUnits)),
    parallelWorkUnits: profile.parallelWorkUnits,
    parallelWorkShare: round(share(profile.parallelWorkUnits, profile.totalWorkUnits)),
    serialFallbackWorkUnits: profile.serialFallbackWorkUnits,
    serialFallbackShare: round(share(profile.serialFallbackWorkUnits, profile.totalWorkUnits)),
    quantumFallbackWorkUnits: profile.quantumFallbackWorkUnits,
    quantumFallbackShare: round(share(profile.quantumFallbackWorkUnits, profile.totalWorkUnits)),
    opaqueFallbackWorkUnits: profile.opaqueFallbackWorkUnits,
    opaqueFallbackShare: round(share(profile.opaqueFallbackWorkUnits, profile.totalWorkUnits)),
    greedy8Loads: profile.greedy8Loads,
    greedy8SerialEquivalentWorkUnits: profile.greedy8SerialEquivalentWorkUnits,
    greedy8SerialFraction: round(greedy8SerialFraction),
    measuredStableApplyDurationMs: profile.stableApplyDurationMs,
    theoreticalEightWaySerialDurationMs: round(theoreticalSerialDurationMs, 6),
    theoreticalEightWaySavedDurationMs: round(profile.stableApplyDurationMs - theoreticalSerialDurationMs, 6),
  };
}

export function verifyMatrixDocuments(documents, generatedAt = new Date().toISOString()) {
  const errors = [];
  const byName = new Map();
  for (const document of documents) {
    if (byName.has(document.fileName)) errors.push(`duplicate report: ${document.fileName}`);
    byName.set(document.fileName, document);
  }
  const cells = [];
  for (const seconds of REQUIRED_SECONDS) {
    for (const threads of REQUIRED_THREADS) {
      for (const profile of [false, true]) {
        const fileName = matrixCellFileName(profile, threads, seconds);
        const document = byName.get(fileName);
        if (!document) {
          errors.push(`missing report: ${fileName}`);
          continue;
        }
        const report = document.report;
        const exact = exactRecord(report);
        const prefix = `${fileName}`;
        if (report?.status !== "completed") errors.push(`${prefix}: report did not complete`);
        if (report?.command?.scenario !== "exact") errors.push(`${prefix}: scenario is not exact`);
        if (String(report?.command?.threads) !== threads) errors.push(`${prefix}: thread setting differs`);
        if (String(report?.command?.seconds) !== seconds) errors.push(`${prefix}: duration differs`);
        if (report?.command?.profile !== profile) errors.push(`${prefix}: profile setting differs`);
        const requestedValidationValid = report?.validation?.allRequestedValidationValid
          ?? report?.validation?.allRunsExact;
        if (report?.validation?.fixtureUnchanged !== true
          || report?.validation?.binaryUnchanged !== true
          || requestedValidationValid !== true) {
          errors.push(`${prefix}: immutable/exact validation is incomplete`);
        }
        if (!exact) {
          errors.push(`${prefix}: exact record is missing`);
        } else {
          if (exact.simulationSeconds !== Number(seconds)) errors.push(`${prefix}: exact duration differs`);
          if (String(exact.requestedThreadSetting) !== threads) errors.push(`${prefix}: benchmark thread setting differs`);
          for (const field of [
            "canonicalSha256",
            "expectedCanonicalSha256",
            "domainSha256",
            "conservationSummarySha256",
          ]) {
            if (!SHA256.test(exact[field] ?? "")) errors.push(`${prefix}: ${field} is invalid`);
          }
          if (exact.conservationCaptureFailure !== null || exact.conservationValidationFailure !== null) {
            errors.push(`${prefix}: conservation failed`);
          }
        }
        const markerCount = report?.runs?.[0]?.nativeProfileMarkers?.length ?? 0;
        if (profile && markerCount === 0) errors.push(`${prefix}: profile markers are missing`);
        if (!profile && markerCount !== 0) errors.push(`${prefix}: profile-off report retained profile markers`);
        cells.push({
          fileName,
          fileSha256: document.sha256,
          profile,
          threads,
          seconds,
          reportStatus: report?.status ?? "missing",
          binaryIdentity: report?.immutableInputs?.binary?.initial ?? null,
          fixtureIdentity: report?.immutableInputs?.fixture?.initial ?? null,
          exact,
          oracleEqual: exact?.exactState === true
            && exact?.canonicalSha256 === exact?.expectedCanonicalSha256
            && Array.isArray(exact?.fieldMismatches)
            && exact.fieldMismatches.length === 0,
          fieldMismatches: Array.isArray(exact?.fieldMismatches) ? exact.fieldMismatches : null,
          nativeAdvanceDurationMs: exact?.nativeAdvanceDurationMs ?? null,
        });
      }
    }
  }

  const binaryKeys = new Set(cells.map((cell) => identityKey(cell.binaryIdentity)));
  const fixtureKeys = new Set(cells.map((cell) => identityKey(cell.fixtureIdentity)));
  if (binaryKeys.size !== 1 || binaryKeys.has(null)) errors.push("binary identity differs across matrix cells");
  if (fixtureKeys.size !== 1 || fixtureKeys.has(null)) errors.push("fixture identity differs across matrix cells");
  const durationProofs = {};
  for (const seconds of REQUIRED_SECONDS) {
    const durationCells = cells.filter((cell) => cell.seconds === seconds);
    const fields = [
      "canonicalSha256",
      "expectedCanonicalSha256",
      "domainSha256",
      "conservationSummarySha256",
    ];
    const common = {};
    for (const field of fields) {
      const values = new Set(durationCells.map((cell) => cell.exact?.[field] ?? null));
      if (values.size !== 1 || values.has(null)) {
        errors.push(`${seconds}s: ${field} differs across profile/thread cells`);
      } else {
        [common[field]] = values;
      }
    }
    const oracleRelations = new Set(durationCells.map((cell) => cell.oracleEqual));
    if (oracleRelations.size !== 1) {
      errors.push(`${seconds}s: native/JavaScript equality differs across profile/thread cells`);
    }
    const mismatchShapes = new Set(durationCells.map((cell) => JSON.stringify(cell.fieldMismatches)));
    if (mismatchShapes.size !== 1) {
      errors.push(`${seconds}s: mismatch fields differ across profile/thread cells`);
    }
    common.nativeMatchesJavascript = oracleRelations.size === 1 ? [...oracleRelations][0] : null;
    common.fieldMismatches = mismatchShapes.size === 1
      ? JSON.parse([...mismatchShapes][0])
      : null;
    durationProofs[seconds] = common;
  }

  const sourceCell = cells.find((cell) => cell.profile && cell.threads === "8" && cell.seconds === "1");
  const sourceDocument = sourceCell ? byName.get(sourceCell.fileName) : null;
  const rawPasses = sourceDocument ? conflictEvidence(sourceDocument.report, errors) : [];
  const passes = rawPasses.map(summarizePass);
  const baselineCell = cells.find((cell) => !cell.profile && cell.threads === "8" && cell.seconds === "1");
  const baselineAdvanceMs = baselineCell?.nativeAdvanceDurationMs;
  if (!Number.isFinite(baselineAdvanceMs) || baselineAdvanceMs <= 0) {
    errors.push("profile-off 8-thread/1-second native advance duration is invalid");
  }
  const stableApplyDurationMs = passes.reduce(
    (sum, profile) => sum + profile.measuredStableApplyDurationMs,
    0,
  );
  const theoreticalSerialDurationMs = passes.reduce(
    (sum, profile) => sum + profile.theoreticalEightWaySerialDurationMs,
    0,
  );
  const theoreticalSavedDurationMs = stableApplyDurationMs - theoreticalSerialDurationMs;
  const theoreticalWholeStepBenefit = Number.isFinite(baselineAdvanceMs) && baselineAdvanceMs > 0
    ? theoreticalSavedDurationMs / baselineAdvanceMs
    : 0;
  const totalWorkUnits = passes.reduce((sum, profile) => sum + profile.totalWorkUnits, 0);
  const parallelWorkUnits = passes.reduce((sum, profile) => sum + profile.parallelWorkUnits, 0);
  const serialFallbackWorkUnits = passes.reduce((sum, profile) => sum + profile.serialFallbackWorkUnits, 0);
  const quantumFallbackWorkUnits = passes.reduce((sum, profile) => sum + profile.quantumFallbackWorkUnits, 0);
  const opaqueFallbackWorkUnits = passes.reduce((sum, profile) => sum + profile.opaqueFallbackWorkUnits, 0);
  const largest = passes.reduce((current, profile) => (
    !current || profile.largestComponentWorkUnits > current.workUnits
      ? { pass: profile.pass, workUnits: profile.largestComponentWorkUnits, share: profile.largestComponentShare }
      : current
  ), null);
  const qualified = errors.length === 0 && theoreticalWholeStepBenefit >= QUALIFICATION_THRESHOLD;

  return {
    schemaVersion: 1,
    verification: "native-belt-conflict-component-qualification-v1",
    status: errors.length === 0 ? "completed" : "failed",
    generatedAt,
    scope: {
      profileSettings: ["off", "on"],
      threadSettings: REQUIRED_THREADS,
      exactSeconds: REQUIRED_SECONDS,
      requestedCells: REQUIRED_THREADS.length * REQUIRED_SECONDS.length * 2,
      profileSourceCell: matrixCellFileName(true, "8", "1"),
      timingBaselineCell: matrixCellFileName(false, "8", "1"),
      materialAlgorithmChanged: false,
      authorityParallelismClaimed: false,
    },
    immutableInputs: {
      binary: cells[0]?.binaryIdentity ?? null,
      fixture: cells[0]?.fixtureIdentity ?? null,
      binarySameAcrossCells: binaryKeys.size === 1 && !binaryKeys.has(null),
      fixtureSameAcrossCells: fixtureKeys.size === 1 && !fixtureKeys.has(null),
    },
    matrix: {
      completedCells: cells.filter((cell) => cell.reportStatus === "completed").length,
      valid: errors.length === 0,
      errors,
      durationProofs,
      cells: cells.map((cell) => ({
        fileName: cell.fileName,
        sha256: cell.fileSha256,
        profile: cell.profile,
        threads: cell.threads,
        seconds: cell.seconds,
        status: cell.reportStatus,
        nativeAdvanceDurationMs: cell.nativeAdvanceDurationMs,
      })),
    },
    conflictProfile: {
      passes,
      combined: {
        componentCount: passes.reduce((sum, profile) => sum + profile.componentCount, 0),
        largestComponent: largest,
        totalWorkUnits,
        parallelWorkUnits,
        parallelWorkShare: round(share(parallelWorkUnits, totalWorkUnits)),
        serialFallbackWorkUnits,
        serialFallbackShare: round(share(serialFallbackWorkUnits, totalWorkUnits)),
        quantumFallbackWorkUnits,
        quantumFallbackShare: round(share(quantumFallbackWorkUnits, totalWorkUnits)),
        opaqueFallbackWorkUnits,
        opaqueFallbackShare: round(share(opaqueFallbackWorkUnits, totalWorkUnits)),
      },
    },
    qualification: {
      thresholdFraction: QUALIFICATION_THRESHOLD,
      profileOffWholeStepDurationMs: Number.isFinite(baselineAdvanceMs) ? baselineAdvanceMs : null,
      measuredStableApplyDurationMs: round(stableApplyDurationMs, 6),
      theoreticalEightWaySerialDurationMs: round(theoreticalSerialDurationMs, 6),
      theoreticalSavedDurationMs: round(theoreticalSavedDurationMs, 6),
      theoreticalWholeStepBenefitFraction: round(theoreticalWholeStepBenefit),
      theoreticalWholeStepBenefitPercent: round(theoreticalWholeStepBenefit * 100, 6),
      qualifiedForImplementationExperiment: qualified,
      decision: qualified
        ? "qualifies-for-implementation-experiment"
        : errors.length === 0 ? "no-go-below-3-percent" : "invalid-evidence",
      model: "Measured stable-apply time multiplied by deterministic work-unit greedy-eight serial fractions; zero scheduling/merge overhead.",
      limitation: "This is a profiling upper-bound qualification, not measured speedup and not authority eligibility.",
    },
  };
}

export function loadMatrixDirectory(inputDir) {
  const documents = [];
  for (const seconds of REQUIRED_SECONDS) {
    for (const threads of REQUIRED_THREADS) {
      for (const profile of [false, true]) {
        const fileName = matrixCellFileName(profile, threads, seconds);
        const filePath = path.join(inputDir, fileName);
        const bytes = fs.readFileSync(filePath);
        documents.push({
          fileName,
          sha256: sha256(bytes),
          report: JSON.parse(bytes.toString("utf8")),
        });
      }
    }
  }
  return documents;
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
  if (!fs.existsSync(options.inputDir) || !fs.statSync(options.inputDir).isDirectory()) {
    console.error(`input directory does not exist: ${options.inputDir}`);
    return 2;
  }
  if (fs.existsSync(options.output)) {
    console.error(`Output already exists: ${options.output}`);
    return 2;
  }
  try {
    const report = verifyMatrixDocuments(loadMatrixDirectory(options.inputDir));
    writeJsonAtomic(options.output, report);
    console.log(JSON.stringify({
      output: options.output,
      status: report.status,
      validCells: report.matrix.completedCells,
      requestedCells: report.scope.requestedCells,
      decision: report.qualification.decision,
      theoreticalWholeStepBenefitPercent: report.qualification.theoreticalWholeStepBenefitPercent,
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
