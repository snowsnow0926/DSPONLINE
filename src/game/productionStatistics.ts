import { formatQuantityCompact } from "./quantityFormat";
import type { ItemId, PlanetId, ProductionHistorySample } from "./types";

export type ProductionStatisticsWindow = "second" | "minute" | "ten-minutes" | "hour" | "total";

export interface ProductionStatisticsWindowDefinition {
  id: ProductionStatisticsWindow;
  label: string;
  seconds: number;
  suffix: string;
}

export const PRODUCTION_STATISTICS_WINDOWS: readonly ProductionStatisticsWindowDefinition[] = [
  { id: "minute", label: "过去 1 分钟", seconds: 60, suffix: "/1min" },
  { id: "ten-minutes", label: "过去 10 分钟", seconds: 600, suffix: "/10min" },
  { id: "hour", label: "过去 1 小时", seconds: 3_600, suffix: "/1h" },
  { id: "total", label: "累计总产量", seconds: 0, suffix: "累计" },
] as const;

const PER_SECOND_WINDOW: ProductionStatisticsWindowDefinition = { id: "second", label: "每秒", seconds: 1, suffix: "/s" };

export const PRODUCTION_HISTORY_SAMPLE_SECONDS = 1;
const RECENT_FINE_SECONDS = 70;
const RECENT_MEDIUM_SECONDS = 660;
const HISTORY_RETENTION_SECONDS = 3_660;

function isHistoryRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Production history is a runtime-only diagnostic cache. A stale durable
 * command from an older client could JSON-canonicalize an undefined array
 * entry to null. Drop malformed samples at every runtime boundary instead of
 * allowing diagnostic data to stop simulation or offline settlement.
 */
export function sanitizeProductionHistorySamples(value: unknown): ProductionHistorySample[] {
  if (!Array.isArray(value)) return [];
  return value.filter((sample): sample is ProductionHistorySample => {
    if (!isHistoryRecord(sample) || typeof sample.elapsedSeconds !== "number" || !Number.isFinite(sample.elapsedSeconds) || sample.elapsedSeconds < 0) return false;
    return isHistoryRecord(sample.productionPerMinute) &&
      isHistoryRecord(sample.consumptionPerMinute) &&
      isHistoryRecord(sample.inventory) &&
      typeof sample.generationKw === "number" && Number.isFinite(sample.generationKw) &&
      typeof sample.demandKw === "number" && Number.isFinite(sample.demandKw);
  });
}

function rounded(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function getProductionHistorySampleDuration(sample: ProductionHistorySample): number {
  const duration = sample.sampleDurationSeconds;
  return Number.isFinite(duration) && duration! > 0 ? Math.max(1, Math.round(duration!)) : 10;
}

function mergeRateRecords(
  samples: readonly ProductionHistorySample[],
  selector: (sample: ProductionHistorySample) => Partial<Record<ItemId, number>>,
  duration: number,
): Partial<Record<ItemId, number>> {
  const weighted = new Map<ItemId, number>();
  for (const sample of samples) {
    const sampleDuration = getProductionHistorySampleDuration(sample);
    for (const [itemId, value] of Object.entries(selector(sample)) as Array<[ItemId, number | undefined]>) {
      if (!Number.isFinite(value)) continue;
      weighted.set(itemId, (weighted.get(itemId) ?? 0) + (value ?? 0) * sampleDuration);
    }
  }
  return Object.fromEntries([...weighted].map(([itemId, value]) => [itemId, rounded(value / duration)])) as Partial<Record<ItemId, number>>;
}

function mergePlanetRateRecords(
  samples: readonly ProductionHistorySample[],
  selector: (sample: ProductionHistorySample) => Partial<Record<PlanetId, Partial<Record<ItemId, number>>>> | undefined,
  duration: number,
): Partial<Record<PlanetId, Partial<Record<ItemId, number>>>> {
  const weighted = new Map<PlanetId, Map<ItemId, number>>();
  for (const sample of samples) {
    const sampleDuration = getProductionHistorySampleDuration(sample);
    for (const [planetId, values] of Object.entries(selector(sample) ?? {}) as Array<[PlanetId, Partial<Record<ItemId, number>>]>) {
      const planet = weighted.get(planetId) ?? new Map<ItemId, number>();
      for (const [itemId, value] of Object.entries(values) as Array<[ItemId, number | undefined]>) {
        if (!Number.isFinite(value)) continue;
        planet.set(itemId, (planet.get(itemId) ?? 0) + (value ?? 0) * sampleDuration);
      }
      weighted.set(planetId, planet);
    }
  }
  return Object.fromEntries([...weighted].map(([planetId, values]) => [
    planetId,
    Object.fromEntries([...values].map(([itemId, value]) => [itemId, rounded(value / duration)])),
  ])) as Partial<Record<PlanetId, Partial<Record<ItemId, number>>>>;
}

function weightedOptional(
  samples: readonly ProductionHistorySample[],
  selector: (sample: ProductionHistorySample) => number | undefined,
  duration: number,
): number | undefined {
  let total = 0;
  let covered = 0;
  for (const sample of samples) {
    const value = selector(sample);
    if (!Number.isFinite(value)) continue;
    const sampleDuration = getProductionHistorySampleDuration(sample);
    total += value! * sampleDuration;
    covered += sampleDuration;
  }
  return covered > 0 ? rounded(total / Math.min(duration, covered), 4) : undefined;
}

export function mergeProductionHistorySamples(samples: readonly ProductionHistorySample[]): ProductionHistorySample {
  const validSamples = sanitizeProductionHistorySamples(samples);
  if (validSamples.length === 0) throw new Error("生产统计时间桶不能为空");
  const duration = validSamples.reduce((sum, sample) => sum + getProductionHistorySampleDuration(sample), 0);
  const latest = validSamples.at(-1)!;
  return {
    elapsedSeconds: latest.elapsedSeconds,
    sampleDurationSeconds: duration,
    productionPerMinute: mergeRateRecords(validSamples, (sample) => sample.productionPerMinute, duration),
    consumptionPerMinute: mergeRateRecords(validSamples, (sample) => sample.consumptionPerMinute, duration),
    planetProductionPerMinute: mergePlanetRateRecords(validSamples, (sample) => sample.planetProductionPerMinute, duration),
    planetConsumptionPerMinute: mergePlanetRateRecords(validSamples, (sample) => sample.planetConsumptionPerMinute, duration),
    inventory: { ...latest.inventory },
    generationKw: weightedOptional(validSamples, (sample) => sample.generationKw, duration) ?? latest.generationKw,
    demandKw: weightedOptional(validSamples, (sample) => sample.demandKw, duration) ?? latest.demandKw,
    machineEfficiency: weightedOptional(validSamples, (sample) => sample.machineEfficiency, duration),
    logisticsEfficiency: weightedOptional(validSamples, (sample) => sample.logisticsEfficiency, duration),
    powerEfficiency: weightedOptional(validSamples, (sample) => sample.powerEfficiency, duration),
    activeMachines: Math.max(0, Math.round(weightedOptional(validSamples, (sample) => sample.activeMachines, duration) ?? latest.activeMachines ?? 0)),
    blockedMachines: Math.max(0, Math.round(weightedOptional(validSamples, (sample) => sample.blockedMachines, duration) ?? latest.blockedMachines ?? 0)),
  };
}

function compactBucketsBefore(
  history: ProductionHistorySample[],
  cutoffElapsedSeconds: number,
  targetDurationSeconds: number,
): void {
  while (true) {
    const start = history.findIndex((sample) =>
      sample.elapsedSeconds <= cutoffElapsedSeconds && getProductionHistorySampleDuration(sample) < targetDurationSeconds);
    if (start < 0) return;
    let duration = 0;
    let end = start;
    while (end < history.length && history[end].elapsedSeconds <= cutoffElapsedSeconds &&
      getProductionHistorySampleDuration(history[end]) < targetDurationSeconds && duration < targetDurationSeconds) {
      duration += getProductionHistorySampleDuration(history[end]);
      end += 1;
    }
    if (end - start < 2 || duration < targetDurationSeconds) return;
    history.splice(start, end - start, mergeProductionHistorySamples(history.slice(start, end)));
  }
}

/**
 * Keep one-hour rolling statistics without retaining 3,600 full item maps.
 * Recent data stays at one-second resolution, then folds into ten-second and
 * one-minute buckets. One extra minute is retained for an exact rolling edge.
 */
export function compactProductionHistory(samples: readonly ProductionHistorySample[]): ProductionHistorySample[] {
  const history = sanitizeProductionHistorySamples(samples).sort((left, right) => left.elapsedSeconds - right.elapsedSeconds);
  const latestElapsedSeconds = history.at(-1)?.elapsedSeconds ?? 0;
  // Worker publications can cover 1, 4, 5, 12, or more simulation seconds.
  // Compact by covered time rather than assuming every source bucket is
  // exactly one second, otherwise higher simulation speeds grow saves forever.
  compactBucketsBefore(history, latestElapsedSeconds - RECENT_FINE_SECONDS, 10);
  compactBucketsBefore(history, latestElapsedSeconds - RECENT_FINE_SECONDS - RECENT_MEDIUM_SECONDS, 60);
  let retainedSeconds = history.reduce((sum, sample) => sum + getProductionHistorySampleDuration(sample), 0);
  while (history.length > 1 && retainedSeconds > HISTORY_RETENTION_SECONDS) {
    retainedSeconds -= getProductionHistorySampleDuration(history[0]);
    history.shift();
  }
  return history;
}

export interface ProductionWindowSnapshot {
  window: ProductionStatisticsWindowDefinition;
  coveredSeconds: number;
  production: Partial<Record<ItemId, number>>;
  consumption: Partial<Record<ItemId, number>>;
  totalProduction: number;
  totalConsumption: number;
}

export function calculateProductionWindowSnapshot(
  history: readonly ProductionHistorySample[],
  windowId: ProductionStatisticsWindow,
  fallbackProductionPerMinute: Partial<Record<ItemId, number>> = {},
  fallbackConsumptionPerMinute: Partial<Record<ItemId, number>> = {},
  totalProduced: Partial<Record<ItemId, number>> = {},
): ProductionWindowSnapshot {
  const validHistory = sanitizeProductionHistorySamples(history);
  const window = windowId === "second"
    ? PER_SECOND_WINDOW
    : PRODUCTION_STATISTICS_WINDOWS.find((entry) => entry.id === windowId) ?? PRODUCTION_STATISTICS_WINDOWS[0];
  if (window.id === "total") {
    const production = Object.fromEntries(Object.entries(totalProduced).flatMap(([itemId, value]) =>
      Number.isFinite(value) && (value ?? 0) >= 0 ? [[itemId, Math.floor(value ?? 0)]] : [])) as Partial<Record<ItemId, number>>;
    return {
      window,
      coveredSeconds: validHistory.reduce((sum, sample) => sum + getProductionHistorySampleDuration(sample), 0),
      production,
      consumption: {},
      totalProduction: Object.values(production).reduce((sum, value) => sum + (value ?? 0), 0),
      totalConsumption: 0,
    };
  }
  const weightedProduction = new Map<ItemId, number>();
  const weightedConsumption = new Map<ItemId, number>();
  let remaining = window.seconds;
  let coveredSeconds = 0;
  const addWeighted = (target: Map<ItemId, number>, record: Partial<Record<ItemId, number>>, weight: number) => {
    for (const [itemId, value] of Object.entries(record) as Array<[ItemId, number | undefined]>) {
      if (!Number.isFinite(value)) continue;
      target.set(itemId, (target.get(itemId) ?? 0) + (value ?? 0) * weight);
    }
  };
  for (let index = validHistory.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const sample = validHistory[index];
    const overlap = Math.min(remaining, getProductionHistorySampleDuration(sample));
    addWeighted(weightedProduction, sample.productionPerMinute, overlap);
    addWeighted(weightedConsumption, sample.consumptionPerMinute, overlap);
    coveredSeconds += overlap;
    remaining -= overlap;
  }

  const scale = window.seconds / 60;
  const normalized = (
    weighted: Map<ItemId, number>,
    fallback: Partial<Record<ItemId, number>>,
  ): Partial<Record<ItemId, number>> => {
    if (coveredSeconds <= 0) {
      return Object.fromEntries(Object.entries(fallback).map(([itemId, value]) => [itemId, rounded((value ?? 0) * scale)])) as Partial<Record<ItemId, number>>;
    }
    return Object.fromEntries([...weighted].map(([itemId, value]) => [itemId, rounded(value / coveredSeconds * scale)])) as Partial<Record<ItemId, number>>;
  };
  const production = normalized(weightedProduction, fallbackProductionPerMinute);
  const consumption = normalized(weightedConsumption, fallbackConsumptionPerMinute);
  return {
    window,
    coveredSeconds,
    production,
    consumption,
    totalProduction: rounded(Object.values(production).reduce((sum, value) => sum + (value ?? 0), 0)),
    totalConsumption: rounded(Object.values(consumption).reduce((sum, value) => sum + (value ?? 0), 0)),
  };
}

export interface ProductionTrendPoint {
  elapsedSeconds: number;
  productionPerMinute: number;
  consumptionPerMinute: number;
}

/** Build at most 72 chart points from the already bounded rolling history. */
export function createProductionTrendSeries(
  history: readonly ProductionHistorySample[],
  windowId: Exclude<ProductionStatisticsWindow, "second" | "total">,
  itemId: ItemId,
  maximumPoints = 72,
): ProductionTrendPoint[] {
  const validHistory = sanitizeProductionHistorySamples(history);
  const window = PRODUCTION_STATISTICS_WINDOWS.find((entry) => entry.id === windowId);
  if (!window || window.seconds <= 0 || validHistory.length === 0) return [];
  const cutoff = (validHistory.at(-1)?.elapsedSeconds ?? 0) - window.seconds;
  const selected = validHistory.filter((sample) => sample.elapsedSeconds > cutoff);
  if (selected.length === 0) return [];
  const groupSize = Math.max(1, Math.ceil(selected.length / Math.max(2, Math.floor(maximumPoints))));
  const points: ProductionTrendPoint[] = [];
  for (let index = 0; index < selected.length; index += groupSize) {
    const group = selected.slice(index, index + groupSize);
    const duration = group.reduce((sum, sample) => sum + getProductionHistorySampleDuration(sample), 0);
    if (duration <= 0) continue;
    const weighted = (selector: (sample: ProductionHistorySample) => number) =>
      group.reduce((sum, sample) => sum + selector(sample) * getProductionHistorySampleDuration(sample), 0) / duration;
    points.push({
      elapsedSeconds: group.at(-1)!.elapsedSeconds,
      productionPerMinute: rounded(weighted((sample) => sample.productionPerMinute[itemId] ?? 0)),
      consumptionPerMinute: rounded(weighted((sample) => sample.consumptionPerMinute[itemId] ?? 0)),
    });
  }
  return points;
}

export function formatProductionStatistic(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) return "0";
  if (Math.abs(value) >= 10_000) return formatQuantityCompact(Math.trunc(value));
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function formatProductionStatisticExact(value: number): string {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}
