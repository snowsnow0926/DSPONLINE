import { describe, expect, it } from "vitest";
import { createContentPackRegistry } from "../../src/game/contentPacks";
import { createInitialState } from "../../src/game/engine";
import { serializePersistentSaveEnvelopeToTransfer, serializeSaveStateJsonChunksToTransfer } from "./terminal-projection-prototype";
import { projectPersistentSaveState } from "../../src/game/saveProjection";
import { serializeSaveEnvelopeToTransfer } from "../../src/game/saveTransfer";
import type { FactoryEntity, GameState } from "../../src/game/types";

const registry = createContentPackRegistry();
const options = { formatVersion: 2, kind: "primary" as const, savedAt: 1_800_000_000_000,
  mode: "normal" as const, slot: "main" as const };

function fixture(): GameState {
  const state = createInitialState(7_951, false);
  for (let index = 0; index < 13; index++) state.entities.push({
    id: `bounded-${index}-矿🚀\ud800`, kind: "machine", planetId: "home", position: { x: index * 7, y: 40 },
    buildingId: "arc_smelter", recipeId: "iron_ingot", machineCount: 1, minerCount: 0,
    inputs: { iron_ore: index === 0 ? 0 : 137 }, outputs: { iron_ingot: 7_000 },
    progress: 0.25, routingCursor: 0, utilization: 0, productionRate: 0, interactionLocked: false,
    fuelRemainingMj: 0, sprayCoaterInstalled: false,
  });
  state.entities.push({ ...state.entities.at(-1)!, id: "bounded-station", kind: "station",
    buildingId: "interstellar_logistics_station", quantumTarget: true,
    stationSlots: [
      { itemId: "iron_ore", localMode: "supply", remoteMode: "demand", minimumLoad: 0.1,
        minStock: 0, maxStock: 7_000, priority: 0, routePolicy: "direct", warperBudget: 0 },
    ],
  });
  for (let index = 0; index < 19; index++) state.belts.push({
    id: `bounded-belt-${index}`, planetId: "home", source: state.entities[0].id, target: state.entities.at(-1)!.id,
    itemId: "iron_ore", lanes: 1, tier: 1, sorterTier: 1, progress: 0.25,
    priority: 0, lastFlow: index % 3, monitorEnabled: false, congestion: 0,
  });
  return state;
}

describe("bounded read-only persistent envelope serialization", () => {
  it.each([45, 46, 47] as const)("matches complete bytes, checksums and property order for v%s", (version) => {
    for (const mode of ["normal", "speedrun"] as const) {
      const state = fixture();
      state.version = version;
      state.mode = mode;
      const reordered = Object.fromEntries(Object.entries(state).reverse()) as unknown as GameState;
      const before = structuredClone(reordered);
      const metadata = { ...options, mode };
      const expected = serializeSaveEnvelopeToTransfer(projectPersistentSaveState(reordered, registry), metadata);
      for (const size of [1, 2, 7, 512]) {
        const actual = serializePersistentSaveEnvelopeToTransfer(reordered, registry, metadata, size);
        expect(actual).toEqual(expected);
        expect(reordered).toEqual(before);
        expect(JSON.stringify(reordered)).toBe(JSON.stringify(before));
      }
    }
  });

  it("preserves independent retries after projection rejects a late record", () => {
    const state = fixture();
    const blackHole = { ...state.entities.at(-1)!, buildingId: "micro_black_hole_connector" } as FactoryEntity;
    state.entities.push(blackHole);
    const before = structuredClone(state);
    expect(() => serializePersistentSaveEnvelopeToTransfer(state, registry, options, 2)).toThrow(TypeError);
    expect(state).toEqual(before);
    blackHole.blackHolePaused = true;
    blackHole.blackHoleActivationConfirmed = false;
    expect(serializePersistentSaveEnvelopeToTransfer(state, registry, options, 2))
      .toEqual(serializeSaveEnvelopeToTransfer(projectPersistentSaveState(state, registry), options));
  });

  it("rejects invalid batch limits before reading source state", () => {
    const state = new Proxy({} as GameState, { get() { throw new Error("source was read"); } });
    for (const size of [0, -1, 1.5, 4_097, Infinity, NaN]) {
      expect(() => serializePersistentSaveEnvelopeToTransfer(state, registry, options, size)).toThrow("存档投影批大小无效");
    }
  });

  it("preserves exact UTF-8 and UTF-16 proofs at every fragment boundary", () => {
    const state = { name: "矿🚀\ud800\udc00\ud800x\udc00", values: [0, -0, 137, null], nested: { kept: true } };
    const text = JSON.stringify(state);
    for (const metadata of [options, { ...options, kind: "slot" as const, mode: "speedrun" as const, slot: 3 as const },
      { ...options, kind: "snapshot" as const, reason: '矿🚀 "state":{} ,"checksum":"escape"' }]) {
      const expected = serializeSaveEnvelopeToTransfer(state, metadata);
      for (let split = 0; split <= text.length; split++) {
        expect(serializeSaveStateJsonChunksToTransfer([text.slice(0, split), "", text.slice(split)], metadata)).toEqual(expected);
      }
    }
  });

  it("keeps the standard projection fallback for inherited collection fields", () => {
    const state = fixture();
    const inherited = Object.assign(Object.create({ entities: state.entities, belts: state.belts }), state) as GameState;
    Reflect.deleteProperty(inherited, "entities"); Reflect.deleteProperty(inherited, "belts");
    expect(serializePersistentSaveEnvelopeToTransfer(inherited, registry, options))
      .toEqual(serializeSaveEnvelopeToTransfer(projectPersistentSaveState(inherited, registry), options));
    expect(inherited.entities).toBe(state.entities);
    expect(inherited.belts).toBe(state.belts);
  });
});
