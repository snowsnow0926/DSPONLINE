import { describe, expect, it } from "vitest";
import {
  createInitialState,
  createSimulationPlanetPhaseLookup,
  getEntityOperatingStatus,
  refreshSimulationPlanetPhaseLookup,
} from "./engine";

describe("refreshSimulationPlanetPhaseLookup", () => {
  it("keeps one lookup root while replacing every state-backed index", () => {
    const before = createInitialState();
    const lookup = createSimulationPlanetPhaseLookup(before);
    const previousEntityMap = lookup.entityById;
    const previousBeltMap = lookup.beltById;
    const firstEntity = before.entities[0];
    const after = {
      ...before,
      entities: before.entities.map((entity) => entity.id === firstEntity.id
        ? { ...entity, utilization: entity.utilization === 0 ? 0.5 : 0 }
        : entity),
    };

    const refreshed = refreshSimulationPlanetPhaseLookup(after, lookup);
    const fresh = createSimulationPlanetPhaseLookup(after);

    expect(refreshed).toBe(lookup);
    expect(refreshed.entityById).not.toBe(previousEntityMap);
    expect(refreshed.beltById).not.toBe(previousBeltMap);
    expect(refreshed.entityById.get(firstEntity.id)).toBe(after.entities[0]);
    expect(getEntityOperatingStatus(after, after.entities[0], refreshed)).toEqual(
      getEntityOperatingStatus(after, after.entities[0], fresh),
    );
  });
});
