import { describe, expect, it } from "vitest";

import type { DesktopNativeCoreFactoryReadModelResult } from "../desktop";
import type {
  FactoryConstructionHeadlineReadModel,
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  FactoryRunStatusReadModel,
  FactorySelectionToolbarReadModel,
  PlanetNavigationReadModel,
  SelectedBeltReadModel,
  SelectedEntityReadModel,
} from "./factoryReadModels";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";
import {
  selectFactoryConstructionHeadlineReadModel,
  selectFactoryInspectorSummaryReadModel,
  selectFactoryMultiSelectionSummaryReadModel,
  selectFactoryPlanetNavigationReadModel,
  selectFactoryRunStatusReadModel,
  selectFactorySelectionToolbarReadModel,
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

const navigationWeb: PlanetNavigationReadModel = {
  schema: "factory-read-model-v1",
  activePlanetId: "home",
  planets: {
    rows: [{
      planetId: "home",
      systemId: "helios",
      displayName: "澄海 I",
      code: "H-I",
      active: true,
      discovered: true,
      colonized: true,
      role: null,
      entityCount: 0,
      deviceCount: 0,
      beltCount: 0,
      constructionQueueCount: 0,
      powerFactor: 1,
    }],
    totalCount: 1,
    truncated: false,
  },
};

const selectionToolbarWeb: FactorySelectionToolbarReadModel = {
  schema: "factory-read-model-v1",
  source: "web-game-state",
  revision: null,
  activePlanetId: "home",
  selectedCount: 2,
  selectedBeltCount: 1,
  canLock: true,
  canUnlock: true,
};

function selectedEntity(entityId: string, interactionLocked: boolean): SelectedEntityReadModel {
  const emptyRows = { rows: [], totalCount: 0, truncated: false };
  return {
    entityId,
    planetId: "home",
    kind: "machine",
    position: { x: 0, y: 0 },
    interactionLocked,
    buildingId: "assembling_machine_mk1",
    resourceId: null,
    recipeId: "iron_ingot",
    storedItemId: null,
    fuelItemId: null,
    machineCount: 1,
    minerCount: 0,
    progress: 0,
    utilization: 0,
    productionRate: 0,
    powerFactor: 1,
    inputItems: emptyRows,
    outputItems: emptyRows,
  };
}

function selectedBelt(beltId: string): SelectedBeltReadModel {
  return {
    beltId,
    planetId: "home",
    sourceEntityId: "entity-open",
    targetEntityId: "entity-locked",
    itemId: "iron_ingot",
    lanes: 1,
    tier: 1,
    sorterTier: 1,
    stackSize: null,
    priority: 1,
    progress: 0,
    lastFlow: 0,
    totalTransferred: 0,
    congestion: 0,
  };
}

function selectionSnapshot(revision = 21): NativeFactoryThinViewSnapshot {
  const current = snapshot(revision);
  const entityRows = [selectedEntity("entity-open", false), selectedEntity("entity-locked", true)];
  const beltRows = [selectedBelt("belt-inspected"), selectedBelt("belt-selected")];
  return {
    ...current,
    frame: {
      ...current.frame!,
      factory: {
        ...current.frame!.factory,
        selection: {
          schema: "factory-read-model-v1",
          activePlanetId: "home",
          requestedEntityCount: entityRows.length,
          requestedBeltCount: beltRows.length,
          entityRows: { rows: entityRows, totalCount: entityRows.length, truncated: false },
          beltRows: { rows: beltRows, totalCount: beltRows.length, truncated: false },
        },
      },
    },
  };
}

const selectionBinding = {
  requestedEntityIds: ["entity-open", "entity-locked"],
  requestedBeltIds: ["belt-inspected", "belt-selected"],
  requestTruncated: false,
  selectedEntityIds: ["entity-open", "entity-locked"],
  selectedBeltIds: ["belt-selected"],
} as const;

const inspectorBinding = {
  requestedEntityIds: selectionBinding.requestedEntityIds,
  requestedBeltIds: selectionBinding.requestedBeltIds,
  requestTruncated: false,
} as const;

const multiSelectionWeb: FactoryMultiSelectionSummaryReadModel = {
  schema: "factory-read-model-v1",
  source: "web-game-state",
  revision: null,
  activePlanetId: "home",
  requestedEntityCount: selectionBinding.requestedEntityIds.length,
  requestedBeltCount: selectionBinding.requestedBeltIds.length,
  entityRows: {
    rows: [selectedEntity("entity-open", false), selectedEntity("entity-locked", true)],
    totalCount: 2,
    truncated: false,
  },
  beltRows: {
    rows: [selectedBelt("belt-inspected"), selectedBelt("belt-selected")],
    totalCount: 2,
    truncated: false,
  },
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
          deviceCount: 0,
          beltCount: 0,
          constructionQueueCount: 0,
          powerFactor: 1,
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

describe("native factory thin-view selection toolbar bridge", () => {
  it("uses complete ordered atomic selection rows for all visible toolbar fields", () => {
    expect(selectFactorySelectionToolbarReadModel(
      selectionToolbarWeb,
      selectionSnapshot(),
      21,
      selectionBinding,
    )).toEqual({
      ...selectionToolbarWeb,
      source: "native-core",
      revision: 21,
    });
  });

  it("fails closed for stale frames, reordered IDs, truncation, or visible semantic drift", () => {
    expect(selectFactorySelectionToolbarReadModel(
      selectionToolbarWeb,
      selectionSnapshot(20),
      21,
      selectionBinding,
    )).toBe(selectionToolbarWeb);

    const current = selectionSnapshot();
    const reorderedRows = [...current.frame!.factory.selection.entityRows.rows].reverse();
    const reordered: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: {
        ...current.frame!,
        factory: {
          ...current.frame!.factory,
          selection: {
            ...current.frame!.factory.selection,
            entityRows: { rows: reorderedRows, totalCount: reorderedRows.length, truncated: false },
          },
        },
      },
    };
    expect(selectFactorySelectionToolbarReadModel(
      selectionToolbarWeb,
      reordered,
      21,
      selectionBinding,
    )).toBe(selectionToolbarWeb);

    const truncated: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: {
        ...current.frame!,
        factory: {
          ...current.frame!.factory,
          selection: {
            ...current.frame!.factory.selection,
            beltRows: { ...current.frame!.factory.selection.beltRows, truncated: true },
          },
        },
      },
    };
    expect(selectFactorySelectionToolbarReadModel(
      selectionToolbarWeb,
      truncated,
      21,
      selectionBinding,
    )).toBe(selectionToolbarWeb);

    const wrongLock: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: {
        ...current.frame!,
        factory: {
          ...current.frame!.factory,
          selection: {
            ...current.frame!.factory.selection,
            entityRows: {
              rows: current.frame!.factory.selection.entityRows.rows.map((row) => ({
                ...row,
                interactionLocked: false,
              })),
              totalCount: 2,
              truncated: false,
            },
          },
        },
      },
    };
    expect(selectFactorySelectionToolbarReadModel(
      selectionToolbarWeb,
      wrongLock,
      21,
      selectionBinding,
    )).toBe(selectionToolbarWeb);
  });

  it("never selects native rows for over-cap or incomplete request bindings", () => {
    expect(selectFactorySelectionToolbarReadModel(
      selectionToolbarWeb,
      selectionSnapshot(),
      21,
      { ...selectionBinding, selectedEntityIds: Array.from({ length: 65 }, (_, index) => `entity-${index}`) },
    )).toBe(selectionToolbarWeb);
    expect(selectFactorySelectionToolbarReadModel(
      selectionToolbarWeb,
      selectionSnapshot(),
      21,
      { ...selectionBinding, requestedEntityIds: ["entity-open"] },
    )).toBe(selectionToolbarWeb);
    expect(selectFactorySelectionToolbarReadModel(
      selectionToolbarWeb,
      selectionSnapshot(),
      21,
      { ...selectionBinding, requestTruncated: true },
    )).toBe(selectionToolbarWeb);
  });
});

describe("native factory thin-view compact inspector bridge", () => {
  const entityWeb: FactoryInspectorSummaryReadModel = {
    schema: "factory-read-model-v1",
    source: "web-game-state",
    revision: null,
    activePlanetId: "home",
    entity: selectedEntity("entity-open", false),
    belt: null,
  };
  const beltWeb: FactoryInspectorSummaryReadModel = {
    schema: "factory-read-model-v1",
    source: "web-game-state",
    revision: null,
    activePlanetId: "home",
    entity: null,
    belt: selectedBelt("belt-inspected"),
  };

  it("uses only a complete exact-revision row for entity and belt display fields", () => {
    expect(selectFactoryInspectorSummaryReadModel(entityWeb, selectionSnapshot(), 21, inspectorBinding)).toEqual({
      ...entityWeb,
      source: "native-core",
      revision: 21,
    });
    expect(selectFactoryInspectorSummaryReadModel(beltWeb, selectionSnapshot(), 21, inspectorBinding)).toEqual({
      ...beltWeb,
      source: "native-core",
      revision: 21,
    });
  });

  it("fails closed for stale, truncated, missing, reordered, or semantically different rows", () => {
    expect(selectFactoryInspectorSummaryReadModel(entityWeb, selectionSnapshot(20), 21, inspectorBinding)).toBe(entityWeb);
    expect(selectFactoryInspectorSummaryReadModel(entityWeb, selectionSnapshot(), 21, {
      ...inspectorBinding,
      requestTruncated: true,
    })).toBe(entityWeb);
    expect(selectFactoryInspectorSummaryReadModel(entityWeb, selectionSnapshot(), 21, {
      ...inspectorBinding,
      requestedEntityIds: ["entity-locked", "entity-open"],
    })).toBe(entityWeb);

    const current = selectionSnapshot();
    const drifted: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: {
        ...current.frame!,
        factory: {
          ...current.frame!.factory,
          selection: {
            ...current.frame!.factory.selection,
            entityRows: {
              ...current.frame!.factory.selection.entityRows,
              rows: current.frame!.factory.selection.entityRows.rows.map((row) => row.entityId === "entity-open"
                ? { ...row, productionRate: 1 }
                : row),
            },
          },
        },
      },
    };
    expect(selectFactoryInspectorSummaryReadModel(entityWeb, drifted, 21, inspectorBinding)).toBe(entityWeb);

    const nestedTruncation: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: {
        ...current.frame!,
        factory: {
          ...current.frame!.factory,
          selection: {
            ...current.frame!.factory.selection,
            entityRows: {
              ...current.frame!.factory.selection.entityRows,
              rows: current.frame!.factory.selection.entityRows.rows.map((row) => row.entityId === "entity-open"
                ? { ...row, inputItems: { rows: [], totalCount: 1, truncated: true } }
                : row),
            },
          },
        },
      },
    };
    expect(selectFactoryInspectorSummaryReadModel(entityWeb, nestedTruncation, 21, inspectorBinding)).toBe(entityWeb);
  });
});

describe("native factory thin-view desktop multi-selection bridge", () => {
  it("selects complete ordered rows only from the exact atomic revision", () => {
    const selected = selectFactoryMultiSelectionSummaryReadModel(
      multiSelectionWeb,
      selectionSnapshot(),
      21,
      inspectorBinding,
    );
    expect(selected).toEqual({ ...multiSelectionWeb, source: "native-core", revision: 21 });
    expect(selectFactoryMultiSelectionSummaryReadModel(
      multiSelectionWeb,
      selectionSnapshot(20),
      21,
      inspectorBinding,
    )).toBe(multiSelectionWeb);
  });

  it("fails closed for reordered, nested-truncated, or semantically drifted rows", () => {
    const current = selectionSnapshot();
    const reordered: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: {
        ...current.frame!,
        factory: {
          ...current.frame!.factory,
          selection: {
            ...current.frame!.factory.selection,
            entityRows: {
              rows: [...current.frame!.factory.selection.entityRows.rows].reverse(),
              totalCount: 2,
              truncated: false,
            },
          },
        },
      },
    };
    expect(selectFactoryMultiSelectionSummaryReadModel(
      multiSelectionWeb,
      reordered,
      21,
      inspectorBinding,
    )).toBe(multiSelectionWeb);

    const nestedTruncated: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: {
        ...current.frame!,
        factory: {
          ...current.frame!.factory,
          selection: {
            ...current.frame!.factory.selection,
            entityRows: {
              ...current.frame!.factory.selection.entityRows,
              rows: current.frame!.factory.selection.entityRows.rows.map((row, index) => index === 0
                ? { ...row, outputItems: { rows: [], totalCount: 1, truncated: true } }
                : row),
            },
          },
        },
      },
    };
    expect(selectFactoryMultiSelectionSummaryReadModel(
      multiSelectionWeb,
      nestedTruncated,
      21,
      inspectorBinding,
    )).toBe(multiSelectionWeb);

    const missingPower: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: {
        ...current.frame!,
        factory: {
          ...current.frame!.factory,
          selection: {
            ...current.frame!.factory.selection,
            entityRows: {
              ...current.frame!.factory.selection.entityRows,
              rows: current.frame!.factory.selection.entityRows.rows.map((row, index) => index === 0
                ? { ...row, powerFactor: null }
                : row),
            },
          },
        },
      },
    };
    expect(selectFactoryMultiSelectionSummaryReadModel(
      multiSelectionWeb,
      missingPower,
      21,
      inspectorBinding,
    )).toBe(multiSelectionWeb);
  });

  it("keeps the complete Web fallback for over-limit or incomplete bindings", () => {
    expect(selectFactoryMultiSelectionSummaryReadModel(
      multiSelectionWeb,
      selectionSnapshot(),
      21,
      { ...inspectorBinding, requestTruncated: true },
    )).toBe(multiSelectionWeb);
    expect(selectFactoryMultiSelectionSummaryReadModel(
      multiSelectionWeb,
      selectionSnapshot(),
      21,
      {
        ...inspectorBinding,
        requestedEntityIds: Array.from({ length: 65 }, (_, index) => `entity-${index}`),
      },
    )).toBe(multiSelectionWeb);
    expect(selectFactoryMultiSelectionSummaryReadModel(
      { ...multiSelectionWeb, entityRows: { ...multiSelectionWeb.entityRows, truncated: true } },
      selectionSnapshot(),
      21,
      inspectorBinding,
    ).source).toBe("web-game-state");
    const nestedWebTruncation: FactoryMultiSelectionSummaryReadModel = {
      ...multiSelectionWeb,
      entityRows: {
        ...multiSelectionWeb.entityRows,
        rows: multiSelectionWeb.entityRows.rows.map((row, index) => index === 0
          ? { ...row, inputItems: { rows: [], totalCount: 1, truncated: true } }
          : row),
      },
    };
    expect(selectFactoryMultiSelectionSummaryReadModel(
      nestedWebTruncation,
      selectionSnapshot(),
      21,
      inspectorBinding,
    )).toBe(nestedWebTruncation);
  });
});

describe("native factory thin-view planet navigation bridge", () => {
  it("uses the exact native dynamic rows while retaining the bounded catalog code", () => {
    const selected = selectFactoryPlanetNavigationReadModel(navigationWeb, snapshot(12), 12);
    expect(selected).not.toBe(navigationWeb);
    expect(selected.planets.rows[0]).toEqual(navigationWeb.planets.rows[0]);
    expect(selected.planets.rows[0].code).toBe("H-I");
  });

  it("fails closed for stale, incomplete, or semantically different rows", () => {
    expect(selectFactoryPlanetNavigationReadModel(navigationWeb, snapshot(11), 12)).toBe(navigationWeb);
    const current = snapshot(12);
    const wrongPower: NativeFactoryThinViewSnapshot = {
      ...current,
      frame: {
        ...current.frame!,
        factory: {
          ...current.frame!.factory,
          planetNavigation: {
            ...current.frame!.factory.planetNavigation,
            planets: {
              ...current.frame!.factory.planetNavigation.planets,
              rows: current.frame!.factory.planetNavigation.planets.rows.map((row) => ({
                ...row,
                powerFactor: 0.5,
              })),
            },
          },
        },
      },
    };
    expect(selectFactoryPlanetNavigationReadModel(navigationWeb, wrongPower, 12)).toBe(navigationWeb);
  });
});
