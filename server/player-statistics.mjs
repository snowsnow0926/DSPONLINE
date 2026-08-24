import { createHash } from "node:crypto";

/**
 * Historical player-count estimates are deliberately separate from the
 * authoritative presence counter.  The latter is a unique, observed
 * "entered the factory" count; an estimate must never overwrite it.
 */
export const PLAYER_ESTIMATE_METHOD = "analytics-uv-presence-ratio-v1";
export const PLAYER_ESTIMATE_VERSION = 1;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MIN_BASELINE_DAYS = 3;
const DEFAULT_BASELINE_DAYS = 7;

function integer(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function validDay(value) {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function dayOrdinal(day) {
  const valid = validDay(day);
  return valid ? Math.floor(Date.parse(`${valid}T00:00:00.000Z`) / DAY_MS) : null;
}

function dayFromOrdinal(ordinal) {
  return new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
}

function dayRange(fromDay, toDay) {
  const from = dayOrdinal(fromDay);
  const to = dayOrdinal(toDay);
  if (from === null || to === null || to < from) throw new Error("玩家估算日期范围无效");
  return Array.from({ length: to - from + 1 }, (_, index) => dayFromOrdinal(from + index));
}

function recordValue(records, day, key) {
  const record = records && typeof records === "object" ? records[day] : null;
  return integer(record?.[key]);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundRatio(value) {
  return Math.round(value * 10_000) / 10_000;
}

function canonicalPlan(plan) {
  return JSON.stringify({
    version: plan.version,
    method: plan.method,
    fromDay: plan.fromDay,
    toDay: plan.toDay,
    baseline: plan.baseline,
    rows: plan.rows.map((row) => ({
      day: row.day,
      observedPlayers: row.observedPlayers,
      estimatedPlayers: row.estimatedPlayers,
      sourceDay: row.sourceDay,
      sourceAnalyticsVisitors: row.sourceAnalyticsVisitors,
      status: row.status,
      confidence: row.confidence,
    })),
  });
}

function planHash(plan) {
  return createHash("sha256").update(canonicalPlan(plan)).digest("hex");
}

function publicBaseline(baseline) {
  return {
    days: [...baseline.days],
    availableDays: baseline.availableDays,
    medianServicePlayers: baseline.medianServicePlayers,
    medianAnalyticsVisitors: baseline.medianAnalyticsVisitors,
    medianPresenceRatio: baseline.medianPresenceRatio,
  };
}

/**
 * Build a deterministic, aggregate-only estimate plan.
 *
 * The baseline is the seven complete days immediately before fromDay.  For a
 * missing day we use the same weekday from the prior week when available,
 * multiplied by the median observed relationship between analytics UV and
 * factory-entry presence.  The first broken day is treated as a partial day
 * and uses the baseline median; this avoids pretending that its 206 observed
 * entries were a complete day after the telemetry fuse engaged.
 */
export function buildPlayerEstimatePlan({
  dailyMetrics = {},
  analyticsDaily = {},
  fromDay,
  toDay,
  baselineDays = DEFAULT_BASELINE_DAYS,
  asOfDay = toDay,
  generatedAt = Date.now(),
} = {}) {
  const from = validDay(fromDay);
  const to = validDay(toDay);
  const asOf = validDay(asOfDay) ?? to;
  const requestedBaselineDays = Number.isInteger(baselineDays)
    ? Math.max(MIN_BASELINE_DAYS, Math.min(30, baselineDays))
    : DEFAULT_BASELINE_DAYS;
  if (!from || !to || dayOrdinal(to) < dayOrdinal(from)) throw new Error("玩家估算日期范围无效");
  if (dayOrdinal(to) > dayOrdinal(asOf)) throw new Error("玩家估算不能覆盖未来日期");

  const fromOrdinal = dayOrdinal(from);
  const baselineDaysList = Array.from({ length: requestedBaselineDays }, (_, index) => dayFromOrdinal(fromOrdinal - requestedBaselineDays + index));
  const baselinePairs = baselineDaysList.flatMap((day) => {
    const servicePlayers = recordValue(dailyMetrics, day, "players");
    const analyticsVisitors = recordValue(analyticsDaily, day, "uniqueVisitors");
    if (servicePlayers < 1 || analyticsVisitors < 1) return [];
    return [{ day, servicePlayers, analyticsVisitors, ratio: servicePlayers / analyticsVisitors }];
  });
  if (baselinePairs.length < MIN_BASELINE_DAYS) {
    throw new Error(`玩家估算需要至少 ${MIN_BASELINE_DAYS} 个完整基线日`);
  }

  const medianServicePlayers = Math.round(median(baselinePairs.map((entry) => entry.servicePlayers)));
  const medianAnalyticsVisitors = Math.round(median(baselinePairs.map((entry) => entry.analyticsVisitors)));
  const medianPresenceRatio = roundRatio(median(baselinePairs.map((entry) => entry.ratio)));
  const rows = dayRange(from, to).map((day) => {
    const observedPlayers = recordValue(dailyMetrics, day, "players");
    const isFirstBrokenDay = day === from;
    const isCurrentPartialDay = day === asOf;
    // Never use a day inside the backfill window as a weekly source.  The
    // first broken day can contain a partial pre-fuse count, while later days
    // are missing entirely; either would bias every matching weekday downward.
    const candidateSourceDay = dayFromOrdinal(dayOrdinal(day) - 7);
    const sourceDay = isFirstBrokenDay || dayOrdinal(candidateSourceDay) >= fromOrdinal
      ? null
      : candidateSourceDay;
    const sourceAnalyticsVisitors = sourceDay ? recordValue(analyticsDaily, sourceDay, "uniqueVisitors") : 0;
    const estimatedPlayers = isFirstBrokenDay
      ? Math.max(observedPlayers, medianServicePlayers)
      : Math.max(1, Math.round((sourceAnalyticsVisitors || medianAnalyticsVisitors) * medianPresenceRatio));
    return {
      day,
      observedPlayers,
      estimatedPlayers,
      sourceDay,
      sourceAnalyticsVisitors,
      status: isFirstBrokenDay ? "partial-day-projection" : isCurrentPartialDay ? "partial-day-projection" : "full-day-projection",
      confidence: "low",
    };
  });

  const plan = {
    version: PLAYER_ESTIMATE_VERSION,
    method: PLAYER_ESTIMATE_METHOD,
    fromDay: from,
    toDay: to,
    asOfDay: asOf,
    generatedAt: integer(generatedAt),
    baseline: {
      days: baselineDaysList,
      availableDays: baselinePairs.map((entry) => entry.day),
      medianServicePlayers,
      medianAnalyticsVisitors,
      medianPresenceRatio,
    },
    rows,
  };
  return { ...plan, planHash: planHash(plan) };
}

/**
 * Apply only the estimate fields.  Existing observed `players` values and all
 * unrelated daily counters remain untouched.  Reapplying the same plan is
 * idempotent; a different existing estimate fails closed.
 */
export function applyPlayerEstimatePlan(dailyMetrics, plan) {
  if (!dailyMetrics || typeof dailyMetrics !== "object" || Array.isArray(dailyMetrics)) {
    throw new Error("dailyMetrics 必须是对象");
  }
  if (!plan || plan.version !== PLAYER_ESTIMATE_VERSION || plan.method !== PLAYER_ESTIMATE_METHOD || plan.planHash !== planHash(plan)) {
    throw new Error("玩家估算计划校验失败");
  }
  let applied = 0;
  let unchanged = 0;
  for (const row of plan.rows) {
    const current = dailyMetrics[row.day] && typeof dailyMetrics[row.day] === "object" ? dailyMetrics[row.day] : {};
    if (current.playersEstimate !== undefined && current.playersEstimate !== row.estimatedPlayers) {
      throw new Error(`玩家估算 ${row.day} 已存在且不一致`);
    }
    if (current.playersEstimateObserved !== undefined && current.playersEstimateObserved !== row.observedPlayers) {
      throw new Error(`玩家估算 ${row.day} 的实测值已存在且不一致`);
    }
    const currentMeta = current.playersEstimateMeta && typeof current.playersEstimateMeta === "object"
      ? current.playersEstimateMeta
      : null;
    if (currentMeta?.planHash && currentMeta.planHash !== plan.planHash) {
      throw new Error(`玩家估算 ${row.day} 已绑定其他计划`);
    }
    const next = {
      ...current,
      playersEstimate: row.estimatedPlayers,
      playersEstimateObserved: row.observedPlayers,
      playersEstimateMeta: {
        version: plan.version,
        method: plan.method,
        planHash: plan.planHash,
        sourceDay: row.sourceDay,
        sourceAnalyticsVisitors: row.sourceAnalyticsVisitors,
        status: row.status,
        confidence: row.confidence,
        generatedAt: plan.generatedAt,
      },
    };
    const comparable = (record) => {
      const copy = { ...record };
      if (copy.playersEstimateMeta && typeof copy.playersEstimateMeta === "object") {
        copy.playersEstimateMeta = { ...copy.playersEstimateMeta };
        delete copy.playersEstimateMeta.generatedAt;
      }
      return JSON.stringify(copy);
    };
    if (comparable(current) === comparable(next)) unchanged += 1;
    else {
      dailyMetrics[row.day] = next;
      applied += 1;
    }
  }
  return { applied, unchanged, days: plan.rows.length, planHash: plan.planHash };
}

export function summarizePlayerEstimates(dailyMetrics = {}) {
  const rows = Object.entries(dailyMetrics && typeof dailyMetrics === "object" ? dailyMetrics : {})
    .filter(([, record]) => Number.isSafeInteger(record?.playersEstimate) && record.playersEstimate >= 0)
    .map(([day, record]) => ({
      day,
      playersEstimate: record.playersEstimate,
      observedPlayers: integer(record.playersEstimateObserved),
      status: record.playersEstimateMeta?.status ?? "unknown",
      confidence: record.playersEstimateMeta?.confidence ?? "unknown",
      method: record.playersEstimateMeta?.method ?? null,
      planHash: record.playersEstimateMeta?.planHash ?? null,
    }))
    .sort((left, right) => left.day.localeCompare(right.day));
  return {
    days: rows.length,
    latest: rows.at(-1) ?? null,
    // This is a sum of daily activity estimates, not a unique lifetime total.
    estimatedPlayersDaySum: rows.reduce((sum, row) => sum + row.playersEstimate, 0),
    daily: rows,
  };
}

export function playerEstimatePlanHash(plan) {
  return planHash(plan);
}
