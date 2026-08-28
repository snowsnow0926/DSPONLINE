import { getInfiniteResearchCumulativeInvestmentBigInt } from "./infiniteResearch";
import { getTechnology } from "./content";
import type {
  DecimalIntegerString,
  GameState,
  InfiniteResearchId,
  ItemId,
  PureIdleReplicationTelemetry,
  StarSystemId,
} from "./types";

function decimal(value: bigint): DecimalIntegerString {
  return (value > 0n ? value : 0n).toString();
}

/** Capture only monotonic counters; no inventory, resource or capacity state is trusted. */
export function capturePureIdleReplicationTelemetry(
  state: GameState,
): PureIdleReplicationTelemetry | undefined {
  const totalProduced: Partial<Record<ItemId, DecimalIntegerString>> = {};
  for (const [itemId, raw] of Object.entries(state.totalProduced) as Array<[ItemId, number | undefined]>) {
    if (!Number.isFinite(raw) || (raw ?? 0) < 0) return undefined;
    // BigInt(number) preserves the integer represented by the runtime Number,
    // including endgame totals above Number.MAX_SAFE_INTEGER. The original
    // Number may already be approximate, but the telemetry itself no longer
    // introduces another unsafe subtraction.
    totalProduced[itemId] = decimal(BigInt(Math.floor(raw ?? 0)));
  }

  const researchInvestmentByItem: Partial<Record<ItemId, DecimalIntegerString>> = {};
  const addResearch = (itemId: ItemId, amount: bigint): void => {
    researchInvestmentByItem[itemId] = decimal(
      BigInt(researchInvestmentByItem[itemId] ?? "0") + amount,
    );
  };
  const completed = new Set(state.research.completedTechIds);
  for (const techId of completed) {
    const technology = getTechnology(techId);
    if (!technology) continue;
    for (const cost of technology.costs) addResearch(cost.itemId, BigInt(cost.amount));
  }
  for (const [techId, progress] of Object.entries(state.research.progressByTech)) {
    if (completed.has(techId as keyof typeof state.research.progressByTech)) continue;
    for (const [itemId, raw] of Object.entries(progress ?? {}) as Array<[ItemId, number | undefined]>) {
      if (!Number.isSafeInteger(raw) || (raw ?? 0) < 0) return undefined;
      addResearch(itemId, BigInt(raw ?? 0));
    }
  }
  try {
    for (const [id, progress] of Object.entries(state.endgame.infiniteResearch)) {
      const invested = getInfiniteResearchCumulativeInvestmentBigInt(
        id as InfiniteResearchId,
        progress.level,
        progress.progress,
      );
      addResearch("universe_matrix", invested);
    }
  } catch {
    return undefined;
  }

  const structurePointsBySystem: Partial<Record<StarSystemId, number>> = {};
  const shellSailsBySystem: Partial<Record<StarSystemId, number>> = {};
  for (const [systemId, plan] of Object.entries(state.dysonPlans) as Array<[
    StarSystemId,
    GameState["dysonPlans"][StarSystemId],
  ]>) {
    if (!Number.isSafeInteger(plan.structurePoints) || plan.structurePoints < 0 ||
      !Number.isSafeInteger(plan.shellSails) || plan.shellSails < 0) return undefined;
    structurePointsBySystem[systemId] = Math.floor(plan.structurePoints);
    shellSailsBySystem[systemId] = Math.floor(plan.shellSails);
  }
  return {
    totalProduced,
    researchInvestmentByItem,
    structurePointsBySystem,
    shellSailsBySystem,
  };
}
