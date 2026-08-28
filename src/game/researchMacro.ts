import { getTechnology, MATRIX_ITEM_IDS } from "./content";
import {
  getEntityInputCapacity,
  investInfiniteResearchBudgetInPlace,
  settleCompletedResearchBoundariesInPlace,
} from "./engine";
import { getInfiniteResearchDefinition } from "./endgame";
import {
  getInfiniteResearchCompletionBasisPoints,
  getInfiniteResearchCumulativeInvestmentBigInt,
} from "./infiniteResearch";
import type { GameState, InfiniteResearchId, ItemId, TechId } from "./types";

const MICROS_PER_SECOND = 1_000_000;

export interface ResearchMacroLedger {
  /** Conservative measured investment during one exact calibration window. */
  unitsPerWindow: bigint;
  windowSeconds: number;
  observedUnits: bigint;
  inflowPerWindow: Partial<Record<ItemId, bigint>>;
}

export interface ResearchMacroApplication {
  consumed: bigint;
  remainder: bigint;
  inflowRemainders: Partial<Record<ItemId, bigint>>;
  completedFiniteTechIds: TechId[];
  completedInfiniteLevels: number[];
}

export interface ResearchMacroCalibrationSnapshot {
  investmentByItem: Partial<Record<ItemId, bigint>>;
  inputByItem: Partial<Record<ItemId, bigint>>;
}

export interface ResearchMacroStatus {
  kind: "none" | "finite" | "infinite";
  id?: string;
  label: string;
  level?: number;
  completionBasisPoints?: number;
  completedFiniteCount: number;
}

export function captureResearchMacroCalibrationSnapshot(
  state: GameState,
): ResearchMacroCalibrationSnapshot | null {
  const investmentByItem: Partial<Record<ItemId, bigint>> = {};
  const inputByItem: Partial<Record<ItemId, bigint>> = {};
  for (const progress of Object.values(state.research.progressByTech)) {
    for (const [itemId, amount] of Object.entries(progress ?? {})) {
      if (!Number.isSafeInteger(amount) || (amount ?? 0) < 0) return null;
      investmentByItem[itemId as ItemId] = (investmentByItem[itemId as ItemId] ?? 0n) + BigInt(amount ?? 0);
    }
  }
  try {
    for (const [id, progress] of Object.entries(state.endgame.infiniteResearch)) {
      investmentByItem.universe_matrix = (investmentByItem.universe_matrix ?? 0n) +
        getInfiniteResearchCumulativeInvestmentBigInt(
        id as InfiniteResearchId,
        progress.level,
        progress.progress,
      );
    }
  } catch {
    return null;
  }
  const matrixIds = new Set<ItemId>(MATRIX_ITEM_IDS);
  for (const entity of state.entities) {
    if (entity.recipeId !== "matrix_research") continue;
    for (const [itemId, amount] of Object.entries(entity.inputs)) {
      if (!matrixIds.has(itemId as ItemId)) continue;
      if (!Number.isSafeInteger(amount) || (amount ?? 0) < 0) return null;
      inputByItem[itemId as ItemId] = (inputByItem[itemId as ItemId] ?? 0n) + BigInt(amount ?? 0);
    }
  }
  return { investmentByItem, inputByItem };
}

export function getResearchInvestmentTotalBigInt(state: GameState): bigint | null {
  const snapshot = captureResearchMacroCalibrationSnapshot(state);
  return snapshot
    ? Object.values(snapshot.investmentByItem).reduce((sum, value) => sum + (value ?? 0n), 0n)
    : null;
}

/**
 * Derive a deterministic research budget from exact engine checkpoints. The
 * whole calibration span is used so finite queues that complete during the
 * first slice still receive their exact observed investment once; any excess
 * budget is discarded when no active research remains.
 */
export function createResearchMacroLedger(
  states: readonly GameState[],
  windowSeconds: number,
): ResearchMacroLedger | null {
  return createResearchMacroLedgerFromSnapshots(
    states.map(captureResearchMacroCalibrationSnapshot),
    windowSeconds,
  );
}

export function createResearchMacroLedgerFromSnapshots(
  snapshots: readonly (ResearchMacroCalibrationSnapshot | null)[],
  windowSeconds: number,
): ResearchMacroLedger | null {
  if (snapshots.length < 2 || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return null;
  if (snapshots.some((value) => value === null)) return null;
  const first = snapshots[0]!;
  const last = snapshots.at(-1)!;
  const itemIds = new Set<ItemId>([
    ...Object.keys(first.investmentByItem),
    ...Object.keys(last.investmentByItem),
    ...Object.keys(first.inputByItem),
    ...Object.keys(last.inputByItem),
  ] as ItemId[]);
  const inflowPerWindow: Partial<Record<ItemId, bigint>> = {};
  let observedUnits = 0n;
  for (const itemId of itemIds) {
    const invested = (last.investmentByItem[itemId] ?? 0n) - (first.investmentByItem[itemId] ?? 0n);
    const safeInvested = invested > 0n ? invested : 0n;
    observedUnits += safeInvested;
    const inventoryDelta = (last.inputByItem[itemId] ?? 0n) - (first.inputByItem[itemId] ?? 0n);
    const inflow = inventoryDelta + safeInvested;
    if (inflow > 0n) inflowPerWindow[itemId] = inflow;
  }
  return {
    unitsPerWindow: observedUnits,
    windowSeconds: windowSeconds * (snapshots.length - 1),
    observedUnits,
    inflowPerWindow,
  };
}

function allocateFiniteBudget(
  state: GameState,
  requested: bigint,
  pools: Map<ItemId, bigint>,
): { consumed: bigint; completedTechIds: TechId[]; remaining: bigint } {
  let remaining = requested;
  let consumed = 0n;
  const completedTechIds = settleCompletedResearchBoundariesInPlace(state);
  const guardLimit = state.research.queuedTechIds.length + 256;
  let guard = 0;

  while (remaining > 0n && state.research.selectedTechId && guard++ < guardLimit) {
    const techId = state.research.selectedTechId;
    const technology = getTechnology(techId);
    if (!technology) {
      settleCompletedResearchBoundariesInPlace(state);
      break;
    }
    const progress = { ...(state.research.progressByTech[techId] ?? {}) };
    for (const cost of technology.costs) {
      if (remaining <= 0n) break;
      const current = Math.max(0, Math.min(cost.amount, Math.floor(progress[cost.itemId] ?? 0)));
      const needed = BigInt(Math.max(0, cost.amount - current));
      const available = pools.get(cost.itemId) ?? 0n;
      const invested = remaining < needed
        ? (remaining < available ? remaining : available)
        : (needed < available ? needed : available);
      if (invested <= 0n) continue;
      progress[cost.itemId] = current + Number(invested);
      pools.set(cost.itemId, available - invested);
      remaining -= invested;
      consumed += invested;
    }
    state.research.progressByTech[techId] = progress;
    const completed = settleCompletedResearchBoundariesInPlace(state);
    completedTechIds.push(...completed);
    if (completed.length === 0) break;
  }
  return { consumed, completedTechIds, remaining };
}

/**
 * Spend a virtual, already-observed research budget without touching lab
 * inventories. This is intentionally used only by the player's opt-in
 * production-replication time-warp mode.
 */
export function advanceResearchReplicationInPlace(
  state: GameState,
  budgetByItem: Readonly<Partial<Record<ItemId, bigint>>>,
): Omit<ResearchMacroApplication, "remainder" | "inflowRemainders"> {
  const pools = new Map<ItemId, bigint>();
  for (const [itemId, raw] of Object.entries(budgetByItem) as Array<[ItemId, bigint | undefined]>) {
    if ((raw ?? 0n) > 0n) pools.set(itemId, raw!);
  }
  let budget = [...pools.values()].reduce((sum, value) => sum + value, 0n);
  const finite = allocateFiniteBudget(state, budget, pools);
  budget = finite.remaining;
  let infiniteConsumed = 0n;
  const completedInfiniteLevels: number[] = [];
  const infiniteId = state.endgame.activeInfiniteResearchId;
  if (!state.research.selectedTechId && infiniteId && budget > 0n) {
    const beforeLevel = state.endgame.infiniteResearch[infiniteId].level;
    const available = pools.get("universe_matrix") ?? 0n;
    infiniteConsumed = investInfiniteResearchBudgetInPlace(
      state,
      infiniteId,
      budget < available ? budget : available,
    );
    const afterLevel = state.endgame.infiniteResearch[infiniteId].level;
    for (let level = beforeLevel + 1; level <= afterLevel; level += 1) completedInfiniteLevels.push(level);
  }
  return {
    consumed: finite.consumed + infiniteConsumed,
    completedFiniteTechIds: finite.completedTechIds,
    completedInfiniteLevels,
  };
}

function redistributeResearchPools(
  state: GameState,
  labs: GameState["entities"],
  originalInputs: ReadonlyArray<Partial<Record<ItemId, number>>>,
  pools: ReadonlyMap<ItemId, bigint>,
): void {
  const itemIds = new Set<ItemId>([
    ...MATRIX_ITEM_IDS,
    ...pools.keys(),
  ]);
  for (const itemId of itemIds) {
    const original = labs.map((_, index) => {
      const amount = originalInputs[index]?.[itemId] ?? 0;
      return Number.isSafeInteger(amount) && amount > 0 ? BigInt(amount) : 0n;
    });
    const stored = [...original];
    const originalTotal = original.reduce((sum, amount) => sum + amount, 0n);
    const desiredTotal = pools.get(itemId) ?? 0n;
    if (desiredTotal < originalTotal) {
      // Exact research consumes labs in stable entity order. Mirroring that
      // order lets real consumption reduce historical over-capacity stock
      // without clipping any untouched lab merely because its current capacity
      // is lower than the saved amount.
      let reduction = originalTotal - (desiredTotal > 0n ? desiredTotal : 0n);
      for (let index = 0; index < stored.length && reduction > 0n; index += 1) {
        const removed = stored[index] < reduction ? stored[index] : reduction;
        stored[index] -= removed;
        reduction -= removed;
      }
    } else {
      let addition = desiredTotal - originalTotal;
      for (let index = 0; index < labs.length && addition > 0n; index += 1) {
        const capacity = BigInt(Math.max(0, Math.floor(getEntityInputCapacity(state, labs[index]))));
        const protectedLimit = capacity > original[index] ? capacity : original[index];
        const headroom = protectedLimit - stored[index];
        const accepted = headroom < addition ? headroom : addition;
        stored[index] += accepted;
        addition -= accepted;
      }
      // Remaining projected inflow is blocked at the aggregate input boundary.
      // It never existed in the source checkpoint, so declining it preserves
      // both capacity rules and every historical over-capacity item.
    }
    for (let index = 0; index < labs.length; index += 1) {
      labs[index].inputs[itemId] = Number(stored[index]);
    }
  }
}

export function advanceResearchMacroInPlace(
  state: GameState,
  ledger: ResearchMacroLedger,
  simulationSeconds: number,
  previousRemainder = 0n,
  previousInflowRemainders: Partial<Record<ItemId, bigint>> = {},
): ResearchMacroApplication {
  const safeMicros = BigInt(Math.max(0, Math.floor(simulationSeconds * MICROS_PER_SECOND)));
  const denominator = BigInt(Math.max(1, Math.floor(ledger.windowSeconds * MICROS_PER_SECOND)));
  const numerator = ledger.unitsPerWindow * safeMicros + (previousRemainder > 0n ? previousRemainder : 0n);
  let budget = numerator / denominator;
  const remainder = numerator % denominator;
  const labs = state.entities.filter((entity) => entity.recipeId === "matrix_research");
  const originalInputs = labs.map((lab) => ({ ...lab.inputs }));
  const pools = new Map<ItemId, bigint>();
  for (const lab of labs) {
    for (const itemId of MATRIX_ITEM_IDS) {
      const amount = lab.inputs[itemId] ?? 0;
      if (Number.isSafeInteger(amount) && amount > 0) pools.set(itemId, (pools.get(itemId) ?? 0n) + BigInt(amount));
    }
  }
  const inflowRemainders: Partial<Record<ItemId, bigint>> = {};
  for (const [itemId, perWindow] of Object.entries(ledger.inflowPerWindow)) {
    const inflowNumerator = (perWindow ?? 0n) * safeMicros + (previousInflowRemainders[itemId as ItemId] ?? 0n);
    const inflow = inflowNumerator / denominator;
    inflowRemainders[itemId as ItemId] = inflowNumerator % denominator;
    pools.set(itemId as ItemId, (pools.get(itemId as ItemId) ?? 0n) + inflow);
  }
  const finite = allocateFiniteBudget(state, budget, pools);
  budget = finite.remaining;
  let infiniteConsumed = 0n;
  const completedInfiniteLevels: number[] = [];
  const infiniteId = state.endgame.activeInfiniteResearchId;
  if (!state.research.selectedTechId && infiniteId) {
    const beforeLevel = state.endgame.infiniteResearch[infiniteId].level;
    const available = pools.get("universe_matrix") ?? 0n;
    infiniteConsumed = investInfiniteResearchBudgetInPlace(
      state,
      infiniteId,
      budget < available ? budget : available,
    );
    pools.set("universe_matrix", available - infiniteConsumed);
    const afterLevel = state.endgame.infiniteResearch[infiniteId].level;
    for (let level = beforeLevel + 1; level <= afterLevel; level += 1) completedInfiniteLevels.push(level);
  }
  redistributeResearchPools(state, labs, originalInputs, pools);
  return {
    consumed: finite.consumed + infiniteConsumed,
    remainder,
    inflowRemainders,
    completedFiniteTechIds: finite.completedTechIds,
    completedInfiniteLevels,
  };
}

export function captureResearchMacroStatus(state: GameState): ResearchMacroStatus {
  const finiteId = state.research.selectedTechId;
  if (finiteId) {
    const technology = getTechnology(finiteId);
    const progress = state.research.progressByTech[finiteId] ?? {};
    const total = technology?.costs.reduce((sum, cost) => sum + cost.amount, 0) ?? 0;
    const invested = technology?.costs.reduce((sum, cost) =>
      sum + Math.max(0, Math.min(cost.amount, Math.floor(progress[cost.itemId] ?? 0))), 0) ?? 0;
    return {
      kind: "finite",
      id: finiteId,
      label: technology?.name ?? finiteId,
      completionBasisPoints: total > 0 ? Math.min(10_000, Math.floor(invested * 10_000 / total)) : 0,
      completedFiniteCount: state.research.completedTechIds.length,
    };
  }
  const infiniteId = state.endgame.activeInfiniteResearchId;
  if (infiniteId) {
    const progress = state.endgame.infiniteResearch[infiniteId];
    return {
      kind: "infinite",
      id: infiniteId,
      label: getInfiniteResearchDefinition(infiniteId)?.name ?? infiniteId,
      level: progress.level,
      completionBasisPoints: getInfiniteResearchCompletionBasisPoints(progress.progress, infiniteId, progress.level),
      completedFiniteCount: state.research.completedTechIds.length,
    };
  }
  return {
    kind: "none",
    label: "当前无进行中的科研",
    completedFiniteCount: state.research.completedTechIds.length,
  };
}
