import { ITEMS, getPlanet } from "./content";
import {
  addStationInteger,
  multiplyStationIntegerBasisPoints,
  normalizeStationInteger,
  stationCompletionBasisPoints,
  stationInteger,
  stationIntegerFromBigInt,
} from "./stationMath";
import type {
  GameState,
  ItemId,
  OrbitalStationState,
  PlanetId,
  StationContract,
  StationContractBoardState,
  StationContractChannel,
  StationContractDifficulty,
  StationContractRequirement,
  StationContractSettlementReason,
  TechId,
} from "./types";

export const STATION_CONTRACT_RULES_VERSION = 1 as const;
export const STATION_CONTRACT_ACCEPT_LIMIT = 3;
export const STATION_CONTRACT_HISTORY_LIMIT = 48;
export const STATION_CONTRACT_SETTLEMENT_ID_LIMIT = 4096;
export const STATION_TASK_TIME_ZONE_OFFSET_MS = 8 * 60 * 60 * 1_000;
export const STATION_TASK_DAY_MS = 24 * 60 * 60 * 1_000;

interface ContractItemCandidate {
  itemId: ItemId;
  weight: number;
  requiredTechId?: TechId;
  category: "industrial" | "dyson" | "advanced";
}

function stationContractText(value: string, maximum: number): string {
  return value.replace(/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").trim().slice(0, maximum);
}

const CONTRACT_ITEMS: ContractItemCandidate[] = [
  { itemId: "titanium_alloy", weight: 4, requiredTechId: "titanium_alloy", category: "industrial" },
  { itemId: "processor", weight: 3, requiredTechId: "processor", category: "industrial" },
  { itemId: "particle_container", weight: 6, requiredTechId: "miniature_particle_collider", category: "industrial" },
  { itemId: "titanium_glass", weight: 5, requiredTechId: "information_matrix", category: "industrial" },
  { itemId: "particle_broadband", weight: 8, requiredTechId: "information_matrix", category: "industrial" },
  { itemId: "plastic", weight: 2, requiredTechId: "basic_chemical_engineering", category: "industrial" },
  { itemId: "space_warper", weight: 12, requiredTechId: "space_warp", category: "advanced" },
  { itemId: "frame_material", weight: 10, requiredTechId: "dyson_sphere_program", category: "dyson" },
  { itemId: "solar_sail", weight: 5, requiredTechId: "dyson_swarm", category: "dyson" },
  { itemId: "small_carrier_rocket", weight: 45, requiredTechId: "vertical_launching_silo", category: "dyson" },
  { itemId: "quantum_chip", weight: 14, requiredTechId: "quantum_chip", category: "advanced" },
  { itemId: "antimatter_fuel_rod", weight: 40, requiredTechId: "artificial_star", category: "advanced" },
  { itemId: "universe_matrix", weight: 60, requiredTechId: "universe_matrix", category: "advanced" },
];

const DIFFICULTY_UNITS: Record<StationContractDifficulty, number> = { P1: 18_000, P2: 48_000, P3: 120_000 };
const DIFFICULTY_REWARDS: Record<StationContractDifficulty, { marks: number; reputation: number; completionMarks: number; completionReputation: number }> = {
  P1: { marks: 45, reputation: 30, completionMarks: 20, completionReputation: 15 },
  P2: { marks: 120, reputation: 80, completionMarks: 65, completionReputation: 40 },
  P3: { marks: 300, reputation: 200, completionMarks: 180, completionReputation: 120 },
};

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function deterministicIndex(seed: number, taskDay: number, slot: number, key: string, length: number): number {
  if (length <= 1) return 0;
  return hashText(`${seed}|${taskDay}|${slot}|${STATION_CONTRACT_RULES_VERSION}|${key}`) % length;
}

function rotatePick<T>(values: readonly T[], count: number, seed: number, taskDay: number, slot: number, key: string): T[] {
  if (values.length === 0 || count < 1) return [];
  const start = deterministicIndex(seed, taskDay, slot, key, values.length);
  const step = values.length > 1 ? 1 + deterministicIndex(seed, taskDay, slot, `${key}:step`, values.length - 1) : 1;
  const result: T[] = [];
  const seen = new Set<number>();
  for (let cursor = 0; result.length < Math.min(count, values.length) && cursor < values.length * 2; cursor += 1) {
    const index = (start + cursor * step) % values.length;
    if (seen.has(index)) continue;
    seen.add(index);
    result.push(values[index]);
  }
  if (result.length < Math.min(count, values.length)) {
    for (let index = 0; index < values.length && result.length < count; index += 1) {
      if (!seen.has(index)) result.push(values[index]);
    }
  }
  return result;
}

function contractsUnlocked(status: OrbitalStationState["status"]): boolean {
  return status === "showcase-building" || status === "operational";
}

function availableContractItems(state: Pick<GameState, "research" | "totalProduced">): ContractItemCandidate[] {
  const completed = new Set(state.research.completedTechIds);
  const result = CONTRACT_ITEMS.filter((candidate) =>
    (state.totalProduced[candidate.itemId] ?? 0) > 0 || !candidate.requiredTechId || completed.has(candidate.requiredTechId));
  return result.length > 0 ? result : CONTRACT_ITEMS.filter((candidate) => candidate.itemId === "titanium_alloy" || candidate.itemId === "processor");
}

function availableSourcePlanets(state: Pick<GameState, "exploration">): PlanetId[] {
  return state.exploration.colonizedPlanetIds.filter((planetId) => getPlanet(planetId).kind !== "gas-giant");
}

function contractAmount(candidate: ContractItemCandidate, difficulty: StationContractDifficulty, multiplier = 1): string {
  const amount = Math.max(100, Math.floor(DIFFICULTY_UNITS[difficulty] * multiplier / candidate.weight / 100) * 100);
  return String(amount);
}

function requirement(
  candidate: ContractItemCandidate,
  difficulty: StationContractDifficulty,
  channel: StationContractChannel = "any",
  sourcePlanetIds?: PlanetId[],
  multiplier = 1,
): StationContractRequirement {
  return {
    itemId: candidate.itemId,
    amount: contractAmount(candidate, difficulty, multiplier),
    delivered: "0",
    sourcePlanetIds: sourcePlanetIds?.length ? [...sourcePlanetIds] : undefined,
    channel,
    weight: candidate.weight,
  };
}

function contractDifficulty(taskDay: number, slot: number, special: boolean, seed: number): StationContractDifficulty {
  if (special) return "P3";
  const roll = deterministicIndex(seed, taskDay, slot, "difficulty", 10);
  return roll < 5 ? "P1" : roll < 9 ? "P2" : "P3";
}

type ContractTemplateId = "single" | "combination" | "dyson" | "origin" | "multi-origin" | "quantum" | "advanced";

function eligibleTemplates(state: Pick<GameState, "quantumLogisticsNetwork">, planets: readonly PlanetId[], special: boolean): ContractTemplateId[] {
  if (special) return state.quantumLogisticsNetwork.enabled ? ["advanced", "quantum", "dyson"] : ["advanced", "dyson", "combination"];
  const result: ContractTemplateId[] = ["single", "combination", "dyson"];
  if (planets.length > 0) result.push("origin");
  if (planets.length > 1) result.push("multi-origin");
  if (state.quantumLogisticsNetwork.enabled) result.push("quantum");
  return result;
}

function createContract(
  state: Pick<GameState, "galaxy" | "research" | "totalProduced" | "exploration" | "quantumLogisticsNetwork">,
  taskDay: number,
  slot: 0 | 1 | 2 | 3,
): StationContract {
  const special = slot === 3;
  const seed = state.galaxy.seed;
  const items = availableContractItems(state);
  const planets = availableSourcePlanets(state);
  const templates = eligibleTemplates(state, planets, special);
  const templateId = templates[deterministicIndex(seed, taskDay, slot, "template", templates.length)];
  const difficulty = contractDifficulty(taskDay, slot, special, seed);
  const industrial = items.filter((candidate) => candidate.category === "industrial");
  const dyson = items.filter((candidate) => candidate.category === "dyson");
  const advanced = items.filter((candidate) => candidate.category === "advanced");
  const choose = (pool: ContractItemCandidate[], count: number, key: string) =>
    rotatePick(pool.length ? pool : items, count, seed, taskDay, slot, key);
  let requirements: StationContractRequirement[];
  let title: string;
  let summary: string;
  if (templateId === "single") {
    const candidate = choose(items, 1, "single")[0];
    requirements = [requirement(candidate, difficulty)];
    title = `${ITEMS[candidate.itemId].name}常规出口`;
    summary = "向轨道贸易航线提交一批标准工业物资。";
  } else if (templateId === "combination") {
    const selected = choose(industrial, difficulty === "P1" ? 2 : 3, "combination");
    requirements = selected.map((candidate) => requirement(candidate, difficulty, "any", undefined, 0.7));
    title = "组合工业舱单";
    summary = "按固定舱单组合交付多种工业部件。";
  } else if (templateId === "dyson") {
    const selected = choose(dyson, Math.min(2, Math.max(1, dyson.length)), "dyson");
    requirements = selected.map((candidate) => requirement(candidate, difficulty, "any", undefined, 0.8));
    title = "戴森工程补给";
    summary = "为远端恒星工程提供结构与发射物资。";
  } else if (templateId === "origin") {
    const candidate = choose(items, 1, "origin:item")[0];
    const planetId = rotatePick(planets, 1, seed, taskDay, slot, "origin:planet")[0];
    requirements = [requirement(candidate, difficulty, "terminal", [planetId])];
    title = `${getPlanet(planetId).name}原产订单`;
    summary = `由${getPlanet(planetId).name}的轨道货运终端提交，或由玩家确认后从量子库存交付。`;
  } else if (templateId === "multi-origin") {
    const selectedPlanets = rotatePick(planets, 2, seed, taskDay, slot, "multi:planets");
    const selectedItems = choose(items, 2, "multi:items");
    requirements = selectedPlanets.map((planetId, index) => requirement(selectedItems[index % selectedItems.length], difficulty, "terminal", [planetId], 0.65));
    title = "多行星协同出口";
    summary = "由两颗指定行星分别完成出口配额，也可由玩家确认后从量子库存交付。";
  } else if (templateId === "quantum") {
    const selected = choose(advanced, difficulty === "P3" ? 2 : 1, "quantum");
    requirements = selected.map((candidate) => requirement(candidate, difficulty, "quantum", undefined, 0.7));
    title = "量子库存应急调拨";
    summary = "只能从量子共享库存手动确认交付。";
  } else {
    const selected = choose(advanced, 2, "advanced");
    requirements = selected.map((candidate) => requirement(candidate, "P3", "any", undefined, 0.8));
    title = "终局部件特别出口";
    summary = "面向深空联合体的高价值特别舱单。";
  }
  const reward = DIFFICULTY_REWARDS[difficulty];
  const specialMultiplier = special ? 2 : 1;
  const id = `station-contract-v${STATION_CONTRACT_RULES_VERSION}-${seed}-${taskDay}-${slot}-${templateId}`;
  return {
    id,
    templateId,
    slot,
    title,
    summary,
    taskDay,
    expiresAtTaskDay: taskDay + 3,
    special,
    difficulty,
    status: "offered",
    requirements,
    rewards: {
      baseMarks: String(reward.marks * specialMultiplier),
      baseReputation: String(reward.reputation * specialMultiplier),
      completionMarks: String(reward.completionMarks * specialMultiplier),
      completionReputation: String(reward.completionReputation * specialMultiplier),
    },
  };
}

export function stationTaskDayIndex(nowMs: number): number {
  const normalized = Number.isFinite(nowMs) ? Math.max(0, Math.floor(nowMs)) : 0;
  return Math.floor((normalized + STATION_TASK_TIME_ZONE_OFFSET_MS) / STATION_TASK_DAY_MS);
}

export function createStationContractBoard(nowMs = Date.now()): StationContractBoardState {
  const safeNow = Number.isFinite(nowMs) ? Math.max(0, Math.floor(nowMs)) : 0;
  return {
    rulesVersion: STATION_CONTRACT_RULES_VERSION,
    taskDay: stationTaskDayIndex(safeNow),
    lastConfirmedWallClockMs: safeNow,
    offers: [],
    accepted: [],
    history: [],
    settledIds: [],
    featuredContractId: null,
  };
}

export function cloneStationContract(contract: StationContract): StationContract {
  return {
    ...contract,
    requirements: contract.requirements.map((entry) => ({
      ...entry,
      sourcePlanetIds: entry.sourcePlanetIds ? [...entry.sourcePlanetIds] : undefined,
    })),
    rewards: { ...contract.rewards },
  };
}

export function cloneStationContractBoard(board: StationContractBoardState): StationContractBoardState {
  return {
    ...board,
    offers: board.offers.map(cloneStationContract),
    accepted: board.accepted.map(cloneStationContract),
    history: board.history.map(cloneStationContract),
    settledIds: [...board.settledIds],
  };
}

function normalizeContract(value: unknown): StationContract | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StationContract>;
  if (typeof candidate.id !== "string" || candidate.id.length < 1 || candidate.id.length > 180 ||
    typeof candidate.templateId !== "string" || candidate.templateId.length < 1 || candidate.templateId.length > 48 ||
    typeof candidate.title !== "string" || typeof candidate.summary !== "string" ||
    !Number.isSafeInteger(candidate.slot) || (candidate.slot ?? -1) < 0 || (candidate.slot ?? -1) > 3 ||
    !Number.isSafeInteger(candidate.taskDay) || (candidate.taskDay ?? -1) < 0 ||
    !Number.isSafeInteger(candidate.expiresAtTaskDay) || (candidate.expiresAtTaskDay ?? -1) < (candidate.taskDay ?? 0) ||
    !["P1", "P2", "P3"].includes(candidate.difficulty ?? "") ||
    !["offered", "accepted", "claimable", "settled"].includes(candidate.status ?? "") ||
    !Array.isArray(candidate.requirements) || candidate.requirements.length < 1 || candidate.requirements.length > 6) return null;
  const requirements = candidate.requirements.flatMap((entry): StationContractRequirement[] => {
    if (!entry || typeof entry !== "object" || !(entry.itemId in ITEMS) || !["any", "terminal", "quantum"].includes(entry.channel)) return [];
    const amount = normalizeStationInteger(entry.amount, "0");
    if (amount === "0") return [];
    const delivered = stationInteger(entry.delivered) > stationInteger(amount) ? amount : normalizeStationInteger(entry.delivered);
    const sourcePlanetIds = Array.isArray(entry.sourcePlanetIds)
      ? [...new Set(entry.sourcePlanetIds.filter((planetId): planetId is PlanetId => typeof planetId === "string" && (() => {
        try { return getPlanet(planetId as PlanetId).id === planetId; } catch { return false; }
      })()))].slice(0, 4)
      : undefined;
    return [{
      itemId: entry.itemId,
      amount,
      delivered,
      sourcePlanetIds: sourcePlanetIds?.length ? sourcePlanetIds : undefined,
      channel: entry.channel,
      weight: Number.isSafeInteger(entry.weight) ? Math.max(1, Math.min(10_000, Math.floor(entry.weight))) : 1,
    }];
  });
  if (requirements.length !== candidate.requirements.length) return null;
  const rewards = candidate.rewards;
  if (!rewards || typeof rewards !== "object") return null;
  const title = stationContractText(candidate.title, 64);
  if (!title) return null;
  const settlementReason = ["completed", "abandoned", "expired"].includes(candidate.settlementReason ?? "")
    ? candidate.settlementReason as StationContractSettlementReason
    : undefined;
  return {
    id: candidate.id,
    templateId: candidate.templateId,
    slot: candidate.slot as 0 | 1 | 2 | 3,
    title,
    summary: stationContractText(candidate.summary, 160),
    taskDay: Math.floor(candidate.taskDay!),
    expiresAtTaskDay: Math.floor(candidate.expiresAtTaskDay!),
    special: Boolean(candidate.special),
    difficulty: candidate.difficulty as StationContractDifficulty,
    status: candidate.status as StationContract["status"],
    requirements,
    rewards: {
      baseMarks: normalizeStationInteger(rewards.baseMarks),
      baseReputation: normalizeStationInteger(rewards.baseReputation),
      completionMarks: normalizeStationInteger(rewards.completionMarks),
      completionReputation: normalizeStationInteger(rewards.completionReputation),
    },
    acceptedAtTaskDay: Number.isSafeInteger(candidate.acceptedAtTaskDay) ? Math.max(0, Math.floor(candidate.acceptedAtTaskDay!)) : undefined,
    settlementId: typeof candidate.settlementId === "string" && candidate.settlementId.length <= 240 ? candidate.settlementId : undefined,
    settlementReason,
    settledAtTaskDay: Number.isSafeInteger(candidate.settledAtTaskDay) ? Math.max(0, Math.floor(candidate.settledAtTaskDay!)) : undefined,
    completionBasisPoints: Number.isSafeInteger(candidate.completionBasisPoints)
      ? Math.max(0, Math.min(10_000, Math.floor(candidate.completionBasisPoints!)))
      : undefined,
  };
}

export function normalizeStationContractBoard(value: unknown, nowMs = Date.now()): StationContractBoardState {
  const fallback = createStationContractBoard(nowMs);
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<StationContractBoardState>;
  const normalizedOffers = Array.isArray(candidate.offers) ? candidate.offers.flatMap((entry) => {
    const normalized = normalizeContract(entry);
    return normalized?.status === "offered" ? [normalized] : [];
  }).slice(0, 4) : [];
  const normalizedAccepted = Array.isArray(candidate.accepted) ? candidate.accepted.flatMap((entry) => {
    const normalized = normalizeContract(entry);
    return normalized && (normalized.status === "accepted" || normalized.status === "claimable") ? [normalized] : [];
  }).slice(0, STATION_CONTRACT_ACCEPT_LIMIT) : [];
  const normalizedHistory = Array.isArray(candidate.history) ? candidate.history.flatMap((entry) => {
    const normalized = normalizeContract(entry);
    return normalized?.status === "settled" && normalized.settlementId ? [normalized] : [];
  }).slice(0, STATION_CONTRACT_HISTORY_LIMIT) : [];
  const historyIds = new Set<string>();
  const history = normalizedHistory.filter((entry) => {
    if (historyIds.has(entry.id)) return false;
    historyIds.add(entry.id);
    return true;
  });
  const candidateSettledIds = Array.isArray(candidate.settledIds)
    ? candidate.settledIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 180)
    : [];
  // 1.1.0 could regenerate the same deterministic offer after all four daily
  // contracts had already been settled. Preserve the authoritative history
  // and reward fence, while dropping only active entries that can no longer
  // be accepted. This repairs affected saves without rewriting progress.
  const settledIds = [...new Set([...candidateSettledIds, ...history.map((entry) => entry.id)])]
    .slice(-STATION_CONTRACT_SETTLEMENT_ID_LIMIT);
  const unavailableIds = new Set(settledIds);
  const accepted = normalizedAccepted.filter((entry) => {
    if (unavailableIds.has(entry.id)) return false;
    unavailableIds.add(entry.id);
    return true;
  });
  const offers = normalizedOffers.filter((entry) => {
    if (unavailableIds.has(entry.id)) return false;
    unavailableIds.add(entry.id);
    return true;
  });
  const featuredContractId = typeof candidate.featuredContractId === "string" &&
    history.some((entry) => entry.id === candidate.featuredContractId && entry.settlementReason === "completed")
    ? candidate.featuredContractId
    : null;
  return {
    rulesVersion: STATION_CONTRACT_RULES_VERSION,
    taskDay: Number.isSafeInteger(candidate.taskDay) ? Math.max(0, Math.floor(candidate.taskDay!)) : fallback.taskDay,
    lastConfirmedWallClockMs: typeof candidate.lastConfirmedWallClockMs === "number" && Number.isFinite(candidate.lastConfirmedWallClockMs)
      ? Math.max(0, Math.floor(candidate.lastConfirmedWallClockMs))
      : fallback.lastConfirmedWallClockMs,
    offers,
    accepted,
    history,
    settledIds,
    featuredContractId,
  };
}

function cloneStationForContracts(station: OrbitalStationState): OrbitalStationState {
  return {
    ...station,
    contractBoard: cloneStationContractBoard(station.contractBoard),
    economy: { ...station.economy, unlockedDecorationIds: [...station.economy.unlockedDecorationIds] },
    totals: { ...station.totals, exportedByItem: { ...station.totals.exportedByItem } },
  };
}

export function getStationContractCompletionBasisPoints(contract: StationContract): number {
  if (contract.requirements.length === 0) return 10_000;
  let weighted = 0;
  let totalWeight = 0;
  for (const entry of contract.requirements) {
    const weight = Math.max(1, Math.floor(entry.weight));
    weighted += stationCompletionBasisPoints(entry.delivered, entry.amount) * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? Math.max(0, Math.min(10_000, Math.floor(weighted / totalWeight))) : 0;
}

export function getStationContractRemaining(
  contract: StationContract,
  itemId: ItemId,
  channel: Exclude<StationContractChannel, "any">,
  sourcePlanetId?: PlanetId,
): bigint {
  return contract.requirements.reduce((sum, entry) => {
    if (entry.itemId !== itemId || !contractRequirementAcceptsDelivery(entry, channel, sourcePlanetId)) return sum;
    const required = stationInteger(entry.amount);
    const delivered = stationInteger(entry.delivered);
    return sum + (required > delivered ? required - delivered : 0n);
  }, 0n);
}

export interface StationContractDeliveryResult {
  accepted: string;
  reason: "delivered" | "missing-contract" | "invalid-channel" | "complete";
}

function contractRequirementAcceptsDelivery(
  entry: StationContractRequirement,
  channel: Exclude<StationContractChannel, "any">,
  sourcePlanetId?: PlanetId,
): boolean {
  // A player-confirmed quantum withdrawal is the manual fallback for every
  // ordinary contract requirement. Source-planet restrictions continue to
  // describe and constrain automatic cargo-terminal delivery only.
  if (channel === "quantum") return true;
  if (entry.channel === "quantum") return false;
  return !entry.sourcePlanetIds?.length || Boolean(sourcePlanetId && entry.sourcePlanetIds.includes(sourcePlanetId));
}

/** Mutates only the supplied station clone and is safe for the simulation hot path. */
export function deliverStationContractMutable(
  station: OrbitalStationState,
  contractId: string,
  itemId: ItemId,
  amount: bigint,
  channel: Exclude<StationContractChannel, "any">,
  sourcePlanetId?: PlanetId,
): StationContractDeliveryResult {
  const contract = station.contractBoard.accepted.find((candidate) => candidate.id === contractId);
  if (!contract || (contract.status !== "accepted" && contract.status !== "claimable")) return { accepted: "0", reason: "missing-contract" };
  if (contract.status === "claimable") return { accepted: "0", reason: "complete" };
  let remaining = amount > 0n ? amount : 0n;
  let accepted = 0n;
  let matchedChannel = false;
  for (const entry of contract.requirements) {
    if (remaining <= 0n || entry.itemId !== itemId || !contractRequirementAcceptsDelivery(entry, channel, sourcePlanetId)) continue;
    matchedChannel = true;
    const required = stationInteger(entry.amount);
    const delivered = stationInteger(entry.delivered);
    const need = required > delivered ? required - delivered : 0n;
    const moved = remaining < need ? remaining : need;
    if (moved <= 0n) continue;
    entry.delivered = stationIntegerFromBigInt(delivered + moved);
    remaining -= moved;
    accepted += moved;
  }
  if (accepted > 0n) {
    station.totals.exportedByItem[itemId] = addStationInteger(station.totals.exportedByItem[itemId], accepted);
    if (getStationContractCompletionBasisPoints(contract) >= 10_000) contract.status = "claimable";
    return { accepted: stationIntegerFromBigInt(accepted), reason: "delivered" };
  }
  return { accepted: "0", reason: matchedChannel ? "complete" : "invalid-channel" };
}

export function acceptStationContract(station: OrbitalStationState, contractId: string): OrbitalStationState {
  if (!contractsUnlocked(station.status) || station.contractBoard.accepted.length >= STATION_CONTRACT_ACCEPT_LIMIT) return station;
  const offer = station.contractBoard.offers.find((candidate) => candidate.id === contractId && candidate.status === "offered");
  if (!offer || station.contractBoard.settledIds.includes(offer.id)) return station;
  const next = cloneStationForContracts(station);
  const accepted = cloneStationContract(offer);
  accepted.status = "accepted";
  accepted.acceptedAtTaskDay = next.contractBoard.taskDay;
  next.contractBoard.offers = next.contractBoard.offers.filter((candidate) => candidate.id !== contractId);
  next.contractBoard.accepted.push(accepted);
  return next;
}

function settleContractMutable(
  station: OrbitalStationState,
  contract: StationContract,
  reason: StationContractSettlementReason,
): void {
  if (contract.settlementId || station.contractBoard.settledIds.includes(contract.id)) return;
  const basisPoints = getStationContractCompletionBasisPoints(contract);
  const completed = reason === "completed" && basisPoints >= 10_000;
  let marks = multiplyStationIntegerBasisPoints(contract.rewards.baseMarks, basisPoints);
  let reputation = multiplyStationIntegerBasisPoints(contract.rewards.baseReputation, basisPoints);
  if (completed) {
    marks = addStationInteger(marks, contract.rewards.completionMarks);
    reputation = addStationInteger(reputation, contract.rewards.completionReputation);
    station.totals.completedContracts = Math.min(Number.MAX_SAFE_INTEGER, station.totals.completedContracts + 1);
  }
  station.economy.orbitalMarks = addStationInteger(station.economy.orbitalMarks, marks);
  station.economy.stationReputation = addStationInteger(station.economy.stationReputation, reputation);
  contract.status = "settled";
  contract.settlementId = `station-settlement:${contract.id}:${reason}`;
  contract.settlementReason = reason;
  contract.settledAtTaskDay = station.contractBoard.taskDay;
  contract.completionBasisPoints = basisPoints;
  station.contractBoard.settledIds.push(contract.id);
  if (station.contractBoard.settledIds.length > STATION_CONTRACT_SETTLEMENT_ID_LIMIT) {
    station.contractBoard.settledIds.splice(0, station.contractBoard.settledIds.length - STATION_CONTRACT_SETTLEMENT_ID_LIMIT);
  }
}

function archiveSettledContract(station: OrbitalStationState, contractId: string): void {
  const index = station.contractBoard.accepted.findIndex((candidate) => candidate.id === contractId);
  if (index < 0) return;
  const [contract] = station.contractBoard.accepted.splice(index, 1);
  station.contractBoard.history.unshift(contract);
  station.contractBoard.history = station.contractBoard.history.slice(0, STATION_CONTRACT_HISTORY_LIMIT);
  if (station.contractBoard.featuredContractId === contractId && contract.settlementReason !== "completed") {
    station.contractBoard.featuredContractId = null;
  }
}

export function claimStationContract(station: OrbitalStationState, contractId: string): OrbitalStationState {
  const current = station.contractBoard.accepted.find((candidate) => candidate.id === contractId);
  if (!current || current.status !== "claimable" || current.settlementId) return station;
  const next = cloneStationForContracts(station);
  const contract = next.contractBoard.accepted.find((candidate) => candidate.id === contractId)!;
  settleContractMutable(next, contract, "completed");
  archiveSettledContract(next, contractId);
  return next;
}

export function abandonStationContract(station: OrbitalStationState, contractId: string): OrbitalStationState {
  const current = station.contractBoard.accepted.find((candidate) => candidate.id === contractId);
  if (!current || current.status === "settled" || current.settlementId) return station;
  const next = cloneStationForContracts(station);
  const contract = next.contractBoard.accepted.find((candidate) => candidate.id === contractId)!;
  settleContractMutable(next, contract, contract.status === "claimable" ? "completed" : "abandoned");
  archiveSettledContract(next, contractId);
  return next;
}

export function setFeaturedStationContract(station: OrbitalStationState, contractId: string | null): OrbitalStationState {
  if (contractId !== null && !station.contractBoard.history.some((contract) =>
    contract.id === contractId && contract.settlementReason === "completed")) return station;
  if (station.contractBoard.featuredContractId === contractId) return station;
  return { ...station, contractBoard: { ...station.contractBoard, featuredContractId: contractId } };
}

export function synchronizeStationContracts(
  state: Pick<GameState, "galaxy" | "research" | "totalProduced" | "exploration" | "quantumLogisticsNetwork"> & { orbitalStation: OrbitalStationState },
  nowMs = Date.now(),
  serverTaskDay?: number,
): OrbitalStationState {
  const station = state.orbitalStation;
  if (!contractsUnlocked(station.status)) return station;
  const safeNow = Number.isFinite(nowMs) ? Math.max(0, Math.floor(nowMs)) : station.contractBoard.lastConfirmedWallClockMs;
  const localDay = stationTaskDayIndex(Math.max(safeNow, station.contractBoard.lastConfirmedWallClockMs));
  const calibratedDay = Number.isSafeInteger(serverTaskDay) && (serverTaskDay ?? -1) >= 0 ? Math.floor(serverTaskDay!) : localDay;
  const nextTaskDay = Math.max(station.contractBoard.taskDay, localDay, calibratedDay);
  const needsOffers = station.contractBoard.offers.length === 0;
  if (nextTaskDay === station.contractBoard.taskDay && !needsOffers && safeNow <= station.contractBoard.lastConfirmedWallClockMs) return station;
  const next = cloneStationForContracts(station);
  next.contractBoard.lastConfirmedWallClockMs = Math.max(next.contractBoard.lastConfirmedWallClockMs, safeNow);
  if (nextTaskDay > next.contractBoard.taskDay) {
    next.contractBoard.taskDay = nextTaskDay;
    for (const contract of [...next.contractBoard.accepted]) {
      if (contract.expiresAtTaskDay > nextTaskDay || contract.settlementId) continue;
      settleContractMutable(next, contract, contract.status === "claimable" ? "completed" : "expired");
      archiveSettledContract(next, contract.id);
    }
    next.contractBoard.offers = [];
  }
  if (next.contractBoard.offers.length === 0) {
    const unavailableIds = new Set([
      ...next.contractBoard.settledIds,
      ...next.contractBoard.history.map((contract) => contract.id),
      ...next.contractBoard.accepted.map((contract) => contract.id),
    ]);
    next.contractBoard.offers = ([0, 1, 2, 3] as const)
      .map((slot) => createContract(state, next.contractBoard.taskDay, slot))
      .filter((contract) => !unavailableIds.has(contract.id));
  }
  return next;
}

export function getStationContractItemLabel(contract: StationContract): string {
  return contract.requirements.map((entry) => ITEMS[entry.itemId].name).join("、");
}
