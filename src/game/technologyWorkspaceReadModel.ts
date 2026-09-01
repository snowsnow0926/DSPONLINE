import type {
  DesktopNativeCoreTechnologyProjectionResult,
  DesktopTechnologyMatrixItemId,
} from "../desktop";
import { ITEMS, MATRIX_ITEM_IDS, PLANET_LIST, getTechnology } from "./content";
import { getDifficultyDefinition } from "./difficulty";
import {
  INTERSTELLAR_CARGO_PER_VESSEL,
  PLANETARY_CARGO_PER_DRONE,
  RAY_RECEIVER_CAPACITY_KW,
  SOLAR_SAIL_LIFETIME_SECONDS,
} from "./engine";
import { INFINITE_RESEARCH_DEFINITIONS } from "./endgame";
import { getInfiniteResearchMaximumLevel } from "./infiniteResearch";
import type {
  DifficultyMode,
  FontScale,
  GameState,
  InfiniteResearchId,
  InfiniteResearchProgress,
  ItemId,
  ResearchState,
  TechnologyLayoutMode,
  TechId,
} from "./types";

export const TECHNOLOGY_WORKSPACE_PROJECTION_LIMITS = Object.freeze({
  techRows: 512,
  progressItemsPerTech: 16,
  infiniteRows: 8,
} as const);

export interface TechnologyWorkspaceEffectsReadModel {
  readonly miningSpeedMultiplier: number;
  readonly researchSpeedMultiplier: number;
  readonly logisticsSpeedMultiplier: number;
  readonly planetaryCargoCapacity: number;
  readonly interstellarCargoCapacity: number;
  readonly solarSailLifetimeSeconds: number;
  readonly rayReceiverCapacityKw: number;
  readonly dysonSailAbsorptionMultiplier: number;
}
export interface TechnologyWorkspaceReadModel {
  readonly schema: "technology-workspace-v1";
  readonly source: "web-game-state" | "native-core";
  readonly revision: number | null;
  readonly research: ResearchState;
  readonly activeInfiniteResearchId: InfiniteResearchId | null;
  readonly autoResearch: boolean;
  readonly infiniteResearch: Record<InfiniteResearchId, InfiniteResearchProgress>;
  readonly settings: {
    readonly technologyLayout: TechnologyLayoutMode;
    readonly fontScale: FontScale;
    readonly difficulty: DifficultyMode;
  };
  readonly matrixStock: Record<DesktopTechnologyMatrixItemId, number>;
  readonly effects: TechnologyWorkspaceEffectsReadModel;
}

export interface NativeTechnologyWorkspaceFrame {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly projection: DesktopNativeCoreTechnologyProjectionResult;
}

export interface NativeTechnologyWorkspaceBinding {
  readonly enabled: boolean;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly expectedRevision: number;
  readonly expectedRegistryFingerprint: string;
}

function effectiveInfiniteLevel(
  infiniteResearch: Readonly<Record<InfiniteResearchId, InfiniteResearchProgress>>,
  id: InfiniteResearchId,
): number {
  return Math.min(
    getInfiniteResearchMaximumLevel(id),
    Math.max(0, Math.floor(infiniteResearch[id]?.level ?? 0)),
  );
}

function createEffects(
  completedTechIds: readonly TechId[],
  infiniteResearch: Readonly<Record<InfiniteResearchId, InfiniteResearchProgress>>,
  difficultyMode: DifficultyMode,
): TechnologyWorkspaceEffectsReadModel {
  const completed = new Set(completedTechIds);
  const difficulty = getDifficultyDefinition(difficultyMode);
  const matrixCompression = effectiveInfiniteLevel(infiniteResearch, "matrix_compression");
  const veinUtilization = effectiveInfiniteLevel(infiniteResearch, "vein_utilization");
  const galacticLogistics = effectiveInfiniteLevel(infiniteResearch, "galactic_logistics");
  const stellarHarnessing = effectiveInfiniteLevel(infiniteResearch, "stellar_harnessing");
  const logisticsCapacityMultiplier = (
    1 + (completed.has("logistics_capacity_1") ? 0.5 : 0) +
    (completed.has("logistics_capacity_2") ? 0.5 : 0)
  ) * (1 + galacticLogistics * 0.05);
  return Object.freeze({
    miningSpeedMultiplier: (completed.has("mining_speed_3") ? 3
      : completed.has("mining_speed_2") ? 2
        : completed.has("mining_speed_1") ? 1.5 : 1) *
      (1 + veinUtilization * 0.1) * difficulty.miningMultiplier,
    researchSpeedMultiplier: (
      1 + (completed.has("research_speed_1") ? 0.25 : 0) +
      (completed.has("research_speed_2") ? 0.25 : 0) +
      (completed.has("research_speed_3") ? 0.25 : 0)
    ) * (1 + matrixCompression * 0.1) * difficulty.productionMultiplier,
    logisticsSpeedMultiplier: (
      1 + (completed.has("logistics_engine_1") ? 0.5 : 0) +
      (completed.has("logistics_engine_2") ? 0.5 : 0)
    ) * (1 + galacticLogistics * 0.05) * difficulty.logisticsMultiplier,
    planetaryCargoCapacity: Math.round(PLANETARY_CARGO_PER_DRONE * logisticsCapacityMultiplier),
    interstellarCargoCapacity: Math.round(INTERSTELLAR_CARGO_PER_VESSEL * logisticsCapacityMultiplier),
    solarSailLifetimeSeconds: SOLAR_SAIL_LIFETIME_SECONDS * (
      1 + (completed.has("solar_sail_life_1") ? 0.5 : 0) +
      (completed.has("solar_sail_life_2") ? 0.5 : 0)
    ),
    rayReceiverCapacityKw: RAY_RECEIVER_CAPACITY_KW * (
      1 + (completed.has("ray_transmission_1") ? 0.5 : 0) +
      (completed.has("ray_transmission_2") ? 0.5 : 0)
    ) * (1 + stellarHarnessing * 0.05),
    dysonSailAbsorptionMultiplier: (completed.has("dyson_absorption_1") ? 2 : 1) *
      (1 + stellarHarnessing * 0.05),
  });
}

function copyInfiniteResearch(
  source: Readonly<Record<InfiniteResearchId, InfiniteResearchProgress>>,
): Record<InfiniteResearchId, InfiniteResearchProgress> {
  return Object.fromEntries(INFINITE_RESEARCH_DEFINITIONS.map(({ id }) => {
    const progress = source[id];
    return [id, Object.freeze({
      level: progress.level,
      ...(progress.historicalLevel === undefined ? {} : { historicalLevel: progress.historicalLevel }),
      progress: progress.progress,
    })];
  })) as Record<InfiniteResearchId, InfiniteResearchProgress>;
}

function createReadModel(
  source: TechnologyWorkspaceReadModel["source"],
  revision: number | null,
  research: ResearchState,
  activeInfiniteResearchId: InfiniteResearchId | null,
  autoResearch: boolean,
  infiniteResearch: Record<InfiniteResearchId, InfiniteResearchProgress>,
  settings: TechnologyWorkspaceReadModel["settings"],
  matrixStock: Record<DesktopTechnologyMatrixItemId, number>,
): TechnologyWorkspaceReadModel {
  return Object.freeze({
    schema: "technology-workspace-v1",
    source,
    revision,
    research,
    activeInfiniteResearchId,
    autoResearch,
    infiniteResearch,
    settings,
    matrixStock,
    effects: createEffects(research.completedTechIds, infiniteResearch, settings.difficulty),
  });
}

export function createWebTechnologyWorkspaceReadModel(game: GameState): TechnologyWorkspaceReadModel {
  const matrixStock = Object.fromEntries(MATRIX_ITEM_IDS.map((itemId) => {
    const entityStock = game.entities.reduce((sum, entity) =>
      sum + (entity.inputs[itemId] ?? 0) + (entity.outputs[itemId] ?? 0), 0);
    const trayStock = PLANET_LIST.reduce((sum, planet) => sum + (planet.id === game.activePlanetId
      ? game.tray[itemId] ?? 0
      : game.planetTrays[planet.id][itemId] ?? 0), 0);
    const amount = Math.floor(entityStock + trayStock + (game.cargo?.itemId === itemId ? game.cargo.amount : 0));
    return [itemId, amount];
  })) as Record<DesktopTechnologyMatrixItemId, number>;
  const research: ResearchState = Object.freeze({
    selectedTechId: game.research.selectedTechId,
    pausedTechId: game.research.pausedTechId,
    queuedTechIds: Object.freeze([...game.research.queuedTechIds]) as TechId[],
    progressByTech: Object.fromEntries(Object.entries(game.research.progressByTech).map(([techId, progress]) => [
      techId,
      Object.freeze({ ...progress }),
    ])) as ResearchState["progressByTech"],
    completedTechIds: Object.freeze([...game.research.completedTechIds]) as TechId[],
  });
  return createReadModel(
    "web-game-state",
    null,
    research,
    game.endgame.activeInfiniteResearchId,
    game.endgame.autoResearch,
    copyInfiniteResearch(game.endgame.infiniteResearch),
    Object.freeze({
      technologyLayout: game.settings.technologyLayout,
      fontScale: game.settings.fontScale,
      difficulty: game.settings.difficulty,
    }),
    matrixStock,
  );
}

function uniqueKnownIds(ids: readonly string[], known: (id: string) => boolean): ids is TechId[] {
  return new Set(ids).size === ids.length && ids.every(known);
}

export function selectNativeTechnologyWorkspaceReadModel(
  frame: NativeTechnologyWorkspaceFrame | null,
  binding: NativeTechnologyWorkspaceBinding,
): TechnologyWorkspaceReadModel | null {
  if (!frame || !binding.enabled || !binding.sessionId || !binding.runId ||
    frame.sessionId !== binding.sessionId || frame.runId !== binding.runId ||
    frame.registryFingerprint !== binding.expectedRegistryFingerprint ||
    frame.revision !== binding.expectedRevision ||
    frame.projection.revision !== binding.expectedRevision) return null;
  const projection = frame.projection;
  if (projection.schemaVersion !== 1 || projection.projectionType !== "technology-v1" || projection.truncated ||
    projection.limits.techRows !== TECHNOLOGY_WORKSPACE_PROJECTION_LIMITS.techRows ||
    projection.limits.progressItemsPerTech !== TECHNOLOGY_WORKSPACE_PROJECTION_LIMITS.progressItemsPerTech ||
    projection.limits.infiniteRows !== TECHNOLOGY_WORKSPACE_PROJECTION_LIMITS.infiniteRows ||
    projection.counts.completedTechIds !== projection.completedTechIds.length ||
    projection.counts.queuedTechIds !== projection.queuedTechIds.length ||
    projection.counts.progressTechs !== projection.progressByTech.length ||
    projection.counts.infiniteResearch !== projection.infiniteResearch.length) return null;
  const knownTech = (id: string): boolean => Boolean(getTechnology(id as TechId));
  if (!uniqueKnownIds(projection.completedTechIds, knownTech) ||
    !uniqueKnownIds(projection.queuedTechIds, knownTech)) return null;
  const selectedTechId = projection.selectedTechId as TechId | null;
  const pausedTechId = projection.pausedTechId as TechId | null;
  if (selectedTechId && !knownTech(selectedTechId) || pausedTechId && !knownTech(pausedTechId) ||
    selectedTechId !== null && selectedTechId === pausedTechId) return null;
  const occupied = new Set<TechId>(projection.completedTechIds as TechId[]);
  if (selectedTechId && occupied.has(selectedTechId) || pausedTechId && occupied.has(pausedTechId)) return null;
  if (projection.queuedTechIds.some((id) => occupied.has(id as TechId) || id === selectedTechId || id === pausedTechId)) return null;

  const progressByTech: ResearchState["progressByTech"] = {};
  const progressTechIds = new Set<string>();
  for (const row of projection.progressByTech) {
    if (row.truncated || row.totalCount !== row.items.length || !knownTech(row.techId) || progressTechIds.has(row.techId) ||
      row.items.length > TECHNOLOGY_WORKSPACE_PROJECTION_LIMITS.progressItemsPerTech) return null;
    progressTechIds.add(row.techId);
    const progress: Partial<Record<ItemId, number>> = {};
    for (const item of row.items) {
      if (!Object.hasOwn(ITEMS, item.itemId) || Object.hasOwn(progress, item.itemId) ||
        !Number.isSafeInteger(item.amount) || item.amount < 0) return null;
      progress[item.itemId as ItemId] = item.amount;
    }
    progressByTech[row.techId as TechId] = Object.freeze(progress);
  }

  const infiniteIds = new Set(INFINITE_RESEARCH_DEFINITIONS.map(({ id }) => id));
  if (projection.infiniteResearch.length !== infiniteIds.size ||
    projection.activeInfiniteResearchId !== null && !infiniteIds.has(projection.activeInfiniteResearchId as InfiniteResearchId)) return null;
  const infiniteResearch = {} as Record<InfiniteResearchId, InfiniteResearchProgress>;
  for (const row of projection.infiniteResearch) {
    const id = row.researchId as InfiniteResearchId;
    if (!infiniteIds.delete(id) || !Number.isSafeInteger(row.level) || row.level < 0 ||
      row.historicalLevel !== null && (!Number.isSafeInteger(row.historicalLevel) || row.historicalLevel < 0) ||
      !/^\d+$/.test(row.progress)) return null;
    infiniteResearch[id] = Object.freeze({
      level: row.level,
      ...(row.historicalLevel === null ? {} : { historicalLevel: row.historicalLevel }),
      progress: row.progress,
    });
  }
  if (infiniteIds.size > 0) return null;
  for (const itemId of MATRIX_ITEM_IDS) {
    const amount = projection.matrixStock[itemId as DesktopTechnologyMatrixItemId];
    if (!Number.isSafeInteger(amount) || amount < 0) return null;
  }
  const research: ResearchState = Object.freeze({
    selectedTechId,
    pausedTechId,
    queuedTechIds: Object.freeze(projection.queuedTechIds as TechId[]) as TechId[],
    progressByTech,
    completedTechIds: Object.freeze(projection.completedTechIds as TechId[]) as TechId[],
  });
  return createReadModel(
    "native-core",
    projection.revision,
    research,
    projection.activeInfiniteResearchId as InfiniteResearchId | null,
    projection.autoResearch,
    infiniteResearch,
    projection.settings,
    projection.matrixStock,
  );
}
