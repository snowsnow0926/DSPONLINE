import { describe, expect, it } from "vitest";
import {
  capPureIdleBackgroundPlan,
  getPureIdleBackgroundPlan,
  getPureIdleUnattendedBackgroundStartedAt,
  PURE_IDLE_BACKGROUND_GRACE_SECONDS,
  requiresBoundedPureIdleCatchup,
  type PureIdleRecoveryRecord,
} from "./pureIdleRecovery";

function record(backgroundStartedAtMs?: number): Pick<PureIdleRecoveryRecord, "startedAtMs" | "backgroundStartedAtMs"> {
  return {
    startedAtMs: 1_000_000,
    ...(backgroundStartedAtMs === undefined ? {} : { backgroundStartedAtMs }),
  };
}

describe("pure idle background grace", () => {
  it("keeps the full wall-clock interval on the macro path while visible", () => {
    expect(getPureIdleBackgroundPlan(record(), 1_000_000 + 90_000)).toEqual({
      backgrounded: false,
      totalWallSeconds: 90,
      highWallSeconds: 90,
      normalOfflineSeconds: 0,
      graceExpired: false,
    });
  });

  it("allows five minutes after the page enters the background", () => {
    const startedAt = 1_000_000 + 60_000;
    expect(getPureIdleBackgroundPlan(record(startedAt), startedAt + 240_000)).toMatchObject({
      backgrounded: true,
      highWallSeconds: 300,
      normalOfflineSeconds: 0,
      graceExpired: false,
    });
  });

  it("does not extend the grace window when background marking is repeated", () => {
    const first = 1_000_000 + 60_000;
    const repeated = first + 120_000;
    const plan = getPureIdleBackgroundPlan(record(first), repeated + 5 * 60_000);
    expect(plan.highWallSeconds).toBe(60 + PURE_IDLE_BACKGROUND_GRACE_SECONDS);
    expect(plan.normalOfflineSeconds).toBe(120);
    expect(plan.graceExpired).toBe(true);
  });

  it("moves the remainder to ordinary offline time after the grace window", () => {
    const startedAt = 1_000_000 + 60_000;
    const plan = getPureIdleBackgroundPlan(
      record(startedAt),
      startedAt + (PURE_IDLE_BACKGROUND_GRACE_SECONDS + 600) * 1_000,
    );
    expect(plan.backgrounded).toBe(true);
    expect(plan.highWallSeconds).toBe(60 + PURE_IDLE_BACKGROUND_GRACE_SECONDS);
    expect(plan.normalOfflineSeconds).toBe(600);
    expect(plan.graceExpired).toBe(true);
  });

  it("detects an unattended timer gap without relying on visibility events", () => {
    const startedAtMs = 1_000_000;
    const unattended = getPureIdleUnattendedBackgroundStartedAt({
      startedAtMs,
      settledWallSeconds: 60,
      summary: undefined,
    }, startedAtMs + 9 * 60 * 60 * 1_000);

    expect(unattended).toBe(startedAtMs + 60_000);
  });

  it("does not classify an actively advancing session as unattended", () => {
    const startedAtMs = 1_000_000;
    expect(getPureIdleUnattendedBackgroundStartedAt({
      startedAtMs,
      settledWallSeconds: 570,
      summary: undefined,
    }, startedAtMs + 600_000)).toBeNull();
  });

  it("caps unstable exact-mode high-rate catch-up and sends the tail offline", () => {
    const plan = getPureIdleBackgroundPlan({
      startedAtMs: 1_000_000,
      backgroundStartedAtMs: 1_060_000,
    }, 1_000_000 + 9 * 60 * 60 * 1_000);
    const capped = capPureIdleBackgroundPlan(plan, 60, 60);

    expect(capped.highWallSeconds).toBe(120);
    expect(capped.normalOfflineSeconds).toBe(9 * 60 * 60 - 120);
    expect(capped.graceExpired).toBe(true);
  });

  it("treats a legacy summary without settlementMode as bounded until recalibration", () => {
    expect(requiresBoundedPureIdleCatchup({ summary: undefined })).toBe(true);
    expect(requiresBoundedPureIdleCatchup({ summary: { settlementMode: "bounded-exact" } })).toBe(true);
    expect(requiresBoundedPureIdleCatchup({ summary: { settlementMode: "affine" } })).toBe(false);
    expect(requiresBoundedPureIdleCatchup({ summary: { settlementMode: "conservative" } })).toBe(false);
  });
});
