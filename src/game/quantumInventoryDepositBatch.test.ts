import { describe, expect, it } from "vitest";
import {
  createEmptyQuantumLogisticsNetworkState,
  createQuantumInventoryDepositBatch,
  depositIntoQuantumInventory,
} from "./quantumLogisticsNetwork";
import type { ItemId, QuantumLogisticsNetworkState } from "./types";
import { advanceSimulation, createPlayerInitialState } from "./engine";
import type { FactoryEntity } from "./types";

describe("owned quantum inventory deposit batches", () => {
  it("preserves sequential acceptance, normalization and exact output across capacity boundaries", () => {
    for (const enabled of [false, true]) {
      const input = {
        enabled,
        inventory: { iron_ore: "0", copper_ore: "0009980", water: "9999999999", coal: "invalid" },
        itemCapacities: { iron_ore: "1", copper_ore: "10000", water: "9999999999999", coal: "bad" },
        routingCursors: { iron_ore: 4, water: -1 },
        uploadRoutingCursors: { iron_ore: 7, water: 0.5 },
        downloadCursor: -3,
      } as QuantumLogisticsNetworkState;
      const original = structuredClone(input);
      const batch = createQuantumInventoryDepositBatch();
      let owned = input;
      let reference = input;
      const items: ItemId[] = ["iron_ore", "copper_ore", "water", "coal"];
      const amounts = [0, 1, 19, 100, "00010", "9".repeat(255), "9".repeat(257), "1e6", -8, NaN, Infinity];
      for (let index = 0; index < 220; index++) {
        const item = items[index % items.length];
        const amount = amounts[index % amounts.length];
        const expected = depositIntoQuantumInventory(reference, item, amount);
        const actual = batch.deposit(owned, item, amount);
        expect(actual).toEqual(expected);
        expect(JSON.stringify(actual.state)).toBe(JSON.stringify(expected.state));
        reference = expected.state;
        owned = actual.state;
      }
      expect(input).toEqual(original);
    }
  });

  it("does not mutate frozen input and leaves the standalone API immutable", () => {
    const input = {
      ...createEmptyQuantumLogisticsNetworkState(), enabled: true,
      inventory: { iron_ore: "9990" }, itemCapacities: { iron_ore: "10000" },
    };
    Object.freeze(input.inventory);
    Object.freeze(input.itemCapacities);
    Object.freeze(input);
    const batch = createQuantumInventoryDepositBatch();
    const first = batch.deposit(input, "iron_ore", 7);
    const firstSnapshot = structuredClone(first.state);
    const standalone = depositIntoQuantumInventory(first.state, "iron_ore", 20);
    expect(first.state).toEqual(firstSnapshot);
    expect(standalone).toMatchObject({ accepted: "3", remainder: "17" });
    const second = batch.deposit(first.state, "iron_ore", 20);
    expect(second.state).toBe(first.state);
    expect(second).toEqual(standalone);
    expect(input.inventory.iron_ore).toBe("9990");
  });

  it("retains an existing 256-digit balance above capacity without accepting or discarding material", () => {
    const balance = "9".repeat(256);
    const input = {
      ...createEmptyQuantumLogisticsNetworkState(), enabled: true,
      inventory: { iron_ore: balance }, itemCapacities: { iron_ore: "10000" },
    };
    const batch = createQuantumInventoryDepositBatch();
    const first = batch.deposit(input, "iron_ore", "9".repeat(255));
    expect(first).toMatchObject({ accepted: "0", remainder: "9".repeat(255) });
    expect(first.state.inventory.iron_ore).toBe(balance);
    const second = batch.deposit(first.state, "copper_ore", 123);
    expect(second.state.inventory).toEqual({ iron_ore: balance, copper_ore: "123" });
    expect(input.inventory).toEqual({ iron_ore: balance });
  });

  it("restarts normalization when a caller replaces its current network", () => {
    const input = { ...createEmptyQuantumLogisticsNetworkState(), enabled: true };
    const batch = createQuantumInventoryDepositBatch();
    const first = batch.deposit(input, "iron_ore", 5);
    const savedFirst = structuredClone(first.state);
    const replacement = {
      ...createEmptyQuantumLogisticsNetworkState(), enabled: false,
      inventory: { copper_ore: "00020" },
    };
    const second = batch.deposit(replacement, "copper_ore", 7);
    expect(second).toEqual(depositIntoQuantumInventory(replacement, "copper_ore", 7));
    const third = batch.deposit(first.state, "iron_ore", 9);
    expect(third).toEqual(depositIntoQuantumInventory(savedFirst, "iron_ore", 9));
    expect(first.state).toEqual(savedFirst);
    expect(replacement.inventory.copper_ore).toBe("00020");
  });

  it("preserves runtime flow created between consecutive engine uploads", () => {
    const batch = createQuantumInventoryDepositBatch();
    const first = batch.deposit({ ...createEmptyQuantumLogisticsNetworkState(), enabled: true }, "iron_ore", 4);
    const flow = {
      boundarySecond: 5, uploaded: { iron_ore: "4" }, downloaded: {},
      globalUploadPerMinute: 5000, globalDownloadPerMinute: 5000,
      quantumTowerStacks: 1, quantumCollectorStacks: 0,
    };
    first.state.runtimeFlow = flow;
    const next = batch.deposit(first.state, "iron_ore", 6);
    expect(next.state.inventory.iron_ore).toBe("10");
    expect(next.state.runtimeFlow).toBe(flow);
    expect(flow.uploaded.iron_ore).toBe("4");
  });

  it.each([false, true])("keeps tower reserves and exact sequential allocation when order is reversed: %s", (reverse) => {
    const state = createPlayerInitialState();
    state.paused = false;
    state.quantumLogisticsNetwork.enabled = true;
    state.quantumLogisticsNetwork.inventory = { iron_ore: "9980", copper_ore: "0" };
    state.quantumLogisticsNetwork.itemCapacities = { iron_ore: "10000" };
    const tower = (id: string, stock: number, reserve: number): FactoryEntity => ({
      id, kind: "station", planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false,
      buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "quantum",
      stationSlots: [{ itemId: "iron_ore", localMode: "storage", remoteMode: "supply",
        minimumLoad: 1, minStock: reserve, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 }],
      stationRoutes: [], inputs: {}, outputs: { iron_ore: stock }, progress: 0, utilization: 0,
      productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0,
    });
    const towers = [tower("batch-a", 100, 50), tower("batch-b", 30, 20)];
    state.entities.push(...(reverse ? [...towers].reverse() : towers));
    const advanced = advanceSimulation(state, 0.1);
    const first = advanced.entities.find((entity) => entity.id === "batch-a")!;
    const second = advanced.entities.find((entity) => entity.id === "batch-b")!;
    expect(advanced.quantumLogisticsNetwork.inventory.iron_ore).toBe("10000");
    expect(advanced.quantumLogisticsNetwork.inventory.copper_ore).toBeUndefined();
    expect(first.outputs.iron_ore).toBe(reverse ? 90 : 80);
    expect(second.outputs.iron_ore).toBe(reverse ? 20 : 30);
    expect(Number(advanced.quantumLogisticsNetwork.inventory.iron_ore) + first.outputs.iron_ore! + second.outputs.iron_ore!).toBe(10110);
    expect(state.quantumLogisticsNetwork.inventory.iron_ore).toBe("9980");
    expect(towers.map((entity) => entity.outputs.iron_ore)).toEqual([100, 30]);
  });
});
