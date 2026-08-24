/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import { createAccountState, getActiveAccount, updateAccountProfile } from "./account";
import {
  LEADERBOARD_STORAGE_KEY,
  formatLeaderboardValue,
  getLeaderboardMetrics,
  getLeaderboardSnapshot,
  normalizeLeaderboardMetrics,
  removeLeaderboardData,
  submitLeaderboardData,
} from "./leaderboard";

describe("local galaxy leaderboard", () => {
  beforeEach(() => window.localStorage.clear());

  it("calculates a stable composite score and scores seeded galaxy entries", () => {
    const metrics = getLeaderboardMetrics({
      energyGeneratedMj: 1_000_000,
      uploadedWhiteMatrix: 10,
      peakGenerationKw: 5_000,
      peakThroughputPerMinute: 100,
      peakActualThroughputPerMinute: 100,
      peakDysonPowerKw: 2_000,
      exploredSystems: 2,
      colonizedPlanets: 3,
      lastGameElapsedSeconds: 0,
      lastWhiteMatrixTotal: 0,
      lastSyncedAt: 0,
    });
    expect(metrics.galaxyScore).toBe(15_509_960);
    expect(metrics.galaxyScoreMetricVersion).toBe("balanced-log-v2");
    expect(formatLeaderboardValue(1_500_000_000, "power")).toBe("15亿");
    expect(formatLeaderboardValue(100_000_000_000_000, "power")).toBe("100兆");

    const account = getActiveAccount(createAccountState(100));
    const snapshot = getLeaderboardSnapshot(account.profile, account.ledger, "galaxy");
    expect(snapshot.entries[0].value).toBeGreaterThan(0);
    expect(snapshot.entries.map((entry) => entry.value)).toEqual([...snapshot.entries.map((entry) => entry.value)].sort((a, b) => b - a));
  });

  it("balances all five visible categories and rewards a three-category endgame lead", () => {
    const threeCategoryLeader = normalizeLeaderboardMetrics({
      energyGeneratedMj: 338_336_642_978_843_460_000,
      uploadedWhiteMatrix: 53_159_646_065_251,
      peakWhiteMatrixPerMinute: 10_153_031_160.79,
      peakDysonPowerKw: 96_213_145_304_802_510,
      peakThroughputPerMinute: 1_144_268_329_401.13,
    });
    const legacyLinearLeader = normalizeLeaderboardMetrics({
      energyGeneratedMj: 4_642_025_940_144_000_000,
      uploadedWhiteMatrix: 236_284_228_966_304,
      peakWhiteMatrixPerMinute: 5_900_833_206.32,
      peakDysonPowerKw: 2_279_485_145_428_393,
      peakThroughputPerMinute: 604_794_607_448.25,
    });
    expect(threeCategoryLeader.galaxyScore).toBeGreaterThan(legacyLinearLeader.galaxyScore);

    const oneLevel = normalizeLeaderboardMetrics({ peakThroughputPerMinute: 100 });
    const doubledLevel = normalizeLeaderboardMetrics({ peakThroughputPerMinute: 201 });
    expect(doubledLevel.galaxyScore - oneLevel.galaxyScore).toBe(1_000_000);

    const noHiddenBonus = normalizeLeaderboardMetrics({
      peakThroughputPerMinute: 100,
      exploredSystems: 10_000,
      colonizedPlanets: 100_000,
    });
    expect(noHiddenBonus.galaxyScore).toBe(oneLevel.galaxyScore);
  });

  it("keeps finite leaderboard values above the former service cap", () => {
    const account = getActiveAccount(createAccountState(100));
    account.ledger.energyGeneratedMj = 2_500_000_000_000_000;
    account.ledger.peakThroughputPerMinute = 1_500_000_000_000_000;
    account.ledger.peakActualThroughputPerMinute = 1_250_000_000_000_000;
    const metrics = getLeaderboardMetrics(account.ledger);
    expect(metrics.energyGeneratedMj).toBe(2_500_000_000_000_000);
    expect(metrics.peakThroughputPerMinute).toBe(1_250_000_000_000_000);
    expect(metrics.theoreticalPeakThroughputPerMinute).toBe(1_500_000_000_000_000);
    expect(Number.isFinite(metrics.galaxyScore)).toBe(true);
  });

  it("keeps modern galactic nominal metrics separate and marks old records as legacy", () => {
    expect(normalizeLeaderboardMetrics({
      peakThroughputPerMinute: 50,
      theoreticalPeakThroughputPerMinute: 600,
      activePlanetThroughputPerMinute: 100,
      galacticThroughputPerMinute: 600,
      nominalThroughputMetricVersion: "galactic-planet-sum-v1",
    })).toMatchObject({
      peakThroughputPerMinute: 50,
      theoreticalPeakThroughputPerMinute: 600,
      activePlanetThroughputPerMinute: 100,
      galacticThroughputPerMinute: 600,
      nominalThroughputMetricVersion: "galactic-planet-sum-v1",
    });

    expect(normalizeLeaderboardMetrics({
      peakThroughputPerMinute: 75,
      theoreticalPeakThroughputPerMinute: 450,
    })).toMatchObject({
      activePlanetThroughputPerMinute: 450,
      galacticThroughputPerMinute: 450,
      nominalThroughputMetricVersion: "legacy-active-planet-v1",
    });
    expect(normalizeLeaderboardMetrics({
      peakThroughputPerMinute: 75,
      galacticThroughputPerMinute: 600,
    })).toMatchObject({
      theoreticalPeakThroughputPerMinute: 600,
      activePlanetThroughputPerMinute: 600,
      galacticThroughputPerMinute: 600,
    });
  });

  it("shows a live local projection and marks it submitted after upload", () => {
    const account = getActiveAccount(createAccountState(100));
    account.ledger.uploadedWhiteMatrix = 400_000;
    let snapshot = getLeaderboardSnapshot(account.profile, account.ledger, "upload");
    expect(snapshot.localRank).not.toBeNull();
    expect(snapshot.localSubmitted).toBe(false);

    const submission = submitLeaderboardData(account.profile, account.ledger);
    expect(submission?.metrics.uploadedWhiteMatrix).toBe(400_000);
    snapshot = getLeaderboardSnapshot(account.profile, account.ledger, "upload");
    expect(snapshot.localSubmitted).toBe(true);
    expect(window.localStorage.getItem(LEADERBOARD_STORAGE_KEY)).toContain(account.profile.id);
  });

  it("keeps private identities off the board and can withdraw prior submissions", () => {
    let state = createAccountState(100);
    const publicAccount = getActiveAccount(state);
    expect(submitLeaderboardData(publicAccount.profile, publicAccount.ledger)).not.toBeNull();
    state = updateAccountProfile(state, { privacy: "private" });
    const privateAccount = getActiveAccount(state);
    expect(submitLeaderboardData(privateAccount.profile, privateAccount.ledger)).toBeNull();
    removeLeaderboardData(privateAccount.profile.id);
    expect(getLeaderboardSnapshot(privateAccount.profile, privateAccount.ledger, "power").localRank).toBeNull();
    expect(window.localStorage.getItem(LEADERBOARD_STORAGE_KEY)).not.toContain(privateAccount.profile.id);
  });

  it("does not inject live progress into an ended season", () => {
    const account = getActiveAccount(createAccountState(100));
    expect(submitLeaderboardData(account.profile, account.ledger, "season_00")).toBeNull();
    const snapshot = getLeaderboardSnapshot(account.profile, account.ledger, "power", "season_00");
    expect(snapshot.localRank).toBeNull();
  });

  it("keeps the white-rate category compatible with old records", () => {
    const legacy = normalizeLeaderboardMetrics({ uploadedWhiteMatrix: 100 });
    expect(legacy.peakWhiteMatrixPerMinute).toBe(0);
    const account = getActiveAccount(createAccountState(101));
    const snapshot = getLeaderboardSnapshot(account.profile, account.ledger, "white-rate");
    expect(snapshot.category.unit).toBe("/min");
    expect(snapshot.entries.some((entry) => entry.value > 0)).toBe(true);
  });
});
