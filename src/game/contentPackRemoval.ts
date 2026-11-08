import { getContentPackUsage, type ContentPackUsage } from "./contentPacks";
import type { ContentPackManifest } from "./mods";
import type { GameState, TechId } from "./types";

export interface ContentPackRemovalPlan {
  state: GameState;
  blockers: ContentPackUsage;
  cleanup: string[];
}

/** Only discard explicitly confirmed pack metadata. Real material is never pruned. */
export function prepareContentPackRemoval(source: GameState, manifest: ContentPackManifest): ContentPackRemovalPlan {
  const items = new Set([...(manifest.items ?? []).map(item => item.id), ...(manifest.idMigrations ?? []).filter(rule => rule.kind === "items").map(rule => rule.from)]);
  const technologies = new Set([...(manifest.technologies ?? []).map(technology => technology.id), ...(manifest.idMigrations ?? []).filter(rule => rule.kind === "technologies").map(rule => rule.from)]);
  const constructionIds = new Set([...(manifest.buildings ?? []).map(building => building.id), ...(manifest.belts ?? []).map(belt => belt.id), ...(manifest.idMigrations ?? []).filter(rule => rule.kind === "buildings" || rule.kind === "belts").map(rule => rule.from)]);
  const cleanup: string[] = [];
  let emptyIndexes = 0;
  const pruneEmpty = <T extends Record<string, unknown>>(record: T, ownedIds = items): T => {
    const entries = Object.entries(record);
    const retained = entries.filter(([id, amount]) => !ownedIds.has(id) || (amount !== 0 && amount !== "0"));
    emptyIndexes += entries.length - retained.length;
    return retained.length === entries.length ? record : Object.fromEntries(retained) as T;
  };
  const usedEntities = new Set(source.belts.flatMap(belt => [belt.source, belt.target]));
  const entities = source.entities.filter(entity => !(entity.kind === "vein" && entity.resourceId && items.has(entity.resourceId) &&
    entity.minerCount === 0 && !usedEntities.has(entity.id) &&
    [...Object.values(entity.inputs), ...Object.values(entity.outputs)].every(amount => !amount)));
  if (entities.length !== source.entities.length) cleanup.push(`无矿机的资源点 ${source.entities.length - entities.length}`);
  const retainedEntities = entities.map(entity => {
    const inputs = pruneEmpty(entity.inputs), outputs = pruneEmpty(entity.outputs);
    return inputs === entity.inputs && outputs === entity.outputs ? entity : { ...entity, inputs, outputs };
  });
  const tray = pruneEmpty(source.tray);
  const planetTrays = Object.fromEntries(Object.entries(source.planetTrays).map(([id, inventory]) => [id, pruneEmpty(inventory)])) as GameState["planetTrays"];
  const construction = pruneEmpty(source.construction, constructionIds);
  const quantumInventory = pruneEmpty(source.quantumLogisticsNetwork.inventory);
  if (emptyIndexes) cleanup.push(`零库存索引 ${emptyIndexes}`);
  const research = {
    ...source.research,
    selectedTechId: source.research.selectedTechId && technologies.has(source.research.selectedTechId) ? null : source.research.selectedTechId,
    pausedTechId: source.research.pausedTechId && technologies.has(source.research.pausedTechId) ? null : source.research.pausedTechId,
    completedTechIds: source.research.completedTechIds.filter(id => !technologies.has(id)),
    queuedTechIds: source.research.queuedTechIds.filter(id => !technologies.has(id)),
    progressByTech: Object.fromEntries(Object.entries(source.research.progressByTech).filter(([id]) => !technologies.has(id))),
  };
  const techReferences = new Set([...source.research.completedTechIds, ...source.research.queuedTechIds, source.research.selectedTechId, source.research.pausedTechId, ...Object.keys(source.research.progressByTech)].filter((id): id is TechId => Boolean(id) && technologies.has(id!)));
  if (techReferences.size) cleanup.push(`科技记录（含已投入进度） ${techReferences.size}`);
  let statistics = 0;
  const prune = <T extends Record<string, unknown>>(record: T): T => {
    const entries = Object.entries(record);
    const retained = entries.filter(([id]) => !items.has(id));
    statistics += entries.length - retained.length;
    return retained.length === entries.length ? record : Object.fromEntries(retained) as T;
  };
  const totalProduced = prune(source.totalProduced);
  const productionHistory = source.productionHistory.map(sample => ({
    ...sample,
    productionPerMinute: prune(sample.productionPerMinute), consumptionPerMinute: prune(sample.consumptionPerMinute), inventory: prune(sample.inventory),
    ...(sample.planetProductionPerMinute ? { planetProductionPerMinute: Object.fromEntries(Object.entries(sample.planetProductionPerMinute).map(([id, record]) => [id, prune(record!)])) } : {}),
    ...(sample.planetConsumptionPerMinute ? { planetConsumptionPerMinute: Object.fromEntries(Object.entries(sample.planetConsumptionPerMinute).map(([id, record]) => [id, prune(record!)])) } : {}),
    ...(sample.pureIdleReplication ? { pureIdleReplication: { ...sample.pureIdleReplication, researchInvestmentByItem: prune(sample.pureIdleReplication.researchInvestmentByItem) } } : {}),
  }));
  if (statistics) cleanup.push(`历史统计项 ${statistics}`);
  const profiles = Object.fromEntries(Object.entries(source.galaxy.profiles).map(([id, profile]) => [id, {
    ...profile,
    resourceIds: profile.resourceIds.filter(item => !items.has(item)),
    rareResourceIds: profile.rareResourceIds.filter(item => !items.has(item)),
  }])) as GameState["galaxy"]["profiles"];
  const state: GameState = { ...source, entities: retainedEntities, tray, planetTrays, construction, quantumLogisticsNetwork: { ...source.quantumLogisticsNetwork, inventory: quantumInventory }, research, totalProduced, productionHistory, galaxy: { ...source.galaxy, profiles } };
  return { state, blockers: getContentPackUsage(state, manifest), cleanup };
}
