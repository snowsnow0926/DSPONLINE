import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { readCloudPayload } from "./cloud-payload-store.mjs";
import { evaluateLeaderboardIntegrity } from "./leaderboard-integrity.mjs";
import { inspectParsedSavePayloadIntegrity } from "./save-integrity.mjs";

const DATABASE_FILE = "/var/lib/dsp-idle-cloud/cloud.sqlite";
const ADMIN_ENV_FILE = "/etc/dsp-idle-cloud/admin.env";
const GUARD_DIRECTORY = "/var/lib/dsp-idle-cloud/account-action-guards";
const API_BASE_URL = "http://127.0.0.1:4330";
const NORMAL_CATEGORIES = ["power", "upload", "white-rate", "dyson", "throughput", "galaxy"];
const SPEEDRUN_TARGETS = ["all_technologies", "dyson_rockets_10000", "white_matrix_1m"];
const BUILDING_STACK_LIMIT = 100_000_000;
const WHITE_MATRIX_INPUTS = [
  "electromagnetic_matrix",
  "energy_matrix",
  "structure_matrix",
  "information_matrix",
  "gravity_matrix",
  "antimatter",
];
const MATRIX_RECIPE_SPECS = {
  electromagnetic_matrix: { duration: 3, output: 1 },
  energy_matrix: { duration: 6, output: 1 },
  structure_matrix: { duration: 8, output: 1 },
  information_matrix: { duration: 10, output: 1 },
  gravity_matrix: { duration: 24, output: 2 },
  universe_matrix: { duration: 15, output: 1 },
};
const DIFFICULTY_PRODUCTION_MULTIPLIER = { relaxed: 1.15, standard: 1, hard: 0.85 };
const DIFFICULTY_POWER_MULTIPLIER = { relaxed: 0.9, standard: 1, hard: 1.2 };
const PROLIFERATOR = {
  1: { extra: 0.125, speed: 0.25, power: 1.3 },
  2: { extra: 0.2, speed: 0.5, power: 1.7 },
  3: { extra: 0.25, speed: 1, power: 2.5 },
};

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function decodeBase64Url(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) fail(code);
  const padding = "=".repeat((4 - value.length % 4) % 4);
  try {
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/") + padding, "base64").toString("utf8");
  } catch {
    fail(code);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function loadState() {
  const database = new Database(DATABASE_FILE, { readonly: true, fileMustExist: true });
  database.pragma("query_only = ON");
  const row = database.prepare("SELECT payload, updated_at AS updatedAt FROM app_state WHERE id = 1").get();
  if (!row?.payload) {
    database.close();
    fail("APP_STATE_MISSING");
  }
  let data;
  try {
    data = JSON.parse(row.payload);
  } catch {
    database.close();
    fail("APP_STATE_INVALID");
  }
  if (data?.schemaVersion !== 8 || data?.storageLayoutVersion !== 3) {
    database.close();
    fail("PRODUCTION_BASELINE_CHANGED");
  }
  return { database, row, data };
}

function normalSubmissionFor(data, accountId) {
  return Object.values(data.submissions ?? {}).find(
    (entry) => entry?.userId === accountId || entry?.accountId === accountId,
  ) ?? null;
}

function resolveAccount(data, matchBy, identifier, expectedWhiteRate = null) {
  const users = Object.values(data.users ?? {});
  if (matchBy === "guard-id") {
    if (!/^guard-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(identifier)) fail("GUARD_ID_INVALID");
    let guard;
    try {
      guard = JSON.parse(readFileSync(`${GUARD_DIRECTORY}/${identifier}.json`, "utf8"));
    } catch {
      fail("GUARD_UNAVAILABLE");
    }
    if (guard?.format !== "dsp-idle-account-action-guard-v1" || typeof guard?.accountId !== "string") {
      fail("GUARD_INVALID");
    }
    const user = data.users?.[guard.accountId];
    if (!user) fail("GUARD_ACCOUNT_MISSING");
    return user;
  }
  const matches = matchBy === "username"
    ? users.filter((user) => user?.username === identifier.toLowerCase())
    : users.filter((user) => user?.displayName === identifier);
  let unique = [...new Map(matches.map((user) => [user.id, user])).values()];
  if (unique.length !== 1 && Number.isFinite(expectedWhiteRate) && expectedWhiteRate > 0) {
    unique = unique.filter((user) => {
      const observed = normalSubmissionFor(data, user.id)?.metrics?.peakWhiteMatrixPerMinute;
      return Number.isFinite(observed) && Math.abs(observed - expectedWhiteRate) / expectedWhiteRate <= 0.02;
    });
  }
  if (unique.length !== 1) fail(`ACCOUNT_MATCH_COUNT_${unique.length}`);
  return unique[0];
}

function normalSubmissionEntries(data, accountId) {
  return Object.entries(data.submissions ?? {})
    .filter(([, submission]) => submission?.userId === accountId || submission?.accountId === accountId)
    .sort(([left], [right]) => left.localeCompare(right));
}

function speedrunSubmissionEntries(data, accountId) {
  return Object.entries(data.speedrunSubmissions ?? {})
    .filter(([, submission]) => submission?.userId === accountId)
    .sort(([left], [right]) => left.localeCompare(right));
}

function protectedAccountSnapshot(database, data, accountId) {
  return {
    user: data.users?.[accountId] ?? null,
    sessions: Object.entries(data.sessions ?? {})
      .filter(([, session]) => session?.userId === accountId)
      .sort(([left], [right]) => left.localeCompare(right)),
    cloud: {
      current: data.cloudSaves?.[accountId] ?? null,
      history: data.cloudSaveHistory?.[accountId] ?? null,
      slots: data.cloudSaveSlots?.[accountId] ?? null,
      slotHistory: data.cloudSaveSlotHistory?.[accountId] ?? null,
      currentByMode: data.cloudSavesByMode?.[accountId] ?? null,
      historyByMode: data.cloudSaveHistoryByMode?.[accountId] ?? null,
      slotsByMode: data.cloudSaveSlotsByMode?.[accountId] ?? null,
      slotHistoryByMode: data.cloudSaveSlotHistoryByMode?.[accountId] ?? null,
    },
    payloadRows: database.prepare(
      "SELECT slot, revision, payload FROM cloud_save_payloads WHERE user_id = ? ORDER BY slot, revision",
    ).all(accountId),
    speedrunSubmissions: speedrunSubmissionEntries(data, accountId),
  };
}

function globalPayloadCounts(database) {
  return {
    payloads: database.prepare("SELECT COUNT(*) AS count FROM cloud_save_payloads").get().count,
    blobs: database.prepare("SELECT COUNT(*) AS count FROM cloud_save_payload_blobs").get().count,
  };
}

function parseSaveState(payload) {
  const parsed = JSON.parse(payload);
  return parsed?.state ?? parsed;
}

function finiteNonNegative(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function saturatingAdd(left, right) {
  const total = finiteNonNegative(left) + finiteNonNegative(right);
  return Number.isFinite(total) ? Math.min(Number.MAX_VALUE, total) : Number.MAX_VALUE;
}

function saturatingProduct(...values) {
  let total = 1;
  for (const value of values) {
    total *= finiteNonNegative(value);
    if (!Number.isFinite(total) || total >= Number.MAX_VALUE) return Number.MAX_VALUE;
  }
  return total;
}

function addCount(map, key, value) {
  if (typeof key !== "string" || !key || value <= 0) return;
  map.set(key, saturatingAdd(map.get(key) ?? 0, value));
}

function sortedCounts(map, limit = 12) {
  return [...map.entries()]
    .map(([id, machineCount]) => ({ id, machineCount }))
    .sort((left, right) => right.machineCount - left.machineCount || left.id.localeCompare(right.id))
    .slice(0, limit);
}

function matrixCompressionLevel(state) {
  return Math.max(0, Math.floor(finiteNonNegative(state?.endgame?.infiniteResearch?.matrix_compression?.level)));
}

function labPlanetMultiplier(state, planetId) {
  const profile = state?.galaxy?.profiles?.[planetId];
  if (!profile || !["balanced", "research"].includes(profile.specialization)) return 1;
  return Math.max(0.1, Math.min(5, finiteNonNegative(profile.productionSpeedMultiplier, 1)));
}

function proliferatorFactors(entity) {
  if (!entity?.sprayCoaterInstalled || ![1, 2, 3].includes(entity.proliferatorTier) ||
      !["speed", "extra"].includes(entity.proliferatorMode)) {
    return { output: 1, power: 1 };
  }
  const definition = PROLIFERATOR[entity.proliferatorTier];
  return {
    output: entity.proliferatorMode === "speed" ? 1 + definition.speed : 1 + definition.extra,
    power: definition.power,
  };
}

function describeState(state, metadata) {
  const entities = Array.isArray(state?.entities) ? state.entities : [];
  const belts = Array.isArray(state?.belts) ? state.belts : [];
  const buildingStacks = new Map();
  const recipeStacks = new Map();
  const relevantRecipeStacks = Object.fromEntries(
    [...Object.keys(MATRIX_RECIPE_SPECS), "antimatter", "critical_photon"].map((id) => [id, 0]),
  );
  const whiteInputs = Object.fromEntries(WHITE_MATRIX_INPUTS.map((id) => [id, 0]));
  const planetIds = new Set();
  const difficulty = Object.hasOwn(DIFFICULTY_PRODUCTION_MULTIPLIER, state?.settings?.difficulty)
    ? state.settings.difficulty
    : "standard";
  const industrialMultiplier = 1 + matrixCompressionLevel(state) * 0.04;
  let totalMachineCount = 0;
  let totalMinerCount = 0;
  let invalidStackCount = 0;
  let overCurrentStackLimitCount = 0;
  let maximumMachineStack = 0;
  let whiteLabNodes = 0;
  let whiteLabMachineCount = 0;
  let whiteLabReportedPerMinute = 0;
  let whiteLabConfiguredCapacityPerMinute = 0;
  let whiteLabConfiguredDemandKw = 0;
  let whiteLabWeightedUtilization = 0;
  let whiteLabOutputBuffer = 0;

  for (const entity of entities) {
    if (typeof entity?.planetId === "string") planetIds.add(entity.planetId);
    const machineCount = Number.isSafeInteger(entity?.machineCount) && entity.machineCount >= 0 ? entity.machineCount : 0;
    const minerCount = Number.isSafeInteger(entity?.minerCount) && entity.minerCount >= 0 ? entity.minerCount : 0;
    if ((Object.hasOwn(entity ?? {}, "machineCount") && !(Number.isSafeInteger(entity.machineCount) && entity.machineCount >= 0)) ||
        (Object.hasOwn(entity ?? {}, "minerCount") && !(Number.isSafeInteger(entity.minerCount) && entity.minerCount >= 0))) invalidStackCount += 1;
    if (machineCount > BUILDING_STACK_LIMIT || minerCount > BUILDING_STACK_LIMIT) overCurrentStackLimitCount += 1;
    maximumMachineStack = Math.max(maximumMachineStack, machineCount, minerCount);
    totalMachineCount = saturatingAdd(totalMachineCount, machineCount);
    totalMinerCount = saturatingAdd(totalMinerCount, minerCount);
    addCount(buildingStacks, entity?.buildingId, machineCount || minerCount);
    addCount(recipeStacks, entity?.recipeId, machineCount);
    if (Object.hasOwn(relevantRecipeStacks, entity?.recipeId)) {
      relevantRecipeStacks[entity.recipeId] = saturatingAdd(relevantRecipeStacks[entity.recipeId], machineCount);
    }

    if (entity?.buildingId !== "matrix_lab" || entity?.recipeId !== "universe_matrix" || machineCount <= 0) continue;
    whiteLabNodes += 1;
    whiteLabMachineCount = saturatingAdd(whiteLabMachineCount, machineCount);
    whiteLabReportedPerMinute = saturatingAdd(whiteLabReportedPerMinute, finiteNonNegative(entity.productionRate));
    const utilization = Math.min(1, finiteNonNegative(entity.utilization));
    whiteLabWeightedUtilization = saturatingAdd(whiteLabWeightedUtilization, machineCount * utilization);
    const spray = proliferatorFactors(entity);
    const planetMultiplier = labPlanetMultiplier(state, entity.planetId);
    const capacity = saturatingProduct(
      machineCount,
      60 / MATRIX_RECIPE_SPECS.universe_matrix.duration,
      MATRIX_RECIPE_SPECS.universe_matrix.output,
      industrialMultiplier,
      DIFFICULTY_PRODUCTION_MULTIPLIER[difficulty],
      planetMultiplier,
      spray.output,
    );
    whiteLabConfiguredCapacityPerMinute = saturatingAdd(whiteLabConfiguredCapacityPerMinute, capacity);
    whiteLabConfiguredDemandKw = saturatingAdd(whiteLabConfiguredDemandKw, saturatingProduct(
      machineCount,
      480,
      DIFFICULTY_POWER_MULTIPLIER[difficulty],
      spray.power,
    ));
    for (const itemId of WHITE_MATRIX_INPUTS) {
      whiteInputs[itemId] = saturatingAdd(whiteInputs[itemId], finiteNonNegative(entity.inputs?.[itemId]));
    }
    whiteLabOutputBuffer = saturatingAdd(whiteLabOutputBuffer, finiteNonNegative(entity.outputs?.universe_matrix));
  }

  const matrixRecipeCapacityPerMinute = {};
  for (const [recipeId, spec] of Object.entries(MATRIX_RECIPE_SPECS)) {
    const machines = finiteNonNegative(relevantRecipeStacks[recipeId]);
    matrixRecipeCapacityPerMinute[recipeId] = saturatingProduct(
      machines,
      60 / spec.duration,
      spec.output,
      industrialMultiplier,
      DIFFICULTY_PRODUCTION_MULTIPLIER[difficulty],
      2,
    );
  }

  return {
    revision: Number.isSafeInteger(metadata?.revision) ? metadata.revision : null,
    payloadBytes: Number.isSafeInteger(metadata?.size) ? metadata.size : null,
    version: state?.version ?? null,
    mode: state?.mode ?? "normal-legacy",
    elapsedSeconds: finiteNonNegative(state?.elapsedSeconds),
    contentPackCount: Array.isArray(state?.contentPacks) ? state.contentPacks.length : 0,
    entityNodes: entities.length,
    beltNodes: belts.length,
    planetCount: planetIds.size,
    totalMachineCount,
    totalMinerCount,
    maximumMachineStack,
    invalidStackCount,
    overCurrentStackLimitCount,
    difficulty,
    matrixCompressionLevel: matrixCompressionLevel(state),
    industrialMultiplier,
    generationKw: finiteNonNegative(state?.metrics?.generationKw),
    demandKw: finiteNonNegative(state?.metrics?.demandKw),
    powerFactor: finiteNonNegative(state?.metrics?.powerFactor),
    totalWhiteMatrixProduced: Math.floor(finiteNonNegative(state?.totalProduced?.universe_matrix)),
    whiteFactory: {
      labNodes: whiteLabNodes,
      labMachineCount: whiteLabMachineCount,
      reportedPerMinute: whiteLabReportedPerMinute,
      configuredCapacityUpperBoundPerMinute: whiteLabConfiguredCapacityPerMinute,
      configuredDemandKw: whiteLabConfiguredDemandKw,
      machineWeightedUtilization: whiteLabMachineCount > 0 ? whiteLabWeightedUtilization / whiteLabMachineCount : 0,
      inputBuffers: whiteInputs,
      outputBuffer: whiteLabOutputBuffer,
      relatedRecipeMachineCounts: relevantRecipeStacks,
      matrixRecipeCapacityUpperBoundsPerMinute: matrixRecipeCapacityPerMinute,
    },
    topBuildingStacks: sortedCounts(buildingStacks),
    topRecipeStacks: sortedCounts(recipeStacks),
  };
}

function integrityProjection(state) {
  return {
    version: state?.version,
    elapsedSeconds: state?.elapsedSeconds,
    totalProduced: state?.totalProduced,
    entities: Array.isArray(state?.entities) && state.entities.length > 0 ? [true] : [],
  };
}

function sectionDigest(value) {
  return sha256Text(JSON.stringify(value ?? null));
}

function conservativeItemUpperBound(state, itemId) {
  const skippedKeys = new Set(["totalProduced", "productionHistory", "metrics", "planetMetrics"]);
  const itemObjectAmountKeys = ["amount", "cargo", "quantity", "stored", "count"];
  let total = 0;
  const visit = (value, parentKey = "") => {
    if (!value || typeof value !== "object" || skippedKeys.has(parentKey)) return;
    if (!Array.isArray(value) && value.itemId === itemId) {
      for (const key of itemObjectAmountKeys) total = saturatingAdd(total, finiteNonNegative(value[key]));
    }
    for (const [key, child] of Object.entries(value)) {
      if (skippedKeys.has(key)) continue;
      if (key === itemId && typeof child === "number") total = saturatingAdd(total, finiteNonNegative(child));
      else if (child && typeof child === "object") visit(child, key);
    }
  };
  visit(state);
  return total;
}

function productionTopologyDigest(state) {
  const relevantRecipes = new Set([...Object.keys(MATRIX_RECIPE_SPECS), "antimatter", "critical_photon"]);
  const topology = (Array.isArray(state?.entities) ? state.entities : [])
    .filter((entity) => relevantRecipes.has(entity?.recipeId))
    .map((entity) => ({
      id: entity.id,
      planetId: entity.planetId,
      buildingId: entity.buildingId,
      recipeId: entity.recipeId,
      machineCount: entity.machineCount,
      sprayCoaterInstalled: entity.sprayCoaterInstalled === true,
      proliferatorTier: entity.proliferatorTier ?? null,
      proliferatorMode: entity.proliferatorMode ?? null,
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return sectionDigest(topology);
}

function transitionEvidence(previousState, currentState, previousDetails, currentDetails, productionDelta, elapsedSeconds) {
  const sections = ["entities", "belts", "tray", "planetTrays", "galaxy", "research", "endgame", "metrics", "planetMetrics"];
  const sectionEquality = Object.fromEntries(sections.map((key) => [
    key,
    sectionDigest(previousState?.[key]) === sectionDigest(currentState?.[key]),
  ]));
  const minimumInputPerItem = productionDelta > 0 ? productionDelta / 1.25 : 0;
  const inputBalance = {};
  const inputProductionCapacity = {};
  for (const itemId of WHITE_MATRIX_INPUTS) {
    const producedBefore = Math.floor(finiteNonNegative(previousState?.totalProduced?.[itemId]));
    const producedAfter = Math.floor(finiteNonNegative(currentState?.totalProduced?.[itemId]));
    const producedDuringWindow = Math.max(0, producedAfter - producedBefore);
    const beforeInventoryUpperBound = conservativeItemUpperBound(previousState, itemId);
    const afterInventoryUpperBound = conservativeItemUpperBound(currentState, itemId);
    const availableUpperBound = saturatingAdd(
      saturatingAdd(beforeInventoryUpperBound, afterInventoryUpperBound),
      producedDuringWindow,
    );
    inputBalance[itemId] = {
      producedDuringWindow,
      beforeInventoryUpperBound,
      afterInventoryUpperBound,
      availableUpperBound,
      minimumRequiredForWhiteOutput: minimumInputPerItem,
      supportsObservedWhiteOutput: availableUpperBound + 0.000001 >= minimumInputPerItem,
    };
    if (Object.hasOwn(MATRIX_RECIPE_SPECS, itemId)) {
      const observedRate = elapsedSeconds > 0 ? producedDuringWindow * 60 / elapsedSeconds : 0;
      const endpointCapacity = Math.max(
        finiteNonNegative(previousDetails?.whiteFactory?.matrixRecipeCapacityUpperBoundsPerMinute?.[itemId]),
        finiteNonNegative(currentDetails?.whiteFactory?.matrixRecipeCapacityUpperBoundsPerMinute?.[itemId]),
      );
      inputProductionCapacity[itemId] = {
        observedRatePerMinute: observedRate,
        generousEndpointCapacityPerMinute: endpointCapacity,
        usageRatio: endpointCapacity > 0 ? observedRate / endpointCapacity : observedRate > 0 ? Number.MAX_VALUE : 0,
      };
    }
  }
  return {
    sectionEquality,
    productionTopologyEqual: productionTopologyDigest(previousState) === productionTopologyDigest(currentState),
    inputBalance,
    inputProductionCapacity,
    allRequiredInputsSupportObservedWhiteOutput: Object.values(inputBalance).every(
      (entry) => entry.supportsObservedWhiteOutput,
    ),
  };
}

function deepWhiteRateAudit(database, data, user, { currentOnly = false } = {}) {
  const accountId = user.id;
  const current = data.cloudSaves?.[accountId] ?? null;
  const submission = normalSubmissionFor(data, accountId);
  if (!current) return { available: false, reason: "missing-current-normal-save" };
  const history = !currentOnly && Array.isArray(data.cloudSaveHistory?.[accountId]) ? data.cloudSaveHistory[accountId] : [];
  const byRevision = new Map();
  for (const metadata of [...history, current]) {
    if (Number.isSafeInteger(metadata?.revision) && metadata.revision >= 1) byRevision.set(metadata.revision, metadata);
  }
  const revisions = [...byRevision.values()].sort((left, right) => left.revision - right.revision);
  const windows = [];
  const readFailures = [];
  let previous = null;
  let latest = null;

  for (const metadata of revisions) {
    try {
      const payload = readCloudPayload(database, { userId: accountId, slot: "main", revision: metadata.revision });
      const bytes = Buffer.byteLength(payload, "utf8");
      const checksumValid = typeof metadata.checksum === "string" && sha256Text(payload) === metadata.checksum;
      const sizeValid = Number.isSafeInteger(metadata.size) && bytes === metadata.size;
      const parsed = JSON.parse(payload);
      const envelope = inspectParsedSavePayloadIntegrity(parsed);
      const state = parsed?.state ?? parsed;
      const details = describeState(state, { ...metadata, size: bytes });
      const record = {
        revision: metadata.revision,
        checksumValid,
        sizeValid,
        envelopeIntegrityValid: envelope.valid === true,
        state,
        details,
      };
      if (previous) {
        const elapsedDelta = finiteNonNegative(state?.elapsedSeconds) - finiteNonNegative(previous.state?.elapsedSeconds);
        const productionDelta = Math.floor(finiteNonNegative(state?.totalProduced?.universe_matrix)) -
          Math.floor(finiteNonNegative(previous.state?.totalProduced?.universe_matrix));
        const integrity = evaluateLeaderboardIntegrity(integrityProjection(state), integrityProjection(previous.state));
        const contentPackFree = details.contentPackCount === 0 && previous.details.contentPackCount === 0;
        const valid = elapsedDelta >= 60 && productionDelta >= 0 && contentPackFree && !integrity.freeze;
        windows.push({
          fromRevision: previous.revision,
          toRevision: record.revision,
          elapsedSeconds: elapsedDelta,
          productionDelta,
          ratePerMinute: valid ? productionDelta * 60 / elapsedDelta : null,
          valid,
          integrityFindingCodes: integrity.findings.map((finding) => finding.code),
          fromRevisionFactory: previous.details,
          toRevisionFactory: details,
          transitionEvidence: transitionEvidence(
            previous.state,
            state,
            previous.details,
            details,
            productionDelta,
            elapsedDelta,
          ),
        });
      }
      previous = record;
      latest = record;
    } catch (error) {
      readFailures.push({ revision: metadata.revision, code: String(error?.code ?? error?.message ?? "READ_FAILED").slice(0, 80) });
      previous = null;
    }
  }

  const validWindows = windows.filter((window) => window.valid && Number.isFinite(window.ratePerMinute));
  const topWindows = [...validWindows]
    .sort((left, right) => right.ratePerMinute - left.ratePerMinute || right.toRevision - left.toRevision)
    .slice(0, 5);
  const retainedPeak = topWindows[0] ?? null;
  const storedPeak = finiteNonNegative(submission?.metrics?.peakWhiteMatrixPerMinute);
  const endpointCapacityAtRetainedPeak = retainedPeak ? Math.max(
    finiteNonNegative(retainedPeak.fromRevisionFactory?.whiteFactory?.configuredCapacityUpperBoundPerMinute),
    finiteNonNegative(retainedPeak.toRevisionFactory?.whiteFactory?.configuredCapacityUpperBoundPerMinute),
  ) : 0;
  const retainedPeakCapacityRatio = endpointCapacityAtRetainedPeak > 0 && retainedPeak
    ? retainedPeak.ratePerMinute / endpointCapacityAtRetainedPeak
    : null;
  const payloadSizes = revisions.map((metadata) => metadata.size).filter(Number.isSafeInteger);
  const anomalyCodes = [];
  if (retainedPeak && !retainedPeak.transitionEvidence.allRequiredInputsSupportObservedWhiteOutput) {
    anomalyCodes.push("WHITE_RATE_INPUT_BALANCE_IMPOSSIBLE");
  }
  const upstreamCapacityRatios = retainedPeak
    ? Object.values(retainedPeak.transitionEvidence.inputProductionCapacity).map((entry) => entry.usageRatio)
    : [];
  if (retainedPeakCapacityRatio !== null && retainedPeakCapacityRatio >= 8 &&
      retainedPeak?.transitionEvidence?.productionTopologyEqual === true &&
      upstreamCapacityRatios.filter((ratio) => ratio >= 8).length >= 5) {
    anomalyCodes.push("WHITE_RATE_COORDINATED_CAPACITY_CONTRADICTION");
  }

  return {
    available: true,
    retainedRevisionCount: revisions.length,
    revisionRange: revisions.length > 0 ? { from: revisions[0].revision, to: revisions.at(-1).revision } : null,
    currentSubmission: {
      strategy: submission?.verification?.strategy ?? null,
      cloudRevision: submission?.verification?.cloudRevision ?? null,
      storedPeakWhiteMatrixPerMinute: storedPeak,
    },
    payloadBytes: {
      current: latest?.details?.payloadBytes ?? null,
      minimumRetained: payloadSizes.length > 0 ? Math.min(...payloadSizes) : null,
      maximumRetained: payloadSizes.length > 0 ? Math.max(...payloadSizes) : null,
    },
    latestState: latest?.details ?? null,
    retainedPeakWindow: retainedPeak ? {
      fromRevision: retainedPeak.fromRevision,
      toRevision: retainedPeak.toRevision,
      elapsedSeconds: retainedPeak.elapsedSeconds,
      productionDelta: retainedPeak.productionDelta,
      ratePerMinute: retainedPeak.ratePerMinute,
      fromRevisionFactory: retainedPeak.fromRevisionFactory,
      toRevisionFactory: retainedPeak.toRevisionFactory,
      transitionEvidence: retainedPeak.transitionEvidence,
      configuredCapacityUsageRatio: retainedPeakCapacityRatio,
      configuredCapacitySupportsObservedRate: retainedPeakCapacityRatio !== null && retainedPeakCapacityRatio <= 1.000001,
    } : null,
    storedPeakReproducedInRetainedHistory: storedPeak === 0 || validWindows.some(
      (window) => Math.abs(window.ratePerMinute - storedPeak) <= Math.max(1, storedPeak * 1e-9),
    ),
    topRetainedWindows: topWindows.map((window) => ({
      fromRevision: window.fromRevision,
      toRevision: window.toRevision,
      elapsedSeconds: window.elapsedSeconds,
      productionDelta: window.productionDelta,
      ratePerMinute: window.ratePerMinute,
    })),
    invalidWindowCount: windows.length - validWindows.length,
    readFailures,
    anomalyCodes,
    highConfidenceProblem: anomalyCodes.length > 0,
  };
}

function inspectAccount(database, data, user, { deepWhiteRate = false, currentOnly = false } = {}) {
  const accountId = user.id;
  const metadata = data.cloudSaves?.[accountId] ?? null;
  const submissions = Object.values(data.submissions ?? {});
  const submission = normalSubmissionFor(data, accountId);
  const problemCodes = [];
  let saveBodyValid = false;
  let integrity = { freeze: false, findings: [] };
  let stateSummary = null;

  if (metadata) {
    try {
      const payload = readCloudPayload(database, {
        userId: accountId,
        slot: "main",
        revision: metadata.revision,
      });
      if (typeof payload !== "string") fail("CURRENT_NORMAL_PAYLOAD_MISSING");
      if (sha256Text(payload) !== metadata.checksum) fail("CURRENT_NORMAL_CHECKSUM_MISMATCH");
      if (Buffer.byteLength(payload, "utf8") !== metadata.size) fail("CURRENT_NORMAL_SIZE_MISMATCH");
      const state = parseSaveState(payload);
      const previousMetadata = (Array.isArray(data.cloudSaveHistory?.[accountId])
        ? data.cloudSaveHistory[accountId]
        : []).find((entry) => entry?.revision === metadata.revision - 1);
      let previousState = null;
      if (previousMetadata) {
        const previousPayload = readCloudPayload(database, {
          userId: accountId,
          slot: "main",
          revision: previousMetadata.revision,
        });
        previousState = parseSaveState(previousPayload);
      }
      integrity = evaluateLeaderboardIntegrity(state, previousState);
      saveBodyValid = Boolean(state && typeof state === "object");
      stateSummary = {
        version: state?.version ?? null,
        mode: state?.mode ?? "normal-legacy",
        entityCount: Array.isArray(state?.entities) ? state.entities.length : null,
        elapsedSeconds: Number.isFinite(state?.elapsedSeconds) ? state.elapsedSeconds : null,
        contentPackCount: Array.isArray(state?.contentPacks) ? state.contentPacks.length : 0,
      };
    } catch (error) {
      problemCodes.push(String(error?.code ?? error?.message ?? "CURRENT_NORMAL_PAYLOAD_INVALID").slice(0, 80));
    }
  }

  const checksumCounts = new Map();
  for (const current of Object.values(data.cloudSaves ?? {})) {
    if (typeof current?.checksum !== "string") continue;
    checksumCounts.set(current.checksum, (checksumCounts.get(current.checksum) ?? 0) + 1);
  }
  const exactPayloadCloneGroupSize = typeof metadata?.checksum === "string"
    ? checksumCounts.get(metadata.checksum) ?? 0
    : 0;

  const metricCounts = new Map();
  for (const entry of submissions) {
    if (!entry?.metrics) continue;
    const fingerprint = digest(entry.metrics);
    metricCounts.set(fingerprint, (metricCounts.get(fingerprint) ?? 0) + 1);
  }
  const identicalMetricsGroupSize = submission?.metrics
    ? metricCounts.get(digest(submission.metrics)) ?? 0
    : 0;

  if (metadata && !saveBodyValid) problemCodes.push("CURRENT_NORMAL_PAYLOAD_INVALID");
  if (integrity.freeze) {
    for (const finding of integrity.findings) problemCodes.push(`INTEGRITY_${finding.code}`);
  }
  if (exactPayloadCloneGroupSize > 1) problemCodes.push("DUPLICATE_CURRENT_SAVE_PAYLOAD");
  if (identicalMetricsGroupSize > 2) problemCodes.push("DUPLICATE_FULL_LEADERBOARD_METRICS");
  if ((stateSummary?.contentPackCount ?? 0) > 0 && submission) problemCodes.push("MODDED_SAVE_ON_OFFICIAL_LEADERBOARD");
  const whiteRateAudit = deepWhiteRate ? deepWhiteRateAudit(database, data, user, { currentOnly }) : null;
  if (whiteRateAudit?.highConfidenceProblem) {
    for (const code of whiteRateAudit.anomalyCodes) problemCodes.push(code);
  }

  const uniqueProblemCodes = [...new Set(problemCodes)];
  const accountControl = data.accountControls?.[accountId];
  const normalResumeAfterRevision = accountControl?.leaderboardResumeAfterRevisionByMode?.normal
    ?? accountControl?.leaderboardResumeAfterRevision
    ?? 0;
  return {
    alreadyRestricted: data.leaderboardModeration?.[accountId]?.status === "blocked",
    restrictionSource: data.leaderboardModeration?.[accountId]?.source ?? null,
    loginDisabled: Number(data.accountControls?.[accountId]?.loginDisabledUntil) > Date.now(),
    leaderboardVisible: user.leaderboardVisible !== false,
    hasCurrentNormalSave: Boolean(metadata),
    hasNormalSubmission: Boolean(submission),
    normalRevision: Number.isInteger(metadata?.revision) ? metadata.revision : null,
    leaderboardResumeAfterRevision: Number.isInteger(normalResumeAfterRevision) && normalResumeAfterRevision > 0
      ? normalResumeAfterRevision
      : null,
    saveBodyValid,
    exactPayloadCloneGroupSize,
    identicalMetricsGroupSize,
    integrityFreeze: integrity.freeze === true,
    integrityFindingCodes: integrity.findings.map((finding) => finding.code),
    state: stateSummary,
    problemCodes: uniqueProblemCodes,
    highConfidenceProblem: uniqueProblemCodes.length > 0,
    ...(whiteRateAudit ? { whiteRateAudit } : {}),
  };
}

function readAdminToken() {
  const line = readFileSync(ADMIN_ENV_FILE, "utf8")
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith("DSP_ADMIN_TOKEN="));
  if (!line) fail("ADMIN_TOKEN_UNAVAILABLE");
  let token = line.slice(line.indexOf("=") + 1).trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1);
  }
  if (!token) fail("ADMIN_TOKEN_UNAVAILABLE");
  return token;
}

function serviceValue(property) {
  return execFileSync(
    "systemctl",
    ["show", "dsp-idle-api-active.service", `-p${property}`, "--value"],
    { encoding: "utf8" },
  ).trim();
}

function serviceSnapshot() {
  return {
    active: serviceValue("ActiveState"),
    restarts: Number(serviceValue("NRestarts")),
    pid: Number(serviceValue("MainPID")),
  };
}

function serviceIsActive(unit) {
  try {
    execFileSync("systemctl", ["is-active", "--quiet", unit], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function systemctl(...arguments_) {
  execFileSync("systemctl", arguments_, { stdio: "ignore" });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForApiHealthy(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [health, ready] = await Promise.all([
        fetch(`${API_BASE_URL}/api/health`),
        fetch(`${API_BASE_URL}/api/ready`),
      ]);
      const readyBody = ready.ok ? await ready.json().catch(() => null) : null;
      if (health.status === 200 && ready.status === 200 && readyBody?.writable === true) return;
    } catch { /* service is still starting */ }
    await sleep(500);
  }
  fail("SERVICE_HEALTH_DEGRADED");
}

function assertRepublishNormalEligible(inspection) {
  if (inspection.alreadyRestricted) fail("REPUBLISH_NORMAL_ACCOUNT_RESTRICTED");
  if (inspection.loginDisabled) fail("REPUBLISH_NORMAL_LOGIN_DISABLED");
  if (!inspection.leaderboardVisible) fail("REPUBLISH_NORMAL_VISIBILITY_DISABLED");
  if (!inspection.hasCurrentNormalSave || !inspection.saveBodyValid) fail("REPUBLISH_NORMAL_SAVE_INVALID");
  if (inspection.integrityFreeze || inspection.highConfidenceProblem) fail("REPUBLISH_NORMAL_INTEGRITY_GATE");
  if (!Number.isInteger(inspection.normalRevision) || inspection.normalRevision < 1) fail("REPUBLISH_NORMAL_REVISION_INVALID");
  if (inspection.hasNormalSubmission) fail("REPUBLISH_NORMAL_SUBMISSION_ALREADY_PRESENT");
  if (inspection.leaderboardResumeAfterRevision !== inspection.normalRevision) {
    fail("REPUBLISH_NORMAL_THRESHOLD_MISMATCH");
  }
}

function updateAppState(mutator) {
  const database = new Database(DATABASE_FILE, { fileMustExist: true });
  database.pragma("busy_timeout = 5000");
  try {
    const transaction = database.transaction(() => {
      const row = database.prepare("SELECT payload, updated_at AS updatedAt FROM app_state WHERE id = 1").get();
      if (!row?.payload) fail("APP_STATE_MISSING");
      const data = JSON.parse(row.payload);
      if (data?.schemaVersion !== 8 || data?.storageLayoutVersion !== 3) fail("PRODUCTION_BASELINE_CHANGED");
      mutator(database, data, row);
      const changed = database.prepare(
        "UPDATE app_state SET payload = ?, updated_at = ? WHERE id = 1 AND updated_at = ?",
      ).run(JSON.stringify(data), Date.now(), row.updatedAt);
      if (changed.changes !== 1) fail("OFFLINE_REPUBLISH_OPTIMISTIC_GUARD_FAILED");
    });
    transaction.immediate();
    database.pragma("wal_checkpoint(FULL)");
  } finally {
    database.close();
  }
}

function clearNormalRevalidationOffline({ userId, expectedInspection, protectedDigestBefore, payloadCountsBefore }) {
  updateAppState((database, data) => {
    const user = data.users?.[userId];
    if (!user) fail("REPUBLISH_NORMAL_ACCOUNT_MISSING");
    const inspection = inspectAccount(database, data, user, { deepWhiteRate: false, currentOnly: false });
    assertRepublishNormalEligible(inspection);
    if (inspection.normalRevision !== expectedInspection.normalRevision) fail("REPUBLISH_NORMAL_REVISION_DRIFT");
    if (digest(protectedAccountSnapshot(database, data, userId)) !== protectedDigestBefore) {
      fail("PROTECTED_ACCOUNT_DATA_CHANGED");
    }
    if (digest(globalPayloadCounts(database)) !== digest(payloadCountsBefore)) fail("CLOUD_PAYLOAD_COUNTS_CHANGED");

    const control = data.accountControls?.[userId];
    if (!control) fail("REPUBLISH_NORMAL_CONTROL_MISSING");
    delete control.leaderboardResumeAfterRevision;
    if (control.leaderboardResumeAfterRevisionByMode && typeof control.leaderboardResumeAfterRevisionByMode === "object") {
      delete control.leaderboardResumeAfterRevisionByMode.normal;
      if (Object.keys(control.leaderboardResumeAfterRevisionByMode).length === 0) {
        delete control.leaderboardResumeAfterRevisionByMode;
      }
    }
    const hasSpeedrunThreshold = Number.isInteger(control.leaderboardResumeAfterRevisionByMode?.speedrun)
      && control.leaderboardResumeAfterRevisionByMode.speedrun > 0;
    if (!control.loginDisabledUntil && !hasSpeedrunThreshold) delete data.accountControls[userId];
  });
}

function restoreRepublishGuardOffline(userId, guard) {
  updateAppState((_database, data) => {
    if (!data.users?.[userId]) fail("REPUBLISH_NORMAL_ACCOUNT_MISSING");
    data.accountControls ??= {};
    if (guard.accountControls === null) delete data.accountControls[userId];
    else data.accountControls[userId] = guard.accountControls;
    data.leaderboardModeration ??= {};
    if (guard.moderation === null) delete data.leaderboardModeration[userId];
    else data.leaderboardModeration[userId] = guard.moderation;
    data.submissions ??= {};
    for (const [key, submission] of Object.entries(data.submissions)) {
      if (submission?.userId === userId || submission?.accountId === userId) delete data.submissions[key];
    }
    for (const [key, submission] of guard.normalSubmissions ?? []) data.submissions[key] = submission;
  });
}

function writeActionGuard({ action, reason, user, state, inspection, protectedDigest, payloadCounts }) {
  mkdirSync(GUARD_DIRECTORY, { recursive: true, mode: 0o700 });
  chmodSync(GUARD_DIRECTORY, 0o700);
  const guardId = `guard-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomBytes(4).toString("hex")}`;
  const path = `${GUARD_DIRECTORY}/${guardId}.json`;
  const guard = {
    format: "dsp-idle-account-action-guard-v1",
    action,
    reason,
    createdAt: Date.now(),
    accountId: user.id,
    usernameHash: sha256Text(user.username),
    appStateUpdatedAt: state.row.updatedAt,
    moderation: state.data.leaderboardModeration?.[user.id] ?? null,
    accountControls: state.data.accountControls?.[user.id] ?? null,
    inspection,
    protectedDigest,
    normalSubmissions: normalSubmissionEntries(state.data, user.id),
    speedrunSubmissionCount: speedrunSubmissionEntries(state.data, user.id).length,
    payloadCounts,
  };
  writeFileSync(path, `${JSON.stringify(guard)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  const descriptor = openSync(path, "r");
  fsyncSync(descriptor);
  closeSync(descriptor);
  return {
    guardId,
    bytes: statSync(path).size,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) fail(`ADMIN_HTTP_${response.status}`);
  return payload;
}

async function republishNormalLeaderboard({ user, before, inspection, protectedDigestBefore, payloadCountsBefore, normalBefore, reason }) {
  assertRepublishNormalEligible(inspection);
  const serviceBefore = serviceSnapshot();
  if (serviceBefore.active !== "active" || serviceBefore.restarts !== 0) fail("ACTIVE_API_CHANGED");
  if (serviceIsActive("dsp-idle-offsite-backup.service") || serviceIsActive("dsp-idle-auto-snapshot.service")) {
    fail("REPUBLISH_NORMAL_BACKUP_JOB_ACTIVE");
  }
  const proxyStatus = JSON.parse(readFileSync("/run/dsp-idle-cloud/api-proxy-status.json", "utf8"));
  if (proxyStatus?.mode !== "forward" || proxyStatus.activeRequests !== 0 ||
      proxyStatus.activeWriterRequests !== 0 || proxyStatus.queuedRequests !== 0) {
    fail("REPUBLISH_NORMAL_PROXY_NOT_IDLE");
  }

  const guard = writeActionGuard({
    action: "republish-normal",
    reason: reason || "authorized-normal-leaderboard-republish",
    user,
    state: before,
    inspection,
    protectedDigest: protectedDigestBefore,
    payloadCounts: payloadCountsBefore,
  });
  const guardBody = JSON.parse(readFileSync(`${GUARD_DIRECTORY}/${guard.guardId}.json`, "utf8"));
  const timers = [
    "dsp-idle-node-health.timer",
    "dsp-idle-healthcheck.timer",
    "dsp-idle-auto-snapshot.timer",
    "dsp-idle-offsite-backup.timer",
  ];
  const timerState = Object.fromEntries(timers.map((unit) => [unit, serviceIsActive(unit)]));
  let mutated = false;
  let apiStopped = false;
  try {
    for (const unit of timers) if (timerState[unit]) systemctl("stop", unit);
    for (const unit of ["dsp-idle-node-health.service", "dsp-idle-healthcheck.service"]) {
      if (serviceIsActive(unit)) systemctl("stop", unit);
    }
    systemctl("stop", "dsp-idle-api-active.service");
    apiStopped = true;
    if (serviceIsActive("dsp-idle-api-active.service")) fail("OFFLINE_REPUBLISH_API_STOP_FAILED");

    clearNormalRevalidationOffline({
      userId: user.id,
      expectedInspection: inspection,
      protectedDigestBefore,
      payloadCountsBefore,
    });
    mutated = true;
    if (!serviceIsActive("dsp-idle-api-handoff-proxy.service")) systemctl("start", "dsp-idle-api-handoff-proxy.service");
    systemctl("start", "dsp-idle-api-active.service");
    apiStopped = false;
    await waitForApiHealthy();

    const after = loadState();
    const afterUser = after.data.users?.[user.id];
    const afterInspection = afterUser
      ? inspectAccount(after.database, after.data, afterUser, { deepWhiteRate: false, currentOnly: false })
      : null;
    const protectedDigestAfter = digest(protectedAccountSnapshot(after.database, after.data, user.id));
    const payloadCountsAfter = globalPayloadCounts(after.database);
    const normalAfter = normalSubmissionEntries(after.data, user.id).length;
    const speedrunAfter = speedrunSubmissionEntries(after.data, user.id).length;
    after.database.close();
    if (!afterInspection || afterInspection.alreadyRestricted || afterInspection.leaderboardResumeAfterRevision !== null) {
      fail("REPUBLISH_NORMAL_THRESHOLD_NOT_CLEARED");
    }
    if (normalAfter < 1 || !afterInspection.hasNormalSubmission) fail("REPUBLISH_NORMAL_BACKFILL_MISSING");
    if (protectedDigestAfter !== protectedDigestBefore) fail("PROTECTED_ACCOUNT_DATA_CHANGED");
    if (digest(payloadCountsAfter) !== digest(payloadCountsBefore)) fail("CLOUD_PAYLOAD_COUNTS_CHANGED");
    if (speedrunAfter !== guardBody.speedrunSubmissionCount) fail("REPUBLISH_NORMAL_SPEEDRUN_CHANGED");
    const serviceAfter = serviceSnapshot();
    if (serviceAfter.active !== "active" || serviceAfter.restarts !== serviceBefore.restarts) fail("ACTIVE_API_CHANGED");
    for (const unit of timers) if (timerState[unit]) systemctl("start", unit);
    return {
      guard,
      normalBefore,
      normalAfter,
      normalRevision: inspection.normalRevision,
      healthStatus: 200,
      readyStatus: 200,
      serviceStable: true,
    };
  } catch (error) {
    try {
      if (!apiStopped && serviceIsActive("dsp-idle-api-active.service")) {
        systemctl("stop", "dsp-idle-api-active.service");
        apiStopped = true;
      }
      if (mutated) restoreRepublishGuardOffline(user.id, guardBody);
      if (!serviceIsActive("dsp-idle-api-handoff-proxy.service")) systemctl("start", "dsp-idle-api-handoff-proxy.service");
      if (!serviceIsActive("dsp-idle-api-active.service")) systemctl("start", "dsp-idle-api-active.service");
      apiStopped = false;
      await waitForApiHealthy();
      for (const unit of timers) if (timerState[unit]) systemctl("start", unit);
    } catch {
      fail("OFFLINE_REPUBLISH_ROLLBACK_FAILED");
    }
    throw error;
  }
}

async function verifyPublicAbsence(accountId) {
  const normalPublicId = `public_${sha256Text(`dspidle-public-leaderboard-v1:galaxy:${accountId}`).slice(0, 32)}`;
  for (const category of NORMAL_CATEGORIES) {
    const board = await requestJson(`/api/leaderboard?category=${category}&seasonId=season_01`);
    if (board.entries?.some((entry) => entry.publicId === normalPublicId)) fail("NORMAL_PUBLIC_FILTER_FAILED");
  }
  const speedrunPublicId = `public_${sha256Text(`dspidle-public-leaderboard-v1:speedrun:${accountId}`).slice(0, 32)}`;
  for (const targetId of SPEEDRUN_TARGETS) {
    const board = await requestJson(`/api/speedrun/leaderboard?targetId=${targetId}&seasonId=season_01`);
    if (board.entries?.some((entry) => entry.publicId === speedrunPublicId)) fail("SPEEDRUN_PUBLIC_FILTER_FAILED");
  }
}

async function main() {
  const [
    matchBy,
    encodedIdentifier,
    action = "inspect",
    applyValue = "false",
    forceValue = "false",
    encodedReason = "",
    deepWhiteRateValue = "false",
    expectedWhiteRateValue = "none",
    currentOnlyValue = "false",
    fullBackupVerifiedValue = "false",
  ] = process.argv.slice(2);
  if (!new Set(["username", "display-name", "guard-id"]).has(matchBy)) fail("MATCH_MODE_INVALID");
  if (!new Set(["inspect", "restrict", "restore", "republishnormal"]).has(action)) fail("ACTION_INVALID");
  if (!new Set(["true", "false"]).has(applyValue) || !new Set(["true", "false"]).has(forceValue) ||
      !new Set(["true", "false"]).has(deepWhiteRateValue) ||
      !new Set(["true", "false"]).has(currentOnlyValue) ||
      !new Set(["true", "false"]).has(fullBackupVerifiedValue)) fail("BOOLEAN_ARGUMENT_INVALID");
  const apply = applyValue === "true";
  const force = forceValue === "true";
  const deepWhiteRate = deepWhiteRateValue === "true";
  const currentOnly = currentOnlyValue === "true";
  const fullBackupVerified = fullBackupVerifiedValue === "true";
  const expectedWhiteRate = expectedWhiteRateValue === "none" ? null : Number(expectedWhiteRateValue);
  const identifier = decodeBase64Url(encodedIdentifier, "IDENTIFIER_INVALID").trim();
  const reason = !encodedReason || encodedReason === "none"
    ? ""
    : decodeBase64Url(encodedReason, "REASON_INVALID").trim();
  if (!identifier || identifier.length > 128) fail("IDENTIFIER_INVALID");
  if (reason.length > 120) fail("REASON_INVALID");
  if (expectedWhiteRate !== null && (!Number.isFinite(expectedWhiteRate) || expectedWhiteRate <= 0)) fail("EXPECTED_WHITE_RATE_INVALID");
  if (matchBy === "guard-id" && !new Set(["inspect", "restore"]).has(action)) fail("GUARD_MATCH_RESTORE_ONLY");
  if (matchBy === "guard-id" && expectedWhiteRate !== null) fail("GUARD_MATCH_EXPECTED_RATE_UNSUPPORTED");
  if (force && (action !== "restrict" || !reason)) fail("FORCE_REQUIRES_RESTRICT_REASON");
  if (apply && action === "inspect") fail("INSPECT_CANNOT_APPLY");
  if (deepWhiteRate && !new Set(["inspect", "restrict"]).has(action)) fail("DEEP_AUDIT_RESTORE_UNSUPPORTED");
  if (expectedWhiteRate !== null && !deepWhiteRate) fail("EXPECTED_WHITE_RATE_REQUIRES_DEEP_AUDIT");
  if (currentOnly && (!deepWhiteRate || action !== "inspect")) fail("CURRENT_ONLY_REQUIRES_DEEP_INSPECT");
  if (action === "republishnormal" && apply && !fullBackupVerified) fail("REPUBLISH_NORMAL_REQUIRES_FULL_BACKUP");

  const before = loadState();
  const user = resolveAccount(before.data, matchBy, identifier, expectedWhiteRate);
  const inspection = inspectAccount(before.database, before.data, user, { deepWhiteRate, currentOnly });
  const protectedBefore = protectedAccountSnapshot(before.database, before.data, user.id);
  const protectedDigestBefore = digest(protectedBefore);
  const payloadCountsBefore = globalPayloadCounts(before.database);
  const normalBefore = normalSubmissionEntries(before.data, user.id).length;
  const loginDisabledBefore = Number(before.data.accountControls?.[user.id]?.loginDisabledUntil) > Date.now();
  before.database.close();

  const desiredRestricted = action === "restrict";
  const alreadyRepublished = action === "republishnormal"
    && inspection.hasNormalSubmission
    && inspection.leaderboardResumeAfterRevision === null
    && !inspection.alreadyRestricted;
  const alreadyDesired = action === "inspect" || alreadyRepublished ||
    (action !== "republishnormal" && inspection.alreadyRestricted === desiredRestricted);
  const wouldApply = action !== "inspect" && !alreadyDesired;
  if (action === "republishnormal" && !alreadyRepublished) assertRepublishNormalEligible(inspection);
  if (action === "restrict" && wouldApply && !inspection.highConfidenceProblem && !force) {
    fail("NO_HIGH_CONFIDENCE_ANOMALY");
  }

  if (!apply || alreadyDesired) {
    process.stdout.write(JSON.stringify({
      ok: true,
      dryRun: !apply,
      idempotent: alreadyDesired,
      action,
      wouldApply,
      fullBackupUsed: action === "republishnormal" && fullBackupVerified,
      backupPolicy: action === "inspect" ? "read-only-no-backup-required" :
        action === "republishnormal" ? "verified-full-release-backup" : "explicit-single-account-leaderboard-only-waiver",
      exactMatch: true,
      inspection,
    }));
    return;
  }

  if (action === "republishnormal") {
    const result = await republishNormalLeaderboard({
      user,
      before,
      inspection,
      protectedDigestBefore,
      payloadCountsBefore,
      normalBefore,
      reason,
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      dryRun: false,
      applied: true,
      action: "republish-normal",
      fullBackupUsed: true,
      backupPolicy: "verified-full-release-backup",
      exactMatch: true,
      inspection,
      verification: {
        leaderboardRestrictedAfter: false,
        leaderboardVisibleAfter: true,
        normalRevision: result.normalRevision,
        revalidationCleared: true,
        normalSubmissionsBefore: result.normalBefore,
        normalSubmissionsAfter: result.normalAfter,
        loginControlUnchanged: true,
        accountIdentityUnchanged: true,
        sessionsUnchanged: true,
        cloudMetadataUnchanged: true,
        cloudPayloadReferencesUnchanged: true,
        cloudPayloadTablesUnchanged: true,
        speedrunSubmissionsUnchanged: true,
        healthStatus: result.healthStatus,
        readyStatus: result.readyStatus,
        serviceStable: result.serviceStable,
      },
      guard: result.guard,
    }));
    return;
  }

  const serviceBefore = serviceSnapshot();
  const guard = writeActionGuard({
    action,
    reason: reason || (action === "restrict" ? inspection.problemCodes.join(",") : "authorized-restore"),
    user,
    state: before,
    inspection,
    protectedDigest: protectedDigestBefore,
    payloadCounts: payloadCountsBefore,
  });
  const token = readAdminToken();
  const authorization = { authorization: `Bearer ${token}` };
  const summary = await requestJson(`/api/admin/account?accountId=${encodeURIComponent(user.id)}`, { headers: authorization });
  if (summary?.account?.accountId !== user.id || summary?.account?.leaderboardRestricted !== inspection.alreadyRestricted) {
    fail("ADMIN_PREFLIGHT_MISMATCH");
  }
  const apiAction = action === "restrict" ? "restrict-leaderboard" : "restore-leaderboard";
  const result = await requestJson("/api/admin/account/action", {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({
      accountId: user.id,
      action: apiAction,
      confirmation: `CONFIRM:${apiAction}:${user.id}`,
    }),
  });
  if (result?.applied !== true || result?.account?.leaderboardRestricted !== desiredRestricted) {
    fail("ADMIN_ACTION_NOT_APPLIED");
  }

  const after = loadState();
  const protectedAfter = protectedAccountSnapshot(after.database, after.data, user.id);
  const protectedDigestAfter = digest(protectedAfter);
  const payloadCountsAfter = globalPayloadCounts(after.database);
  const normalAfter = normalSubmissionEntries(after.data, user.id).length;
  const restrictedAfter = after.data.leaderboardModeration?.[user.id]?.status === "blocked";
  const loginDisabledAfter = Number(after.data.accountControls?.[user.id]?.loginDisabledUntil) > Date.now();
  after.database.close();

  if (protectedDigestAfter !== protectedDigestBefore) fail("PROTECTED_ACCOUNT_DATA_CHANGED");
  if (digest(payloadCountsAfter) !== digest(payloadCountsBefore)) fail("CLOUD_PAYLOAD_COUNTS_CHANGED");
  if (restrictedAfter !== desiredRestricted) fail("LEADERBOARD_RESTRICTION_MISMATCH");
  if (loginDisabledAfter !== loginDisabledBefore) fail("LOGIN_CONTROL_CHANGED");
  if (normalAfter !== 0) fail("NORMAL_SUBMISSION_NOT_CLEARED");
  if (action === "restrict") await verifyPublicAbsence(user.id);

  const health = await fetch(`${API_BASE_URL}/api/health`);
  const ready = await fetch(`${API_BASE_URL}/api/ready`);
  const serviceAfter = serviceSnapshot();
  if (health.status !== 200 || ready.status !== 200) fail("SERVICE_HEALTH_DEGRADED");
  if (serviceAfter.active !== "active" || serviceAfter.restarts !== serviceBefore.restarts || serviceAfter.pid !== serviceBefore.pid) {
    fail("ACTIVE_API_CHANGED");
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    dryRun: false,
    applied: true,
    action,
    guard,
    fullBackupUsed: false,
    backupPolicy: "explicit-single-account-leaderboard-only-waiver",
    exactMatch: true,
    inspection,
    verification: {
      restrictedAfter,
      loginControlUnchanged: true,
      accountIdentityUnchanged: true,
      sessionsUnchanged: true,
      cloudMetadataUnchanged: true,
      cloudPayloadReferencesUnchanged: true,
      cloudPayloadTablesUnchanged: true,
      speedrunSubmissionsUnchanged: true,
      normalSubmissionsBefore: normalBefore,
      normalSubmissionsAfter: normalAfter,
      publicAbsenceVerified: action === "restrict",
      healthStatus: health.status,
      readyStatus: ready.status,
      serviceStable: true,
    },
  }));
}

main().catch((error) => {
  const code = typeof error?.code === "string" ? error.code : "SAFE_LEADERBOARD_ACTION_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
