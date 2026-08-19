import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  advancePersistentSimulationRuntime,
  createPersistentSimulationRuntime,
  getEntityOperatingStatus,
  isProductiveEntityBlockedForHistory,
} from "./engine";
import { migrateGame } from "./storage";
import type { GameState } from "./types";

const environment = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;

describe("RuntimeWorld M3 aggregate status oracle", () => {
  it.skipIf(!environment?.DSP_M3_STATUS_FIXTURE)("matches presentation status on a normalized read-only fixture", () => {
    const raw = JSON.parse(readFileSync(environment!.DSP_M3_STATUS_FIXTURE!, "utf8"));
    const fixedNowMs = Number.isFinite(Number(raw?.savedAt)) && Number(raw.savedAt) > 0
      ? Math.floor(Number(raw.savedAt))
      : 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(fixedNowMs);
    let source: GameState | null;
    try {
      source = migrateGame(raw.state ?? raw);
    } finally {
      now.mockRestore();
    }
    expect(source).not.toBeNull();
    source!.paused = false;
    const runtime = createPersistentSimulationRuntime(source!);
    advancePersistentSimulationRuntime(runtime, 5, 5);
    const mismatches = runtime.state.entities.flatMap((entity) => {
      if (entity.kind !== "machine" && !(entity.kind === "vein" && entity.minerCount > 0)) return [];
      const expected = getEntityOperatingStatus(runtime.state, entity, runtime.lookup).tone === "blocked";
      const actual = isProductiveEntityBlockedForHistory(runtime.state, entity, runtime.lookup);
      return expected === actual ? [] : [{
        kind: entity.kind,
        buildingId: entity.buildingId,
        recipeId: entity.recipeId,
        expected,
        actual,
      }];
    });
    if (mismatches.length > 0) console.log(`RUNTIMEWORLD_M3_STATUS_MISMATCH ${JSON.stringify(mismatches.slice(0, 20))}`);
    expect(mismatches).toEqual([]);
  }, 120_000);
});
