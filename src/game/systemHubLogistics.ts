import "../compat/runtime";
import { getBuilding, getPlanet } from "./content";
import { getSystemDistanceLy } from "./galaxy";
import type {
  DecimalIntegerString,
  FactoryEntity,
  FleetReturnBucket,
  GameState,
  ItemId,
  StarSystemId,
  SystemSpaceStationState,
} from "./types";

/**
 * The system hub is the only gameplay store allowed to cross the safe JS
 * integer boundary. Values are persisted as canonical decimal strings; all
 * arithmetic below is deterministic BigInt arithmetic and never leaks a
 * BigInt into a JSON object.
 */
export const SYSTEM_HUB_MAX_DIGITS = 256;
export const SYSTEM_HUB_SETTLEMENT_SECONDS = 5;
export const SYSTEM_HUB_FLEET_RETURN_SECONDS = 30;
export const SYSTEM_HUB_CARGO_PER_VESSEL = 100;
export const SYSTEM_HUB_BASE_INTERSTELLAR_THROUGHPUT = 10_000_000;

export function normalizeHubInteger(value: unknown, fallback: DecimalIntegerString = "0"): DecimalIntegerString {
  if (typeof value === "bigint") return value >= 0n && value.toString().length <= SYSTEM_HUB_MAX_DIGITS ? value.toString() : fallback;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : fallback;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  const normalized = value.replace(/^0+(?=\d)/, "");
  return normalized.length <= SYSTEM_HUB_MAX_DIGITS ? normalized : fallback;
}

function integer(value: unknown): bigint {
  return BigInt(normalizeHubInteger(value));
}

function decimal(value: bigint): DecimalIntegerString {
  if (value < 0n) return "0";
  const text = value.toString();
  return text.length <= SYSTEM_HUB_MAX_DIGITS ? text : "9".repeat(SYSTEM_HUB_MAX_DIGITS);
}

export function compareHubInteger(left: unknown, right: unknown): -1 | 0 | 1 {
  const a = integer(left);
  const b = integer(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addHubInteger(left: unknown, right: unknown): DecimalIntegerString {
  return decimal(integer(left) + integer(right));
}

export function subtractHubInteger(left: unknown, right: unknown): DecimalIntegerString {
  const result = integer(left) - integer(right);
  return decimal(result < 0n ? 0n : result);
}

export function minHubInteger(...values: unknown[]): DecimalIntegerString {
  if (values.length === 0) return "0";
  return decimal(values.map(integer).reduce((minimum, value) => value < minimum ? value : minimum));
}

export function multiplyHubInteger(value: unknown, factor: number): DecimalIntegerString {
  if (!Number.isSafeInteger(factor) || factor < 0) return "0";
  return decimal(integer(value) * BigInt(factor));
}

export interface HubAllocationRequest {
  key: string;
  amount: DecimalIntegerString;
}

export interface HubAllocationResult {
  allocations: Record<string, DecimalIntegerString>;
  nextCursor: number;
  totalAllocated: DecimalIntegerString;
}

/**
 * Proportionally allocates a budget. Requests are normalized and sorted by a
 * stable key before calculating floors, so object/array insertion order never
 * changes the result. Remaining units are distributed with a persisted cursor.
 */
export function allocateHubBudget(
  budget: DecimalIntegerString,
  requests: readonly HubAllocationRequest[],
  cursor = 0,
): HubAllocationResult {
  const normalized = requests
    .map((request) => ({ key: request.key, amount: integer(request.amount) }))
    .filter((request) => request.key.length > 0 && request.amount > 0n)
    .sort((left, right) => left.key.localeCompare(right.key));
  const allocations: Record<string, DecimalIntegerString> = {};
  if (normalized.length === 0 || integer(budget) <= 0n) {
    for (const request of normalized) allocations[request.key] = "0";
    return { allocations, nextCursor: 0, totalAllocated: "0" };
  }
  const totalRequest = normalized.reduce((sum, request) => sum + request.amount, 0n);
  const available = integer(budget) < totalRequest ? integer(budget) : totalRequest;
  let allocated = 0n;
  for (const request of normalized) {
    const amount = (available * request.amount) / totalRequest;
    allocations[request.key] = decimal(amount);
    allocated += amount;
  }
  let remainder = available - allocated;
  const start = ((Number.isSafeInteger(cursor) ? cursor : 0) % normalized.length + normalized.length) % normalized.length;
  for (let offset = 0; remainder > 0n && offset < normalized.length * 2; offset += 1) {
    const request = normalized[(start + offset) % normalized.length];
    const current = integer(allocations[request.key]);
    if (current >= request.amount) continue;
    allocations[request.key] = decimal(current + 1n);
    remainder -= 1n;
  }
  const nextCursor = normalized.length === 0 ? 0 : (start + Number(available - remainder)) % normalized.length;
  return { allocations, nextCursor, totalAllocated: decimal(available - remainder) };
}

function powerOfTwo(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0) return 1n;
  // 2^1024 already exceeds the useful gameplay validation range. Saturating
  // here keeps hostile module counts from allocating unbounded memory.
  return 2n ** BigInt(Math.min(exponent, 1024));
}

/** Cost for a contiguous module range; each ten modules share a doubled tier. */
export function sumEscalatingModuleCost(
  baseCost: DecimalIntegerString,
  existingModules: number,
  additionalModules: number,
): DecimalIntegerString {
  if (!Number.isSafeInteger(existingModules) || existingModules < 0 ||
    !Number.isSafeInteger(additionalModules) || additionalModules <= 0) return "0";
  const base = integer(baseCost);
  let remaining = additionalModules;
  let index = existingModules;
  let total = 0n;
  while (remaining > 0) {
    const tier = Math.floor(index / 10);
    const inTier = Math.min(remaining, 10 - (index % 10));
    total += base * powerOfTwo(tier) * BigInt(inTier);
    index += inTier;
    remaining -= inTier;
  }
  return decimal(total);
}

export interface HubPrototypeHub {
  id: string;
  systemId: StarSystemId;
  inventory: Record<string, DecimalIntegerString>;
}

export interface HubPrototypeContract {
  key: string;
  sourceHubId: string;
  targetHubId: string;
  itemId: string;
  amount: DecimalIntegerString;
  distanceLy: number;
}

export interface HubPrototypeFixture {
  hubs: HubPrototypeHub[];
  contracts: HubPrototypeContract[];
  legacyPairChecks: number;
}

export interface HubPrototypeReport {
  durationMs: number;
  contractCount: number;
  legacyPairChecks: number;
  activeItems: number;
  totalMoved: DecimalIntegerString;
  stateBytes: number;
}

/** Builds a player-data-free, 8-hub terminal-shaped fixture for stage 0. */
export function createHubPrototypeFixture(
  stationCount = 416,
  activeHubCount = 8,
  activeItems: readonly string[] = ["iron_ingot", "copper_ingot", "steel", "processor", "universe_matrix"],
): HubPrototypeFixture {
  const hubs = Array.from({ length: Math.max(2, Math.min(8, activeHubCount)) }, (_, index) => ({
    id: `hub_${index.toString().padStart(2, "0")}`,
    systemId: (["helios", "borealis", "aurora", "ember", "sirius", "white_dwarf", "neutron", "blue_giant"] as StarSystemId[])[index],
    inventory: Object.fromEntries(activeItems.map((itemId) => [itemId, "1000000000"])),
  }));
  const contracts: HubPrototypeContract[] = [];
  for (const itemId of activeItems) {
    for (let index = 0; index + 1 < hubs.length; index += 1) {
      const source = hubs[index];
      const target = hubs[(index + 1) % hubs.length];
      contracts.push({
        key: `${source.id}:${target.id}:${itemId}`,
        sourceHubId: source.id,
        targetHubId: target.id,
        itemId,
        amount: "100000000",
        distanceLy: index + 1,
      });
    }
  }
  return { hubs, contracts, legacyPairChecks: Math.max(0, Math.floor(stationCount)) ** 2 * activeItems.length };
}

export function settleHubPrototype(fixture: HubPrototypeFixture): HubPrototypeReport {
  const startedAt = performance.now();
  const hubs = new Map(fixture.hubs.map((hub) => [hub.id, structuredClone(hub)]));
  const requests = fixture.contracts
    .map((contract) => ({ key: contract.key, amount: contract.amount }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const allocation = allocateHubBudget("1000000000000", requests, 0);
  let totalMoved = "0";
  for (const contract of fixture.contracts) {
    const amount = allocation.allocations[contract.key] ?? "0";
    const source = hubs.get(contract.sourceHubId);
    const target = hubs.get(contract.targetHubId);
    if (!source || !target || compareHubInteger(amount, source.inventory[contract.itemId] ?? "0") > 0) continue;
    source.inventory[contract.itemId] = subtractHubInteger(source.inventory[contract.itemId] ?? "0", amount);
    target.inventory[contract.itemId] = addHubInteger(target.inventory[contract.itemId] ?? "0", amount);
    totalMoved = addHubInteger(totalMoved, amount);
  }
  const stateBytes = JSON.stringify({ hubs: [...hubs.values()] }).length;
  return {
    durationMs: performance.now() - startedAt,
    contractCount: fixture.contracts.length,
    legacyPairChecks: fixture.legacyPairChecks,
    activeItems: new Set(fixture.contracts.map((contract) => contract.itemId)).size,
    totalMoved,
    stateBytes,
  };
}

export function releaseExpiredFleetBuckets(
  buckets: readonly FleetReturnBucket[],
  simulationSecond: number,
): { buckets: FleetReturnBucket[]; releasedVessels: number } {
  const remaining: FleetReturnBucket[] = [];
  let releasedVessels = 0;
  for (const bucket of buckets) {
    const returnAtSecond = Number.isSafeInteger(bucket.returnAtSecond) ? bucket.returnAtSecond : Number.MAX_SAFE_INTEGER;
    const vesselCount = Number.isSafeInteger(bucket.vesselCount) ? Math.max(0, bucket.vesselCount) : 0;
    if (returnAtSecond <= simulationSecond) releasedVessels += vesselCount;
    else remaining.push({ ...bucket, returnAtSecond, vesselCount });
  }
  return { buckets: remaining.sort((left, right) => left.returnAtSecond - right.returnAtSecond || left.routeKey.localeCompare(right.routeKey)), releasedVessels };
}

export interface HubSettlementReport {
  simulationSecond: number;
  systemsSettled: number;
  localUploads: number;
  localDownloads: number;
  crossSystemMoved: DecimalIntegerString;
  vesselsDispatched: number;
  vesselsReleased: number;
  activeItems: number;
  skippedBecauseNoFleet: boolean;
}

function safeAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function safeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number") return 0;
  return Math.max(0, value);
}

function stationSystemId(station: FactoryEntity): StarSystemId | null {
  try {
    return getPlanet(station.planetId).systemId;
  } catch {
    return null;
  }
}

export function isElevatorStation(station: FactoryEntity): boolean {
  return station.buildingId === "interstellar_logistics_station" &&
    station.stationTier === 2 && station.stationOperationMode === "elevator";
}

function isOperationalStation(state: GameState, station: FactoryEntity): boolean {
  const systemId = stationSystemId(station);
  return Boolean(systemId && isElevatorStation(station) && state.systemSpaceStations[systemId]?.status === "operational");
}

function hubBufferLimit(state: GameState): number {
  const raw = state.settings.logisticsBufferLimit;
  return Number.isSafeInteger(raw) ? Math.max(1_000, Math.min(100_000_000, raw)) : 1_000_000;
}

function stackedOutputCapacity(state: GameState, station: FactoryEntity): number {
  const building = station.buildingId ? getBuilding(station.buildingId) : null;
  if (!building) return 0;
  const count = Math.max(1, safeAmount(station.machineCount));
  return Math.min(hubBufferLimit(state), Math.max(0, Math.floor(building.outputCapacity)) * count);
}

function stationPowerFactor(stations: readonly FactoryEntity[]): number {
  if (stations.length === 0) return 1;
  return stations.reduce((factor, station) => {
    const value = typeof station.powerFactor === "number" && Number.isFinite(station.powerFactor) ? station.powerFactor : 1;
    return Math.min(factor, Math.max(0, Math.min(1, value)));
  }, 1);
}

function fleetReturnSeconds(state: GameState, sourceSystemId: StarSystemId, targetSystemId: StarSystemId): number {
  const distance = Math.max(0, getSystemDistanceLy(state, sourceSystemId, targetSystemId));
  // Keep a deterministic floor while reflecting the same distance variable used
  // by legacy interstellar route economics.
  return Math.max(SYSTEM_HUB_FLEET_RETURN_SECONDS, Math.ceil(15 + distance * 2));
}

function ensureSystemHub(state: GameState, systemId: StarSystemId): SystemSpaceStationState {
  const existing = state.systemSpaceStations[systemId];
  if (existing) return existing;
  const created: SystemSpaceStationState = {
    systemId,
    status: "not-started",
    costRevision: 0,
    costMultiplierBasisPoints: 10_000,
    phaseIndex: 0,
    delivered: {},
    constructionBuffer: {},
    inventory: {},
    itemPolicies: {},
    modules: { backbone: 0, energy: 0, interstellar: 0 },
    routingCursors: {},
    viewport: { x: 0, y: 0, zoom: 0.85 },
    decorations: [],
  };
  state.systemSpaceStations[systemId] = created;
  return created;
}

function mergeFleetReturnBucket(state: GameState, routeKey: string, returnAtSecond: number, vesselCount: number): void {
  if (vesselCount < 1) return;
  const existing = state.galacticHubNetwork.fleetReturns.find((bucket) => bucket.routeKey === routeKey && bucket.returnAtSecond === returnAtSecond);
  if (existing) existing.vesselCount = Math.min(Number.MAX_SAFE_INTEGER, existing.vesselCount + vesselCount);
  else state.galacticHubNetwork.fleetReturns.push({ routeKey, returnAtSecond, vesselCount });
  state.galacticHubNetwork.fleetReturns.sort((left, right) => left.returnAtSecond - right.returnAtSecond || left.routeKey.localeCompare(right.routeKey));
}

/**
 * Settles Mk.II elevator stations on a five-second boundary. This mutates the
 * worker-owned GameState, but persists only canonical decimal strings and
 * aggregate fleet return buckets. Legacy stations are intentionally ignored.
 */
export function settleSystemHubLogistics(state: GameState, simulationSecond: number): HubSettlementReport {
  state.systemSpaceStations ??= {};
  state.galacticHubNetwork ??= { fleetInstalled: 0, fleetBusy: 0, fleetReturns: [], warpers: "0", warperTarget: "0", routingCursors: {} };
  const report: HubSettlementReport = {
    simulationSecond: Math.max(0, Math.floor(simulationSecond)),
    systemsSettled: 0,
    localUploads: 0,
    localDownloads: 0,
    crossSystemMoved: "0",
    vesselsDispatched: 0,
    vesselsReleased: 0,
    activeItems: 0,
    skippedBecauseNoFleet: false,
  };
  const released = releaseExpiredFleetBuckets(state.galacticHubNetwork.fleetReturns, report.simulationSecond);
  state.galacticHubNetwork.fleetReturns = released.buckets;
  state.galacticHubNetwork.fleetBusy = Math.max(0, safeCount(state.galacticHubNetwork.fleetBusy) - released.releasedVessels);
  report.vesselsReleased = released.releasedVessels;

  const stationsBySystem = new Map<StarSystemId, FactoryEntity[]>();
  for (const station of state.entities) {
    const systemId = stationSystemId(station);
    if (!systemId || !isOperationalStation(state, station)) continue;
    const stations = stationsBySystem.get(systemId);
    if (stations) stations.push(station);
    else stationsBySystem.set(systemId, [station]);
  }
  for (const [systemId, stations] of stationsBySystem) {
    const hub = ensureSystemHub(state, systemId);
    report.systemsSettled += 1;
    stations.sort((left, right) => left.id.localeCompare(right.id));
    const powerFactor = stationPowerFactor(stations);
    const activeItems = new Set<ItemId>();
    for (const station of stations) {
      for (const [rawItemId, rawAmount] of Object.entries(station.inputs)) {
        const amount = safeAmount(rawAmount);
        if (amount < 1) continue;
        const accepted = Math.floor(amount * powerFactor);
        if (accepted < 1) continue;
        const itemId = rawItemId as ItemId;
        hub.inventory[itemId] = addHubInteger(hub.inventory[itemId] ?? "0", accepted);
        station.inputs[itemId] = amount - accepted;
        report.localUploads += accepted;
        activeItems.add(itemId);
      }
    }
    const outputRequests = new Map<ItemId, Array<{ key: string; amount: DecimalIntegerString; station: FactoryEntity; portIndex: number }>>();
    for (const station of stations) {
      const capacity = stackedOutputCapacity(state, station);
      const assigned = station.elevatorOutputItems ?? [];
      const seen = new Set<ItemId>();
      assigned.slice(0, 5).forEach((itemId, portIndex) => {
        if (!itemId || seen.has(itemId)) return;
        seen.add(itemId);
        const free = Math.max(0, capacity - safeAmount(station.outputs[itemId]));
        if (free < 1) return;
        const requests = outputRequests.get(itemId);
        const request = { key: `${station.id}:${portIndex}`, amount: String(free), station, portIndex };
        if (requests) requests.push(request);
        else outputRequests.set(itemId, [request]);
        activeItems.add(itemId);
      });
    }
    for (const [itemId, requests] of [...outputRequests.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const localThroughput = String(Math.min(Number.MAX_SAFE_INTEGER,
        Math.floor(SYSTEM_HUB_BASE_INTERSTELLAR_THROUGHPUT * Math.max(1, safeCount(hub.modules.backbone) + 1) * powerFactor)));
      const allocation = allocateHubBudget(minHubInteger(hub.inventory[itemId] ?? "0", localThroughput), requests, hub.routingCursors[itemId] ?? 0);
      hub.routingCursors[itemId] = allocation.nextCursor;
      for (const request of requests) {
        const moved = safeAmount(Number(allocation.allocations[request.key] ?? "0"));
        if (moved < 1) continue;
        request.station.outputs[itemId] = safeAmount(request.station.outputs[itemId]) + moved;
        hub.inventory[itemId] = subtractHubInteger(hub.inventory[itemId] ?? "0", moved);
        report.localDownloads += moved;
      }
    }
    report.activeItems += activeItems.size;
  }

  const installedFromElevatorStations = [...stationsBySystem.values()].reduce((sum, stations) =>
    sum + stations.reduce((stationSum, station) => stationSum + safeAmount(station.stationVessels), 0), 0);
  if (installedFromElevatorStations > 0) {
    state.galacticHubNetwork.fleetInstalled = Math.min(Number.MAX_SAFE_INTEGER, installedFromElevatorStations);
    state.galacticHubNetwork.fleetBusy = Math.min(state.galacticHubNetwork.fleetBusy, state.galacticHubNetwork.fleetInstalled);
  }

  const operationalHubs = [...stationsBySystem.keys()].sort()
    .map((systemId) => ({ systemId, hub: ensureSystemHub(state, systemId) }))
    .filter(({ hub }) => hub.status === "operational");
  if (operationalHubs.length < 2 || !state.research.completedTechIds.includes("unified_system_logistics_protocol")) {
    return report;
  }
  const network = state.galacticHubNetwork;
  const installed = safeCount(network.fleetInstalled);
  const busy = safeCount(network.fleetBusy);
  const freeVessels = Math.max(0, installed - busy);
  const moduleCount = operationalHubs.reduce((sum, { hub }) => sum + safeCount(hub.modules.interstellar), 0);
  const networkPowerFactor = operationalHubs.reduce((factor, { systemId }) => {
    const stations = stationsBySystem.get(systemId) ?? [];
    return Math.min(factor, stationPowerFactor(stations));
  }, 1);
  const throughput = Math.floor(Math.min(
    SYSTEM_HUB_BASE_INTERSTELLAR_THROUGHPUT * Math.max(1, moduleCount + 1),
    freeVessels * SYSTEM_HUB_CARGO_PER_VESSEL,
    Math.floor(Number(normalizeHubInteger(network.warpers)) / 2) * SYSTEM_HUB_CARGO_PER_VESSEL,
  ) * networkPowerFactor);
  if (throughput < 1) {
    report.skippedBecauseNoFleet = true;
    return report;
  }
  const itemIds = new Set<ItemId>();
  for (const { hub } of operationalHubs) for (const itemId of Object.keys(hub.itemPolicies)) itemIds.add(itemId as ItemId);
  for (const itemId of [...itemIds].sort()) {
    const sources = operationalHubs.flatMap(({ systemId, hub }) => {
      const policy = hub.itemPolicies[itemId];
      if (!policy?.interstellarEnabled) return [];
      const available = compareHubInteger(hub.inventory[itemId] ?? "0", policy.reserve) > 0
        ? subtractHubInteger(hub.inventory[itemId] ?? "0", policy.reserve)
        : "0";
      return compareHubInteger(available, "0") > 0 ? [{ key: `${systemId}:source`, systemId, hub, amount: available }] : [];
    });
    const targets = operationalHubs.flatMap(({ systemId, hub }) => {
      const policy = hub.itemPolicies[itemId];
      if (!policy?.interstellarEnabled || compareHubInteger(policy.target, hub.inventory[itemId] ?? "0") <= 0) return [];
      const deficit = subtractHubInteger(policy.target, hub.inventory[itemId] ?? "0");
      return compareHubInteger(deficit, "0") > 0 ? [{ key: `${systemId}:target`, systemId, hub, amount: deficit }] : [];
    });
    if (!sources.length || !targets.length) continue;
    const sourceBudget = allocateHubBudget(String(throughput), sources.map(({ key, amount }) => ({ key, amount })), 0);
    const targetBudget = allocateHubBudget(String(throughput), targets.map(({ key, amount }) => ({ key, amount })), 0);
    const sourceRemaining = new Map(sources.map((entry) => [entry.key, BigInt(sourceBudget.allocations[entry.key] ?? "0")]));
    const targetRemaining = new Map(targets.map((entry) => [entry.key, BigInt(targetBudget.allocations[entry.key] ?? "0")]));
    let sourceIndex = 0;
    let targetIndex = 0;
    while (sourceIndex < sources.length && targetIndex < targets.length) {
      const source = sources[sourceIndex];
      const target = targets[targetIndex];
      if (source.systemId === target.systemId) {
        const alternative = targets.findIndex((candidate, candidateIndex) => candidateIndex >= targetIndex &&
          candidate.systemId !== source.systemId && (targetRemaining.get(candidate.key) ?? 0n) > 0n);
        if (alternative >= 0) targetIndex = alternative;
        else {
          sourceIndex += 1;
          targetIndex = 0;
        }
        continue;
      }
      const moved = (sourceRemaining.get(source.key) ?? 0n) < (targetRemaining.get(target.key) ?? 0n)
        ? (sourceRemaining.get(source.key) ?? 0n)
        : (targetRemaining.get(target.key) ?? 0n);
      if (moved <= 0n) {
        if ((sourceRemaining.get(source.key) ?? 0n) <= 0n) sourceIndex += 1;
        if ((targetRemaining.get(target.key) ?? 0n) <= 0n) targetIndex += 1;
        continue;
      }
      const movedString = moved.toString();
      source.hub.inventory[itemId] = subtractHubInteger(source.hub.inventory[itemId] ?? "0", movedString);
      target.hub.inventory[itemId] = addHubInteger(target.hub.inventory[itemId] ?? "0", movedString);
      sourceRemaining.set(source.key, (sourceRemaining.get(source.key) ?? 0n) - moved);
      targetRemaining.set(target.key, (targetRemaining.get(target.key) ?? 0n) - moved);
      report.crossSystemMoved = addHubInteger(report.crossSystemMoved, movedString);
      const movedNumber = Math.min(Number.MAX_SAFE_INTEGER, Number(moved));
      const vessels = Math.max(1, Math.ceil(movedNumber / SYSTEM_HUB_CARGO_PER_VESSEL));
      network.fleetBusy = Math.min(Number.MAX_SAFE_INTEGER, safeCount(network.fleetBusy) + vessels);
      network.warpers = subtractHubInteger(network.warpers, vessels * 2);
      report.vesselsDispatched += vessels;
       mergeFleetReturnBucket(state, `${source.systemId}->${target.systemId}:${itemId}`, report.simulationSecond + fleetReturnSeconds(state, source.systemId, target.systemId), vessels);
      if ((sourceRemaining.get(source.key) ?? 0n) <= 0n) sourceIndex += 1;
      if ((targetRemaining.get(target.key) ?? 0n) <= 0n) targetIndex += 1;
    }
  }
  return report;
}
