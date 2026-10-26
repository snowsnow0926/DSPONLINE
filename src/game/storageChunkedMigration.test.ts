import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "./engine";
import { createContentPackRegistry } from "./contentPacks";
import { migrateGame, parseTrustedWorkerEnvelope, parseTrustedWorkerEnvelopeChunked } from "./storage";
import { decodeVerifiedSaveTransfer, serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import type { FactoryEntity, GameState } from "./types";

function fixture(version: number): GameState {
  const state = createInitialState(43, false);
  (state as { version: number }).version = version;
  const machine: FactoryEntity = {
    id: "normalization-machine", kind: "machine", buildingId: "assembling_machine_mk1", planetId: "home",
    position: { x: 12, y: 23 }, machineCount: 2, minerCount: 0, inputs: { iron_ingot: 12 }, outputs: { gear: 3 },
    progress: -2, routingCursor: 0, utilization: -1, productionRate: -1, interactionLocked: false,
    sprayCoaterInstalled: false, proliferatorBonusProgress: { gear: 0.7 }, quantumTarget: true,
  };
  state.entities.push(machine, {
    ...machine, id: "normalization-station", kind: "station", buildingId: "interstellar_logistics_station",
    inputs: {}, outputs: { iron_ingot: 4 }, stationTier: 1, quantumMode: "legacy",
    sprayCoaterInstalled: true, proliferatorBonusProgress: { iron_ingot: 0.25 },
  });
  state.belts.push({
    id: "normalization-line", source: machine.id, target: "normalization-station", planetId: "home",
    itemId: "iron_ingot", tier: 2, sorterTier: 2, lanes: 2, progress: 0.375,
    totalTransferred: 12, congestion: 0, lastFlow: 0, priority: 0, monitorEnabled: false,
  });
  return state;
}

function trusted(state: GameState) {
  const verification = serializeSaveEnvelopeToTransfer(state, {
    formatVersion: 2, kind: "primary", mode: state.mode, slot: "main", savedAt: 1_800_000_000_000,
  });
  return { raw: decodeVerifiedSaveTransfer(verification.bytes, verification), verification };
}

const registry = createContentPackRegistry();
const immediate = { yieldControl: async () => undefined };

describe("cooperative canonical save migration", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => vi.useRealTimers());

  it.each(Array.from({ length: 47 }, (_, index) => index + 1))(
    "preserves complete synchronous results and caller records for version %s", async (version) => {
      const { raw, verification } = trusted(fixture(version));
      const decoded = JSON.parse(raw).state;
      const recordsBefore = JSON.stringify({ entities: decoded.entities, belts: decoded.belts });
      const expected = migrateGame(decoded);
      expect(JSON.stringify({ entities: decoded.entities, belts: decoded.belts })).toBe(recordsBefore);
      const actual = await parseTrustedWorkerEnvelopeChunked(raw, verification, registry, immediate);
      expect(actual).toStrictEqual(expected);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
      expect(actual.entities.find((entity) => entity.id === "normalization-machine")?.proliferatorBonusProgress).toEqual({});
    },
  );

  it("can abort after a record batch without publishing a partial state, then retry exactly", async () => {
    const source = fixture(47);
    const template = source.entities.find((entity) => entity.id === "normalization-machine")!;
    source.entities.push(...Array.from({ length: 2_500 }, (_, index) => ({ ...template, id: `batch-${index}` })));
    const { raw, verification } = trusted(source);
    const controller = new AbortController();
    let yields = 0;
    await expect(parseTrustedWorkerEnvelopeChunked(raw, verification, registry, {
      signal: controller.signal,
      yieldControl: async () => { if (++yields === 3) controller.abort(); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(yields).toBe(3);
    const retried = await parseTrustedWorkerEnvelopeChunked(raw, verification, registry, immediate);
    expect(retried).toStrictEqual(parseTrustedWorkerEnvelope(raw, verification, registry));
  });

  it("preserves unsafe-quantity rejection across a scheduling boundary", async () => {
    const source = fixture(47);
    source.entities.at(-1)!.machineCount = Number.MAX_SAFE_INTEGER + 1;
    const { raw, verification } = trusted(source);
    expect(() => parseTrustedWorkerEnvelope(raw, verification)).toThrow();
    await expect(parseTrustedWorkerEnvelopeChunked(raw, verification, registry, immediate)).rejects.toThrow();
  });

  it.each([
    (raw: string) => raw.replace('"formatVersion":2', '"formatVersion":99'),
    (raw: string) => raw.replace('"slot":"main"', '"slot":99'),
    (raw: string) => raw.replace('"mode":"normal"', '"mode":"invalid"'),
  ])("keeps canonical envelope rejection", async (corrupt) => {
    const valid = trusted(fixture(47));
    const raw = corrupt(valid.raw);
    expect(() => parseTrustedWorkerEnvelope(raw, valid.verification, registry)).toThrow();
    await expect(parseTrustedWorkerEnvelopeChunked(raw, valid.verification, registry, immediate)).rejects.toThrow();
  });
});
