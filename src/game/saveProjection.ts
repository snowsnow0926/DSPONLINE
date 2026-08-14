import { isAchievementId } from "./progression";
import { normalizeIdleSettlementState } from "./idleSettlement";
import { getActiveContentPackReferences, type ContentPackRegistry } from "./contentPacks";
import { omitSaveContractDefaults } from "./saveFieldContract";
import type { BeltConnection, BlueprintDefinition, FactoryEntity, GameState, ItemId, StationSlot } from "./types";

/**
 * Pure, Worker-safe projection of runtime state into the v46 persistent JSON
 * shape. This module must never construct or import a Worker.
 */
export function projectPersistentSaveState(state: GameState, contentPackRegistry: ContentPackRegistry): GameState {
  const { runtimeFlow: _runtimeFlow, ...quantumLogisticsNetwork } = state.quantumLogisticsNetwork;
  const compactRecord = (value: Partial<Record<ItemId, number>>): Partial<Record<ItemId, number>> => ({ ...value });
  const compactStationSlots = (slots: StationSlot[] | undefined): StationSlot[] | undefined => {
    if (!slots) return undefined;
    const compact = slots.map((slot) => {
      const projected = { ...slot } as Record<string, any>;
      omitSaveContractDefaults(projected, "station-slot", state.version);
      return projected as StationSlot;
    });
    // Slot indexes are authoritative for routes and cursors. Only trim a
    // JSON-empty suffix; never filter the array or collapse an interior slot.
    while (compact.length > 0 && Object.values(compact.at(-1) as unknown as Record<string, unknown>)
      .every((value) => value === undefined)) compact.pop();
    return compact;
  };
  const compactEntity = (entity: FactoryEntity): FactoryEntity => {
    const compact = {
      ...entity,
      inputs: compactRecord(entity.inputs),
      outputs: compactRecord(entity.outputs),
      ...(entity.stationSlots ? { stationSlots: compactStationSlots(entity.stationSlots) } : {}),
      ...(entity.proliferatorBonusProgress
        ? { proliferatorBonusProgress: compactRecord(entity.proliferatorBonusProgress) }
        : {}),
    } as Record<string, any>;
    if (entity.buildingId === "micro_black_hole_connector" && state.version >= 46) {
      if (typeof entity.blackHolePaused !== "boolean" || typeof entity.blackHoleActivationConfirmed !== "boolean") {
        throw new TypeError("A current micro black hole must have explicit pause and activation-confirmation state before saving");
      }
    }
    // Older clients briefly wrote quantumTarget to every entity. It remains a
    // persisted field only for the interstellar station where it is meaningful.
    if (entity.buildingId !== "interstellar_logistics_station") delete compact.quantumTarget;
    omitSaveContractDefaults(compact, "entity", state.version);
    if (entity.buildingId === "micro_black_hole_connector" && state.version >= 46) {
      // This final assignment deliberately runs after sparse-default omission.
      // A future shared-contract entry cannot silently turn an active,
      // player-confirmed sink into the fail-closed load default.
      compact.blackHolePaused = entity.blackHolePaused;
      compact.blackHoleActivationConfirmed = entity.blackHoleActivationConfirmed;
    }
    return compact as FactoryEntity;
  };
  const compactBelt = (belt: BeltConnection): BeltConnection => {
    const compact = { ...belt } as Record<string, any>;
    omitSaveContractDefaults(compact, "belt", state.version);
    return compact as BeltConnection;
  };
  const persistentEntities = state.entities.map(compactEntity);
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
