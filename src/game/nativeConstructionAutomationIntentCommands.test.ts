import { describe, expect, it } from "vitest";
import {
  createNativeConstructionAutomationBatchBuildingTargetStockIntentCommand,
  createNativeConstructionAutomationEnabledIntentCommand,
  createNativeConstructionAutomationQuantumSupplyIntentCommand,
  createNativeConstructionAutomationTargetStockIntentCommand,
} from "./nativeConstructionAutomationIntentCommands";

describe("native construction automation semantic intent commands", () => {
  it("emits only the requested automation policy marker", () => {
    expect(createNativeConstructionAutomationEnabledIntentCommand(41, true)).toMatchObject({
      protocolVersion: 1,
      baseRevision: 41,
      topLevelChanges: [{
        path: ["constructionAutomation", "intent"],
        operation: "set",
        value: { kind: "enabled", enabled: true },
      }],
      changedEntities: [],
      changedBelts: [],
    });
    expect(createNativeConstructionAutomationQuantumSupplyIntentCommand(42, false)
      .topLevelChanges[0]).toEqual({
        path: ["constructionAutomation", "intent"],
        operation: "set",
        value: { kind: "quantumSupplyEnabled", enabled: false },
      });
  });

  it("submits one target ID and value without renderer-derived directories or inventory", () => {
    const command = createNativeConstructionAutomationTargetStockIntentCommand(
      43,
      "logistics_vessel",
      500,
    );
    expect(command.topLevelChanges).toEqual([{
      path: ["constructionAutomation", "intent"],
      operation: "set",
      value: { kind: "targetStock", targetId: "logistics_vessel", target: 500 },
    }]);
    const encoded = JSON.stringify(command);
    expect(encoded).not.toContain("jobs");
    expect(encoded).not.toContain("quantumMaterialBuffer");
    expect(encoded).not.toContain("portableFleet");
    expect(encoded).not.toContain("constructionQueue");
  });

  it("submits one batch target policy without renderer-derived target IDs", () => {
    const command = createNativeConstructionAutomationBatchBuildingTargetStockIntentCommand(
      44,
      2_000,
    );
    expect(command).toMatchObject({
      protocolVersion: 1,
      baseRevision: 44,
      topLevelChanges: [{
        path: ["constructionAutomation", "intent"],
        operation: "set",
        value: { kind: "batchBuildingTargetStock", target: 2_000 },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    const encoded = JSON.stringify(command);
    expect(encoded).not.toContain("targetId");
    expect(encoded).not.toContain("wind_turbine");
    expect(encoded).not.toContain("jobs");
    expect(encoded).not.toContain("inventory");
  });

  it("rejects malformed revisions, IDs, booleans and targets before crossing the bridge", () => {
    expect(() => createNativeConstructionAutomationEnabledIntentCommand(-1, true)).toThrow();
    expect(() => createNativeConstructionAutomationEnabledIntentCommand(0, 1 as unknown as boolean)).toThrow();
    expect(() => createNativeConstructionAutomationQuantumSupplyIntentCommand(0, "yes" as unknown as boolean)).toThrow();
    expect(() => createNativeConstructionAutomationTargetStockIntentCommand(0, "" as never, 1)).toThrow();
    expect(() => createNativeConstructionAutomationTargetStockIntentCommand(0, "x\0y" as never, 1)).toThrow();
    expect(() => createNativeConstructionAutomationTargetStockIntentCommand(0, "x".repeat(161) as never, 1)).toThrow();
    expect(() => createNativeConstructionAutomationTargetStockIntentCommand(0, "arc_smelter", -1)).toThrow();
    expect(() => createNativeConstructionAutomationTargetStockIntentCommand(0, "arc_smelter", 1.5)).toThrow();
    expect(() => createNativeConstructionAutomationTargetStockIntentCommand(0, "arc_smelter", 100_000_001)).toThrow();
    expect(() => createNativeConstructionAutomationBatchBuildingTargetStockIntentCommand(-1, 1)).toThrow();
    expect(() => createNativeConstructionAutomationBatchBuildingTargetStockIntentCommand(0, 0)).toThrow();
    expect(() => createNativeConstructionAutomationBatchBuildingTargetStockIntentCommand(0, -1)).toThrow();
    expect(() => createNativeConstructionAutomationBatchBuildingTargetStockIntentCommand(0, 1.5)).toThrow();
    expect(() => createNativeConstructionAutomationBatchBuildingTargetStockIntentCommand(0, 100_000_001)).toThrow();
    expect(() => createNativeConstructionAutomationBatchBuildingTargetStockIntentCommand(
      0,
      Number.MAX_SAFE_INTEGER + 1,
    )).toThrow();
  });
});
