export type LeaderboardCategoryId = "power" | "upload" | "white-rate" | "dyson" | "throughput" | "galaxy";

export interface LeaderboardMetrics {
  energyGeneratedMj: number;
  uploadedWhiteMatrix: number;
  peakWhiteMatrixPerMinute: number;
  peakGenerationKw: number;
  /** Actual settled totalProduced delta. */
  peakThroughputPerMinute: number;
  /** Nominal machine capacity retained as a separate diagnostic. */
  theoreticalPeakThroughputPerMinute?: number;
  /** Nominal snapshot for the planet active when the save was uploaded. */
  activePlanetThroughputPerMinute?: number;
  /** Saturating sum of every explicit planetMetrics entry. */
  galacticThroughputPerMinute?: number;
  nominalThroughputMetricVersion?: "galactic-planet-sum-v1" | "legacy-active-planet-v1";
  throughputMetricVersion?: "settled-total-produced-v1" | "legacy-nominal-v1";
  throughputWindowSeconds?: number;
  peakDysonPowerKw: number;
  exploredSystems: number;
  colonizedPlanets: number;
  galaxyScore: number;
  galaxyScoreMetricVersion?: "balanced-log-v2" | "legacy-linear-v1";
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function integer(value: unknown): number {
  return Math.floor(nonNegative(value));
}

function saturatingAdd(left: number, right: number): number {
  const safeLeft = nonNegative(left);
  const safeRight = nonNegative(right);
  return safeLeft >= Number.MAX_VALUE - safeRight ? Number.MAX_VALUE : safeLeft + safeRight;
}

export const GALAXY_SCORE_METRIC_VERSION = "balanced-log-v2" as const;

const GALAXY_SCORE_POINTS_PER_DOUBLING = 1_000_000;

/**
 * Each visible leaderboard category contributes one equally weighted,
 * logarithmic engineering level. This keeps a cumulative metric from
 * overwhelming every rate metric merely because its unit has more digits:
 * within any category, every doubling is worth the same number of points.
 */
function logarithmicGalaxyScoreTerm(value: unknown, baseline: number): number {
  const normalized = nonNegative(value);
  if (normalized === 0) return 0;
  return Math.round(Math.log2(1 + normalized / baseline) * GALAXY_SCORE_POINTS_PER_DOUBLING);
}

export function calculateLeaderboardGalaxyScore(metrics: Omit<LeaderboardMetrics, "galaxyScore">): number {
  const terms = [
    logarithmicGalaxyScoreTerm(metrics.energyGeneratedMj, 1_000_000),
    logarithmicGalaxyScoreTerm(metrics.uploadedWhiteMatrix, 1),
    logarithmicGalaxyScoreTerm(metrics.peakWhiteMatrixPerMinute, 1),
    logarithmicGalaxyScoreTerm(metrics.peakDysonPowerKw, 100),
    logarithmicGalaxyScoreTerm(metrics.peakThroughputPerMinute, 1),
  ];
  return Math.round(terms.reduce(saturatingAdd, 0));
}

export function normalizeLeaderboardMetrics(value: unknown): LeaderboardMetrics {
  const source = value && typeof value === "object" ? value as Record<string, any> : {};
  const nominalFallback = nonNegative(source.theoreticalPeakThroughputPerMinute
    ?? source.galacticThroughputPerMinute
    ?? source.peakThroughputPerMinute);
  const metrics = {
    energyGeneratedMj: nonNegative(source.energyGeneratedMj),
    uploadedWhiteMatrix: integer(source.uploadedWhiteMatrix),
    peakWhiteMatrixPerMinute: nonNegative(source.peakWhiteMatrixPerMinute),
    peakGenerationKw: nonNegative(source.peakGenerationKw),
    peakThroughputPerMinute: nonNegative(source.peakThroughputPerMinute),
    theoreticalPeakThroughputPerMinute: nominalFallback,
    activePlanetThroughputPerMinute: nonNegative(source.activePlanetThroughputPerMinute ?? nominalFallback),
    galacticThroughputPerMinute: nonNegative(source.galacticThroughputPerMinute ?? nominalFallback),
    nominalThroughputMetricVersion: (source.nominalThroughputMetricVersion === "galactic-planet-sum-v1"
      ? "galactic-planet-sum-v1"
      : "legacy-active-planet-v1") as LeaderboardMetrics["nominalThroughputMetricVersion"],
    throughputMetricVersion: (source.throughputMetricVersion === "settled-total-produced-v1"
      ? "settled-total-produced-v1"
      : "legacy-nominal-v1") as LeaderboardMetrics["throughputMetricVersion"],
    throughputWindowSeconds: nonNegative(source.throughputWindowSeconds),
    peakDysonPowerKw: nonNegative(source.peakDysonPowerKw),
    exploredSystems: integer(source.exploredSystems),
    colonizedPlanets: integer(source.colonizedPlanets),
  };
  return {
    ...metrics,
    galaxyScore: calculateLeaderboardGalaxyScore(metrics),
    galaxyScoreMetricVersion: GALAXY_SCORE_METRIC_VERSION,
  };
}
