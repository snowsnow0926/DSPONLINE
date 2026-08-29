import { describe, expect, it } from "vitest";
import {
  createNativeProjectedCargoReturnCommand,
  createNativeProjectedEntityInventoryStowCommand,
  createNativeProjectedEntityInventoryTakeCommand,
  createNativeProjectedTrayItemLimitCommand,
  createNativeProjectedTrayTakeCommand,
} from "./nativeProjectedFactoryInventoryCommands";
import type {
  NativeFactoryInventoryCargo,
  NativeFactoryInventoryFrame,
  NativeFactoryInventoryRow,
} from "./nativeFactoryInventoryStore";
import type { FactoryEntity } from "./types";

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

function entity(overrides: Partial<FactoryEntity> = {}): FactoryEntity {
  return {
    id: "machine-a",
    kind: "machine",
    planetId: "home",
    position: { x: 0, y: 0 },
    interactionLocked: false,
    buildingId: "assembling_machine_mk1",
    machineCount: 1,
    minerCount: 0,
    inputs: { iron_ore: 12 },
    outputs: { iron_ingot: 130 },
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
    ...overrides,
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

  it("takes entity input/output through one exact entity leaf and one canonical cargo leaf", () => {
    expect(createNativeProjectedEntityInventoryTakeCommand(
      frame(),
      entity(),
      "outputs",
      "iron_ingot",
    )).toMatchObject({
      baseRevision: 41,
      topLevelChanges: [{
        path: ["cargo"],
        operation: "set",
        value: {
          itemId: "iron_ingot",
          amount: 100,
          origin: { kind: "node-output", id: "machine-a" },
        },
      }],
      changedEntities: [{
        id: "machine-a",
        changes: [{ path: ["outputs", "iron_ingot"], operation: "set", value: 30 }],
      }],
    });

    const toppingUp = frame({
      cargo: { itemId: "iron_ore", amount: 95, origin: { kind: "tray", id: null } },
    });
    expect(createNativeProjectedEntityInventoryTakeCommand(
      toppingUp,
      entity(),
      "inputs",
      "iron_ore",
    )?.changedEntities[0].changes[0].value).toBe(7);
  });

  it("stows entity material into bounded tray or portable fleet without predicting state", () => {
    const regular = frame({
      rows: [{ itemId: "iron_ingot", amount: 990, freeCapacity: 10, overLimit: false }],
      trayItemLimit: 1_000,
    });
    expect(createNativeProjectedEntityInventoryStowCommand(
      regular,
      entity(),
      "outputs",
      "iron_ingot",
    )).toMatchObject({
      topLevelChanges: [{ path: ["tray", "iron_ingot"], operation: "set", value: 1_000 }],
      changedEntities: [{
        id: "machine-a",
        changes: [{ path: ["outputs", "iron_ingot"], operation: "set", value: 120 }],
      }],
    });

    const portableSource = entity({ inputs: { logistics_drone: 7 } });
    expect(createNativeProjectedEntityInventoryStowCommand(
      frame(),
      portableSource,
      "inputs",
      "logistics_drone",
    )?.topLevelChanges).toEqual([
      { path: ["portableFleet", "logistics_drone"], operation: "set", value: 10 },
    ]);
  });

  it("fails closed for stale planet, fractional source and station output", () => {
    expect(() => createNativeProjectedEntityInventoryTakeCommand(
      frame(),
      entity({ planetId: "ashen" }),
      "outputs",
      "iron_ingot",
    )).toThrow(/投影无效/);
    expect(() => createNativeProjectedEntityInventoryTakeCommand(
      frame(),
      entity({ outputs: { iron_ingot: 1.5 } }),
      "outputs",
      "iron_ingot",
    )).toThrow(/建筑库存/);
    expect(() => createNativeProjectedEntityInventoryTakeCommand(
      frame(),
      entity({ kind: "station" }),
      "outputs",
      "iron_ingot",
    )).toThrow(/预留证明/);
  });
});
