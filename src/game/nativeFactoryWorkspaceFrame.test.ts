import { describe, expect, it } from "vitest";
import type {
  DesktopNativeCoreFactoryReadModelResult,
  DesktopNativeCoreViewportProjectionV2Result,
} from "../desktop";
import { selectNativeAuthoritativeFactoryWorkspaceFrame } from "./nativeFactoryWorkspaceFrame";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";

const emptyRows = <Row>(rows: Row[] = []) => ({ rows, totalCount: rows.length, truncated: false });

function factory(revision = 17): DesktopNativeCoreFactoryReadModelResult {
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
      paused: false,
      elapsedSeconds: 120,
      simulationSpeed: 1,
      timeWarp: {
        controllerEntityId: "time-warp-1",
        enabled: true,
        requestedMultiplier: 15,
        effectiveMultiplier: 12,
        requiredPowerKw: 1e13,
        allocatedPowerKw: 1e13,
      },
      entityCount: 4,
      beltCount: 3,
      activePlanetEntityCount: 4,
      activePlanetBeltCount: 3,
      constructionQueueCount: 1,
    },
    planetNavigation: {
      schema: "factory-read-model-v1",
      activePlanetId: "home",
      planets: emptyRows([{
        planetId: "home",
        systemId: "helios",
        displayName: "家园星",
        code: "home",
        active: true,
        discovered: true,
        colonized: true,
        role: "auto",
        entityCount: 4,
        deviceCount: 4,
        beltCount: 3,
        constructionQueueCount: 1,
        powerFactor: 1,
      }]),
    },
    selection: {
      schema: "factory-read-model-v1",
      activePlanetId: "home",
      requestedEntityCount: 0,
      requestedBeltCount: 0,
      entityRows: emptyRows(),
      beltRows: emptyRows(),
    },
    construction: {
      schema: "factory-read-model-v1",
      activePlanetId: "home",
      queue: emptyRows([{
        queueId: "queue-1",
        blueprintId: "blueprint-1",
        blueprintVersionId: null,
        blueprintRevision: null,
        blueprintName: "测试蓝图",
        planetId: "home",
        queuedAt: 1,
        status: "pending-materials",
        rotation: 0,
        mirror: "none",
        placedEntityCount: 0,
        reservedConstruction: emptyRows(),
        reservedFleet: emptyRows(),
      }]),
      automation: {
        enabled: true,
        quantumSourceEnabled: true,
        totalCrafted: 2,
        lastCraftedId: "assembling_machine_mk1",
        targets: emptyRows(),
        jobs: emptyRows(),
        destroyedByproducts: emptyRows(),
      },
    },
  };
}

function viewport(revision = 17): DesktopNativeCoreViewportProjectionV2Result {
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  return {
    schemaVersion: 2,
    projectionType: "viewport-v2",
    revision,
    planetId: "home",
    bounds,
    base: {},
    entities: [],
    belts: [],
    pinnedEntityIds: [],
    pinnedBeltIds: [],
    nextEntityCursor: null,
    nextBeltCursor: null,
    planetTotals: { entities: 4, belts: 3 },
    viewportTotals: { entities: 0, belts: 0 },
    worldBounds: bounds,
    minimap: { bounds, entityCount: 4, beltCount: 3, occupiedCellCount: 1, cellSize: 320 },
    broadQueryFallback: false,
  };
}

function snapshot(overrides: Partial<NativeFactoryThinViewSnapshot> = {}): NativeFactoryThinViewSnapshot {
  return {
    status: "ready",
    requestedRevision: 17,
    frame: {
      revision: 17,
      planetId: "home",
      authoritySessionId: "authority-1",
      factory: factory(),
      viewport: viewport(),
    },
    ...overrides,
  };
}

const binding = {
  enabled: true,
  sessionId: "authority-1",
  expectedRevision: 17,
  activePlanetId: "home",
} as const;

describe("native authoritative factory workspace frame", () => {
  it("creates all non-canvas factory read models without a GameState oracle", () => {
    const result = selectNativeAuthoritativeFactoryWorkspaceFrame(snapshot(), binding);
    expect(result).toMatchObject({
      source: "native-authoritative",
      sessionId: "authority-1",
      revision: 17,
      runStatus: { source: "native-core", paused: false },
      timeWarp: { enabled: true, requestedMultiplier: 15, effectiveMultiplier: 12 },
      constructionHeadline: { activePlanetDisplayName: "家园星", constructionQueueCount: 1 },
      constructionWorkspace: { source: "native-core", revision: 17 },
      planetNavigation: { activePlanetId: "home" },
    });
  });

  it("rejects stale, cross-session and identity-mismatched atoms", () => {
    expect(selectNativeAuthoritativeFactoryWorkspaceFrame(snapshot(), {
      ...binding,
      sessionId: "authority-2",
    })).toBeNull();
    expect(selectNativeAuthoritativeFactoryWorkspaceFrame(snapshot({ requestedRevision: 16 }), binding)).toBeNull();
    expect(selectNativeAuthoritativeFactoryWorkspaceFrame(snapshot(), {
      ...binding,
      activePlanetId: "remote",
    })).toBeNull();
  });

  it("falls back atomically for any truncated or inconsistent nested workspace", () => {
    const completeFactory = factory();
    const truncatedFactory = {
      ...completeFactory,
      construction: {
        ...completeFactory.construction,
        queue: { ...completeFactory.construction.queue, truncated: true },
      },
    };
    expect(selectNativeAuthoritativeFactoryWorkspaceFrame(snapshot({
      frame: { ...snapshot().frame!, factory: truncatedFactory },
    }), binding)).toBeNull();

    const mismatchedFactory = {
      ...completeFactory,
      shell: { ...completeFactory.shell, constructionQueueCount: 2 },
    };
    expect(selectNativeAuthoritativeFactoryWorkspaceFrame(snapshot({
      frame: { ...snapshot().frame!, factory: mismatchedFactory },
    }), binding)).toBeNull();

    const invalidTimeWarpFactory = {
      ...completeFactory,
      shell: {
        ...completeFactory.shell,
        timeWarp: { ...completeFactory.shell.timeWarp!, allocatedPowerKw: 1e14 },
      },
    };
    expect(selectNativeAuthoritativeFactoryWorkspaceFrame(snapshot({
      frame: { ...snapshot().frame!, factory: invalidTimeWarpFactory },
    }), binding)).toBeNull();

    const missingActiveFactory = {
      ...completeFactory,
      planetNavigation: {
        ...completeFactory.planetNavigation,
        planets: {
          ...completeFactory.planetNavigation.planets,
          rows: completeFactory.planetNavigation.planets.rows.map((row) => ({ ...row, active: false })),
        },
      },
    };
    expect(selectNativeAuthoritativeFactoryWorkspaceFrame(snapshot({
      frame: { ...snapshot().frame!, factory: missingActiveFactory },
    }), binding)).toBeNull();
  });
});
