import { createHash } from "node:crypto";

export const STATION_SHOWCASE_SCHEMA = "station-showcase-v1";
export const STATION_VISIBILITIES = new Set(["public", "private"]);
export const STATION_SIGNAL_IDS = new Set(["spectacular", "precise", "industrial", "layout"]);
export const PUBLIC_STATION_METRIC_KEYS = new Set([
  "total-generation",
  "peak-throughput",
  "dyson-power",
  "explored-systems",
  "colonized-planets",
  "universe-matrix-produced",
  "solar-sails-launched",
  "carrier-rockets-launched",
]);

const DECIMAL_INTEGER_PATTERN = /^(0|[1-9][0-9]{0,255})$/;
const ID_PATTERN = /^[a-z][a-z0-9_]{1,80}$/;
const CONTRACT_TEMPLATE_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
const PLACEMENT_ID_PATTERN = /^[A-Za-z0-9_:-]{1,160}$/;
const PUBLIC_ID_PATTERN = /^station_[a-f0-9]{32}$/;
const STATION_STATUSES = new Set(["locked", "eligible", "core-building", "dock-building", "showcase-building", "operational"]);
const STAGE_IDS = new Set(["core", "dock", "showcase"]);
const CONTRACT_DIFFICULTIES = new Set(["P1", "P2", "P3"]);
const CONTRACT_STATUSES = new Set(["offered", "accepted", "claimable", "settled"]);
const CONTRACT_CHANNELS = new Set(["any", "terminal", "quantum"]);
const SETTLEMENT_REASONS = new Set(["completed", "abandoned", "expired"]);
const ROTATIONS = new Set([0, 90, 180, 270]);
const LAYERS = new Set([0, 1, 2, 3]);
const OFFICIAL_THEME_IDS = new Set(["orbital_teal", "solar_gold", "nebula_violet", "deep_blue"]);
const OFFICIAL_ACHIEVEMENT_IDS = new Set([
  "first_manual_mine", "automated_mining", "first_logistics_line", "stable_power_grid",
  "electromagnetic_matrix_online", "energy_matrix_online", "six_matrix_mastery",
  "planetary_logistics_online", "interstellar_delivery", "rare_resource_harvest",
  "dyson_swarm_online", "permanent_dyson_structure", "multi_system_industry",
]);
const LEVELS = [
  { level: 1, reputation: 0n, halfWidth: 520, halfHeight: 320, placementLimit: 16 },
  { level: 2, reputation: 100n, halfWidth: 650, halfHeight: 380, placementLimit: 32 },
  { level: 3, reputation: 300n, halfWidth: 760, halfHeight: 440, placementLimit: 64 },
  { level: 4, reputation: 800n, halfWidth: 860, halfHeight: 500, placementLimit: 112 },
  { level: 5, reputation: 2_000n, halfWidth: 960, halfHeight: 560, placementLimit: 176 },
  { level: 6, reputation: 5_000n, halfWidth: 1_080, halfHeight: 620, placementLimit: 256 },
];
const STATION_STAGE_REQUIREMENTS = new Map([
  ["core", {
    costs: [
      ["titanium_alloy", "200000"], ["frame_material", "100000"], ["processor", "200000"], ["universe_matrix", "20000"],
    ],
    logisticsVessels: 0,
  }],
  ["dock", {
    costs: [["quantum_chip", "100000"], ["particle_container", "200000"], ["space_warper", "20000"]],
    logisticsVessels: 200,
  }],
  ["showcase", {
    costs: [["titanium_glass", "300000"], ["particle_broadband", "200000"], ["plastic", "500000"], ["universe_matrix", "50000"]],
    logisticsVessels: 0,
  }],
]);
const OFFICIAL_DECORATIONS = new Map([
  ["deck_grid", { width: 160, height: 100, rotations: ROTATIONS, layers: new Set([0]), variants: 3 }],
  ["bulkhead_arc", { width: 120, height: 34, rotations: ROTATIONS, layers: new Set([1, 2]), variants: 2 }],
  ["guide_light", { width: 52, height: 26, rotations: ROTATIONS, layers: new Set([2, 3]), variants: 4 }],
  ["cargo_crate", { width: 72, height: 58, rotations: ROTATIONS, layers: new Set([1, 2]), variants: 4 }],
  ["service_robot", { width: 54, height: 54, rotations: ROTATIONS, layers: new Set([1, 2]), variants: 3 }],
  ["hydroponic_planter", { width: 76, height: 54, rotations: ROTATIONS, layers: new Set([1, 2]), variants: 3 }],
  ["observation_window", { width: 150, height: 72, rotations: new Set([0, 180]), layers: new Set([1, 2]), variants: 3 }],
  ["factory_flag", { width: 58, height: 92, rotations: new Set([0, 180]), layers: new Set([2, 3]), variants: 6 }],
  ["route_hologram", { width: 118, height: 92, rotations: ROTATIONS, layers: new Set([2, 3]), variants: 4 }],
  ["quantum_sculpture", { width: 92, height: 116, rotations: ROTATIONS, layers: new Set([1, 2]), variants: 2 }],
  ["contract_trophy", { width: 86, height: 108, rotations: ROTATIONS, layers: new Set([1, 2]), variants: 1 }],
  ["dyson_monument", { width: 150, height: 150, rotations: ROTATIONS, layers: new Set([1, 2]), variants: 1 }],
  ["galactic_beacon", { width: 118, height: 170, rotations: ROTATIONS, layers: new Set([1, 2]), variants: 1 }],
]);
const FUNCTIONAL_ANCHORS = [
  { x: -270, y: -80, width: 260, height: 180 },
  { x: 80, y: -170, width: 250, height: 150 },
  { x: 270, y: 80, width: 230, height: 150 },
  { x: -10, y: 190, width: 250, height: 140 },
  { x: -365, y: 195, width: 210, height: 130 },
  { x: 410, y: -175, width: 220, height: 130 },
];

const COLLECTION_KEYS = ["stationProfiles", "stationFavorites", "stationSignals", "stationModeration"];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decimal(value) {
  return typeof value === "string" && DECIMAL_INTEGER_PATTERN.test(value);
}

function finiteInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function safeText(value, maximum, { allowEmpty = true } = {}) {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.trim().length > 0) &&
    !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
}

function stationLevel(reputation) {
  if (!decimal(reputation)) return LEVELS[0];
  const value = BigInt(reputation);
  return [...LEVELS].reverse().find((entry) => value >= entry.reputation) ?? LEVELS[0];
}

function validViewport(value) {
  return isRecord(value) && Number.isFinite(value.x) && Math.abs(value.x) <= 100_000 &&
    Number.isFinite(value.y) && Math.abs(value.y) <= 100_000 &&
    Number.isFinite(value.zoom) && value.zoom >= 0.1 && value.zoom <= 4;
}

function validItemRecord(value, maximumEntries = 512) {
  return isRecord(value) && Object.keys(value).length <= maximumEntries &&
    Object.entries(value).every(([itemId, amount]) => ID_PATTERN.test(itemId) && decimal(amount));
}

function validStage(stage) {
  if (!isRecord(stage) || !STAGE_IDS.has(stage.stageId)) return false;
  const expected = STATION_STAGE_REQUIREMENTS.get(stage.stageId);
  if (!expected || !Array.isArray(stage.costs) || stage.costs.length !== expected.costs.length || stage.costs.some((cost, index) =>
    !isRecord(cost) || cost.itemId !== expected.costs[index][0] || cost.amount !== expected.costs[index][1])) return false;
  if (!isRecord(stage.fleetCosts) || Object.keys(stage.fleetCosts).some((fleetId) => fleetId !== "logistics_vessel") ||
    (stage.fleetCosts.logistics_vessel ?? 0) !== expected.logisticsVessels) return false;
  if (!validItemRecord(stage.delivered, expected.costs.length) || Object.entries(stage.delivered).some(([itemId, amount]) => {
    const requirement = expected.costs.find(([expectedItemId]) => expectedItemId === itemId);
    return !requirement || BigInt(amount) > BigInt(requirement[1]);
  })) return false;
  return isRecord(stage.deliveredFleet) && Object.keys(stage.deliveredFleet).every((fleetId) => fleetId === "logistics_vessel") &&
    finiteInteger(stage.deliveredFleet.logistics_vessel ?? 0, 0, expected.logisticsVessels);
}

function stageComplete(stage) {
  const expected = STATION_STAGE_REQUIREMENTS.get(stage.stageId);
  return expected.costs.every(([itemId, amount]) => BigInt(stage.delivered[itemId] ?? "0") >= BigInt(amount)) &&
    (stage.deliveredFleet.logistics_vessel ?? 0) >= expected.logisticsVessels;
}

function validContractRequirement(requirement) {
  return isRecord(requirement) && ID_PATTERN.test(requirement.itemId) && decimal(requirement.amount) && decimal(requirement.delivered) &&
    CONTRACT_CHANNELS.has(requirement.channel) && finiteInteger(requirement.weight, 1, 1_000_000) &&
    (requirement.sourcePlanetIds === undefined || Array.isArray(requirement.sourcePlanetIds) && requirement.sourcePlanetIds.length <= 64 &&
      requirement.sourcePlanetIds.every((planetId) => typeof planetId === "string" && ID_PATTERN.test(planetId)));
}

function validRewards(rewards) {
  return isRecord(rewards) && ["baseMarks", "baseReputation", "completionMarks", "completionReputation"].every((key) => decimal(rewards[key]));
}

function validContract(contract, boardTaskDay) {
  if (!isRecord(contract) || !PLACEMENT_ID_PATTERN.test(contract.id) || !CONTRACT_TEMPLATE_PATTERN.test(contract.templateId) ||
    ![0, 1, 2, 3].includes(contract.slot) || !safeText(contract.title, 64, { allowEmpty: false }) || !safeText(contract.summary, 180) ||
    !finiteInteger(contract.taskDay, 0) || !finiteInteger(contract.expiresAtTaskDay, contract.taskDay, boardTaskDay + 10_000) ||
    typeof contract.special !== "boolean" || !CONTRACT_DIFFICULTIES.has(contract.difficulty) || !CONTRACT_STATUSES.has(contract.status) ||
    !Array.isArray(contract.requirements) || contract.requirements.length < 1 || contract.requirements.length > 8 ||
    !contract.requirements.every(validContractRequirement) || !validRewards(contract.rewards)) return false;
  if (contract.acceptedAtTaskDay !== undefined && !finiteInteger(contract.acceptedAtTaskDay, 0)) return false;
  if (contract.settlementId !== undefined && !PLACEMENT_ID_PATTERN.test(contract.settlementId)) return false;
  if (contract.settlementReason !== undefined && !SETTLEMENT_REASONS.has(contract.settlementReason)) return false;
  if (contract.settledAtTaskDay !== undefined && !finiteInteger(contract.settledAtTaskDay, 0)) return false;
  return contract.completionBasisPoints === undefined || finiteInteger(contract.completionBasisPoints, 0, 10_000);
}

function sameContractIdentity(left, right) {
  const sameOptionalStringArray = (leftValues, rightValues) => {
    if (leftValues === undefined || rightValues === undefined) return leftValues === rightValues;
    return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues[index]);
  };
  const sameRequirement = (leftRequirement, rightRequirement) =>
    leftRequirement.itemId === rightRequirement.itemId && leftRequirement.amount === rightRequirement.amount &&
    leftRequirement.channel === rightRequirement.channel && leftRequirement.weight === rightRequirement.weight &&
    sameOptionalStringArray(leftRequirement.sourcePlanetIds, rightRequirement.sourcePlanetIds);
  const rewardKeys = ["baseMarks", "baseReputation", "completionMarks", "completionReputation"];
  return left.id === right.id && left.templateId === right.templateId && left.slot === right.slot &&
    left.title === right.title && left.summary === right.summary && left.taskDay === right.taskDay &&
    left.expiresAtTaskDay === right.expiresAtTaskDay && left.special === right.special &&
    left.difficulty === right.difficulty && left.requirements.length === right.requirements.length &&
    left.requirements.every((requirement, index) => sameRequirement(requirement, right.requirements[index])) &&
    rewardKeys.every((key) => left.rewards[key] === right.rewards[key]);
}

function validContractBoard(board) {
  if (!isRecord(board) || board.rulesVersion !== 1 || !finiteInteger(board.taskDay, 0) ||
    !finiteInteger(board.lastConfirmedWallClockMs, 0) || !Array.isArray(board.offers) || board.offers.length > 4 ||
    !Array.isArray(board.accepted) || board.accepted.length > 3 || !Array.isArray(board.history) || board.history.length > 256 ||
    !Array.isArray(board.settledIds) || board.settledIds.length > 4096 ||
    !board.settledIds.every((id) => PLACEMENT_ID_PATTERN.test(id)) ||
    !(board.featuredContractId === null || PLACEMENT_ID_PATTERN.test(board.featuredContractId))) return false;
  const contracts = [...board.offers, ...board.accepted, ...board.history];
  if (!contracts.every((contract) => validContract(contract, board.taskDay))) return false;
  const collectionIdsAreUnique = (collection) => new Set(collection.map((contract) => contract.id)).size === collection.length;
  if (!collectionIdsAreUnique(board.offers) || !collectionIdsAreUnique(board.accepted) || !collectionIdsAreUnique(board.history)) return false;
  const acceptedIds = new Set(board.accepted.map((contract) => contract.id));
  const historyById = new Map(board.history.map((contract) => [contract.id, contract]));
  if (board.accepted.some((contract) => historyById.has(contract.id)) || board.offers.some((contract) => acceptedIds.has(contract.id))) return false;
  const settledIds = new Set(board.settledIds);
  // Compatibility for the exact 1.1.0 client bug: after settling all four
  // deterministic offers, the same day could regenerate those offers. They
  // are reward-fenced and unclaimable because their IDs are already settled.
  // Keep rejecting every other cross-collection collision.
  return board.offers.every((offer) => {
    const settled = historyById.get(offer.id);
    return !settled || settledIds.has(offer.id) && sameContractIdentity(offer, settled);
  });
}

function validPlacement(placement, allowUnknownDecoration = true) {
  return isRecord(placement) && PLACEMENT_ID_PATTERN.test(placement.id) && ID_PATTERN.test(placement.decorationId) &&
    Number.isFinite(placement.x) && Math.abs(placement.x) <= 10_000 && Number.isFinite(placement.y) && Math.abs(placement.y) <= 10_000 &&
    ROTATIONS.has(placement.rotation) && LAYERS.has(placement.layer) && finiteInteger(placement.variant, 0, 255) &&
    (allowUnknownDecoration || OFFICIAL_DECORATIONS.has(placement.decorationId));
}

export function validateOrbitalStationGameState(state) {
  if (!isRecord(state) || state.version !== 47 || !isRecord(state.orbitalStation)) return false;
  const station = state.orbitalStation;
  if (station.stateVersion !== 1 || !STATION_STATUSES.has(station.status) || !isRecord(station.construction) ||
    station.construction.costRevision !== 1 || !Array.isArray(station.construction.stageRequirements) ||
    station.construction.stageRequirements.length !== 3 || !station.construction.stageRequirements.every(validStage) ||
    new Set(station.construction.stageRequirements.map((stage) => stage.stageId)).size !== 3 || !validViewport(station.viewport) ||
    !validContractBoard(station.contractBoard) || !isRecord(station.economy) || !decimal(station.economy.orbitalMarks) ||
    !decimal(station.economy.stationReputation) || !Array.isArray(station.economy.unlockedDecorationIds) ||
    station.economy.unlockedDecorationIds.length > 512 || !station.economy.unlockedDecorationIds.every((id) =>
      typeof id === "string" && /^(?:theme:)?[a-z][a-z0-9_]{1,80}$/.test(id)) || !isRecord(station.layout) ||
    typeof station.layout.themeId !== "string" || !ID_PATTERN.test(station.layout.themeId) || !Array.isArray(station.layout.placements) ||
    station.layout.placements.length > 256 || !station.layout.placements.every((placement) => validPlacement(placement)) ||
    new Set(station.layout.placements.map((placement) => placement.id)).size !== station.layout.placements.length ||
    !Array.isArray(station.layout.featuredAchievementIds) || station.layout.featuredAchievementIds.length > 8 ||
    !station.layout.featuredAchievementIds.every((id) => typeof id === "string" && ID_PATTERN.test(id)) || !isRecord(station.profile) ||
    !safeText(station.profile.title, 32, { allowEmpty: false }) || !safeText(station.profile.motto, 96) ||
    !Array.isArray(station.profile.featuredMetricKeys) || station.profile.featuredMetricKeys.length > 4 ||
    !station.profile.featuredMetricKeys.every((key) => PUBLIC_STATION_METRIC_KEYS.has(key)) || !isRecord(station.totals) ||
    !finiteInteger(station.totals.completedContracts, 0) || !validItemRecord(station.totals.exportedByItem)) return false;
  const unlockedAchievementIds = new Set(Array.isArray(state.achievements?.unlockedIds) ? state.achievements.unlockedIds : []);
  if (station.layout.featuredAchievementIds.some((id) => !unlockedAchievementIds.has(id))) return false;
  if (state.mode === "speedrun" && station.status !== "locked") return false;
  if (state.mode === "normal" && station.status !== "locked" && Math.max(0, Math.floor(Number(state.totalProduced?.universe_matrix) || 0)) < 1) return false;
  const stages = Object.fromEntries(station.construction.stageRequirements.map((stage) => [stage.stageId, stage]));
  const completed = {
    core: stageComplete(stages.core),
    dock: stageComplete(stages.dock),
    showcase: stageComplete(stages.showcase),
  };
  if ((station.status === "eligible" || station.status === "core-building") && completed.core ||
    station.status === "dock-building" && (!completed.core || completed.dock) ||
    station.status === "showcase-building" && (!completed.core || !completed.dock || completed.showcase) ||
    station.status === "operational" && (!completed.core || !completed.dock || !completed.showcase)) return false;
  const level = stationLevel(station.economy.stationReputation);
  if (station.layout.placements.length > level.placementLimit || station.layout.placements.some((placement) => {
    const definition = OFFICIAL_DECORATIONS.get(placement.decorationId);
    if (definition && (!definition.rotations.has(placement.rotation) || !definition.layers.has(placement.layer) || placement.variant >= definition.variants)) return true;
    const swapped = placement.rotation === 90 || placement.rotation === 270;
    const width = definition ? swapped ? definition.height : definition.width : 0;
    const height = definition ? swapped ? definition.width : definition.height : 0;
    const outOfBounds = Math.abs(placement.x) + width / 2 > level.halfWidth || Math.abs(placement.y) + height / 2 > level.halfHeight;
    const overlapsAnchor = FUNCTIONAL_ANCHORS.some((anchor) =>
      Math.abs(placement.x - anchor.x) * 2 < width + anchor.width && Math.abs(placement.y - anchor.y) * 2 < height + anchor.height);
    return outOfBounds || overlapsAnchor;
  })) return false;
  const terminalsByPlanet = new Set();
  for (const entity of state.entities ?? []) {
    if (entity?.buildingId !== "orbital_cargo_terminal") continue;
    if (state.mode !== "normal" || typeof entity.planetId !== "string" || terminalsByPlanet.has(entity.planetId) ||
      entity.machineCount !== 1 || !Array.isArray(entity.orbitalCargoPortItems) || entity.orbitalCargoPortItems.length !== 4 ||
      entity.orbitalCargoPortItems.some((itemId) => itemId !== null && (typeof itemId !== "string" || !ID_PATTERN.test(itemId))) ||
      !Number.isFinite(entity.orbitalCargoProgress) || entity.orbitalCargoProgress < 0 || entity.orbitalCargoProgress >= 1 ||
      !decimal(entity.orbitalCargoTotalUploaded)) return false;
    const binding = entity.orbitalCargoBinding;
    if (binding !== null && binding !== undefined && (!isRecord(binding) ||
      !(binding.kind === "construction" || binding.kind === "contract" && PLACEMENT_ID_PATTERN.test(binding.contractId)))) return false;
    terminalsByPlanet.add(entity.planetId);
  }
  return true;
}

export function stationProjectionFromState(state) {
  if (!validateOrbitalStationGameState(state)) return null;
  const station = state.orbitalStation;
  return {
    status: station.status,
    reputation: station.economy.stationReputation,
    themeId: station.layout.themeId,
    placements: station.layout.placements.map((placement) => ({ ...placement })),
    featuredAchievementIds: [...station.layout.featuredAchievementIds],
    featuredContract: station.contractBoard.history.find((contract) => contract.id === station.contractBoard.featuredContractId && contract.settlementReason === "completed")
      ? (() => {
          const contract = station.contractBoard.history.find((entry) => entry.id === station.contractBoard.featuredContractId);
          return { id: contract.id, title: contract.title, difficulty: contract.difficulty, settledAtTaskDay: contract.settledAtTaskDay ?? contract.taskDay };
        })()
      : null,
    profile: {
      title: station.profile.title,
      motto: station.profile.motto,
      featuredMetricKeys: [...station.profile.featuredMetricKeys],
    },
    totals: { completedContracts: station.totals.completedContracts },
    production: {
      universeMatrix: Math.max(0, Math.floor(Number(state.totalProduced?.universe_matrix) || 0)),
      solarSails: Math.max(0, Math.floor(Number(state.dysonSwarm?.totalLaunched) || 0)),
      carrierRockets: Math.max(0, Math.floor(Number(state.dysonSphere?.totalRocketsLaunched) || 0)),
    },
    contentPackUnverified: Array.isArray(state.contentPacks) && state.contentPacks.length > 0,
  };
}

function publicPlacement(placement, level) {
  const definition = OFFICIAL_DECORATIONS.get(placement.decorationId);
  if (!definition || !validPlacement(placement, false) || !definition.rotations.has(placement.rotation) ||
    !definition.layers.has(placement.layer) || placement.variant >= definition.variants) return null;
  const swapped = placement.rotation === 90 || placement.rotation === 270;
  const width = swapped ? definition.height : definition.width;
  const height = swapped ? definition.width : definition.height;
  if (Math.abs(placement.x) + width / 2 > level.halfWidth || Math.abs(placement.y) + height / 2 > level.halfHeight) return null;
  return {
    id: placement.id,
    decorationId: placement.decorationId,
    x: Math.round(placement.x * 100) / 100,
    y: Math.round(placement.y * 100) / 100,
    rotation: placement.rotation,
    layer: placement.layer,
    variant: placement.variant,
  };
}

export function stationPublicId(userId) {
  return `station_${createHash("sha256").update(`dspidle-station-public-v1:${userId}`).digest("hex").slice(0, 32)}`;
}

export function buildPublicStationSnapshot({ user, projection, sourceRevision, publishedAt = Date.now(), leaderboardMetrics = null }) {
  if (!user || !projection || projection.status !== "operational" || !finiteInteger(sourceRevision, 1) ||
    !safeText(projection.profile?.title, 32, { allowEmpty: false }) || !safeText(projection.profile?.motto, 96)) return null;
  const level = stationLevel(projection.reputation);
  const placements = Array.isArray(projection.placements)
    ? projection.placements.map((placement) => publicPlacement(placement, level)).filter(Boolean).slice(0, Math.min(256, level.placementLimit))
    : [];
  const metricValues = {
    "total-generation": Math.max(0, Number(leaderboardMetrics?.energyGeneratedMj) || 0),
    "peak-throughput": Math.max(0, Number(leaderboardMetrics?.peakThroughputPerMinute) || 0),
    "dyson-power": Math.max(0, Number(leaderboardMetrics?.peakDysonPowerKw) || 0),
    "explored-systems": Math.max(0, Math.floor(Number(leaderboardMetrics?.exploredSystems) || 0)),
    "colonized-planets": Math.max(0, Math.floor(Number(leaderboardMetrics?.colonizedPlanets) || 0)),
    "universe-matrix-produced": projection.production?.universeMatrix ?? 0,
    "solar-sails-launched": projection.production?.solarSails ?? 0,
    "carrier-rockets-launched": projection.production?.carrierRockets ?? 0,
  };
  const featuredKeys = Array.isArray(projection.profile.featuredMetricKeys)
    ? [...new Set(projection.profile.featuredMetricKeys.filter((key) => PUBLIC_STATION_METRIC_KEYS.has(key)))].slice(0, 4)
    : [];
  const publicId = stationPublicId(user.id);
  return {
    schema: STATION_SHOWCASE_SCHEMA,
    publicId,
    owner: {
      displayName: typeof user.displayName === "string" ? user.displayName.slice(0, 24) : "星际工程师",
      avatar: typeof user.displayName === "string" ? user.displayName.trim().slice(0, 1).toUpperCase() || "A" : "A",
    },
    profile: { title: projection.profile.title, motto: projection.profile.motto },
    station: {
      stage: "operational",
      reputation: projection.reputation,
      level: level.level,
      themeId: OFFICIAL_THEME_IDS.has(projection.themeId) ? projection.themeId : "orbital_teal",
      placements,
      featuredAchievementIds: Array.isArray(projection.featuredAchievementIds)
        ? projection.featuredAchievementIds.filter((id) => OFFICIAL_ACHIEVEMENT_IDS.has(id)).slice(0, 8)
        : [],
      completedContracts: Math.max(0, Math.floor(Number(projection.totals?.completedContracts) || 0)),
      featuredContract: projection.featuredContract && safeText(projection.featuredContract.title, 64, { allowEmpty: false })
        ? { ...projection.featuredContract }
        : null,
    },
    metrics: Object.fromEntries(featuredKeys.map((key) => [key, metricValues[key]])),
    aggregateMetrics: Object.fromEntries(["total-generation", "peak-throughput", "dyson-power", "explored-systems", "colonized-planets"].map((key) => [key, metricValues[key]])),
    metricStatus: projection.contentPackUnverified ? "content-pack-unverified" : "official",
    publishedAt: Math.max(0, Math.floor(publishedAt)),
  };
}

export function normalizeStationCollections(source, users = {}) {
  const profiles = {};
  for (const [userId, record] of Object.entries(isRecord(source?.stationProfiles) ? source.stationProfiles : {})) {
    if (!users[userId] || !isRecord(record) || record.userId !== userId || !PUBLIC_ID_PATTERN.test(record.publicId) ||
      !STATION_VISIBILITIES.has(record.visibility) || !(record.snapshot === null || isRecord(record.snapshot) && record.snapshot.schema === STATION_SHOWCASE_SCHEMA) ||
      !(record.sourceRevision === null || finiteInteger(record.sourceRevision, 1)) || !finiteInteger(record.updatedAt, 0)) continue;
    profiles[userId] = { ...record };
  }
  const favorites = {};
  for (const [key, record] of Object.entries(isRecord(source?.stationFavorites) ? source.stationFavorites : {})) {
    if (!isRecord(record) || !users[record.userId] || !users[record.targetUserId] || record.userId === record.targetUserId ||
      key !== `${record.userId}:${record.targetUserId}` || !finiteInteger(record.createdAt, 0)) continue;
    favorites[key] = { ...record };
  }
  const signals = {};
  for (const [key, record] of Object.entries(isRecord(source?.stationSignals) ? source.stationSignals : {})) {
    if (!isRecord(record) || !users[record.userId] || !users[record.targetUserId] || record.userId === record.targetUserId ||
      key !== `${record.userId}:${record.targetUserId}` || !STATION_SIGNAL_IDS.has(record.signalId) || !finiteInteger(record.updatedAt, 0)) continue;
    signals[key] = { ...record };
  }
  const moderation = {};
  for (const [userId, record] of Object.entries(isRecord(source?.stationModeration) ? source.stationModeration : {})) {
    if (!users[userId] || !isRecord(record) || record.withdrawn !== true || !safeText(record.reason ?? "", 120) || !finiteInteger(record.updatedAt, 0)) continue;
    moderation[userId] = { withdrawn: true, reason: record.reason ?? "", updatedAt: record.updatedAt };
  }
  return { stationProfiles: profiles, stationFavorites: favorites, stationSignals: signals, stationModeration: moderation };
}

export function stationCollectionsProjection(data) {
  return Object.fromEntries(COLLECTION_KEYS.map((key) => [key, data?.[key] ?? {}]));
}

export function withoutStationCollections(data) {
  const projected = { ...data };
  for (const key of COLLECTION_KEYS) delete projected[key];
  return projected;
}

export function initializeStationSqliteTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS station_profiles (
      user_id TEXT PRIMARY KEY,
      public_id TEXT NOT NULL UNIQUE,
      visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
      source_revision INTEGER,
      snapshot_json TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS station_favorites (
      user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, target_user_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS station_signals (
      user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      signal_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, target_user_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS station_moderation (
      user_id TEXT PRIMARY KEY,
      withdrawn INTEGER NOT NULL CHECK (withdrawn IN (0, 1)),
      reason TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS station_favorites_target_idx ON station_favorites(target_user_id);
    CREATE INDEX IF NOT EXISTS station_signals_target_idx ON station_signals(target_user_id);
  `);
}

export function loadStationSqliteCollections(database, users) {
  const source = { stationProfiles: {}, stationFavorites: {}, stationSignals: {}, stationModeration: {} };
  for (const row of database.prepare("SELECT user_id AS userId, public_id AS publicId, visibility, source_revision AS sourceRevision, snapshot_json AS snapshotJson, updated_at AS updatedAt FROM station_profiles").all()) {
    let snapshot = null;
    try { snapshot = row.snapshotJson ? JSON.parse(row.snapshotJson) : null; } catch { snapshot = null; }
    source.stationProfiles[row.userId] = { userId: row.userId, publicId: row.publicId, visibility: row.visibility, sourceRevision: row.sourceRevision, snapshot, updatedAt: row.updatedAt };
  }
  for (const row of database.prepare("SELECT user_id AS userId, target_user_id AS targetUserId, created_at AS createdAt FROM station_favorites").all()) {
    source.stationFavorites[`${row.userId}:${row.targetUserId}`] = row;
  }
  for (const row of database.prepare("SELECT user_id AS userId, target_user_id AS targetUserId, signal_id AS signalId, updated_at AS updatedAt FROM station_signals").all()) {
    source.stationSignals[`${row.userId}:${row.targetUserId}`] = row;
  }
  for (const row of database.prepare("SELECT user_id AS userId, withdrawn, reason, updated_at AS updatedAt FROM station_moderation").all()) {
    source.stationModeration[row.userId] = { withdrawn: row.withdrawn === 1, reason: row.reason, updatedAt: row.updatedAt };
  }
  return normalizeStationCollections(source, users);
}

function changed(previous, next) {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function applyMapDiff(database, previous, next, removeStatement, writeRecord) {
  for (const key of Object.keys(previous ?? {})) if (!Object.hasOwn(next ?? {}, key)) removeStatement.run(key);
  for (const [key, record] of Object.entries(next ?? {})) {
    if (!Object.hasOwn(previous ?? {}, key) || changed(previous[key], record)) writeRecord(key, record);
  }
}

export function applyStationSqliteCollections(database, previousData, nextData) {
  const previous = stationCollectionsProjection(previousData);
  const next = stationCollectionsProjection(nextData);
  const deleteProfile = database.prepare("DELETE FROM station_profiles WHERE user_id = ?");
  const upsertProfile = database.prepare("INSERT INTO station_profiles (user_id, public_id, visibility, source_revision, snapshot_json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET public_id = excluded.public_id, visibility = excluded.visibility, source_revision = excluded.source_revision, snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at");
  applyMapDiff(database, previous.stationProfiles, next.stationProfiles, deleteProfile, (_key, record) =>
    upsertProfile.run(record.userId, record.publicId, record.visibility, record.sourceRevision, record.snapshot ? JSON.stringify(record.snapshot) : null, record.updatedAt));
  const deleteFavorite = database.prepare("DELETE FROM station_favorites WHERE user_id || ':' || target_user_id = ?");
  const upsertFavorite = database.prepare("INSERT INTO station_favorites (user_id, target_user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, target_user_id) DO UPDATE SET created_at = excluded.created_at");
  applyMapDiff(database, previous.stationFavorites, next.stationFavorites, deleteFavorite, (_key, record) =>
    upsertFavorite.run(record.userId, record.targetUserId, record.createdAt));
  const deleteSignal = database.prepare("DELETE FROM station_signals WHERE user_id || ':' || target_user_id = ?");
  const upsertSignal = database.prepare("INSERT INTO station_signals (user_id, target_user_id, signal_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, target_user_id) DO UPDATE SET signal_id = excluded.signal_id, updated_at = excluded.updated_at");
  applyMapDiff(database, previous.stationSignals, next.stationSignals, deleteSignal, (_key, record) =>
    upsertSignal.run(record.userId, record.targetUserId, record.signalId, record.updatedAt));
  const deleteModeration = database.prepare("DELETE FROM station_moderation WHERE user_id = ?");
  const upsertModeration = database.prepare("INSERT INTO station_moderation (user_id, withdrawn, reason, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET withdrawn = excluded.withdrawn, reason = excluded.reason, updated_at = excluded.updated_at");
  applyMapDiff(database, previous.stationModeration, next.stationModeration, deleteModeration, (key, record) =>
    upsertModeration.run(key, record.withdrawn ? 1 : 0, record.reason, record.updatedAt));
}

export function refreshStationProfile(data, user, projection, sourceRevision, leaderboardMetrics, now = Date.now()) {
  data.stationProfiles ??= {};
  const publicId = stationPublicId(user.id);
  const snapshot = buildPublicStationSnapshot({ user, projection, sourceRevision, publishedAt: now, leaderboardMetrics });
  if (!snapshot) {
    const existing = data.stationProfiles[user.id];
    if (!existing) return { profile: null, published: false, reason: projection?.status === "operational" ? "invalid" : "not-operational" };
    data.stationProfiles[user.id] = { ...existing, snapshot: null, sourceRevision: null, updatedAt: now, visibility: user.stationVisibility === "private" ? "private" : "public" };
    return { profile: data.stationProfiles[user.id], published: false, reason: "not-operational" };
  }
  const profile = {
    userId: user.id,
    publicId,
    visibility: user.stationVisibility === "private" ? "private" : "public",
    sourceRevision,
    snapshot,
    updatedAt: now,
  };
  data.stationProfiles[user.id] = profile;
  return { profile, published: true, reason: null };
}

export function clearStationProfileSnapshot(data, userId, now = Date.now()) {
  const existing = data.stationProfiles?.[userId];
  if (!existing) return null;
  data.stationProfiles[userId] = { ...existing, snapshot: null, sourceRevision: null, updatedAt: now };
  return data.stationProfiles[userId];
}

export function setStationVisibility(data, user, visibility, now = Date.now()) {
  if (!STATION_VISIBILITIES.has(visibility)) return null;
  user.stationVisibility = visibility;
  data.stationProfiles ??= {};
  const existing = data.stationProfiles[user.id];
  data.stationProfiles[user.id] = existing
    ? { ...existing, visibility, updatedAt: now }
    : { userId: user.id, publicId: stationPublicId(user.id), visibility, sourceRevision: null, snapshot: null, updatedAt: now };
  return data.stationProfiles[user.id];
}

export function findPublicStation(data, users, publicId) {
  if (!PUBLIC_ID_PATTERN.test(publicId)) return null;
  const profile = Object.values(data.stationProfiles ?? {}).find((entry) => entry.publicId === publicId);
  if (!profile || profile.visibility !== "public" || !profile.snapshot || data.stationModeration?.[profile.userId]?.withdrawn === true ||
    users?.[profile.userId]?.stationVisibility === "private") return null;
  return profile;
}

export function stationSocialSummary(data, targetUserId, viewerUserId = null) {
  const favorites = Object.values(data.stationFavorites ?? {}).filter((record) => record.targetUserId === targetUserId);
  const signals = Object.values(data.stationSignals ?? {}).filter((record) => record.targetUserId === targetUserId);
  return {
    favoriteCount: favorites.length,
    viewerFavorite: viewerUserId ? favorites.some((record) => record.userId === viewerUserId) : false,
    signals: Object.fromEntries([...STATION_SIGNAL_IDS].map((signalId) => [signalId, signals.filter((record) => record.signalId === signalId).length])),
    viewerSignal: viewerUserId ? signals.find((record) => record.userId === viewerUserId)?.signalId ?? null : null,
  };
}

export function setStationFavorite(data, userId, targetUserId, favorite, now = Date.now()) {
  if (userId === targetUserId) return { ok: false, code: "STATION_SELF_SOCIAL_FORBIDDEN" };
  data.stationFavorites ??= {};
  const key = `${userId}:${targetUserId}`;
  if (favorite) data.stationFavorites[key] = { userId, targetUserId, createdAt: data.stationFavorites[key]?.createdAt ?? now };
  else delete data.stationFavorites[key];
  return { ok: true, favorite: Boolean(data.stationFavorites[key]) };
}

export function setStationSignal(data, userId, targetUserId, signalId, now = Date.now()) {
  if (userId === targetUserId) return { ok: false, code: "STATION_SELF_SOCIAL_FORBIDDEN" };
  if (!STATION_SIGNAL_IDS.has(signalId)) return { ok: false, code: "STATION_SIGNAL_INVALID" };
  data.stationSignals ??= {};
  const key = `${userId}:${targetUserId}`;
  data.stationSignals[key] = { userId, targetUserId, signalId, updatedAt: now };
  return { ok: true, signalId };
}

export function deleteStationAccountData(data, userId) {
  delete data.stationProfiles?.[userId];
  delete data.stationModeration?.[userId];
  for (const [key, record] of Object.entries(data.stationFavorites ?? {})) {
    if (record.userId === userId || record.targetUserId === userId) delete data.stationFavorites[key];
  }
  for (const [key, record] of Object.entries(data.stationSignals ?? {})) {
    if (record.userId === userId || record.targetUserId === userId) delete data.stationSignals[key];
  }
}

export function stationPublicIdForUser(data, userId) {
  const profile = data.stationProfiles?.[userId];
  return profile?.visibility === "public" && profile.snapshot && data.stationModeration?.[userId]?.withdrawn !== true
    ? profile.publicId
    : null;
}
