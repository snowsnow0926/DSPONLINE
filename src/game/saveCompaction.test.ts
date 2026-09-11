import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import { advanceSimulation, createInitialState } from "./engine";
import { computeSaveStateChecksum } from "./saveEnvelopeIntegrity";
import { inspectSave, migrateGame, serializeEnvelope } from "./storage";

const environment = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;

describe("v46 sparse save projection", () => {
  it("omits only default/zero runtime fields while preserving authoritative nonzero state", () => {
    const state = createInitialState(1, false);
    const primary = state.entities[0];
    const secondary = state.entities[1];
    primary.inputs.iron_ore = 42;
    primary.outputs.iron_ore = 7;
    primary.progress = 0.5;
    primary.powerFactor = 0.8;
    primary.productionRate = 12;
    secondary.inputs = {};
    secondary.outputs = { copper_ore: 0 };
    state.belts.push({
      id: "compact-line",
      planetId: primary.planetId,
      source: primary.id,
      target: secondary.id,
      itemId: "iron_ore",
      lanes: 1,
      tier: 1,
      sorterTier: 1,
      progress: 0,
      priority: 0,
      stackSize: 1,
      monitorEnabled: false,
      totalTransferred: 0,
      congestion: 0,
      lastFlow: 0,
      routeMode: "auto",
    });
    const raw = serializeEnvelope(state, 1_786_377_600_000);
    const parsed = JSON.parse(raw) as { state: typeof state };
    const persistedPrimary = parsed.state.entities.find((entity) => entity.id === primary.id)! as unknown as Record<string, unknown>;
    const persistedSecondary = parsed.state.entities.find((entity) => entity.id === secondary.id)! as unknown as Record<string, unknown>;
    const persistedBelt = parsed.state.belts[0] as unknown as Record<string, unknown>;
    expect(persistedPrimary).toMatchObject({ inputs: { iron_ore: 42 }, outputs: { iron_ore: 7 }, progress: 0.5, powerFactor: 0.8, productionRate: 12 });
    expect(persistedSecondary).not.toHaveProperty("inputs");
    expect(persistedSecondary).toHaveProperty("outputs.copper_ore", 0);
    for (const key of ["lanes", "tier", "sorterTier", "progress", "priority", "stackSize", "monitorEnabled", "totalTransferred", "congestion", "lastFlow", "routeMode"]) {
      expect(persistedBelt).not.toHaveProperty(key);
    }
    const inspection = inspectSave(raw);
    expect(inspection).toMatchObject({ valid: true, checksum: "valid", stateVersion: 46 });
    expect(inspection.state!.entities.find((entity) => entity.id === primary.id)).toMatchObject({
      inputs: { iron_ore: 42 }, outputs: { iron_ore: 7 }, progress: 0.5, powerFactor: 0.8, productionRate: 12,
    });
    expect(inspection.state!.belts[0]).toMatchObject({ lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 0, stackSize: 1, lastFlow: 0 });
  });

  it("loads an uncompressed v46 envelope and keeps the next exact step identical after sparse round-trip", () => {
    const state = createInitialState(1, false);
    state.paused = false;
    const oldEnvelope = {
      formatVersion: 2,
      kind: "primary",
      savedAt: 100,
      mode: "normal",
      slot: "main",
      state,
      checksum: computeSaveStateChecksum(2, state),
    };
    const oldInspection = inspectSave(JSON.stringify(oldEnvelope));
    expect(oldInspection.valid).toBe(true);
    const compactInspection = inspectSave(serializeEnvelope(oldInspection.state!, 101));
    expect(compactInspection.valid).toBe(true);
    expect(hashGameState(advanceSimulation(structuredClone(oldInspection.state!), 5))).toBe(
      hashGameState(advanceSimulation(structuredClone(compactInspection.state!), 5)),
    );
  });

  it.skipIf(!environment?.DSP_REAL_FIXTURE)("measures read-only real-save reduction and reload integrity", () => {
    const sourceRaw = readFileSync(environment!.DSP_REAL_FIXTURE!, "utf8");
    const parsed = JSON.parse(sourceRaw);
    const state = migrateGame(parsed.state ?? parsed);
    expect(state).not.toBeNull();
    const compactRaw = serializeEnvelope(state!, 1_786_377_600_000);
    const sourceBytes = new TextEncoder().encode(sourceRaw).byteLength;
    const compactBytes = new TextEncoder().encode(compactRaw).byteLength;
    const inspection = inspectSave(compactRaw);
    const report = {
      sourceBytes,
      compactBytes,
      reductionBytes: sourceBytes - compactBytes,
      reductionRatio: Number(((sourceBytes - compactBytes) / sourceBytes).toFixed(4)),
      entities: state!.entities.length,
      belts: state!.belts.length,
    };
    console.log(`V138_SAVE_COMPACTION ${JSON.stringify(report)}`);
    expect(inspection).toMatchObject({ valid: true, checksum: "valid", stateVersion: 46 });
    expect(compactBytes).toBeLessThan(sourceBytes);
  }, 120_000);
});
