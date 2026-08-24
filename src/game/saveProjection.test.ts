import { describe, expect, it } from "vitest";
import { createContentPackRegistry } from "./contentPacks";
import { createInitialState } from "./engine";
import { hydrateCurrentPersistentSaveProjection, projectPersistentSaveState } from "./saveProjection";
import type { FactoryEntity } from "./types";

describe("current persistent save projection hydration", () => {
  it("restores sparse v47 runtime defaults without changing the canonical projection", () => {
    const registry = createContentPackRegistry();
    const state = createInitialState(1_155, false);
    const controller: FactoryEntity = {
      id: "projection-controller",
      kind: "machine",
      planetId: "home",
      position: { x: 0, y: 0 },
      interactionLocked: false,
      buildingId: "time_warp_device",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    state.entities.push(controller);
    const projected = projectPersistentSaveState(state, registry);
    const expectedProjection = structuredClone(projected);
    const sparseController = projected.entities.find((entity) => entity.id === controller.id)! as unknown as Record<string, unknown>;
    expect(sparseController).not.toHaveProperty("inputs");
    expect(sparseController).not.toHaveProperty("outputs");

    const hydrated = hydrateCurrentPersistentSaveProjection(projected);
    const hydratedController = hydrated.entities.find((entity) => entity.id === controller.id)!;
    expect(hydratedController.inputs).toEqual({});
    expect(hydratedController.outputs).toEqual({});
    expect(hydratedController.sprayCoaterInstalled).toBe(false);
    expect(hydratedController.fuelRemainingMj).toBe(0);
    expect(projectPersistentSaveState(hydrated, registry)).toEqual(expectedProjection);
  });

  it("rejects legacy or arbitrary state objects because this is not an import migrator", () => {
    expect(() => hydrateCurrentPersistentSaveProjection({ version: 46, mode: "normal", entities: [], belts: [] }))
      .toThrow("当前持久化投影身份无效");
    expect(() => hydrateCurrentPersistentSaveProjection(null)).toThrow("当前持久化投影结构无效");
  });
});
