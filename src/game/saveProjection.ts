import { isAchievementId } from "./progression";
import { normalizeIdleSettlementState } from "./idleSettlement";
import { getActiveContentPackReferences, type ContentPackRegistry } from "./contentPacks";
import type { BeltConnection, BlueprintDefinition, FactoryEntity, GameState, ItemId } from "./types";

/**
 * Pure, Worker-safe projection of runtime state into the v46 persistent JSON
 * shape. This module must never construct or import a Worker.
 */
export function projectPersistentSaveState(state: GameState, contentPackRegistry: ContentPackRegistry): GameState {
  const { runtimeFlow: _runtimeFlow, ...quantumLogisticsNetwork } = state.quantumLogisticsNetwork;
  const compactRecord = (value: Partial<Record<ItemId, number>>): Partial<Record<ItemId, number>> => ({ ...value });
  const omitDefault = (record: Record<string, any>, key: string, expected: unknown) => {
    if (Object.is(record[key], expected) || record[key] === undefined) delete record[key];
  };
  const compactEntity = (entity: FactoryEntity): FactoryEntity => {
    const { quantumTarget: _legacyQuantumTarget, ...withoutLegacyQuantumTarget } = entity;
    const compact = {
      ...withoutLegacyQuantumTarget,
      inputs: compactRecord(entity.inputs),
      outputs: compactRecord(entity.outputs),
      ...(entity.proliferatorBonusProgress
        ? { proliferatorBonusProgress: compactRecord(entity.proliferatorBonusProgress) }
        : {}),
    } as Record<string, any>;
    omitDefault(compact, "interactionLocked", false);
    omitDefault(compact, "powerGridId", "grid-a");
    omitDefault(compact, "powerPriority", 2);
    omitDefault(compact, "machineCount", 0);
    omitDefault(compact, "minerCount", 0);
    omitDefault(compact, "progress", 0);
    omitDefault(compact, "routingCursor", 0);
    omitDefault(compact, "powerInputKw", 0);
    omitDefault(compact, "powerOutputKw", 0);
    omitDefault(compact, "stationProgress", 0);
    omitDefault(compact, "stationTrips", 0);
    omitDefault(compact, "stationLastTransfer", 0);
    omitDefault(compact, "stationCongestion", 0);
    omitDefault(compact, "stationDispatchCursor", 0);
    omitDefault(compact, "proliferatorPoints", 0);
    omitDefault(compact, "resourceDepletionRemainder", 0);
    omitDefault(compact, "stationWarperAutoRefill", false);
    omitDefault(compact, "stationHubEnabled", false);
    omitDefault(compact, "quantumTarget", false);
    if (compact.stationWarpEnabled === true) delete compact.stationWarpEnabled;
    if (compact.proliferatorBonusProgress && Object.keys(compact.proliferatorBonusProgress).length === 0) delete compact.proliferatorBonusProgress;
    if (Object.keys(compact.inputs).length === 0) delete compact.inputs;
    if (Object.keys(compact.outputs).length === 0) delete compact.outputs;
    if (compact.stationLastSupplyPeerBySlot && Object.keys(compact.stationLastSupplyPeerBySlot).length === 0) delete compact.stationLastSupplyPeerBySlot;
    if (Array.isArray(compact.stationRoutes) && compact.stationRoutes.length === 0) delete compact.stationRoutes;
    return compact as FactoryEntity;
  };
  const compactBelt = (belt: BeltConnection): BeltConnection => {
    const compact = { ...belt } as Record<string, any>;
    omitDefault(compact, "lanes", 1);
    omitDefault(compact, "tier", 1);
    omitDefault(compact, "sorterTier", Math.min(3, belt.tier ?? 1));
    omitDefault(compact, "progress", 0);
    omitDefault(compact, "priority", 0);
    omitDefault(compact, "stackSize", 1);
    omitDefault(compact, "monitorEnabled", false);
    omitDefault(compact, "totalTransferred", 0);
    omitDefault(compact, "congestion", 0);
    omitDefault(compact, "lastFlow", 0);
    omitDefault(compact, "routeMode", "auto");
    return compact as BeltConnection;
  };
  const persistentEntities = state.entities.map((entity) => {
    const compact = compactEntity(entity);
    if (entity.buildingId === "interstellar_logistics_station") {
      return entity.quantumTarget === true ? { ...compact, quantumTarget: true } : compact;
    }
    return compact;
  });
  const sanitizeBlueprint = (blueprint: BlueprintDefinition): BlueprintDefinition => ({
    ...blueprint,
    entities: blueprint.entities.map((entity) => {
      const { quantumTarget: _legacyQuantumTarget, operationEnabledOnDeploy: _legacyOperation, ...withoutLegacyFields } = entity;
      if (entity.buildingId === "interstellar_logistics_station") return { ...withoutLegacyFields, quantumTarget: entity.quantumTarget === true };
      if (entity.buildingId === "micro_black_hole_connector") return typeof entity.operationEnabledOnDeploy === "boolean"
        ? { ...withoutLegacyFields, operationEnabledOnDeploy: entity.operationEnabledOnDeploy }
        : withoutLegacyFields;
      return withoutLegacyFields;
    }),
  });
  return {
    ...state,
    mode: state.mode === "speedrun" ? "speedrun" : "normal",
    idleSettlement: normalizeIdleSettlementState(state.idleSettlement),
    productionHistory: [],
    contentPacks: getActiveContentPackReferences(contentPackRegistry),
    achievements: {
      ...state.achievements,
      unlockedIds: state.achievements.unlockedIds.filter(isAchievementId),
    },
    entities: persistentEntities,
    belts: state.belts.map(compactBelt),
    blueprints: state.blueprints.map(sanitizeBlueprint),
    blueprintVersions: state.blueprintVersions.map((snapshot) => ({ ...snapshot, definition: sanitizeBlueprint(snapshot.definition) })),
    planetTrays: { ...state.planetTrays, [state.activePlanetId]: { ...state.tray } },
    quantumLogisticsNetwork,
  };
}
