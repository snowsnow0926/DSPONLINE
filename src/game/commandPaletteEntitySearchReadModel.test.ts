import { describe, expect, it } from "vitest";

import type { DesktopNativeCoreCommandPaletteEntitySearchResult } from "../desktop";
import {
  COMMAND_PALETTE_ENTITY_SEARCH_LIMITS,
  createCommandPaletteNativeEntityFocusPlan,
  createCommandPaletteEntitySearchSelector,
  selectNativeCommandPaletteEntitySearchReadModel,
  type CommandPaletteEntitySearchSelector,
} from "./commandPaletteEntitySearchReadModel";
import { createInitialState } from "./engine";

function projection(
  selector: CommandPaletteEntitySearchSelector,
  revision = 7,
): DesktopNativeCoreCommandPaletteEntitySearchResult {
  return {
    schemaVersion: 1,
    projectionType: "command-palette-entity-search-v1",
    revision,
    registryFingerprint: "builtin:test",
    limits: {
      queryBytes: 256,
      selectorIds: 256,
      rows: 16,
      requestBytes: 32768,
      projectionBytes: 1048576,
    },
    request: {
      query: selector.query,
      cursor: selector.cursor,
      limit: selector.limit,
      buildingIds: [...selector.buildingIds],
      resourceIds: [...selector.resourceIds],
      planetIds: [...selector.planetIds],
    },
    totalCount: 1,
    rows: [{
      entityId: "entity-1",
      buildingId: "arc_smelter",
      resourceId: null,
      planetId: "home",
      recipeId: "iron_ingot",
      positionX: 24,
      positionY: -12,
    }],
    nextCursor: null,
  };
}

describe("command palette native entity-search read model", () => {
  it("derives sorted bounded display-name selectors from the active catalog", () => {
    const selector = createCommandPaletteEntitySearchSelector("  熔炉  ", 0, 16);
    expect(selector.query).toBe("熔炉");
    expect(selector.buildingIds).toContain("arc_smelter");
    expect(selector.truncated).toBe(false);
    expect(selector.buildingIds).toEqual([...selector.buildingIds].sort());
  });

  it("fails closed when a MOD catalog match or serialized selector request exceeds its bound", () => {
    const modBuildings = Array.from({ length: COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.selectorIds + 1 }, (_, index) => ({
      id: `mod_building_${String(index).padStart(3, "0")}`,
      name: "共享 MOD 熔炉",
    }));
    const countTruncated = createCommandPaletteEntitySearchSelector("mod", 0, 16, {
      buildings: modBuildings,
      resources: [],
      planets: [],
    });
    expect(countTruncated.truncated).toBe(true);
    expect(countTruncated.buildingIds).toHaveLength(COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.selectorIds);

    const largeIds = Array.from({ length: 205 }, (_, index) => ({
      id: `mod_${String(index).padStart(3, "0")}_${"x".repeat(150)}`,
      name: "共享 MOD 熔炉",
    }));
    const byteTruncated = createCommandPaletteEntitySearchSelector("mod", 0, 16, {
      buildings: largeIds,
      resources: [],
      planets: [],
    });
    expect(byteTruncated.truncated).toBe(true);
  });

  it("accepts only the same session, revision, fingerprint, selector and known local IDs", () => {
    const selector = createCommandPaletteEntitySearchSelector("熔炉", 0, 16);
    const frame = { sessionId: "authority-1", revision: 7, selector, projection: projection(selector) };
    const binding = {
      enabled: true,
      sessionId: "authority-1",
      expectedRevision: 7,
      expectedRegistryFingerprint: "builtin:test",
      selector,
    };
    expect(selectNativeCommandPaletteEntitySearchReadModel(frame, binding)?.rows[0]).toMatchObject({
      entityId: "entity-1",
      positionX: 24,
      positionY: -12,
    });
    expect(selectNativeCommandPaletteEntitySearchReadModel(
      { ...frame, revision: 6 },
      binding,
    )).toBeNull();
    expect(selectNativeCommandPaletteEntitySearchReadModel(
      { ...frame, projection: { ...projection(selector), registryFingerprint: "builtin:other" } },
      binding,
    )).toBeNull();
    expect(selectNativeCommandPaletteEntitySearchReadModel(
      {
        ...frame,
        projection: {
          ...projection(selector),
          rows: [{ ...projection(selector).rows[0], buildingId: "unknown_mod_building" }],
        },
      },
      binding,
    )).toBeNull();
    expect(selectNativeCommandPaletteEntitySearchReadModel(
      {
        ...frame,
        projection: {
          ...projection(selector),
          rows: [{ ...projection(selector).rows[0], positionX: Number.NaN }],
        },
      },
      binding,
    )).toBeNull();
  });

  it("builds a native click focus plan without reading the full GameState entity array", () => {
    const game = new Proxy(createInitialState(), {
      get(target, property, receiver) {
        if (property === "entities") throw new Error("native click must not scan GameState entities");
        return Reflect.get(target, property, receiver);
      },
    });
    const target = {
      sessionId: "authority-1",
      revision: 7,
      registryFingerprint: "builtin:test",
      planetId: "home" as const,
      label: "电弧熔炉",
      positionX: 24,
      positionY: -12,
    };
    expect(createCommandPaletteNativeEntityFocusPlan(
      game,
      target,
      { sessionId: "authority-1", revision: 7 },
      "builtin:test",
    )).toEqual({
      planetId: "home",
      changePlanet: false,
      centerX: 152,
      centerY: 78,
      duration: 260,
    });
    expect(createCommandPaletteNativeEntityFocusPlan(
      game,
      target,
      { sessionId: "authority-1", revision: 8 },
      "builtin:test",
    )).toBeNull();
  });
});
