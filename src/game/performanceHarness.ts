import {
  connectBeltWithResult,
  createBlueprint,
  placeBuilding,
  removeBelt,
  removeBlueprint,
  removeEntity,
} from "./engine";
import { readPersistedLocalSaveValue } from "./localSaveStore";
import { recordGameStateEditLineage } from "./gameStateEditLineage";
import { inspectSave, migrateGame } from "./storage";
import type { BuildingId, ConstructionId, GameState } from "./types";

export interface FactoryOperationScenarioResult {
  original: { entities: number; belts: number; blueprints: number };
  final: { entities: number; belts: number; blueprints: number };
  buildingId: BuildingId | null;
  placementOrigin: { x: number; y: number };
  placed: number;
  removed: number;
  reconnected: number;
  blueprinted: number;
}

export interface FactoryOperationScenarioRun {
  state: GameState;
  result: FactoryOperationScenarioResult;
}

/**
 * Run one atomic player-style edit batch. The caller owns the returned state;
 * the supplied authority is never mutated. Loopback production benchmarks use
 * this through the ordinary App command/history/Worker path instead of parsing
 * another 77 MB save for every round.
 */
export function runFactoryOperationScenario(initialState: GameState, rounds: number): FactoryOperationScenarioRun {
  const count = Math.max(1, Math.min(100, Math.floor(rounds)));
  let state: GameState = recordGameStateEditLineage(
    { ...initialState, construction: { ...initialState.construction } },
    initialState,
    {},
  );
  const original = { entities: state.entities.length, belts: state.belts.length, blueprints: state.blueprints.length };
  const preferredBuildingIds: BuildingId[] = ["arc_smelter", "assembling_machine_mk1", "storage_mk1"];
  const buildingId = preferredBuildingIds.find((candidate) => state.entities.some((entity) =>
    entity.planetId === state.activePlanetId && entity.buildingId === candidate && !entity.interactionLocked)) ??
    state.entities.find((entity) => entity.buildingId && entity.kind !== "vein" && !entity.interactionLocked)?.buildingId ?? null;
  const anchor = state.entities
    .filter((entity) => entity.planetId === state.activePlanetId)
    .reduce((current, entity) => ({
      x: Math.max(current.x, Math.abs(entity.position.x)),
      y: Math.max(current.y, Math.abs(entity.position.y)),
    }), { x: 0, y: 0 });
  const placementOrigin = { x: anchor.x + 10_000, y: anchor.y + 10_000 };
  let placed = 0;
  let removed = 0;
  let reconnected = 0;
  let blueprinted = 0;
  if (buildingId) state.construction[buildingId] = Math.max(1_000_000, Math.floor(state.construction[buildingId] ?? 0));
  for (let index = 0; index < count && buildingId; index += 1) {
    const before = state;
    const next = placeBuilding(state, buildingId, {
      x: placementOrigin.x + (index % 10) * 12,
      y: placementOrigin.y + Math.floor(index / 10) * 12,
    });
    if (next === before) continue;
    state = next;
    const created = state.entities.at(-1)?.id;
    if (!created) continue;
    placed += 1;
    const removedState = removeEntity(state, created);
    if (removedState !== state) {
      state = removedState;
      removed += 1;
    }
    state.construction[buildingId] = Math.max(1_000_000, Math.floor(state.construction[buildingId] ?? 0));
  }
  const beltCandidates = state.belts.slice(0, Math.min(count, state.belts.length)).map((belt) => ({ ...belt }));
  for (const belt of beltCandidates) {
    const removedState = removeBelt(state, belt.id);
    if (removedState === state) continue;
    state = removedState;
    const constructionId: ConstructionId = belt.tier === 3 ? "conveyor_belt_mk3" : belt.tier === 2 ? "conveyor_belt_mk2" : "conveyor_belt_mk1";
    state.construction[constructionId] = Math.max(1_000_000, Math.floor(state.construction[constructionId] ?? 0));
    const result = connectBeltWithResult(state, belt.source, belt.target, belt.itemId, belt.tier, belt.targetPortIndex, belt.lanes);
    if (result.created) {
      state = result.state;
      reconnected += 1;
    }
  }
  const blueprintEntityIds = state.entities
    .filter((entity) => entity.planetId === state.activePlanetId && entity.buildingId && !entity.interactionLocked)
    .slice(0, Math.min(24, count + 4))
    .map((entity) => entity.id);
  if (blueprintEntityIds.length > 0) {
    const next = createBlueprint(state, blueprintEntityIds, "memory-stress");
    if (next !== state) {
      state = next;
      blueprinted += 1;
      const createdBlueprint = state.blueprints.at(-1);
      if (createdBlueprint) state = removeBlueprint(state, createdBlueprint.id);
    }
  }
  return {
    state,
    result: {
      original,
      final: { entities: state.entities.length, belts: state.belts.length, blueprints: state.blueprints.length },
      buildingId,
      placementOrigin,
      placed,
      removed,
      reconnected,
      blueprinted,
    },
  };
}

/** Fallback for a harness that is not hosted by FactoryGame. It imports one
 * verified primary into an isolated graph and never publishes that result. */
export async function runReadOnlyFactoryOperationScenario(rounds: number): Promise<FactoryOperationScenarioResult> {
  const raw = await readPersistedLocalSaveValue("dsp-idle-network.save.v1");
  const inspection = raw ? inspectSave(raw) : null;
  if (!inspection?.state) throw new Error("真实存档未能从 IndexedDB 读取");
  const migrated = migrateGame(inspection.state);
  if (!migrated) throw new Error("真实存档迁移失败");
  return runFactoryOperationScenario(migrated, rounds).result;
}
