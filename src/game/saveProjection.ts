import { isAchievementId } from "./progression";
import { normalizeIdleSettlementState } from "./idleSettlement";
import { getActiveContentPackReferences, type ContentPackRegistry } from "./contentPacks";
import {
  listSaveContractFields,
  omitSaveContractDefaults,
  resolveSaveContractDefault,
  type SaveFieldScope,
} from "./saveFieldContract";
import { normalizeQuantumLogisticsNetworkState } from "./quantumLogisticsNetwork";
import type { BeltConnection, BlueprintDefinition, FactoryEntity, GameState, ItemId, StationSlot } from "./types";

const CURRENT_PROJECTED_SAVE_VERSION = 47;
const PERSISTED_STATION_SLOT_COUNT = 5;

function hydrateContractDefaultsInPlace(
  record: Record<string, any>,
  scope: SaveFieldScope,
  version: number,
): void {
  for (const field of listSaveContractFields(scope, version, "missing-default")) {
    if (Object.hasOwn(record, field) && record[field] !== undefined) continue;
    const resolved = resolveSaveContractDefault(scope, field, record, version);
    if (resolved.applies) record[field] = resolved.value;
  }
}

/**
 * Rehydrates only the exact defaults removed by projectPersistentSaveState.
 *
 * The input is an owned, checksum-verified v47 Worker projection, so this
 * deliberately mutates it in place instead of cloning tens of thousands of
 * entities a second time. It is not a general save migration or import path;
 * external/legacy saves must continue through storage.migrateGame.
 */
export function hydrateCurrentPersistentSaveProjection(state: unknown): GameState {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("当前持久化投影结构无效");
  }
  const projected = state as Record<string, any>;
  if (projected.version !== CURRENT_PROJECTED_SAVE_VERSION ||
    (projected.mode !== "normal" && projected.mode !== "speedrun") ||
    typeof projected.activePlanetId !== "string" || projected.activePlanetId.length === 0 ||
    !Array.isArray(projected.entities) || !Array.isArray(projected.belts) ||
    !projected.quantumLogisticsNetwork || typeof projected.quantumLogisticsNetwork !== "object") {
    throw new Error("当前持久化投影身份无效");
  }
  for (const candidate of projected.entities) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("当前持久化投影实体无效");
    }
    const entity = candidate as Record<string, any>;
    hydrateContractDefaultsInPlace(entity, "entity", projected.version);
    if (entity.fuelRemainingMj === undefined) entity.fuelRemainingMj = 0;
    if (entity.sprayCoaterInstalled === undefined) entity.sprayCoaterInstalled = false;
    const interstellarStation = entity.buildingId === "interstellar_logistics_station";
    const orbitalCollector = entity.buildingId === "orbital_collector";
    if (interstellarStation && entity.stationModeTransition === undefined) entity.stationModeTransition = null;
    if ((interstellarStation || orbitalCollector) && entity.quantumTransition === undefined) entity.quantumTransition = null;
    if (interstellarStation && entity.elevatorOutputItems === undefined) {
      entity.elevatorOutputItems = [null, null, null, null, null];
    }
    if (entity.kind === "station" && !orbitalCollector) {
      if (!Array.isArray(entity.stationSlots)) entity.stationSlots = [];
      for (const slot of entity.stationSlots) {
        if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
          throw new Error("当前持久化投影物流槽位无效");
        }
        hydrateContractDefaultsInPlace(slot as Record<string, any>, "station-slot", projected.version);
      }
      while (entity.stationSlots.length < PERSISTED_STATION_SLOT_COUNT) {
        const slot: Record<string, any> = {};
        hydrateContractDefaultsInPlace(slot, "station-slot", projected.version);
        entity.stationSlots.push(slot);
      }
    }
  }
  for (const candidate of projected.belts) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("当前持久化投影传送带无效");
    }
    hydrateContractDefaultsInPlace(candidate as Record<string, any>, "belt", projected.version);
  }
  projected.quantumLogisticsNetwork = normalizeQuantumLogisticsNetworkState(projected.quantumLogisticsNetwork);
  return projected as GameState;
}

/**
 * Pure, Worker-safe projection of runtime state into the v47 persistent JSON
 * shape. This module must never construct or import a Worker.
 */
function createPersistentRecordProjector(state: GameState, owned: boolean) {
  const compactRecord = (value: Partial<Record<ItemId, number>>): Partial<Record<ItemId, number>> => owned ? value : { ...value };
  const compactStationSlots = (slots: StationSlot[] | undefined): StationSlot[] | undefined => {
    if (!slots) return undefined;
    const compact = owned ? slots : slots.map((slot) => ({ ...slot }));
    for (const slot of compact) {
      const projected = slot as Record<string, any>;
      omitSaveContractDefaults(projected, "station-slot", state.version);
    }
    while (compact.length > 0 && Object.values(compact.at(-1) as unknown as Record<string, unknown>)
      .every((value) => value === undefined)) compact.pop();
    return compact;
  };
  const compactEntity = (entity: FactoryEntity): FactoryEntity => {
    const compact = (owned ? entity : {
      ...entity,
      inputs: compactRecord(entity.inputs),
      outputs: compactRecord(entity.outputs),
    }) as Record<string, any>;
    if (entity.stationSlots) compact.stationSlots = compactStationSlots(entity.stationSlots);
    if (entity.proliferatorBonusProgress) compact.proliferatorBonusProgress = compactRecord(entity.proliferatorBonusProgress);
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
    if (entity.buildingId !== "interstellar_logistics_station") delete compact.quantumTarget;
    omitSaveContractDefaults(compact, "entity", state.version);
    if (compact.fuelRemainingMj === 0) delete compact.fuelRemainingMj;
    if (compact.sprayCoaterInstalled === false) delete compact.sprayCoaterInstalled;
    if (compact.stationModeTransition === null) delete compact.stationModeTransition;
    if (compact.quantumTransition === null) delete compact.quantumTransition;
    if (Array.isArray(compact.elevatorOutputItems) && compact.elevatorOutputItems.length === 5 &&
      compact.elevatorOutputItems.every((item: unknown) => item === null)) {
      delete compact.elevatorOutputItems;
    }
    if (entity.buildingId === "micro_black_hole_connector" && state.version >= 46) {
      compact.blackHolePaused = entity.blackHolePaused;
      compact.blackHoleActivationConfirmed = entity.blackHoleActivationConfirmed;
    }
    return compact as FactoryEntity;
  };
  const compactBelt = (belt: BeltConnection): BeltConnection => {
    const compact = (owned ? belt : { ...belt }) as Record<string, any>;
    omitSaveContractDefaults(compact, "belt", state.version);
    return compact as BeltConnection;
  };
  return { compactEntity, compactBelt };
}

function projectPersistentSaveStateInternal(
  state: GameState,
  contentPackRegistry: ContentPackRegistry,
  owned: boolean,
): GameState {
  const { runtimeFlow: _runtimeFlow, ...quantumLogisticsNetwork } = state.quantumLogisticsNetwork;
  const { compactEntity, compactBelt } = createPersistentRecordProjector(state, owned);
  const persistentEntities = state.entities.map(compactEntity);
  const sanitizeBlueprint = (blueprint: BlueprintDefinition): BlueprintDefinition => {
    const projected = (owned ? blueprint : { ...blueprint }) as BlueprintDefinition;
    projected.entities = blueprint.entities.map((entity) => {
      const { quantumTarget: _legacyQuantumTarget, operationEnabledOnDeploy: _legacyOperation, ...withoutLegacyFields } = entity;
      if (entity.buildingId === "interstellar_logistics_station") return { ...withoutLegacyFields, quantumTarget: entity.quantumTarget === true };
      if (entity.buildingId === "micro_black_hole_connector") return typeof entity.operationEnabledOnDeploy === "boolean"
        ? { ...withoutLegacyFields, operationEnabledOnDeploy: entity.operationEnabledOnDeploy }
        : withoutLegacyFields;
      return withoutLegacyFields;
    });
    return projected;
  };
  const projected = (owned ? state : { ...state }) as GameState;
  // M0 bridge: a v46 build must not write the orbital-station namespace. A
  // bridge build reading a v47 save keeps the namespace untouched.
  if (state.version < 47) delete (projected as unknown as Record<string, unknown>).orbitalStation;
  Object.assign(projected, {
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
  });
  return projected;
}

export function projectPersistentSaveState(state: GameState, contentPackRegistry: ContentPackRegistry): GameState {
  return projectPersistentSaveStateInternal(state, contentPackRegistry, false);
}

export interface PersistentSaveProjectionParts {
  base: Omit<GameState, "entities" | "belts">;
  entityCount: number;
  beltCount: number;
  projectEntityRange: (offset: number, count: number) => GameState["entities"];
  projectBeltRange: (offset: number, count: number) => GameState["belts"];
}

/**
 * Bounded-memory view of the exact v47 projection. The authoritative
 * Simulation Worker can serialize one entity/belt page at a time without
 * first constructing a second 80k/155k record graph or a 77 MB JSON transfer.
 *
 * Each range deliberately delegates to the same projection implementation as
 * the public full-save boundary. That keeps the streaming sidecar byte-for-
 * byte equivalent while the first-layer architecture is still JavaScript.
 */
export function createPersistentSaveProjectionParts(
  state: GameState,
  contentPackRegistry: ContentPackRegistry,
): PersistentSaveProjectionParts {
  const projectedBase = projectPersistentSaveStateInternal({ ...state, entities: [], belts: [] }, contentPackRegistry, false);
  const { compactEntity, compactBelt } = createPersistentRecordProjector(state, false);
  const { entities: _entities, belts: _belts, ...base } = projectedBase;
  return {
    base,
    entityCount: state.entities.length,
    beltCount: state.belts.length,
    projectEntityRange: (offset, count) => state.entities.slice(offset, offset + count).map(compactEntity),
    projectBeltRange: (offset, count) => state.belts.slice(offset, offset + count).map(compactBelt),
  };
}

/**
 * Save-Worker-only projection for an exclusively owned decoded checkpoint.
 * It drops runtime-only leaves in place, avoiding a second 80k/150k record
 * graph while the original transferable bytes remain the exact return source.
 */
export function projectPersistentSaveStateInPlaceOwned(state: GameState, contentPackRegistry: ContentPackRegistry): GameState {
  return projectPersistentSaveStateInternal(state, contentPackRegistry, true);
}
