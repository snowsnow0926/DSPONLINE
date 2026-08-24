import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPlayerEstimatePlan,
  buildPlayerEstimatePlan,
  PLAYER_ESTIMATE_METHOD,
  summarizePlayerEstimates,
} from "./player-statistics.mjs";

function baselineData() {
  const dailyMetrics = {};
  const analyticsDaily = {};
  const service = [1000, 510, 463, 597, 543, 497, 469];
  const visitors = [1205, 633, 607, 747, 720, 629, 635];
  for (let index = 0; index < service.length; index += 1) {
    const day = `2026-08-${String(index + 7).padStart(2, "0")}`;
    dailyMetrics[day] = { requests: 10, players: service[index] };
    analyticsDaily[day] = { uniqueVisitors: visitors[index] };
  }
  dailyMetrics["2026-08-14"] = { requests: 20, players: 206, errors: 3 };
  return { dailyMetrics, analyticsDaily };
}

test("builds deterministic, transparent estimates without changing observed counts", () => {
  const { dailyMetrics, analyticsDaily } = baselineData();
  const first = buildPlayerEstimatePlan({
    dailyMetrics,
    analyticsDaily,
    fromDay: "2026-08-14",
    toDay: "2026-08-24",
    asOfDay: "2026-08-24",
    generatedAt: 123,
  });
  const second = buildPlayerEstimatePlan({
    dailyMetrics,
    analyticsDaily,
    fromDay: "2026-08-14",
    toDay: "2026-08-24",
    asOfDay: "2026-08-24",
    generatedAt: 456,
  });
  assert.equal(first.method, PLAYER_ESTIMATE_METHOD);
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.baseline.availableDays.length, 7);
  assert.equal(first.rows.length, 11);
  assert.deepEqual(first.rows[0], {
    day: "2026-08-14",
    observedPlayers: 206,
    estimatedPlayers: 510,
    sourceDay: null,
    sourceAnalyticsVisitors: 0,
    status: "partial-day-projection",
    confidence: "low",
  });
  assert.equal(first.rows.at(-1).status, "partial-day-projection");
  assert.equal(first.rows[7].day, "2026-08-21");
  assert.equal(first.rows[7].sourceDay, null);
  assert.equal(first.rows[7].estimatedPlayers, 502);
  assert.equal(dailyMetrics["2026-08-14"].players, 206);
});

test("applies only estimate fields, is idempotent, and rejects conflicting history", () => {
  const { dailyMetrics, analyticsDaily } = baselineData();
  const plan = buildPlayerEstimatePlan({
    dailyMetrics,
    analyticsDaily,
    fromDay: "2026-08-14",
    toDay: "2026-08-15",
    generatedAt: 123,
  });
  const result = applyPlayerEstimatePlan(dailyMetrics, plan);
  assert.equal(result.applied, 2);
  assert.equal(result.unchanged, 0);
  assert.equal(dailyMetrics["2026-08-14"].players, 206);
  assert.equal(dailyMetrics["2026-08-14"].requests, 20);
  assert.equal(dailyMetrics["2026-08-14"].playersEstimate, 510);
  assert.equal(applyPlayerEstimatePlan(dailyMetrics, { ...plan, generatedAt: 456 }).unchanged, 2);

  dailyMetrics["2026-08-15"].playersEstimate = 9999;
  assert.throws(() => applyPlayerEstimatePlan(dailyMetrics, plan), /已存在且不一致/);
});

test("summarizes estimates as daily activity, not a unique lifetime count", () => {
  const summary = summarizePlayerEstimates({
    "2026-08-14": { players: 206, playersEstimate: 510, playersEstimateObserved: 206, playersEstimateMeta: { status: "partial-day-projection", confidence: "low", method: PLAYER_ESTIMATE_METHOD, planHash: "a" } },
    "2026-08-15": { players: 0, playersEstimate: 500, playersEstimateObserved: 0, playersEstimateMeta: { status: "full-day-projection", confidence: "low", method: PLAYER_ESTIMATE_METHOD, planHash: "a" } },
  });
  assert.equal(summary.days, 2);
  assert.equal(summary.estimatedPlayersDaySum, 1010);
  assert.equal(summary.latest.day, "2026-08-15");
  assert.equal(summary.daily[0].observedPlayers, 206);
});

test("rejects a backfill range that extends beyond the as-of day", () => {
  const { dailyMetrics, analyticsDaily } = baselineData();
  assert.throws(() => buildPlayerEstimatePlan({
    dailyMetrics,
    analyticsDaily,
    fromDay: "2026-08-14",
    toDay: "2026-08-25",
    asOfDay: "2026-08-24",
  }), /不能覆盖未来日期/);
});
