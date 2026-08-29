import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { createNativeRendererShellState } from "./nativeRendererShell";

describe("native renderer shell", () => {
  it("drops player-scale collections without mutating the handed-off state", () => {
    const source = createInitialState(12345, false);
    const firstEntity = source.entities[0]!;
    source.entities = Array.from({ length: 20_000 }, (_, index) => ({
      ...firstEntity,
      id: `large-${index}`,
      inputs: { iron_ore: index },
      outputs: { iron_ingot: index },
    }));
    source.belts = Array.from({ length: 30_000 }, (_, index) => ({
      id: `belt-${index}`,
      planetId: "home",
      source: `large-${index % 20_000}`,
      target: `large-${(index + 1) % 20_000}`,
      itemId: "iron_ore",
      tier: 1 as const,
      sorterTier: 1 as const,
      lanes: 1,
      stackSize: 1,
      progress: 0,
      priority: 1 as const,
      lastFlow: index,
    }));
    source.productionHistory = Array.from({ length: 10_000 }, (_, index) => ({
      elapsedSeconds: index,
      productionPerMinute: { iron_ore: index },
      consumptionPerMinute: {},
      inventory: { iron_ore: index },
      generationKw: index,
      demandKw: index,
    }));
    source.settings.theme = "light";
    source.contentPacks = [{ id: "mod:large", version: "9.9.9" }];

    const shell = createNativeRendererShellState(source);

    expect(source.entities).toHaveLength(20_000);
    expect(source.belts).toHaveLength(30_000);
    expect(source.productionHistory).toHaveLength(10_000);
    expect(shell).not.toBe(source);
    expect(shell.version).toBe(47);
    expect(shell.entities).toEqual([]);
    expect(shell.belts).toEqual([]);
    expect(shell.productionHistory).toEqual([]);
    expect(shell.tray).toEqual({});
    expect(shell.construction).toEqual({});
    expect(shell.paused).toBe(true);
    expect(shell.timeWarp.enabled).toBe(false);
    expect(shell.settings.theme).toBe("light");
    expect(shell.contentPacks).toEqual([{ id: "mod:large", version: "9.9.9" }]);
  });

  it("has a bounded serialized size independent of the source factory size", () => {
    const small = createInitialState(7, false);
    const large = createInitialState(7, false);
    const firstEntity = large.entities[0]!;
    large.entities = Array.from({ length: 50_000 }, (_, index) => ({
      ...firstEntity,
      id: `entity-${index}`,
      inputs: { iron_ore: Number.MAX_SAFE_INTEGER },
      outputs: { iron_ingot: Number.MAX_SAFE_INTEGER },
    }));

    const smallBytes = new TextEncoder().encode(JSON.stringify(createNativeRendererShellState(small))).byteLength;
    const largeBytes = new TextEncoder().encode(JSON.stringify(createNativeRendererShellState(large))).byteLength;

    expect(largeBytes).toBe(smallBytes);
    expect(largeBytes).toBeLessThan(100_000);
  });

  it("fails closed outside the exact normal v47 handoff boundary", () => {
    const speedrun = createInitialState();
    speedrun.mode = "speedrun";
    expect(() => createNativeRendererShellState(speedrun)).toThrow(/normal GameState v47/);

    const legacy = createInitialState();
    legacy.version = 46;
    expect(() => createNativeRendererShellState(legacy)).toThrow(/normal GameState v47/);
  });
});
