import { describe, expect, it } from "vitest";
import { createInitialState, placeBuilding } from "./engine";
import { collectGameStateEditLineage } from "./gameStateEditLineage";
import { runFactoryOperationScenario } from "./performanceHarness";
import { createSimulationCommandPatch } from "./simulationRuntimeProtocol";

describe("production performance harness edit batch", () => {
  it("runs through one lineage-backed command without mutating its authority", () => {
    let initial = createInitialState(11_910, false);
    initial.construction.storage_mk1 = 1;
    initial = placeBuilding(initial, "storage_mk1", { x: 0, y: 0 });
    const initialNextId = initial.nextId;
    const initialConstruction = { ...initial.construction };
    const run = runFactoryOperationScenario(initial, 5);

    expect(run.result.placed).toBe(5);
    expect(run.result.removed).toBe(5);
    expect(run.result.blueprinted).toBe(1);
    expect(run.result.final.entities).toBe(run.result.original.entities);
    expect(run.result.final.belts).toBe(run.result.original.belts);
    expect(initial.nextId).toBe(initialNextId);
    expect(initial.construction).toEqual(initialConstruction);

    const lineage = collectGameStateEditLineage(initial, run.state);
    expect(lineage).not.toBeNull();
    expect(lineage!.depth).toBeGreaterThan(1);
    const patch = createSimulationCommandPatch(initial, run.state, 0);
    expect(patch).not.toBeNull();
    expect(patch!.topLevelChanges.length).toBeGreaterThan(0);
  });
});
