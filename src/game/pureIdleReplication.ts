import { STAR_SYSTEM_LIST } from "./content";
import {
  advanceDysonRocketMacroInPlace,
  refreshDysonGenerationSnapshot,
} from "./engine";
import { addQuantumInteger } from "./quantumLogisticsNetwork";
import { advanceResearchReplicationInPlace } from "./researchMacro";
import type {
  GameState,
  ItemId,
  ProductionHistorySample,
  StarSystemId,
} from "./types";

const MICROS_PER_SECOND = 1_000_000;
export const PURE_IDLE_REPLICATION_PREFERRED_WINDOW_SECONDS = 60;
export const PURE_IDLE_REPLICATION_MINIMUM_WINDOW_SECONDS = 30;
export const PURE_IDLE_REPLICATION_ALGORITHM_VERSION = "pure-idle-replication-v1-positive-output";

export interface PureIdleReplicationContract {
  windowSeconds: number;
  materialByItem: Partial<Record<ItemId, bigint>>;
  researchByItem: Partial<Record<ItemId, bigint>>;
  rocketsBySystem: Partial<Record<StarSystemId, bigint>>;
  sailsBySystem: Partial<Record<StarSystemId, bigint>>;
}

export type PureIdleReplicationReadiness =
  | { ok: true; contract: PureIdleReplicationContract }
  | { ok: false; coveredSeconds: number; reason: string };

export interface PureIdleReplicationApplication {
  creditedMaterials: Partial<Record<ItemId, bigint>>;
  creditedResearch: bigint;
  launchedRockets: number;
  absorbedSails: number;
}

function positiveNumberDelta(after: number | undefined, before: number | undefined): bigint {
  const end = Number.isSafeInteger(after) && (after ?? 0) >= 0 ? Math.floor(after ?? 0) : 0;
  const start = Number.isSafeInteger(before) && (before ?? 0) >= 0 ? Math.floor(before ?? 0) : 0;
  return end > start ? BigInt(end - start) : 0n;
}

function positiveDecimalDelta(after: string | undefined, before: string | undefined): bigint {
  if (after !== undefined && !/^\d+$/.test(after)) return 0n;
  if (before !== undefined && !/^\d+$/.test(before)) return 0n;
  const end = BigInt(after ?? "0");
  const start = BigInt(before ?? "0");
  return end > start ? end - start : 0n;
}

function chooseWindow(history: readonly ProductionHistorySample[]): {
  start: ProductionHistorySample;
  end: ProductionHistorySample;
  seconds: number;
} | null {
  const samples = history
    .filter((sample) => sample.pureIdleReplication)
    .sort((left, right) => left.elapsedSeconds - right.elapsedSeconds);
  const end = samples.at(-1);
  if (!end) return null;
  for (const target of [PURE_IDLE_REPLICATION_PREFERRED_WINDOW_SECONDS, PURE_IDLE_REPLICATION_MINIMUM_WINDOW_SECONDS]) {
    const boundary = end.elapsedSeconds - target;
    const start = samples.filter((sample) => sample.elapsedSeconds <= boundary + 1e-9).at(-1);
    if (start && end.elapsedSeconds - start.elapsedSeconds >= target - 1e-9) {
      return { start, end, seconds: end.elapsedSeconds - start.elapsedSeconds };
    }
  }
  return null;
}

export function getPureIdleReplicationReadiness(
  history: readonly ProductionHistorySample[],
): PureIdleReplicationReadiness {
  const telemetry = history.filter((sample) => sample.pureIdleReplication);
  const coveredSeconds = telemetry.length > 1
    ? Math.max(0, telemetry.at(-1)!.elapsedSeconds - telemetry[0].elapsedSeconds)
    : 0;
  const selected = chooseWindow(history);
  if (!selected) {
    return {
      ok: false,
      coveredSeconds,
      reason: `需要先正常运行至少 ${PURE_IDLE_REPLICATION_MINIMUM_WINDOW_SECONDS} 个模拟秒以记录产率（当前 ${Math.floor(coveredSeconds)} 秒）`,
    };
  }
  const start = selected.start.pureIdleReplication!;
  const end = selected.end.pureIdleReplication!;
  const materialByItem: Partial<Record<ItemId, bigint>> = {};
  for (const itemId of new Set<ItemId>([
    ...Object.keys(start.totalProduced),
    ...Object.keys(end.totalProduced),
  ] as ItemId[])) {
    const delta = positiveDecimalDelta(end.totalProduced[itemId], start.totalProduced[itemId]);
    if (delta > 0n) materialByItem[itemId] = delta;
  }
  const researchByItem: Partial<Record<ItemId, bigint>> = {};
  for (const itemId of new Set<ItemId>([
    ...Object.keys(start.researchInvestmentByItem),
    ...Object.keys(end.researchInvestmentByItem),
  ] as ItemId[])) {
    const delta = positiveDecimalDelta(
      end.researchInvestmentByItem[itemId],
      start.researchInvestmentByItem[itemId],
    );
    if (delta > 0n) researchByItem[itemId] = delta;
  }
  const rocketsBySystem: Partial<Record<StarSystemId, bigint>> = {};
  const sailsBySystem: Partial<Record<StarSystemId, bigint>> = {};
  for (const system of STAR_SYSTEM_LIST) {
    const rocketDelta = positiveNumberDelta(
      end.structurePointsBySystem[system.id],
      start.structurePointsBySystem[system.id],
    );
    const sailDelta = positiveNumberDelta(
      end.shellSailsBySystem[system.id],
      start.shellSailsBySystem[system.id],
    );
    if (rocketDelta > 0n) rocketsBySystem[system.id] = rocketDelta;
    if (sailDelta > 0n) sailsBySystem[system.id] = sailDelta;
  }
  const totalPositive = [materialByItem, researchByItem, rocketsBySystem, sailsBySystem]
    .some((record) => Object.values(record).some((value) => (value ?? 0n) > 0n));
  if (!totalPositive) {
    return {
      ok: false,
      coveredSeconds: selected.seconds,
      reason: `最近 ${Math.floor(selected.seconds)} 个模拟秒没有记录到可复制的正向产出`,
    };
  }
  return {
    ok: true,
    contract: {
      windowSeconds: selected.seconds,
      materialByItem,
      researchByItem,
      rocketsBySystem,
      sailsBySystem,
    },
  };
}

function scaledAmount(
  perWindow: bigint,
  simulationMicros: bigint,
  windowMicros: bigint,
  key: string,
  remainders: Record<string, bigint>,
): bigint {
  const numerator = perWindow * simulationMicros + (remainders[key] ?? 0n);
  remainders[key] = numerator % windowMicros;
  return numerator / windowMicros;
}

function safeIntegerNumber(value: bigint): number {
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

function addRuntimeCounter(current: number | undefined, amount: bigint): number {
  const baseline = typeof current === "number" && Number.isFinite(current) && current > 0 ? current : 0;
  const increment = Number(amount);
  if (!Number.isFinite(increment) || baseline + increment >= Number.MAX_VALUE) return Number.MAX_VALUE;
  return Math.max(baseline, Math.floor(baseline + increment));
}

export function advancePureIdleReplicationInPlace(
  state: GameState,
  contract: PureIdleReplicationContract,
  simulationSeconds: number,
  remainders: Record<string, bigint>,
): PureIdleReplicationApplication {
  const simulationMicros = BigInt(Math.max(0, Math.floor(simulationSeconds * MICROS_PER_SECOND)));
  const windowMicros = BigInt(Math.max(1, Math.floor(contract.windowSeconds * MICROS_PER_SECOND)));
  const creditedMaterials: Partial<Record<ItemId, bigint>> = {};
  state.quantumLogisticsNetwork.enabled = true;
  for (const [itemId, perWindow] of Object.entries(contract.materialByItem) as Array<[ItemId, bigint | undefined]>) {
    const amount = scaledAmount(perWindow ?? 0n, simulationMicros, windowMicros, `material:${itemId}`, remainders);
    if (amount <= 0n) continue;
    creditedMaterials[itemId] = amount;
    state.quantumLogisticsNetwork.inventory[itemId] = addQuantumInteger(
      state.quantumLogisticsNetwork.inventory[itemId],
      amount,
    );
    state.totalProduced[itemId] = addRuntimeCounter(state.totalProduced[itemId], amount);
  }

  const researchBudgets: Partial<Record<ItemId, bigint>> = {};
  for (const [itemId, perWindow] of Object.entries(contract.researchByItem) as Array<[ItemId, bigint | undefined]>) {
    const amount = scaledAmount(perWindow ?? 0n, simulationMicros, windowMicros, `research:${itemId}`, remainders);
    if (amount > 0n) researchBudgets[itemId] = amount;
  }
  const research = advanceResearchReplicationInPlace(state, researchBudgets);

  const launchesBySystem: Partial<Record<StarSystemId, number>> = {};
  for (const [systemId, perWindow] of Object.entries(contract.rocketsBySystem) as Array<[StarSystemId, bigint | undefined]>) {
    const amount = scaledAmount(perWindow ?? 0n, simulationMicros, windowMicros, `rocket:${systemId}`, remainders);
    if (amount > 0n) launchesBySystem[systemId] = safeIntegerNumber(amount);
  }
  const launchedRockets = advanceDysonRocketMacroInPlace(state, launchesBySystem);

  let absorbedSails = 0;
  for (const [systemId, perWindow] of Object.entries(contract.sailsBySystem) as Array<[StarSystemId, bigint | undefined]>) {
    const amount = safeIntegerNumber(scaledAmount(perWindow ?? 0n, simulationMicros, windowMicros, `sail:${systemId}`, remainders));
    const plan = state.dysonPlans[systemId];
    if (!plan || amount <= 0) continue;
    const accepted = Math.min(amount, Math.max(0, Number.MAX_SAFE_INTEGER - plan.shellSails));
    plan.shellSails += accepted;
    absorbedSails += accepted;
  }
  state.dysonSphere.totalSailsAbsorbed = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.floor(state.dysonSphere.totalSailsAbsorbed + absorbedSails),
  );
  refreshDysonGenerationSnapshot(state);
  return {
    creditedMaterials,
    creditedResearch: research.consumed,
    launchedRockets,
    absorbedSails,
  };
}

export function pureIdleReplicationRatePerSecond(
  contract: PureIdleReplicationContract,
  value: bigint | undefined,
): number {
  return contract.windowSeconds > 0 ? Number(value ?? 0n) / contract.windowSeconds : 0;
}
