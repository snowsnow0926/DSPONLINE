import "../compat/structuredClone";
import { getBeltConstructionId, getExtractorBuildingId, getRecipe, ITEMS } from "./content";
import { hasTypedContentIdReference, removeContentIdReferences, type ContentIdSets } from "./contentIdMigration";
import type { ContentPackRegistry } from "./contentPacks";
import { cancelStationRoutes } from "./engine";
import { isCoreContentPackId } from "./mods";
import type { BlueprintDefinition, GameState, ItemId, PlanetId } from "./types";

export interface VanillaSaveConversionPreview {
  packs: number;
  entities: number;
  belts: number;
  blueprints: number;
  constructionOrders: number;
  handcraftOrders: number;
  technologies: number;
  itemNames: string[];
}

export interface VanillaSaveConversionPlan {
  state: GameState;
  registry: ContentPackRegistry;
  preview: VanillaSaveConversionPreview;
  issues: string[];
}

function collectPackContent(registry: ContentPackRegistry) {
  const ids = {
    items: new Set<string>(),
    buildings: new Set<string>(),
    recipes: new Set<string>(),
    technologies: new Set<string>(),
    belts: new Set<string>(),
  };
  const beltTiers = new Set<number>();
  const itemIds = new Set<string>();
  const manifests = Object.values(registry.packs).flatMap(pack => [
    pack.manifest, ...(pack.previousManifests ?? []),
  ]);
  for (const manifest of manifests) {
    for (const kind of ["items", "buildings", "recipes", "technologies", "belts"] as const) {
      for (const entry of manifest[kind] ?? []) {
        if (!isCoreContentPackId(kind, entry.id)) ids[kind].add(entry.id);
      }
    }
    for (const entry of manifest.items ?? []) itemIds.add(entry.id);
    for (const belt of manifest.belts ?? []) beltTiers.add(belt.tier);
    for (const alias of manifest.idMigrations ?? []) {
      if (!isCoreContentPackId(alias.kind, alias.from)) ids[alias.kind].add(alias.from);
      if (alias.kind === "items") itemIds.add(alias.from);
    }
  }
  return { ids, beltTiers, itemIds };
}

function convertBlueprint(
  blueprint: BlueprintDefinition,
  ids: ContentIdSets,
  tiers: ReadonlySet<number>,
): BlueprintDefinition | undefined {
  const entities = blueprint.entities.filter(entity => !ids.buildings.has(entity.buildingId));
  const resourceAnchors = blueprint.resourceAnchors?.filter(anchor =>
    !ids.items.has(anchor.resourceId) && !ids.buildings.has(anchor.extractorBuildingId));
  const keys = new Set([...entities.map(entity => entity.key), ...(resourceAnchors ?? []).map(anchor => anchor.key)]);
  if (keys.size === 0) return undefined;
  return removeContentIdReferences({
    ...blueprint,
    entities,
    ...(resourceAnchors ? { resourceAnchors } : {}),
    belts: blueprint.belts.filter(belt =>
      !ids.items.has(belt.itemId) && !tiers.has(belt.tier) &&
      keys.has(belt.sourceKey) && keys.has(belt.targetKey)),
    ...(blueprint.externalPorts ? {
      externalPorts: blueprint.externalPorts.filter(port => !ids.items.has(port.itemId) && keys.has(port.entityKey)),
    } : {}),
  }, ids);
}

function analyzeConversion(state: GameState, registry: ContentPackRegistry) {
  const content = collectPackContent(registry);
  const removedEntities = new Set(state.entities.filter(entity =>
    Boolean(entity.buildingId && content.ids.buildings.has(entity.buildingId)) ||
    Boolean(entity.kind === "vein" && entity.resourceId && content.ids.items.has(entity.resourceId)),
  ).map(entity => entity.id));
  const removedBelts = new Set(state.belts.filter(belt =>
    content.ids.items.has(belt.itemId) || content.beltTiers.has(belt.tier) ||
    removedEntities.has(belt.source) || removedEntities.has(belt.target),
  ).map(belt => belt.id));
  const affectedBlueprint = (blueprint: BlueprintDefinition) =>
    hasTypedContentIdReference(blueprint, content.ids) ||
    blueprint.belts.some(belt => content.beltTiers.has(belt.tier));
  const blueprints = new Map(state.blueprints.map(blueprint => [blueprint.id, blueprint]));
  const versions = new Map(state.blueprintVersions.map(version => [version.id, version.definition]));
  const cancelledOrders = new Set(state.constructionQueue.filter(order => {
    const definition = order.blueprintVersionId ? versions.get(order.blueprintVersionId) : blueprints.get(order.blueprintId);
    return Boolean(definition && affectedBlueprint(definition)) || hasTypedContentIdReference(order, content.ids) ||
      Object.values(order.placedEntityIdsByKey ?? {}).some(id => removedEntities.has(id));
  }).map(order => order.id));
  const techIds = new Set([...state.research.completedTechIds, ...state.research.queuedTechIds,
    state.research.selectedTechId, state.research.pausedTechId, ...Object.keys(state.research.progressByTech)]
    .filter((id): id is string => Boolean(id && content.ids.technologies.has(id))));
  const preview: VanillaSaveConversionPreview = {
    packs: Object.values(registry.packs).filter(pack => pack.enabled).length,
    entities: removedEntities.size,
    belts: removedBelts.size,
    blueprints: state.blueprints.filter(affectedBlueprint).length,
    constructionOrders: cancelledOrders.size,
    handcraftOrders: state.handcraftQueue.filter(order => content.ids.recipes.has(order.recipeId)).length,
    technologies: techIds.size,
    itemNames: [...content.itemIds].sort().map(id => ITEMS[id as ItemId]?.name ?? id),
  };
  return { ...content, removedEntities, removedBelts, cancelledOrders, preview };
}

/** Cheap preview only. The full state is copied after the player confirms. */
export function getVanillaSaveConversionPreview(state: GameState, registry: ContentPackRegistry): VanillaSaveConversionPreview {
  return analyzeConversion(state, registry).preview;
}

export function prepareVanillaSaveConversion(source: GameState, registry: ContentPackRegistry): VanillaSaveConversionPlan {
  const analysis = analyzeConversion(source, registry);
  // Retain configurations for the verified recovery snapshot.
  const targetRegistry = structuredClone(registry);
  for (const pack of Object.values(targetRegistry.packs)) pack.enabled = false;
  const draft = structuredClone(source);
  const { ids, beltTiers, removedEntities, removedBelts, cancelledOrders } = analysis;
  const add = (record: Partial<Record<string, number>>, id: string, amount: number) => {
    const total = (record[id] ?? 0) + amount;
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(total) || total < 0) {
      throw new Error(`${id} 回收后超过安全库存上限，请先转移库存后重试`);
    }
    record[id] = total;
  };
  const refund = (planetId: PlanetId, inventory: Partial<Record<ItemId, number>>) => {
    const tray = planetId === draft.activePlanetId ? draft.tray : (draft.planetTrays[planetId] ??= {});
    for (const [id, amount] of Object.entries(inventory)) {
      if (!amount || ids.items.has(id)) continue;
      if (id === "logistics_drone" || id === "logistics_vessel") add(draft.portableFleet, id, amount);
      else add(tray, id, amount);
    }
  };
  try {
    // Cargo remains reserved in the supply station until arrival. Cancelling a
    // route releases that reservation and refunds its reserved warpers once.
    cancelStationRoutes(draft, (station, route) =>
      ids.items.has(route.itemId) || removedEntities.has(station.id) || removedEntities.has(route.peerId) ||
      removedEntities.has(route.vehicleStationId ?? station.id) ||
      (route.waypointStationIds ?? []).some(id => removedEntities.has(id)));
    for (const inventory of [draft.tray, ...Object.values(draft.planetTrays)]) {
      for (const [id, amount] of Object.entries(inventory)) {
        if (!ids.items.has(id) && amount !== undefined && !Number.isSafeInteger(amount)) {
          throw new Error(`${id} 回收后超过安全库存上限，请先转移库存后重试`);
        }
      }
    }

    for (const entity of draft.entities) {
      if (removedEntities.has(entity.id)) {
        refund(entity.planetId, entity.inputs);
        refund(entity.planetId, entity.outputs);
        if (entity.kind === "vein" && entity.resourceId && entity.minerCount > 0) {
          const extractor = entity.extractorBuildingId ?? getExtractorBuildingId(entity.resourceId);
          if (extractor && !ids.buildings.has(extractor)) add(draft.construction, extractor, entity.minerCount);
        }
        if (entity.sprayCoaterInstalled) add(draft.construction, "spray_coater", 1);
        refund(entity.planetId, {
          logistics_drone: entity.stationDrones ?? 0,
          logistics_vessel: entity.stationVessels ?? 0,
          space_warper: entity.stationWarpers ?? 0,
        });
      } else {
        if (entity.recipeId && ids.recipes.has(entity.recipeId)) {
          delete entity.recipeId;
          entity.progress = 0;
        }
        if (entity.extractorBuildingId && ids.buildings.has(entity.extractorBuildingId)) {
          delete entity.extractorBuildingId;
          entity.minerCount = 0;
          entity.progress = 0;
        }
        if (entity.fuelItemId && ids.items.has(entity.fuelItemId)) {
          delete entity.fuelItemId;
          entity.fuelRemainingMj = 0;
          entity.powerOutputKw = 0;
        }
      }
      if (entity.quantumTransition) {
        entity.quantumTransition.bridges = entity.quantumTransition.bridges.filter(bridge => {
          const remove = ids.items.has(bridge.itemId) ||
            removedEntities.has(bridge.sourceStationId) || removedEntities.has(bridge.targetStationId);
          // Bridge contracts mirror legacy route reservations. Their material
          // remains in the supply station until the route actually arrives.
          return !remove;
        });
      }
    }
    draft.entities = draft.entities.filter(entity => !removedEntities.has(entity.id));
    for (const belt of draft.belts) {
      if (removedBelts.has(belt.id) && !beltTiers.has(belt.tier)) add(draft.construction, getBeltConstructionId(belt.tier), belt.lanes);
    }
    draft.belts = draft.belts.filter(belt => !removedBelts.has(belt.id));
    if (draft.cargo && ids.items.has(draft.cargo.itemId)) draft.cargo = null;
    else if (draft.cargo?.origin?.id && removedEntities.has(draft.cargo.origin.id)) delete draft.cargo.origin;

    for (const order of draft.handcraftQueue) {
      if (!ids.recipes.has(order.recipeId) || order.progress <= 0) continue;
      const recipe = getRecipe(order.recipeId);
      if (!recipe) throw new Error(`缺少 ${order.recipeId} 配方，无法核对已投入的手合材料`);
      for (const input of recipe.inputs) refund(order.planetId, { [input.itemId]: input.amount });
    }
    draft.handcraftQueue = draft.handcraftQueue.filter(order => !ids.recipes.has(order.recipeId));
    for (const order of draft.constructionQueue) {
      if (!cancelledOrders.has(order.id)) continue;
      for (const [id, amount] of Object.entries(order.reservedConstruction ?? {})) {
        if (!ids.buildings.has(id) && !ids.belts.has(id)) add(draft.construction, id, amount ?? 0);
      }
      for (const [id, amount] of Object.entries(order.reservedFleet ?? {})) {
        add(draft.portableFleet, id, amount ?? 0);
      }
    }
    draft.constructionQueue = draft.constructionQueue.filter(order => !cancelledOrders.has(order.id));
    const entitiesById = new Map(source.entities.map(entity => [entity.id, entity]));
    for (const [entityId, job] of Object.entries(draft.constructionAutomation.jobs)) {
      if (!removedEntities.has(entityId) && !hasTypedContentIdReference(job, ids)) continue;
      refund(entitiesById.get(entityId)?.planetId ?? draft.activePlanetId, job.inventory);
      delete draft.constructionAutomation.jobs[entityId];
    }
    for (const [entityId, inventory] of Object.entries(draft.constructionAutomation.quantumMaterialBuffer ?? {})) {
      if (!removedEntities.has(entityId)) continue;
      refund(entitiesById.get(entityId)?.planetId ?? draft.activePlanetId, inventory);
      delete draft.constructionAutomation.quantumMaterialBuffer![entityId];
    }
    draft.blueprints = draft.blueprints.flatMap(blueprint => {
      const converted = convertBlueprint(blueprint, ids, beltTiers);
      return converted ? [converted] : [];
    });
    draft.blueprintVersions = draft.blueprintVersions.flatMap(version => {
      const definition = convertBlueprint(version.definition, ids, beltTiers);
      return definition ? [{ ...version, definition }] : [];
    });
    draft.productionPlans = draft.productionPlans.filter(plan => !ids.items.has(plan.itemId));
    const candidate = removeContentIdReferences(draft, ids);
    candidate.contentPacks = [];
    candidate.research.selectedTechId ??= null;
    candidate.research.pausedTechId ??= null;
    if (hasTypedContentIdReference(candidate, ids)) throw new Error("仍有内容包引用，转换已停止，请导出存档供排查");
    return { state: candidate, registry: targetRegistry, preview: analysis.preview, issues: [] };
  } catch (error) {
    return { state: source, registry, preview: analysis.preview, issues: [error instanceof Error ? error.message : "无法安全完成转换"] };
  }
}
