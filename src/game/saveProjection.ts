import { isAchievementId } from "./progression";
import { normalizeIdleSettlementState } from "./idleSettlement";
import { getActiveContentPackReferences, type ContentPackRegistry } from "./contentPacks";
import { omitSaveContractDefaults } from "./saveFieldContract";
import type { BeltConnection, BlueprintDefinition, FactoryEntity, GameState, ItemId, StationSlot } from "./types";

/**
 * Pure, Worker-safe projection of runtime state into the v47 persistent JSON
 * shape. This module must never construct or import a Worker.
 */
export function projectPersistentSaveState(state: GameState, contentPackRegistry: ContentPackRegistry): GameState {
  const { runtimeFlow: _runtimeFlow, ...quantumLogisticsNetwork } = state.quantumLogisticsNetwork;
  // M0 bridge: a v46 build must not write the orbital-station namespace. A
  // bridge build reading a v47 save keeps the namespace untouched.
  const { orbitalStation: _omittedOrbitalStation, ...stateWithoutOrbitalStation } = state;
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
    if (entity.buildingId === "orbital_cargo_terminal" && state.version >= 47) {
      const binding = entity.orbitalCargoBinding;
      const validBinding = binding === null || binding === undefined || binding.kind === "construction" ||
        binding.kind === "contract" && typeof binding.contractId === "string" && binding.contractId.length > 0 && binding.contractId.length <= 180;
      if (state.mode !== "normal" || entity.machineCount !== 1 || !Array.isArray(entity.orbitalCargoPortItems) ||
        entity.orbitalCargoPortItems.length !== 4 || !validBinding || !Number.isFinite(entity.orbitalCargoProgress) ||
        (entity.orbitalCargoProgress ?? -1) < 0 || (entity.orbitalCargoProgress ?? 1) >= 1 ||
        typeof entity.orbitalCargoTotalUploaded !== "string" || !/^(0|[1-9][0-9]{0,255})$/.test(entity.orbitalCargoTotalUploaded)) {
        throw new TypeError("A current orbital cargo terminal must have one machine, four stable ports, and valid upload state before saving");
      }
    }
    // Older clients briefly wrote quantumTarget to every entity. It remains a
    // persisted field only for the interstellar station where it is meaningful.
    if (entity.buildingId !== "interstellar_logistics_station") delete compact.quantumTarget;
    omitSaveContractDefaults(compact, "entity", state.version);
    // v47 migration already restores these exact inactive defaults. Keeping
    // them on every late-game entity added several MiB and multiplied the
    // temporary JSON/TextEncoder memory needed by every autosave. Omit only
    // values whose absence is explicitly normalized back to the same runtime
    // state; active transitions, fuel and coater configuration stay intact.
    if (compact.fuelRemainingMj === 0) delete compact.fuelRemainingMj;
    if (compact.sprayCoaterInstalled === false) delete compact.sprayCoaterInstalled;
    if (compact.stationModeTransition === null) delete compact.stationModeTransition;
    if (compact.quantumTransition === null) delete compact.quantumTransition;
    if (Array.isArray(compact.elevatorOutputItems) && compact.elevatorOutputItems.length === 5 &&
      compact.elevatorOutputItems.every((item: unknown) => item === null)) {
      delete compact.elevatorOutputItems;
    }
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
    ...(state.version >= 47 ? state : stateWithoutOrbitalStation),
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
  } as unknown as GameState;
}
