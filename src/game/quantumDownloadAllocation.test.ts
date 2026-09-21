import { describe, expect, it } from "vitest";
import { createEmptyQuantumLogisticsNetworkState, normalizeQuantumLogisticsNetworkState, settleQuantumLogisticsNetwork } from "./quantumLogisticsNetwork";
import type { ItemId, QuantumLogisticsNetworkState } from "./types";

const request = (key: string, itemId: ItemId, amount: number, priority = 1) => ({ key, stationId: key, itemId, requested: amount, capacity: amount, priority });

describe("quantum download feasibility and persistent fairness", () => {
  it("does not reserve bandwidth for a high-priority item with no stock", () => {
    const state = { ...createEmptyQuantumLogisticsNetworkState(), enabled: true, inventory: { water: "1000000" } };
    const result = settleQuantumLogisticsNetwork(state, [], [request("tower", "hydrogen", 10000, 2), request("center", "water", 16)], { globalDownloadCap: 416 });
    expect(result.outputDelivered).toEqual({ tower: "0", center: "16" });
    expect(result.state.inventory.water).toBe("999984");
    expect(result.diagnostics.blockedByDownloadBandwidth).toBe("0");
    expect(result.diagnostics.blockedByInventory).toBe("10000");
    expect(state.inventory.water).toBe("1000000");
  });

  it("uses only deliverable high-priority stock before serving another item", () => {
    const state = { ...createEmptyQuantumLogisticsNetworkState(), enabled: true, inventory: { hydrogen: "10", water: "100" } };
    const result = settleQuantumLogisticsNetwork(state, [], [request("tower", "hydrogen", 10000, 2), request("center", "water", 100)], { globalDownloadCap: 50 });
    expect(result.outputDelivered).toEqual({ tower: "10", center: "40" });
    expect(result.diagnostics.deliveredOutput).toBe("50");
    expect(result.diagnostics.blockedByDownloadBandwidth).toBe("60");
    expect(result.diagnostics.blockedByInventory).toBe("9990");
  });

  it("keeps high priority when two receivers compete for the same scarce item", () => {
    const state = { ...createEmptyQuantumLogisticsNetworkState(), enabled: true, inventory: { water: "7" } };
    const result = settleQuantumLogisticsNetwork(state, [], [request("ordinary", "water", 10), request("high", "water", 5, 2)], { globalDownloadCap: 100 });
    expect(result.outputDelivered).toEqual({ high: "5", ordinary: "2" });
  });

  it.each([false, true])("rotates scarce bandwidth independently of higher priority groups, mixed=%s", (mixed) => {
    let state: QuantumLogisticsNetworkState = { ...createEmptyQuantumLogisticsNetworkState(), enabled: true, inventory: { water: "100", hydrogen: "100", stone: "100" } };
    const outputs = [request("a", "water", 1), request("b", "hydrogen", 1), request("c", "water", 1)];
    if (mixed) outputs.push(request("high", "stone", 1, 2));
    const total: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 9; i += 1) {
      const result = settleQuantumLogisticsNetwork(state, [], i % 2 ? [...outputs].reverse() : outputs, { globalDownloadCap: mixed ? 2 : 1 });
      for (const key of Object.keys(total)) total[key] += Number(result.outputDelivered[key]);
      // Normalizing is also what loading a save and an intervening deposit do.
      state = normalizeQuantumLogisticsNetworkState(JSON.parse(JSON.stringify(result.state)));
    }
    expect(total).toEqual({ a: 3, b: 3, c: 3 });
  });

  it("does not allocate a billion empty requests ahead of a small stocked request", () => {
    const state = { ...createEmptyQuantumLogisticsNetworkState(), enabled: true, inventory: { water: "10" } };
    const result = settleQuantumLogisticsNetwork(state, [], [request("a-empty", "hydrogen", 1000000000), request("z-water", "water", 10)], { globalDownloadCap: 10 });
    expect(result.outputDelivered["z-water"]).toBe("10");
  });
});
