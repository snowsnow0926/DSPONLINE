import type {
  ActivityMaterialId,
  EndgameState,
  GalacticExportPriority,
  GalacticExportProjectId,
  InfiniteResearchId,
  InfiniteResearchProgress,
  ItemAmount,
  GameState,
} from "./types";
import {
  getInfiniteResearchCompletionBasisPoints,
  getInfiniteResearchCostBigInt,
  getInfiniteResearchMaximumLevel,
} from "./infiniteResearch";

export interface InfiniteResearchDefinition {
  id: InfiniteResearchId;
  name: string;
  symbol: string;
  color: string;
  summary: string;
  effect: string;
  baseCost: number;
  growth: number;
}

export interface GalacticExportDefinition {
  id: GalacticExportProjectId;
  name: string;
  itemId: ItemAmount["itemId"];
  symbol: string;
  color: string;
  summary: string;
  baseTarget: number;
  targetGrowth: number;
  creditsPerItem: number;
  baseRatePerMinute: number;
  reserve: number;
}

export const INFINITE_RESEARCH_DEFINITIONS: readonly InfiniteResearchDefinition[] = [
  {
    id: "matrix_compression",
    name: "矩阵压缩",
    symbol: "MC",
    color: "#63c8d2",
    summary: "将科研矩阵折叠为更高密度的演算单元。",
    effect: "每级科研速度 +10%，全部普通生产速度 +4%",
    baseCost: 250,
    growth: 1.55,
  },
  {
    id: "vein_utilization",
    name: "矿脉极限利用",
    symbol: "VU",
    color: "#d8a65d",
    summary: "提高全部资源采集速度，并逐级降低固体矿脉消耗，最终实现固体无损开采。",
    effect: "每级固体、原油、液体与轨道采集速度 +10%；固体矿脉消耗 -10%，Lv.10 起固体矿脉无限",
    baseCost: 300,
    growth: 1.58,
  },
  {
    id: "galactic_logistics",
    name: "银河物流协议",
    symbol: "GL",
    color: "#72b9a2",
    summary: "统一星区航路的调度与装载策略。",
    effect: "每级物流航速与载荷 +5%，银河出口速度 +10%",
    baseCost: 350,
    growth: 1.6,
  },
  {
    id: "stellar_harnessing",
    name: "恒星能量驯化",
    symbol: "SH",
    color: "#e7bd58",
    summary: "让戴森结构与射线接收阵列逐级逼近理论上限。",
    effect: "每级戴森功率、射线接收与壳面吸附 +5%",
    baseCost: 400,
    growth: 1.62,
  },
  {
    id: "continuum_simulation",
    name: "连续体演算",
    symbol: "CS",
    color: "#b99be1",
    summary: "把生产状态压缩成可长期运行的离线时间片。",
    effect: "每级离线额度 +24 小时",
    baseCost: 500,
    growth: 1.65,
  },
] as const;

export const GALACTIC_EXPORT_DEFINITIONS: readonly GalacticExportDefinition[] = [
  {
    id: "universe_archive",
    name: "宇宙矩阵档案",
    itemId: "universe_matrix",
    symbol: "UNI",
    color: "#d9dedb",
    summary: "向银河档案库交付高密度宇宙矩阵。",
    baseTarget: 1_000,
    targetGrowth: 1.55,
    creditsPerItem: 12,
    baseRatePerMinute: 120,
    reserve: 120,
  },
  {
    id: "solar_sail_array",
    name: "太阳帆阵列",
    itemId: "solar_sail",
    symbol: "SAIL",
    color: "#e6c45f",
    summary: "为远端恒星系部署一次性太阳帆阵列。",
    baseTarget: 5_000,
    targetGrowth: 1.5,
    creditsPerItem: 3,
    baseRatePerMinute: 360,
    reserve: 240,
  },
  {
    id: "carrier_rocket_fleet",
    name: "运载火箭舰队",
    itemId: "small_carrier_rocket",
    symbol: "ROCKET",
    color: "#e28a63",
    summary: "向前线恒星工程持续输送结构施工包。",
    baseTarget: 1_000,
    targetGrowth: 1.52,
    creditsPerItem: 24,
    baseRatePerMinute: 60,
    reserve: 60,
  },
  {
    id: "antimatter_exchange",
    name: "反物质能源交换",
    itemId: "antimatter_fuel_rod",
    symbol: "AM",
    color: "#c6b0e2",
    summary: "用终局燃料棒换取银河能源信用。",
    baseTarget: 500,
    targetGrowth: 1.58,
    creditsPerItem: 80,
    baseRatePerMinute: 30,
    reserve: 24,
  },
] as const;

export const INFINITE_RESEARCH_BY_ID = Object.fromEntries(
  INFINITE_RESEARCH_DEFINITIONS.map((definition) => [definition.id, definition]),
) as Record<InfiniteResearchId, InfiniteResearchDefinition>;

/** "Greater than 200" is intentionally represented as the first unlocked total. */
export const PURE_IDLE_REPLICATION_UNLOCK_TOTAL_LEVEL = 201;

export function getPureIdleReplicationResearchLevelTotal(state: Pick<GameState, "endgame">): number {
  return INFINITE_RESEARCH_DEFINITIONS.reduce(
    (sum, definition) => sum + getInfiniteResearchLevel(state, definition.id),
    0,
  );
}

export function isPureIdleReplicationUnlocked(state: Pick<GameState, "endgame">): boolean {
  return getPureIdleReplicationResearchLevelTotal(state) >= PURE_IDLE_REPLICATION_UNLOCK_TOTAL_LEVEL;
}

export const GALACTIC_EXPORT_BY_ID = Object.fromEntries(
  GALACTIC_EXPORT_DEFINITIONS.map((definition) => [definition.id, definition]),
) as Record<GalacticExportProjectId, GalacticExportDefinition>;

export function getInfiniteResearchDefinition(id: InfiniteResearchId | null | undefined): InfiniteResearchDefinition | undefined {
  return id ? INFINITE_RESEARCH_BY_ID[id] : undefined;
}

export function getInfiniteResearchCost(id: InfiniteResearchId, level: number): number {
  const cost = getInfiniteResearchCostBigInt(id, level);
  return Number(cost > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : cost);
}

export function getInfiniteResearchCompletion(progress: InfiniteResearchProgress, id: InfiniteResearchId): number {
  return getInfiniteResearchCompletionBasisPoints(progress.progress, id, progress.level) / 10_000;
}

export function getGalacticExportDefinition(id: GalacticExportProjectId): GalacticExportDefinition {
  return GALACTIC_EXPORT_BY_ID[id];
}

export function getGalacticExportTarget(id: GalacticExportProjectId, level: number): number {
  const definition = GALACTIC_EXPORT_BY_ID[id];
  return Math.min(2_000_000_000, Math.max(1, Math.round(definition.baseTarget * definition.targetGrowth ** Math.max(0, Math.floor(level)))));
}

export function getGalacticExportReward(id: GalacticExportProjectId, level: number): number {
  const definition = GALACTIC_EXPORT_BY_ID[id];
  return Math.max(1, Math.floor(getGalacticExportTarget(id, level) * definition.creditsPerItem));
}

export function createEndgameState(): EndgameState {
  const infiniteResearch = Object.fromEntries(INFINITE_RESEARCH_DEFINITIONS.map((definition) => [
    definition.id,
    { level: 0, progress: "0" } satisfies InfiniteResearchProgress,
  ])) as Record<InfiniteResearchId, InfiniteResearchProgress>;
  const exportProjects = Object.fromEntries(GALACTIC_EXPORT_DEFINITIONS.map((definition) => [
    definition.id,
    {
      id: definition.id,
      enabled: false,
      priority: 1 as GalacticExportPriority,
      level: 0,
      delivered: 0,
      totalDelivered: 0,
      dispatchProgress: 0,
    } satisfies EndgameState["exportProjects"][GalacticExportProjectId],
  ])) as EndgameState["exportProjects"];
  const emptyActivityAmounts = () => ({
    universe_matrix: 0,
    solar_sail: 0,
    small_carrier_rocket: 0,
    antimatter_fuel_rod: 0,
  }) satisfies Record<ActivityMaterialId, number>;
  return {
    activeInfiniteResearchId: null,
    autoResearch: true,
    autoDispatch: true,
    dispatchThrottle: 1,
    exportProjects,
    galacticCredits: 0,
    galacticScore: 0,
    totalExported: 0,
    exportedLastMinute: 0,
    exportWindowAmount: 0,
    exportWindowStartedAt: 0,
    infiniteResearch,
    exportInputMode: "building",
    constructionActivity: {
      activityId: null,
      participantId: null,
      configRevision: null,
      startsAtMs: 0,
      endsAtMs: 0,
      serverTimeAnchorMs: 0,
      activityClockMs: 0,
      personalTargets: emptyActivityAmounts(),
      globalTargets: emptyActivityAmounts(),
      personalDelivered: emptyActivityAmounts(),
      pendingBatches: {},
      nextBatchSequence: 0,
    },
  };
}

export function isEndgameUnlocked(state: Pick<GameState, "research">): boolean {
  return state.research.completedTechIds.includes("universe_matrix");
}

export const BASE_OFFLINE_SECONDS = 7 * 24 * 60 * 60;
export const MAX_OFFLINE_SECONDS = 30 * 24 * 60 * 60;

export function getOfflineSimulationLimitSeconds(state: Pick<GameState, "endgame">): number {
  const level = state.endgame?.infiniteResearch?.continuum_simulation?.level ?? 0;
  return Math.min(MAX_OFFLINE_SECONDS, BASE_OFFLINE_SECONDS + Math.max(0, Math.floor(level)) * 24 * 60 * 60);
}

export function getInfiniteResearchLevel(state: Pick<GameState, "endgame">, id: InfiniteResearchId): number {
  return Math.min(getInfiniteResearchMaximumLevel(id), Math.max(0, Math.floor(state.endgame?.infiniteResearch?.[id]?.level ?? 0)));
}
