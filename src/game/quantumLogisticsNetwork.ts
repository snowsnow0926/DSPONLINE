import type {
  DecimalIntegerString,
  FactoryEntity,
  GameState,
  ItemId,
  QuantumBridgeContract,
  QuantumLogisticsNetworkState,
  QuantumStationMode,
  QuantumStationTransition,
  StationRoute,
} from "./types";

/** A quantum settlement is intentionally quantized in persistent simulation time. */
export const QUANTUM_SETTLEMENT_SECONDS = 5;
export const QUANTUM_UNIT_CAP_PER_MINUTE = 5_000;
export const QUANTUM_MAX_INTEGER_DIGITS = 256;
export const QUANTUM_DEFAULT_LEVEL = 0;
export const QUANTUM_ITEM_CAPACITY_MIN = "10000" as DecimalIntegerString;
export const QUANTUM_ITEM_CAPACITY_MAX = "10000000000" as DecimalIntegerString;
export const QUANTUM_ITEM_CAPACITY_DEFAULT = QUANTUM_ITEM_CAPACITY_MAX;
export const QUANTUM_ITEM_CAPACITY_PRESETS = [
  "10000",
  "100000",
  "1000000",
  "10000000",
  "100000000",
  "1000000000",
  "10000000000",
] as const satisfies readonly DecimalIntegerString[];

function decimal(value: bigint): DecimalIntegerString {
  if (value <= 0n) return "0";
  const normalized = value.toString();
  return normalized.length <= QUANTUM_MAX_INTEGER_DIGITS
    ? normalized
    : "9".repeat(QUANTUM_MAX_INTEGER_DIGITS);
}

/**
 * Normalize persisted quantities without accepting signs, fractions,
 * exponent notation, NaN, Infinity, or values that would make JSON unsafe.
 */
export function normalizeQuantumInteger(value: unknown, fallback: DecimalIntegerString = "0"): DecimalIntegerString {
  if (typeof value === "bigint") return value >= 0n && value.toString().length <= QUANTUM_MAX_INTEGER_DIGITS ? value.toString() : fallback;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  const normalized = value.replace(/^0+(?=\d)/, "");
  return normalized.length <= QUANTUM_MAX_INTEGER_DIGITS ? normalized : fallback;
}

export function isValidQuantumItemCapacity(value: unknown): boolean {
  const normalized = normalizeQuantumInteger(value, "0");
  if (normalized === "0") return false;
  const amount = BigInt(normalized);
  return amount >= BigInt(QUANTUM_ITEM_CAPACITY_MIN) && amount <= BigInt(QUANTUM_ITEM_CAPACITY_MAX);
}

export function normalizeQuantumItemCapacity(
  value: unknown,
  fallback: DecimalIntegerString = QUANTUM_ITEM_CAPACITY_DEFAULT,
): DecimalIntegerString {
  const normalized = normalizeQuantumInteger(value, fallback);
  const amount = BigInt(normalized);
  if (amount < BigInt(QUANTUM_ITEM_CAPACITY_MIN)) return QUANTUM_ITEM_CAPACITY_MIN;
  if (amount > BigInt(QUANTUM_ITEM_CAPACITY_MAX)) return QUANTUM_ITEM_CAPACITY_MAX;
  return decimal(amount);
}

export function getQuantumItemCapacity(
  network: Pick<QuantumLogisticsNetworkState, "itemCapacities">,
  itemId: ItemId,
): DecimalIntegerString {
  const configured = network.itemCapacities[itemId];
  return configured === undefined
    ? QUANTUM_ITEM_CAPACITY_DEFAULT
    : normalizeQuantumItemCapacity(configured);
}

export function setQuantumNetworkItemCapacity(
  network: QuantumLogisticsNetworkState,
  itemId: ItemId,
  value: unknown,
): QuantumLogisticsNetworkState {
  if (!isValidQuantumItemCapacity(value)) return network;
  const capacity = normalizeQuantumItemCapacity(value);
  if (getQuantumItemCapacity(network, itemId) === capacity && network.itemCapacities[itemId] === capacity) return network;
  return {
    ...network,
    itemCapacities: { ...network.itemCapacities, [itemId]: capacity },
  };
}

function integer(value: unknown): bigint {
  return BigInt(normalizeQuantumInteger(value));
}

export function compareQuantumInteger(left: unknown, right: unknown): -1 | 0 | 1 {
  const a = integer(left);
  const b = integer(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addQuantumInteger(left: unknown, right: unknown): DecimalIntegerString {
  return decimal(integer(left) + integer(right));
}

export function subtractQuantumInteger(left: unknown, right: unknown): DecimalIntegerString {
  const result = integer(left) - integer(right);
  return decimal(result > 0n ? result : 0n);
}

export function minQuantumInteger(...values: unknown[]): DecimalIntegerString {
  if (values.length === 0) return "0";
  return decimal(values.map(integer).reduce((min, value) => value < min ? value : min));
}

export interface QuantumInventoryDepositResult {
  accepted: DecimalIntegerString;
  remainder: DecimalIntegerString;
  state: QuantumLogisticsNetworkState;
}

/**
 * Put material into the shared inventory without applying the five-second
 * upload budget. This is used at the moment a quantum supply endpoint actually
 * receives material; the regular boundary settlement remains responsible for
 * any material still sitting in a local tower buffer.
 */
export function depositIntoQuantumInventory(
  network: QuantumLogisticsNetworkState,
  itemId: ItemId,
  amount: DecimalIntegerString | number,
): QuantumInventoryDepositResult {
  const runtimeFlow = network.runtimeFlow;
  const state = normalizeQuantumLogisticsNetworkState(network);
  if (runtimeFlow) state.runtimeFlow = runtimeFlow;
  const requested = integer(amount);
  if (!state.enabled || requested <= 0n) {
    return { accepted: "0", remainder: decimal(requested), state };
  }
  const current = integer(state.inventory[itemId]);
  const capacity = integer(getQuantumItemCapacity(state, itemId));
  const free = capacity > current ? capacity - current : 0n;
  const accepted = requested < free ? requested : free;
  if (accepted > 0n) state.inventory[itemId] = decimal(current + accepted);
  return {
    accepted: decimal(accepted),
    remainder: decimal(requested - accepted),
    state,
  };
}

export interface QuantumBandwidth {
  mode: QuantumStationMode;
  powerFactor: number;
  multiplier: number;
  uploadPerMinute: number;
  downloadPerMinute: number;
  uploadPerBoundary: number;
  downloadPerBoundary: number;
}

/**
 * Galactic logistics uses both speed and payload improvements. The square is
 * kept in one place so UI, simulation and diagnostics cannot drift apart.
 */
export function getQuantumLogisticsMultiplier(level: number): number {
  const normalizedLevel = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : QUANTUM_DEFAULT_LEVEL;
  const base = 1 + 0.05 * normalizedLevel;
  return base * base;
}

export function getQuantumTowerBandwidth(
  entity: Pick<FactoryEntity, "buildingId" | "machineCount" | "quantumMode">,
  level: number,
  powerFactor = 1,
): QuantumBandwidth {
  const mode = entity.quantumMode ?? "legacy";
  // Kept in the signature for source compatibility. Quantum bandwidth is a
  // save-wide infrastructure contract and is no longer divided per tower.
  void powerFactor;
  const multiplier = getQuantumLogisticsMultiplier(level);
  const active = entity.buildingId === "interstellar_logistics_station" && mode === "quantum";
  const count = active && Number.isFinite(entity.machineCount) ? Math.max(0, Math.floor(entity.machineCount)) : 0;
  const uploadPerMinute = QUANTUM_UNIT_CAP_PER_MINUTE * multiplier * count;
  const boundaryFactor = QUANTUM_SETTLEMENT_SECONDS / 60;
  return {
    mode,
    powerFactor: active ? 1 : 0,
    multiplier,
    uploadPerMinute,
    downloadPerMinute: uploadPerMinute,
    uploadPerBoundary: Math.max(0, Math.floor(uploadPerMinute * boundaryFactor)),
    downloadPerBoundary: Math.max(0, Math.floor(uploadPerMinute * boundaryFactor)),
  };
}

export interface QuantumBandwidthSummary {
  multiplier: number;
  globalUploadPerMinute: number;
  globalDownloadPerMinute: number;
  activeTowerCount: number;
  activeTowerStacks: number;
}

export function getQuantumBandwidthSummary(
  entities: readonly (Pick<FactoryEntity, "buildingId" | "machineCount" | "quantumMode"> & { id?: string })[],
  level: number,
  powerFactors: Readonly<Record<string, number>> = {},
): QuantumBandwidthSummary {
  let globalUploadPerMinute = 0;
  let activeTowerCount = 0;
  let activeTowerStacks = 0;
  void powerFactors;
  for (const [index, entity] of entities.entries()) {
    void index;
    const bandwidth = getQuantumTowerBandwidth(entity, level);
    if (bandwidth.mode === "quantum" && bandwidth.uploadPerMinute > 0) activeTowerCount += 1;
    if (entity.buildingId === "interstellar_logistics_station" && entity.quantumMode === "quantum") {
      activeTowerStacks += Math.max(0, Math.floor(entity.machineCount));
    }
    globalUploadPerMinute += bandwidth.uploadPerMinute;
  }
  return {
    multiplier: getQuantumLogisticsMultiplier(level),
    globalUploadPerMinute,
    globalDownloadPerMinute: globalUploadPerMinute,
    activeTowerCount,
    activeTowerStacks,
  };
}

export function createEmptyQuantumLogisticsNetworkState(): QuantumLogisticsNetworkState {
  return {
    enabled: false,
    inventory: {},
    itemCapacities: {},
    routingCursors: {} as Record<ItemId, number>,
    uploadRoutingCursors: {} as Record<ItemId, number>,
  };
}

export function normalizeQuantumLogisticsNetworkState(value: unknown): QuantumLogisticsNetworkState {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const inventory: Partial<Record<ItemId, DecimalIntegerString>> = {};
  if (raw.inventory && typeof raw.inventory === "object" && !Array.isArray(raw.inventory)) {
    for (const [itemId, amount] of Object.entries(raw.inventory)) {
      const normalized = normalizeQuantumInteger(amount);
      if (normalized !== "0") inventory[itemId as ItemId] = normalized;
    }
  }
  const itemCapacities: Partial<Record<ItemId, DecimalIntegerString>> = {};
  if (raw.itemCapacities && typeof raw.itemCapacities === "object" && !Array.isArray(raw.itemCapacities)) {
    for (const [itemId, amount] of Object.entries(raw.itemCapacities)) {
      itemCapacities[itemId as ItemId] = normalizeQuantumItemCapacity(amount);
    }
  }
  const routingCursors = {} as Record<ItemId, number>;
  if (raw.routingCursors && typeof raw.routingCursors === "object" && !Array.isArray(raw.routingCursors)) {
    for (const [itemId, cursor] of Object.entries(raw.routingCursors)) {
      if (typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0) {
        routingCursors[itemId as ItemId] = cursor;
      }
    }
  }
  const uploadRoutingCursors = {} as Record<ItemId, number>;
  if (raw.uploadRoutingCursors && typeof raw.uploadRoutingCursors === "object" && !Array.isArray(raw.uploadRoutingCursors)) {
    for (const [itemId, cursor] of Object.entries(raw.uploadRoutingCursors)) {
      if (typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0) {
        uploadRoutingCursors[itemId as ItemId] = cursor;
      }
    }
  }
  return { enabled: raw.enabled === true, inventory, itemCapacities, routingCursors, uploadRoutingCursors };
}

export interface QuantumSettlementInput {
  key: string;
  stationId: string;
  itemId: ItemId;
  requested: DecimalIntegerString | number;
  /** Higher priority inputs are accepted first when one tower has many lines. */
  priority?: number;
}

export interface QuantumSettlementOutput extends QuantumSettlementInput {
  /** Downstream capacity for this line during the boundary. */
  capacity: DecimalIntegerString | number;
}

export interface QuantumSettlementOptions {
  seconds?: number;
  globalUploadCap?: DecimalIntegerString | number;
  globalDownloadCap?: DecimalIntegerString | number;
  /** Engine-only fast path for a state already normalized at load/session creation. */
  mutateNormalizedState?: boolean;
}

export interface QuantumSettlementDiagnostics {
  requestedInput: DecimalIntegerString;
  acceptedInput: DecimalIntegerString;
  requestedOutput: DecimalIntegerString;
  deliveredOutput: DecimalIntegerString;
  blockedByUploadBandwidth: DecimalIntegerString;
  blockedByDownloadBandwidth: DecimalIntegerString;
  blockedByInventory: DecimalIntegerString;
  blockedByItemCapacity: DecimalIntegerString;
  activeItems: ItemId[];
}

export interface QuantumSettlementResult {
  state: QuantumLogisticsNetworkState;
  inputAccepted: Record<string, DecimalIntegerString>;
  outputDelivered: Record<string, DecimalIntegerString>;
  diagnostics: QuantumSettlementDiagnostics;
}

function safeFloor(value: unknown): bigint {
  const normalized = normalizeQuantumInteger(value);
  return BigInt(normalized);
}

interface NormalizedQuantumRequest {
  key: string;
  stationId: string;
  itemId: ItemId;
  amount: bigint;
  priority: number;
}

interface PreparedQuantumSettlement {
  inputs: NormalizedQuantumRequest[];
  outputs: NormalizedQuantumRequest[];
  inputsByItem: Map<ItemId, NormalizedQuantumRequest[]>;
  outputsByItem: Map<ItemId, NormalizedQuantumRequest[]>;
  requestedInput: bigint;
  requestedOutput: bigint;
  activeItems: ItemId[];
}

function normalizedPriority(priority: number | undefined): number {
  return Number.isFinite(priority) ? Math.floor(priority!) : 1;
}

function normalizeInputRequests(requests: readonly QuantumSettlementInput[]): NormalizedQuantumRequest[] {
  const normalized: NormalizedQuantumRequest[] = [];
  for (const request of requests) {
    if (request.key.length === 0) continue;
    const amount = safeFloor(request.requested);
    if (amount <= 0n) continue;
    normalized.push({
      key: request.key,
      stationId: request.stationId,
      itemId: request.itemId,
      amount,
      priority: normalizedPriority(request.priority),
    });
  }
  return normalized.sort((left, right) => right.priority - left.priority || left.key.localeCompare(right.key));
}

function normalizeOutputRequests(requests: readonly QuantumSettlementOutput[]): NormalizedQuantumRequest[] {
  const normalized: NormalizedQuantumRequest[] = [];
  for (const request of requests) {
    if (request.key.length === 0) continue;
    const requested = safeFloor(request.requested);
    const capacity = safeFloor(request.capacity);
    const amount = capacity < requested ? capacity : requested;
    if (amount <= 0n) continue;
    normalized.push({
      key: request.key,
      stationId: request.stationId,
      itemId: request.itemId,
      amount,
      priority: normalizedPriority(request.priority),
    });
  }
  return normalized.sort((left, right) => right.priority - left.priority || left.key.localeCompare(right.key));
}

function addPreparedRequest<K extends string>(map: Map<K, NormalizedQuantumRequest[]>, key: K, request: NormalizedQuantumRequest): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(request);
  else map.set(key, [request]);
}

/** Normalize, group and establish deterministic order once per boundary. */
function prepareQuantumSettlement(
  inputs: readonly QuantumSettlementInput[],
  outputs: readonly QuantumSettlementOutput[],
): PreparedQuantumSettlement {
  const normalizedInputs = normalizeInputRequests(inputs);
  const normalizedOutputs = normalizeOutputRequests(outputs);
  const inputsByItem = new Map<ItemId, NormalizedQuantumRequest[]>();
  const outputsByItem = new Map<ItemId, NormalizedQuantumRequest[]>();
  let requestedInput = 0n;
  let requestedOutput = 0n;
  for (const request of normalizedInputs) {
    requestedInput += request.amount;
    addPreparedRequest(inputsByItem, request.itemId, request);
  }
  for (const request of normalizedOutputs) {
    requestedOutput += request.amount;
    addPreparedRequest(outputsByItem, request.itemId, request);
  }
  // Item allocation uses key order for deterministic remainder rotation. This
  // is the only secondary order required after the request arrays themselves.
  for (const requestsForItem of outputsByItem.values()) {
    requestsForItem.sort((left, right) => left.key.localeCompare(right.key));
  }
  return {
    inputs: normalizedInputs,
    outputs: normalizedOutputs,
    inputsByItem,
    outputsByItem,
    requestedInput,
    requestedOutput,
    activeItems: [...outputsByItem.keys()].sort(),
  };
}

function allocateProportionally(
  budget: bigint,
  requests: readonly { key: string; amount: bigint }[],
  cursor: number,
): { values: Record<string, bigint>; total: bigint; nextCursor: number } {
  const ordered = requests.filter((request) => request.amount > 0n);
  const values: Record<string, bigint> = {};
  if (ordered.length === 0 || budget <= 0n) return { values, total: 0n, nextCursor: 0 };
  const totalRequested = ordered.reduce((sum, request) => sum + request.amount, 0n);
  const available = budget < totalRequested ? budget : totalRequested;
  let allocated = 0n;
  for (const request of ordered) {
    const amount = available * request.amount / totalRequested;
    values[request.key] = amount;
    allocated += amount;
  }
  let remainder = available - allocated;
  const normalizedCursor = ((Number.isSafeInteger(cursor) ? cursor : 0) % ordered.length + ordered.length) % ordered.length;
  let offset = 0;
  while (remainder > 0n && offset < ordered.length * 2) {
    const request = ordered[(normalizedCursor + offset) % ordered.length];
    const current = values[request.key] ?? 0n;
    if (current < request.amount) {
      values[request.key] = current + 1n;
      remainder -= 1n;
    }
    offset += 1;
  }
  const distributed = available - remainder;
  return {
    values,
    total: distributed,
    nextCursor: (normalizedCursor + Number(distributed % BigInt(ordered.length))) % ordered.length,
  };
}

function allocateWithPriority(
  budget: bigint,
  requests: readonly { key: string; amount: bigint; priority?: number }[],
  cursor: number,
): { values: Record<string, bigint>; total: bigint; nextCursor: number } {
  const values: Record<string, bigint> = {};
  let remaining = budget > 0n ? budget : 0n;
  let total = 0n;
  let nextCursor = cursor;
  const requestsByPriority = new Map<number, Array<{ key: string; amount: bigint }>>();
  for (const request of requests) {
    const priority = normalizedPriority(request.priority);
    const group = requestsByPriority.get(priority);
    if (group) group.push(request);
    else requestsByPriority.set(priority, [request]);
  }
  const priorities = [...requestsByPriority.keys()].sort((left, right) => right - left);
  for (const priority of priorities) {
    if (remaining <= 0n) break;
    const group = requestsByPriority.get(priority)!;
    const allocation = allocateProportionally(remaining, group, nextCursor);
    Object.assign(values, allocation.values);
    total += allocation.total;
    remaining -= allocation.total;
    nextCursor = allocation.nextCursor;
  }
  return { values, total, nextCursor };
}

function requestBudget(value: unknown, fallback: bigint): bigint {
  if (value === undefined) return fallback;
  return safeFloor(value);
}

function allocateInputs(
  state: QuantumLogisticsNetworkState,
  prepared: PreparedQuantumSettlement,
  cap: DecimalIntegerString | number | undefined,
): { values: Record<string, bigint>; accepted: bigint; blockedBandwidth: bigint; blockedCapacity: bigint } {
  const capacityFeasible: Record<string, bigint> = {};
  let feasibleTotal = 0n;
  let blockedCapacity = 0n;
  for (const [itemId, itemRequests] of prepared.inputsByItem) {
    const current = integer(state.inventory[itemId]);
    const capacity = integer(getQuantumItemCapacity(state, itemId));
    const free = capacity > current ? capacity - current : 0n;
    const requested = itemRequests.reduce((sum, request) => sum + request.amount, 0n);
    const allocation = allocateWithPriority(free, itemRequests, state.uploadRoutingCursors[itemId] ?? 0);
    Object.assign(capacityFeasible, allocation.values);
    feasibleTotal += allocation.total;
    blockedCapacity += requested - allocation.total;
  }
  const global = allocateWithPriority(
    requestBudget(cap, feasibleTotal),
    prepared.inputs.map((request) => ({ ...request, amount: capacityFeasible[request.key] ?? 0n })),
    0,
  );
  for (const [itemId, itemRequests] of prepared.inputsByItem) {
    const acceptedForItem = itemRequests.reduce((sum, request) => sum + (global.values[request.key] ?? 0n), 0n);
    const requestedForItem = itemRequests.reduce((sum, request) => sum + request.amount, 0n);
    if (acceptedForItem < requestedForItem && itemRequests.length > 1) {
      state.uploadRoutingCursors[itemId] = (state.uploadRoutingCursors[itemId] ?? 0) + 1;
    }
    if (acceptedForItem > 0n) state.inventory[itemId] = decimal(integer(state.inventory[itemId]) + acceptedForItem);
  }
  return {
    values: global.values,
    accepted: global.total,
    blockedBandwidth: feasibleTotal > global.total ? feasibleTotal - global.total : 0n,
    blockedCapacity,
  };
}

function allocateOutputs(
  state: QuantumLogisticsNetworkState,
  prepared: PreparedQuantumSettlement,
  cap: DecimalIntegerString | number | undefined,
): { values: Record<string, bigint>; delivered: bigint; requested: bigint; blockedBandwidth: bigint; blockedInventory: bigint; activeItems: ItemId[] } {
  const values: Record<string, bigint> = {};
  let delivered = 0n;
  const requested = prepared.requestedOutput;
  let blockedBandwidth = 0n;
  let blockedInventory = 0n;
  const globalAllocation = allocateWithPriority(requestBudget(cap, requested), prepared.outputs, 0);
  blockedBandwidth = requested > globalAllocation.total ? requested - globalAllocation.total : 0n;
  for (const [itemId, itemRequests] of prepared.outputsByItem) {
    const available = integer(state.inventory[itemId]);
    const planned = itemRequests.reduce((sum, request) => sum + (globalAllocation.values[request.key] ?? 0n), 0n);
    const itemBudget = available < planned ? available : planned;
    const allocation = allocateProportionally(
      itemBudget,
      itemRequests.map((request) => ({ key: request.key, amount: globalAllocation.values[request.key] ?? 0n })),
      state.routingCursors[itemId] ?? 0,
    );
    for (const request of itemRequests) values[request.key] = allocation.values[request.key] ?? 0n;
    delivered += allocation.total;
    state.inventory[itemId] = decimal(available - allocation.total);
    if (allocation.total < planned && itemRequests.length > 0) state.routingCursors[itemId] = (state.routingCursors[itemId] ?? 0) + 1;
    blockedInventory += planned > allocation.total ? planned - allocation.total : 0n;
  }
  return { values, delivered, requested, blockedBandwidth, blockedInventory, activeItems: prepared.activeItems };
}

/**
 * Settle one deterministic quantum boundary. Downloads are committed first so
 * their released item capacity can accept uploads in the same boundary.
 * The function is pure with respect to its argument and performs no loops
 * proportional to item quantity.
 */
export function settleQuantumLogisticsNetwork(
  network: QuantumLogisticsNetworkState,
  inputs: readonly QuantumSettlementInput[],
  outputs: readonly QuantumSettlementOutput[],
  options: QuantumSettlementOptions = {},
): QuantumSettlementResult {
  const state = options.mutateNormalizedState ? network : normalizeQuantumLogisticsNetworkState(network);
  if (!state.enabled) {
    return {
      state,
      inputAccepted: {},
      outputDelivered: {},
      diagnostics: {
        requestedInput: "0", acceptedInput: "0", requestedOutput: "0", deliveredOutput: "0",
        blockedByUploadBandwidth: "0", blockedByDownloadBandwidth: "0", blockedByInventory: "0",
        blockedByItemCapacity: "0", activeItems: [],
      },
    };
  }
  const seconds = Math.max(1, Math.floor(options.seconds ?? QUANTUM_SETTLEMENT_SECONDS));
  void seconds; // The caller supplies per-boundary caps; keeping seconds explicit documents the contract.
  const prepared = prepareQuantumSettlement(inputs, outputs);
  const outputResult = allocateOutputs(state, prepared, options.globalDownloadCap);
  const outputDelivered: Record<string, DecimalIntegerString> = {};
  for (const [key, amount] of Object.entries(outputResult.values)) outputDelivered[key] = decimal(amount);
  const inputAccepted: Record<string, DecimalIntegerString> = {};
  const inputResult = allocateInputs(state, prepared, options.globalUploadCap);
  const requestedInput = prepared.requestedInput;
  for (const request of prepared.inputs) {
    const accepted = inputResult.values[request.key] ?? 0n;
    inputAccepted[request.key] = decimal(accepted);
  }
  const requestedOutput = outputResult.requested;
  return {
    state,
    inputAccepted,
    outputDelivered,
    diagnostics: {
      requestedInput: decimal(requestedInput),
      acceptedInput: decimal(inputResult.accepted),
      requestedOutput: decimal(requestedOutput),
      deliveredOutput: decimal(outputResult.delivered),
      blockedByUploadBandwidth: decimal(inputResult.blockedBandwidth),
      blockedByDownloadBandwidth: decimal(outputResult.blockedBandwidth),
      blockedByInventory: decimal(outputResult.blockedInventory),
      blockedByItemCapacity: decimal(inputResult.blockedCapacity),
      activeItems: outputResult.activeItems,
    },
  };
}

export interface QuantumAttachmentResult {
  state: GameState;
  changed: boolean;
  reason?: "missing-station" | "not-upgraded" | "already-quantum" | "already-legacy" | "transition-active";
}

function isInterstellarTower(entity: FactoryEntity | undefined): entity is FactoryEntity {
  return Boolean(entity?.kind === "station" && entity.buildingId === "interstellar_logistics_station");
}

function isOrbitalCollector(entity: FactoryEntity | undefined): entity is FactoryEntity {
  return Boolean(entity?.kind === "station" && entity.buildingId === "orbital_collector");
}

function cloneNetwork(network: QuantumLogisticsNetworkState): QuantumLogisticsNetworkState {
  return {
    enabled: network.enabled,
    inventory: { ...network.inventory },
    itemCapacities: { ...network.itemCapacities },
    routingCursors: { ...network.routingCursors },
    uploadRoutingCursors: { ...network.uploadRoutingCursors },
    ...(network.runtimeFlow ? {
      runtimeFlow: {
        ...network.runtimeFlow,
        uploaded: { ...network.runtimeFlow.uploaded },
        downloaded: { ...network.runtimeFlow.downloaded },
      },
    } : {}),
  };
}

interface GlobalStationRoute {
  demand: FactoryEntity;
  route: StationRoute;
}

interface GlobalStationRouteLedger {
  entityById: Map<string, FactoryEntity>;
  routesByStationId: Map<string, GlobalStationRoute[]>;
}

/**
 * Legacy interstellar routes are persisted on their demand station, while
 * the installed vessels may belong to either endpoint. Attachment therefore
 * uses the global route ledger instead of assuming the tower owns the route
 * array. Local drone routes deliberately stay outside this ledger: quantum
 * mode replaces only interstellar transport.
 */
function buildGlobalStationRouteLedger(state: GameState): GlobalStationRouteLedger {
  const entityById = new Map<string, FactoryEntity>();
  const routesByStationId = new Map<string, GlobalStationRoute[]>();
  const add = (stationId: string, value: GlobalStationRoute) => {
    const routes = routesByStationId.get(stationId);
    if (routes) routes.push(value);
    else routesByStationId.set(stationId, [value]);
  };
  for (const demand of state.entities) {
    entityById.set(demand.id, demand);
    for (const route of demand.stationRoutes ?? []) {
      if (route.scope !== "remote") continue;
      const value = { demand, route };
      const relatedStationIds = new Set([
        demand.id,
        route.peerId,
        route.vehicleStationId ?? demand.id,
        ...(route.waypointStationIds ?? []),
      ]);
      for (const stationId of relatedStationIds) add(stationId, value);
    }
  }
  return { entityById, routesByStationId };
}

function createQuantumBridge(stationId: string, demand: FactoryEntity, route: StationRoute, now = 0): QuantumBridgeContract {
  const progress = Math.max(0, Math.min(1, Number.isFinite(route.progress) ? route.progress : 0));
  return {
    id: `quantum_bridge_${stationId}_${route.id}`,
    itemId: route.itemId,
    // peerId is the supply endpoint; the containing entity is the demand.
    sourceStationId: route.peerId,
    targetStationId: demand.id,
    cargo: normalizeQuantumInteger(route.cargo),
    remainingCargo: normalizeQuantumInteger(route.cargo),
    arriveAtSecond: now + Math.max(1, route.duration * (1 - progress)),
  };
}

function bridgeMatchesRoute(stationId: string, bridge: QuantumBridgeContract, route: StationRoute): boolean {
  return bridge.id === `quantum_bridge_${route.id}` ||
    bridge.id === `quantum_bridge_${stationId}_${route.id}`;
}

/**
 * Keep transition metadata tied to the authoritative route ledger. A route is
 * reserved in full until normal route settlement removes it; then its bridge
 * is reduced to zero instead of blocking attachment indefinitely.
 */
function synchronizeQuantumBridges(
  state: GameState,
  stationId: string,
  transition: QuantumStationTransition,
  activeRoutes: readonly GlobalStationRoute[],
): { bridges: QuantumBridgeContract[]; activeRoutes: GlobalStationRoute[]; changed: boolean } {
  const activeByBridgeId = new Map<string, GlobalStationRoute>();
  for (const active of activeRoutes) {
    activeByBridgeId.set(`quantum_bridge_${active.route.id}`, active);
    activeByBridgeId.set(`quantum_bridge_${stationId}_${active.route.id}`, active);
  }
  const used = new Set<string>();
  let changed = false;
  const bridges: QuantumBridgeContract[] = [];
  for (const bridge of transition.bridges) {
    const candidate = activeByBridgeId.get(bridge.id);
    const match = candidate && !used.has(candidate.route.id) && bridgeMatchesRoute(stationId, bridge, candidate.route)
      ? candidate
      : undefined;
    if (!match) {
      if (bridge.remainingCargo !== "0") changed = true;
      bridges.push({ ...bridge, remainingCargo: "0" });
      continue;
    }
    used.add(match.route.id);
    const cargo = normalizeQuantumInteger(match.route.cargo);
    const nextBridge = {
      ...bridge,
      itemId: match.route.itemId,
      sourceStationId: match.route.peerId,
      targetStationId: match.demand.id,
      cargo,
      remainingCargo: cargo,
      arriveAtSecond: state.elapsedSeconds + Math.max(1, match.route.duration * (1 - Math.max(0, Math.min(1, match.route.progress)))),
    };
    if (JSON.stringify(nextBridge) !== JSON.stringify(bridge)) changed = true;
    bridges.push(nextBridge);
  }
  for (const active of activeRoutes) {
    if (used.has(active.route.id)) continue;
    bridges.push(createQuantumBridge(stationId, active.demand, active.route, state.elapsedSeconds));
    changed = true;
  }
  return { bridges, activeRoutes: [...activeRoutes], changed };
}

export interface QuantumAttachmentBatchEntry {
  stationId: string;
  changed: boolean;
  reason?: QuantumAttachmentResult["reason"];
}

export interface QuantumAttachmentStartBatchResult {
  state: GameState;
  entries: QuantumAttachmentBatchEntry[];
  startedIds: string[];
}

/** Start multiple handoffs from one entity/route scan and one entity update. */
export function beginQuantumAttachments(
  state: GameState,
  stationIds: readonly string[],
): QuantumAttachmentStartBatchResult {
  const orderedIds = [...new Set(stationIds)].sort((left, right) => left.localeCompare(right));
  if (orderedIds.length === 0) return { state, entries: [], startedIds: [] };
  const ledger = buildGlobalStationRouteLedger(state);
  const transitions = new Map<string, QuantumStationTransition>();
  const entries: QuantumAttachmentBatchEntry[] = [];
  const startedIds: string[] = [];
  for (const stationId of orderedIds) {
    const station = ledger.entityById.get(stationId);
    let reason: QuantumAttachmentResult["reason"] | undefined;
    if (!isInterstellarTower(station)) reason = "missing-station";
    else if ((station.stationTier ?? 1) < 2) reason = "not-upgraded";
    else if (station.quantumMode === "quantum") reason = "already-quantum";
    else if (station.quantumTransition) reason = "transition-active";
    if (reason) {
      entries.push({ stationId, changed: false, reason });
      continue;
    }
    const transition: QuantumStationTransition = {
      targetMode: "quantum",
      startedAtSecond: state.elapsedSeconds,
      boundarySecond: (Math.floor(state.elapsedSeconds / QUANTUM_SETTLEMENT_SECONDS) + 1) * QUANTUM_SETTLEMENT_SECONDS,
      bridges: (ledger.routesByStationId.get(stationId) ?? []).map(({ demand, route }) =>
        createQuantumBridge(stationId, demand, route, state.elapsedSeconds)),
    };
    transitions.set(stationId, transition);
    entries.push({ stationId, changed: true });
    startedIds.push(stationId);
  }
  if (transitions.size === 0) return { state, entries, startedIds };
  return {
    state: {
      ...state,
      entities: state.entities.map((entity) => {
        const transition = transitions.get(entity.id);
        return transition ? { ...entity, quantumMode: "transitioning", quantumTransition: transition } : entity;
      }),
    },
    entries,
    startedIds,
  };
}

/** Mark a station for the next five-second handoff without deleting routes. */
export function beginQuantumAttachment(state: GameState, stationId: string): QuantumAttachmentResult {
  const batch = beginQuantumAttachments(state, [stationId]);
  const entry = batch.entries[0];
  return entry?.changed
    ? { state: batch.state, changed: true }
    : { state, changed: false, reason: entry?.reason ?? "missing-station" };
}

/**
 * Orbital collectors are supply-only quantum endpoints. They use the same
 * global route ledger as towers so a route persisted on its demand peer must
 * finish before the collector changes mode.
 */
export function beginOrbitalCollectorQuantumModeChanges(
  state: GameState,
  collectorIds: readonly string[],
  targetMode: "quantum" | "legacy",
): QuantumAttachmentStartBatchResult {
  const orderedIds = [...new Set(collectorIds)].sort((left, right) => left.localeCompare(right));
  if (orderedIds.length === 0) return { state, entries: [], startedIds: [] };
  const ledger = buildGlobalStationRouteLedger(state);
  const transitions = new Map<string, QuantumStationTransition>();
  const entries: QuantumAttachmentBatchEntry[] = [];
  const startedIds: string[] = [];
  for (const collectorId of orderedIds) {
    const collector = ledger.entityById.get(collectorId);
    let reason: QuantumAttachmentResult["reason"] | undefined;
    if (!isOrbitalCollector(collector)) reason = "missing-station";
    else if (collector.quantumTransition) reason = "transition-active";
    else if (targetMode === "quantum" && collector.quantumMode === "quantum") reason = "already-quantum";
    else if (targetMode === "legacy" && collector.quantumMode !== "quantum") reason = "already-legacy";
    if (reason) {
      entries.push({ stationId: collectorId, changed: false, reason });
      continue;
    }
    const transition: QuantumStationTransition = {
      targetMode,
      startedAtSecond: state.elapsedSeconds,
      boundarySecond: (Math.floor(state.elapsedSeconds / QUANTUM_SETTLEMENT_SECONDS) + 1) * QUANTUM_SETTLEMENT_SECONDS,
      bridges: targetMode === "quantum"
        ? (ledger.routesByStationId.get(collectorId) ?? []).map(({ demand, route }) =>
          createQuantumBridge(collectorId, demand, route, state.elapsedSeconds))
        : [],
    };
    transitions.set(collectorId, transition);
    entries.push({ stationId: collectorId, changed: true });
    startedIds.push(collectorId);
  }
  if (transitions.size === 0) return { state, entries, startedIds };
  return {
    state: {
      ...state,
      entities: state.entities.map((entity) => {
        const transition = transitions.get(entity.id);
        return transition ? { ...entity, quantumMode: "transitioning", quantumTransition: transition } : entity;
      }),
    },
    entries,
    startedIds,
  };
}

export function beginOrbitalCollectorQuantumModeChange(
  state: GameState,
  collectorId: string,
  targetMode: "quantum" | "legacy",
): QuantumAttachmentResult {
  const batch = beginOrbitalCollectorQuantumModeChanges(state, [collectorId], targetMode);
  const entry = batch.entries[0];
  return entry?.changed
    ? { state: batch.state, changed: true }
    : { state, changed: false, reason: entry?.reason ?? "missing-station" };
}

export interface QuantumAttachmentSettlementBatchResult {
  state: GameState;
  changed: boolean;
  completedIds: string[];
  pendingIds: string[];
}

/** Settle every selected transition from one global route ledger. */
export function settleQuantumAttachments(
  state: GameState,
  stationIds?: ReadonlySet<string>,
  cancel = false,
): QuantumAttachmentSettlementBatchResult {
  if (!state.entities.some((entity) => entity.quantumTransition && (!stationIds || stationIds.has(entity.id)))) {
    return { state, changed: false, completedIds: [], pendingIds: [] };
  }
  const ledger = buildGlobalStationRouteLedger(state);
  const updates = new Map<string, Pick<FactoryEntity, "quantumMode" | "quantumTransition">>();
  const completedIds: string[] = [];
  const pendingIds: string[] = [];
  let enableNetwork = false;
  for (const station of state.entities) {
    if (!station.quantumTransition || stationIds && !stationIds.has(station.id)) continue;
    const transition = station.quantumTransition;
    const synchronized = synchronizeQuantumBridges(
      state,
      station.id,
      transition,
      ledger.routesByStationId.get(station.id) ?? [],
    );
    if (!cancel && (state.elapsedSeconds < transition.boundarySecond ||
      synchronized.activeRoutes.length > 0 ||
      synchronized.bridges.some((bridge) => compareQuantumInteger(bridge.remainingCargo, "0") > 0))) {
      pendingIds.push(station.id);
      if (synchronized.changed) {
        updates.set(station.id, {
          quantumMode: station.quantumMode ?? "transitioning",
          quantumTransition: { ...transition, bridges: synchronized.bridges },
        });
      }
      continue;
    }
    const targetMode: QuantumStationMode = cancel ? "legacy" : transition.targetMode;
    updates.set(station.id, { quantumMode: targetMode, quantumTransition: null });
    completedIds.push(station.id);
    if (!cancel && transition.targetMode === "quantum") enableNetwork = true;
  }
  if (updates.size === 0) return { state, changed: false, completedIds, pendingIds };
  const nextNetwork = enableNetwork && !state.quantumLogisticsNetwork.enabled
    ? { ...cloneNetwork(state.quantumLogisticsNetwork), enabled: true }
    : state.quantumLogisticsNetwork;
  return {
    state: {
      ...state,
      quantumLogisticsNetwork: nextNetwork,
      entities: state.entities.map((entity) => {
        const update = updates.get(entity.id);
        return update ? { ...entity, ...update } : entity;
      }),
    },
    changed: true,
    completedIds,
    pendingIds,
  };
}

/** Complete or cancel a handoff only at/after its persisted boundary. */
export function settleQuantumAttachment(state: GameState, stationId: string, cancel = false): QuantumAttachmentResult {
  const station = state.entities.find((entity) => entity.id === stationId);
  if (!station?.quantumTransition) return { state, changed: false, reason: "transition-active" };
  const result = settleQuantumAttachments(state, new Set([stationId]), cancel);
  return result.changed ? { state: result.state, changed: true } : { state, changed: false };
}
