import { describe, expect, it } from "vitest";

import type { DesktopNativeCoreFactoryReadModelResult } from "../desktop";
import type {
  FactoryConstructionHeadlineReadModel,
  FactoryRunStatusReadModel,
} from "./factoryReadModels";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";
import {
  selectFactoryConstructionHeadlineReadModel,
  selectFactoryRunStatusReadModel,
} from "./nativeFactoryThinViewBridge";

const web: FactoryRunStatusReadModel = {
  schema: "factory-read-model-v1",
  source: "web-game-state",
  revision: null,
  activePlanetId: "home",
  paused: false,
};

const constructionWeb: FactoryConstructionHeadlineReadModel = {
  schema: "factory-read-model-v1",
  source: "web-game-state",
  revision: null,
  activePlanetId: "home",
  activePlanetDisplayName: "澄海 I",
  constructionQueueCount: 0,
};

function factory(revision: number, paused = false): DesktopNativeCoreFactoryReadModelResult {
  const emptyRows = { rows: [], totalCount: 0, truncated: false };
  return {
    schemaVersion: 1,
    projectionType: "factory-read-model-v1",
    revision,
    shell: {
      schema: "factory-read-model-v1",
      source: "native-core",
      stateVersion: 47,
      mode: "normal",
      activePlanetId: "home",
      paused,
      elapsedSeconds: 1,
      simulationSpeed: 1,
      entityCount: 0,
      beltCount: 0,
      activePlanetEntityCount: 0,
      activePlanetBeltCount: 0,
      constructionQueueCount: 0,
    },
    planetNavigation: {
      schema: "factory-read-model-v1",
      activePlanetId: "home",
      planets: {
        rows: [{
          planetId: "home",
          systemId: "helios",
          displayName: "澄海 I",
          code: "home",
          active: true,
          discovered: true,
          colonized: true,
          role: null,
          entityCount: 0,
          beltCount: 0,
          constructionQueueCount: 0,
        }],
        totalCount: 1,
        truncated: false,
      },
    },
    selection: {
      schema: "factory-read-model-v1",
      activePlanetId: "home",
      requestedEntityCount: 0,
      requestedBeltCount: 0,
      entityRows: emptyRows,
      beltRows: emptyRows,
    },
    construction: {
      schema: "factory-read-model-v1",
      activePlanetId: "home",
      queue: emptyRows,
      automation: {
        enabled: false,
        quantumSourceEnabled: false,
        totalCrafted: 0,
        lastCraftedId: null,
        targets: emptyRows,
        jobs: emptyRows,
        destroyedByproducts: emptyRows,
      },
    },
  };
}

function snapshot(
  revision: number,
  status: NativeFactoryThinViewSnapshot["status"] = "ready",
  paused = false,
): NativeFactoryThinViewSnapshot {
  return {
    status,
    requestedRevision: revision,
    frame: {
      revision,
      planetId: "home",
      factory: factory(revision, paused),
      viewport: {
        schemaVersion: 2,
        projectionType: "viewport-v2",
        revision,
        planetId: "home",
        bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
        base: {},
        entities: [],
        belts: [],
        pinnedEntityIds: [],
        pinnedBeltIds: [],
        nextEntityCursor: null,
        nextBeltCursor: null,
        planetTotals: { entities: 0, belts: 0 },
        viewportTotals: { entities: 0, belts: 0 },
        worldBounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
        minimap: {
          bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
          entityCount: 0,
          beltCount: 0,
          occupiedCellCount: 0,
          cellSize: 512,
        },
        broadQueryFallback: false,
      },
    },
  };
}

describe("native factory thin-view run-status bridge", () => {
  it("uses the native shell only for the exact ready revision", () => {
    expect(selectFactoryRunStatusReadModel(web, snapshot(7), 7)).toEqual({
      ...web,
      source: "native-core",
      revision: 7,
    });
  });

  it("keeps Web output for stale or superseded frames", () => {
    expect(selectFactoryRunStatusReadModel(web, snapshot(6), 7)).toBe(web);
    expect(selectFactoryRunStatusReadModel(web, snapshot(7, "loading"), 7)).toBe(web);
    expect(selectFactoryRunStatusReadModel(web, snapshot(7, "unavailable"), 7)).toBe(web);
  });

  it("keeps Web output when same-revision native semantics do not match", () => {
    expect(selectFactoryRunStatusReadModel(web, snapshot(7, "ready", true), 7)).toBe(web);
    const current = snapshot(7);
    const wrongPlanet: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: {
        ...current.frame!,
        factory: {
          ...current.frame!.factory,
          shell: { ...current.frame!.factory.shell, activePlanetId: "other" },
        },
      },
    };
    expect(selectFactoryRunStatusReadModel(web, wrongPlanet, 7)).toBe(web);
  });
});

describe("native factory thin-view construction headline bridge", () => {
  it("uses the native atomic frame only at the exact revision", () => {
    expect(selectFactoryConstructionHeadlineReadModel(constructionWeb, snapshot(9), 9)).toEqual({
      ...constructionWeb,
      source: "native-core",
      revision: 9,
    });
    expect(selectFactoryConstructionHeadlineReadModel(constructionWeb, snapshot(8), 9)).toBe(constructionWeb);
  });

  it("keeps Web output while native data is loading or unavailable", () => {
    expect(selectFactoryConstructionHeadlineReadModel(constructionWeb, snapshot(9, "loading"), 9)).toBe(constructionWeb);
    expect(selectFactoryConstructionHeadlineReadModel(constructionWeb, snapshot(9, "unavailable"), 9)).toBe(constructionWeb);
  });

  it("keeps Web output for planet or same-revision semantic mismatches", () => {
    const current = snapshot(9);
    const wrongPlanet: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: { ...current.frame!, planetId: "other" },
    };
    expect(selectFactoryConstructionHeadlineReadModel(constructionWeb, wrongPlanet, 9)).toBe(constructionWeb);

    const wrongQueueCount: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: {
        ...current.frame!,
        factory: {
          ...current.frame!.factory,
          shell: { ...current.frame!.factory.shell, constructionQueueCount: 1 },
          construction: {
            ...current.frame!.factory.construction,
            queue: { rows: [], totalCount: 1, truncated: true },
          },
        },
      },
    };
    expect(selectFactoryConstructionHeadlineReadModel(constructionWeb, wrongQueueCount, 9)).toBe(constructionWeb);

    const inactivePlanet: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: {
        ...current.frame!,
        factory: {
          ...current.frame!.factory,
          planetNavigation: {
            ...current.frame!.factory.planetNavigation,
            planets: {
              ...current.frame!.factory.planetNavigation.planets,
              rows: current.frame!.factory.planetNavigation.planets.rows.map((row) => ({ ...row, active: false })),
            },
          },
        },
      },
    };
    expect(selectFactoryConstructionHeadlineReadModel(constructionWeb, inactivePlanet, 9)).toBe(constructionWeb);
  });
});
