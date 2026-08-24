import type { AccountLedger, AccountProfile } from "./account";
import { formatQuantityCompact } from "./quantityFormat";
import { formatPowerKw } from "./units";
import {
  calculateLeaderboardGalaxyScore,
  normalizeLeaderboardMetrics,
  type LeaderboardCategoryId,
  type LeaderboardMetrics,
} from "./leaderboardContract";

export { normalizeLeaderboardMetrics } from "./leaderboardContract";
export type { LeaderboardCategoryId, LeaderboardMetrics } from "./leaderboardContract";

export const LEADERBOARD_STORAGE_KEY = "dsp-idle-network.leaderboard.v1";

export interface LeaderboardCategoryDefinition {
  id: LeaderboardCategoryId;
  label: string;
  unit: string;
  description: string;
  color: string;
}

export interface LeaderboardSeason {
  id: string;
  name: string;
  status: "active" | "ended";
  startsAt: number;
  endsAt: number;
}

export interface LeaderboardSubmission {
  accountId: string;
  displayName: string;
  avatar: string;
  seasonId: string;
  metrics: LeaderboardMetrics;
  submittedAt: number;
}

export interface LeaderboardEntry extends LeaderboardSubmission {
  rank: number;
  value: number;
  isLocal: boolean;
  submitted: boolean;
  verified: boolean;
  stationPublicId?: string;
}

export interface LeaderboardSnapshot {
  season: LeaderboardSeason;
  category: LeaderboardCategoryDefinition;
  entries: LeaderboardEntry[];
  localRank: number | null;
  localSubmitted: boolean;
}

export const LEADERBOARD_CATEGORIES: readonly LeaderboardCategoryDefinition[] = [
  { id: "power", label: "累计发电", unit: "MJ", description: "工业电网累计输出的能量", color: "#e4b955" },
  { id: "upload", label: "白矩阵上传", unit: "份", description: "提交至银河档案的白矩阵", color: "#d9dedb" },
  { id: "white-rate", label: "白糖产量", unit: "/min", description: "相邻有效主云存档区间的实际产量峰值", color: "#8bc7b7" },
  { id: "dyson", label: "戴森功率", unit: "", description: "戴森云与戴森球当前功率", color: "#e7bd58" },
  { id: "throughput", label: "实际结算吞吐", unit: "/min", description: "相邻主云修订或本地 60 秒窗口内的实际生产增量", color: "#69cbb0" },
  { id: "galaxy", label: "银河综合", unit: "分", description: "五个公开榜指标等权；每项每翻倍增加同等分数，不含隐藏加分", color: "#b8a0e4" },
] as const;

export const LEADERBOARD_SEASONS: readonly LeaderboardSeason[] = [
  { id: "season_01", name: "第一银河纪元", status: "active", startsAt: Date.UTC(2026, 0, 1), endsAt: Date.UTC(2026, 11, 31, 23, 59, 59) },
  { id: "season_00", name: "先驱者测试季", status: "ended", startsAt: Date.UTC(2025, 0, 1), endsAt: Date.UTC(2025, 11, 31, 23, 59, 59) },
] as const;

const NPC_ENTRIES: readonly { accountId: string; displayName: string; avatar: string; metrics: LeaderboardMetrics }[] = [
  { accountId: "npc_orion", displayName: "Orion Forge", avatar: "O", metrics: { energyGeneratedMj: 9_800_000_000, uploadedWhiteMatrix: 1_240_000, peakWhiteMatrixPerMinute: 38_000, peakGenerationKw: 8_600_000, peakThroughputPerMinute: 480_000, peakDysonPowerKw: 5_200_000, exploredSystems: 3, colonizedPlanets: 6, galaxyScore: 0 } },
  { accountId: "npc_kuiper", displayName: "柯伊伯联合体", avatar: "K", metrics: { energyGeneratedMj: 7_600_000_000, uploadedWhiteMatrix: 980_000, peakWhiteMatrixPerMinute: 44_000, peakGenerationKw: 6_900_000, peakThroughputPerMinute: 620_000, peakDysonPowerKw: 3_900_000, exploredSystems: 3, colonizedPlanets: 6, galaxyScore: 0 } },
  { accountId: "npc_nova", displayName: "Nova Assembly", avatar: "N", metrics: { energyGeneratedMj: 6_200_000_000, uploadedWhiteMatrix: 1_100_000, peakWhiteMatrixPerMinute: 31_000, peakGenerationKw: 5_800_000, peakThroughputPerMinute: 330_000, peakDysonPowerKw: 4_100_000, exploredSystems: 3, colonizedPlanets: 5, galaxyScore: 0 } },
  { accountId: "npc_tianji", displayName: "天玑工坊", avatar: "T", metrics: { energyGeneratedMj: 4_900_000_000, uploadedWhiteMatrix: 760_000, peakWhiteMatrixPerMinute: 35_000, peakGenerationKw: 4_800_000, peakThroughputPerMinute: 410_000, peakDysonPowerKw: 2_700_000, exploredSystems: 2, colonizedPlanets: 5, galaxyScore: 0 } },
  { accountId: "npc_helios", displayName: "Helios Cooperative", avatar: "H", metrics: { energyGeneratedMj: 3_800_000_000, uploadedWhiteMatrix: 640_000, peakWhiteMatrixPerMinute: 24_000, peakGenerationKw: 3_900_000, peakThroughputPerMinute: 290_000, peakDysonPowerKw: 2_100_000, exploredSystems: 2, colonizedPlanets: 4, galaxyScore: 0 } },
  { accountId: "npc_ashen", displayName: "烬原开拓局", avatar: "A", metrics: { energyGeneratedMj: 2_700_000_000, uploadedWhiteMatrix: 520_000, peakWhiteMatrixPerMinute: 21_000, peakGenerationKw: 3_200_000, peakThroughputPerMinute: 240_000, peakDysonPowerKw: 1_600_000, exploredSystems: 2, colonizedPlanets: 4, galaxyScore: 0 } },
  { accountId: "npc_magnetar", displayName: "Magnetar Line", avatar: "M", metrics: { energyGeneratedMj: 1_900_000_000, uploadedWhiteMatrix: 410_000, peakWhiteMatrixPerMinute: 16_000, peakGenerationKw: 2_600_000, peakThroughputPerMinute: 180_000, peakDysonPowerKw: 1_200_000, exploredSystems: 2, colonizedPlanets: 3, galaxyScore: 0 } },
  { accountId: "npc_borealis", displayName: "北冕资源网", avatar: "B", metrics: { energyGeneratedMj: 1_100_000_000, uploadedWhiteMatrix: 300_000, peakWhiteMatrixPerMinute: 11_000, peakGenerationKw: 1_900_000, peakThroughputPerMinute: 120_000, peakDysonPowerKw: 820_000, exploredSystems: 2, colonizedPlanets: 3, galaxyScore: 0 } },
] as const;

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function integer(value: unknown): number {
  return Math.floor(nonNegative(value));
}

export function getLeaderboardMetrics(ledger: AccountLedger): LeaderboardMetrics {
  const metrics: LeaderboardMetrics = {
    energyGeneratedMj: nonNegative(ledger.energyGeneratedMj),
    uploadedWhiteMatrix: integer(ledger.uploadedWhiteMatrix),
    peakWhiteMatrixPerMinute: 0,
    peakGenerationKw: nonNegative(ledger.peakGenerationKw),
    peakThroughputPerMinute: nonNegative(ledger.peakActualThroughputPerMinute),
    theoreticalPeakThroughputPerMinute: nonNegative(ledger.peakThroughputPerMinute),
    throughputMetricVersion: "settled-total-produced-v1",
    throughputWindowSeconds: 60,
    peakDysonPowerKw: nonNegative(ledger.peakDysonPowerKw),
    exploredSystems: integer(ledger.exploredSystems),
    colonizedPlanets: integer(ledger.colonizedPlanets),
    galaxyScore: 0,
    galaxyScoreMetricVersion: "balanced-log-v2",
  };
  metrics.galaxyScore = calculateLeaderboardGalaxyScore(metrics);
  return metrics;
}

export function getLeaderboardCategory(id: LeaderboardCategoryId): LeaderboardCategoryDefinition {
  return LEADERBOARD_CATEGORIES.find((category) => category.id === id) ?? LEADERBOARD_CATEGORIES[0];
}

export function getLeaderboardSeason(id = "season_01"): LeaderboardSeason {
  return LEADERBOARD_SEASONS.find((season) => season.id === id) ?? LEADERBOARD_SEASONS[0];
}

export function getLeaderboardValue(metrics: LeaderboardMetrics, category: LeaderboardCategoryId): number {
  if (category === "power") return metrics.energyGeneratedMj;
  if (category === "upload") return metrics.uploadedWhiteMatrix;
  if (category === "white-rate") return metrics.peakWhiteMatrixPerMinute;
  if (category === "dyson") return metrics.peakDysonPowerKw;
  if (category === "throughput") return metrics.peakThroughputPerMinute;
  return metrics.galaxyScore;
}

export function formatLeaderboardValue(value: number, category: LeaderboardCategoryId): string {
  if (category === "dyson") return formatPowerKw(value);
  if ((category === "throughput" || category === "white-rate") && Math.abs(value) < 10_000) return value.toFixed(1).replace(/\.0$/, "");
  return formatQuantityCompact(Math.floor(value));
}

function loadSubmissions(): LeaderboardSubmission[] {
  try {
    const raw = window.localStorage.getItem(LEADERBOARD_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || typeof entry.accountId !== "string" || typeof entry.seasonId !== "string") return [];
      return [{
        accountId: entry.accountId,
        displayName: typeof entry.displayName === "string" ? entry.displayName.slice(0, 24) : "匿名工程师",
        avatar: typeof entry.avatar === "string" ? entry.avatar.slice(0, 2) : "A",
        seasonId: entry.seasonId,
        metrics: normalizeLeaderboardMetrics(entry.metrics),
        submittedAt: nonNegative(entry.submittedAt),
      }];
    });
  } catch {
    return [];
  }
}

function saveSubmissions(submissions: LeaderboardSubmission[]): void {
  try {
    window.localStorage.setItem(LEADERBOARD_STORAGE_KEY, JSON.stringify(submissions.slice(-100)));
  } catch {
    // A failed local submission should not interrupt the simulation.
  }
}

export function submitLeaderboardData(profile: AccountProfile, ledger: AccountLedger, seasonId = "season_01"): LeaderboardSubmission | null {
  const season = getLeaderboardSeason(seasonId);
  if (profile.privacy === "private" || season.status !== "active") return null;
  const submission: LeaderboardSubmission = {
    accountId: profile.id,
    displayName: profile.displayName,
    avatar: profile.avatar,
    seasonId: season.id,
    metrics: getLeaderboardMetrics(ledger),
    submittedAt: Date.now(),
  };
  const submissions = loadSubmissions().filter((entry) => !(entry.accountId === profile.id && entry.seasonId === seasonId));
  saveSubmissions([...submissions, submission]);
  return submission;
}

export function removeLeaderboardData(accountId: string, seasonId?: string): void {
  const submissions = loadSubmissions().filter((entry) => entry.accountId !== accountId || (seasonId !== undefined && entry.seasonId !== seasonId));
  saveSubmissions(submissions);
}

export function getLeaderboardSnapshot(profile: AccountProfile, ledger: AccountLedger, category: LeaderboardCategoryId, seasonId = "season_01"): LeaderboardSnapshot {
  const season = getLeaderboardSeason(seasonId);
  const localMetrics = getLeaderboardMetrics(ledger);
  const storedSubmissions = loadSubmissions();
  const submissions = storedSubmissions.filter((entry) => entry.seasonId === season.id && entry.accountId !== profile.id);
  const ownSubmission = storedSubmissions.find((entry) => entry.seasonId === season.id && entry.accountId === profile.id);
  const localEntry = profile.privacy !== "public" || (season.status === "ended" && !ownSubmission) ? [] : [{
    accountId: profile.id,
    displayName: profile.displayName,
    avatar: profile.avatar,
    seasonId: season.id,
    metrics: season.status === "active" ? localMetrics : ownSubmission!.metrics,
    submittedAt: ownSubmission?.submittedAt ?? 0,
    rank: 0,
    value: getLeaderboardValue(season.status === "active" ? localMetrics : ownSubmission!.metrics, category),
    isLocal: true,
    submitted: Boolean(ownSubmission),
    verified: Boolean(ownSubmission),
  } satisfies LeaderboardEntry];
  const candidates: Array<LeaderboardEntry> = [
    ...NPC_ENTRIES.map((entry) => {
      const metrics = normalizeLeaderboardMetrics(entry.metrics);
      return { ...entry, metrics, seasonId: season.id, submittedAt: season.startsAt, rank: 0, value: getLeaderboardValue(metrics, category), isLocal: false, submitted: true, verified: true };
    }),
    ...localEntry,
    ...submissions.map((entry) => ({
      ...entry,
      rank: 0,
      value: getLeaderboardValue(entry.metrics, category),
      isLocal: false,
      submitted: true,
      verified: true,
    })),
  ];
  candidates.sort((left, right) => right.value - left.value || left.accountId.localeCompare(right.accountId));
  const entries = candidates.map((entry, index) => ({ ...entry, rank: index + 1 }));
  const local = entries.find((entry) => entry.isLocal);
  return {
    season,
    category: getLeaderboardCategory(category),
    entries,
    localRank: local?.rank ?? null,
    localSubmitted: Boolean(local?.submitted),
  };
}
