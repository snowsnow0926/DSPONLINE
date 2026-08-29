import { describe, expect, it } from "vitest";
import {
  createNativeProjectedCargoReturnCommand,
  createNativeProjectedTrayItemLimitCommand,
  createNativeProjectedTrayTakeCommand,
} from "./nativeProjectedFactoryInventoryCommands";
import type {
  NativeFactoryInventoryCargo,
  NativeFactoryInventoryFrame,
  NativeFactoryInventoryRow,
} from "./nativeFactoryInventoryStore";

function frame(options: {
  rows?: NativeFactoryInventoryRow[];
  cargo?: NativeFactoryInventoryCargo | null;
  portableFleet?: { logistics_drone: number; logistics_vessel: number };
  trayItemLimit?: number;
} = {}): NativeFactoryInventoryFrame {
  const rows = options.rows ?? [{ itemId: "iron_ore", amount: 100, freeCapacity: 999_900, overLimit: false }];
  return {
    source: "native-core",
    sessionId: "session-a",
    runId: "run-a",
    revision: 41,
    registryFingerprint: "builtin:test",
    activePlanetId: "home",
    cargo: options.cargo ?? null,
    pickupTargetAmount: 100,
    portableFleet: options.portableFleet ?? { logistics_drone: 3, logistics_vessel: 4 },
    trayItemLimit: options.trayItemLimit ?? 1_000_000,
    trayItemLimitBounds: { minimum: 1_000, default: 1_000_000, maximum: 100_000_000 },
    rows,
    rowsByItemId: new Map(rows.map((row) => [row.itemId, row])),
  };
}

describe("native projected factory inventory commands", () => {
  it("takes toward 100 with a whole canonical cargo replacement and keeps a zero tray leaf", () => {
    expect(createNativeProjectedTrayTakeCommand(frame(), "iron_ore")).toMatchObject({
      protocolVersion: 1,
      baseRevision: 41,
      topLevelChanges: [
        { path: ["tray", "iron_ore"], operation: "set", value: 0 },
        {
          path: ["cargo"],
          operation: "set",
          value: { itemId: "iron_ore", amount: 100, origin: { kind: "tray" } },
        },
      ],
      changedEntities: [],
      changedBelts: [],
    });
  });

  it("replaces stale origin metadata when topping up the same item", () => {
    const current = frame({
      rows: [{ itemId: "iron_ore", amount: 70, freeCapacity: 999_930, overLimit: false }],
      cargo: { itemId: "iron_ore", amount: 60, origin: { kind: "node-output", id: "source" } },
    });
    expect(createNativeProjectedTrayTakeCommand(current, "iron_ore")?.topLevelChanges).toEqual([
      { path: ["tray", "iron_ore"], operation: "set", value: 30 },
      {
        path: ["cargo"],
        operation: "set",
        value: { itemId: "iron_ore", amount: 100, origin: { kind: "tray" } },
      },
    ]);
  });

  it("does not reverse material when historical cargo already exceeds the pickup target", () => {
    const historical = frame({
      cargo: { itemId: "iron_ore", amount: 125, origin: { kind: "tray", id: null } },
    });
    expect(createNativeProjectedTrayTakeCommand(historical, "iron_ore")).toBeNull();
    expect(createNativeProjectedTrayTakeCommand(frame({
      cargo: { itemId: "copper_ore", amount: 1, origin: null },
    }), "iron_ore")).toBeNull();
  });

  it("returns an ordinary cargo stack losslessly even above the configured limit", () => {
    const current = frame({
      rows: [{ itemId: "MOD/item-alpha", amount: 1_100, freeCapacity: 0, overLimit: true }],
      cargo: { itemId: "MOD/item-alpha", amount: 125, origin: { kind: "tray", id: null } },
      trayItemLimit: 1_000,
    });
    expect(createNativeProjectedCargoReturnCommand(current)?.topLevelChanges).toEqual([
      { path: ["tray", "MOD/item-alpha"], operation: "set", value: 1_225 },
      { path: ["cargo"], operation: "set", value: null },
    ]);
  });

  it("redirects portable fleet cargo to the global portable inventory", () => {
    const current = frame({
      cargo: { itemId: "logistics_drone", amount: 7, origin: { kind: "node-input", id: "station" } },
      portableFleet: { logistics_drone: 3, logistics_vessel: 4 },
    });
    expect(createNativeProjectedCargoReturnCommand(current)?.topLevelChanges).toEqual([
      { path: ["portableFleet", "logistics_drone"], operation: "set", value: 10 },
      { path: ["cargo"], operation: "set", value: null },
    ]);
  });

  it("clamps the active planet limit without touching existing stock", () => {
    expect(createNativeProjectedTrayItemLimitCommand(frame(), 999)?.topLevelChanges).toEqual([
      { path: ["planetTrayItemLimits", "home"], operation: "set", value: 1_000 },
    ]);
    expect(createNativeProjectedTrayItemLimitCommand(frame(), 1_000_000)).toBeNull();
    expect(createNativeProjectedTrayItemLimitCommand(frame(), Number.NaN)).toBeNull();
    expect(createNativeProjectedTrayItemLimitCommand(frame(), 1e12)?.topLevelChanges[0].value)
      .toBe(100_000_000);
  });

  it("rejects a return that would overflow JavaScript's safe integer range", () => {
    expect(() => createNativeProjectedCargoReturnCommand(frame({
      rows: [{
        itemId: "iron_ore",
        amount: Number.MAX_SAFE_INTEGER,
        freeCapacity: 0,
        overLimit: true,
      }],
      cargo: { itemId: "iron_ore", amount: 1, origin: null },
    }))).toThrow(/安全整数/);
  });
});
