import { describe, expect, it, vi } from "vitest";

import type {
  DesktopNativeCoreFactoryReadModelResult,
  DesktopNativeCoreViewportProjectionV2Result,
} from "../desktop";
import {
  NativeFactoryThinViewStore,
  type NativeFactoryThinViewRequest,
  type NativeFactoryThinViewSource,
} from "./nativeFactoryThinViewStore";

function factoryProjection(revision: number, planetId = "planet-a"): DesktopNativeCoreFactoryReadModelResult {
  return {
    schemaVersion: 1,
    projectionType: "factory-read-model-v1",
    revision,
    shell: {
      schema: "factory-read-model-v1",
      source: "native-core",
      stateVersion: 47,
      mode: "normal",
      activePlanetId: planetId,
      paused: false,
      elapsedSeconds: 12,
      simulationSpeed: 1,
      entityCount: 1,
      beltCount: 0,
      activePlanetEntityCount: 1,
      activePlanetBeltCount: 0,
      constructionQueueCount: 0,
    },
    planetNavigation: {
      schema: "factory-read-model-v1",
      activePlanetId: planetId,
      planets: { rows: [], totalCount: 1, truncated: true },
    },
    selection: {
      schema: "factory-read-model-v1",
      activePlanetId: planetId,
      requestedEntityCount: 0,
      requestedBeltCount: 0,
      entityRows: { rows: [], totalCount: 0, truncated: false },
      beltRows: { rows: [], totalCount: 0, truncated: false },
    },
    construction: {
      schema: "factory-read-model-v1",
      activePlanetId: planetId,
      queue: { rows: [], totalCount: 0, truncated: false },
      automation: {
        enabled: false,
        quantumSourceEnabled: false,
        totalCrafted: 0,
        lastCraftedId: null,
        targets: { rows: [], totalCount: 0, truncated: false },
        jobs: { rows: [], totalCount: 0, truncated: false },
        destroyedByproducts: { rows: [], totalCount: 0, truncated: false },
      },
    },
  };
}

function viewportProjection(revision: number, planetId = "planet-a"): DesktopNativeCoreViewportProjectionV2Result {
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  return {
    schemaVersion: 2,
    projectionType: "viewport-v2",
    revision,
    planetId,
    bounds,
    base: {},
    entities: [],
    belts: [],
    pinnedEntityIds: [],
    pinnedBeltIds: [],
    nextEntityCursor: null,
    nextBeltCursor: null,
    planetTotals: { entities: 1, belts: 0 },
    viewportTotals: { entities: 1, belts: 0 },
    worldBounds: bounds,
    minimap: { bounds, entityCount: 1, beltCount: 0, occupiedCellCount: 1, cellSize: 512 },
    broadQueryFallback: false,
  };
}

function request(revision: number, planetId = "planet-a"): NativeFactoryThinViewRequest {
  return {
    expectedRevision: revision,
    factory: { selectedEntityIds: [], selectedBeltIds: [] },
    viewport: {
      planetId,
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      entityCursor: 0,
      entityLimit: 128,
      beltCursor: 0,
      beltLimit: 256,
      pinnedEntityIds: [],
      pinnedBeltIds: [],
    },
  };
}

function source(
  factory: DesktopNativeCoreFactoryReadModelResult | null,
  viewport: DesktopNativeCoreViewportProjectionV2Result | null,
): NativeFactoryThinViewSource {
  return {
    readVerifiedFactoryReadModel: vi.fn().mockResolvedValue(factory),
    readVerifiedViewportProjectionV2: vi.fn().mockResolvedValue(viewport),
  };
}

describe("NativeFactoryThinViewStore", () => {
  it("publishes shell and viewport atomically at one verified revision", async () => {
    const store = new NativeFactoryThinViewStore();
    const notifications: string[] = [];
    store.subscribe(() => notifications.push(store.getSnapshot().status));

    const result = await store.refresh(source(factoryProjection(7), viewportProjection(7)), request(7));

    expect(result.status).toBe("committed");
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      requestedRevision: 7,
      frame: { revision: 7, planetId: "planet-a" },
    });
    expect(notifications).toEqual(["loading", "ready"]);
  });

  it("keeps the previous complete frame when either projection is unavailable or mismatched", async () => {
    const store = new NativeFactoryThinViewStore();
    await store.refresh(source(factoryProjection(3), viewportProjection(3)), request(3));
    const priorFrame = store.getSnapshot().frame;

    const unavailable = await store.refresh(source(factoryProjection(4), viewportProjection(5)), request(4));

    expect(unavailable).toEqual({ status: "unavailable" });
    expect(store.getSnapshot()).toEqual({ status: "unavailable", requestedRevision: 4, frame: priorFrame });
  });

  it("does not let an older slow request overwrite the newest revision", async () => {
    let resolveOldFactory!: (value: DesktopNativeCoreFactoryReadModelResult) => void;
    const oldSource: NativeFactoryThinViewSource = {
      readVerifiedFactoryReadModel: () => new Promise((resolve) => { resolveOldFactory = resolve; }),
      readVerifiedViewportProjectionV2: vi.fn().mockResolvedValue(viewportProjection(10)),
    };
    const store = new NativeFactoryThinViewStore();
    const oldRefresh = store.refresh(oldSource, request(10));
    await store.refresh(source(factoryProjection(11), viewportProjection(11)), request(11));
    resolveOldFactory(factoryProjection(10));

    await expect(oldRefresh).resolves.toEqual({ status: "superseded" });
    expect(store.getSnapshot().frame?.revision).toBe(11);
  });

  it("supersedes an older selection request even when both target the same revision", async () => {
    let resolveOldFactory!: (value: DesktopNativeCoreFactoryReadModelResult) => void;
    const oldSource: NativeFactoryThinViewSource = {
      readVerifiedFactoryReadModel: () => new Promise((resolve) => { resolveOldFactory = resolve; }),
      readVerifiedViewportProjectionV2: vi.fn().mockResolvedValue(viewportProjection(12, "planet-a")),
    };
    const store = new NativeFactoryThinViewStore();
    const oldRefresh = store.refresh(oldSource, request(12, "planet-a"));
    await store.refresh(source(factoryProjection(12, "planet-b"), viewportProjection(12, "planet-b")), request(12, "planet-b"));
    resolveOldFactory(factoryProjection(12, "planet-a"));

    await expect(oldRefresh).resolves.toEqual({ status: "superseded" });
    expect(store.getSnapshot().frame).toMatchObject({ revision: 12, planetId: "planet-b" });
  });

  it("clears the complete frame and invalidates in-flight reads", async () => {
    let resolveFactory!: (value: DesktopNativeCoreFactoryReadModelResult) => void;
    const pendingSource: NativeFactoryThinViewSource = {
      readVerifiedFactoryReadModel: () => new Promise((resolve) => { resolveFactory = resolve; }),
      readVerifiedViewportProjectionV2: vi.fn().mockResolvedValue(viewportProjection(2)),
    };
    const store = new NativeFactoryThinViewStore();
    const pending = store.refresh(pendingSource, request(2));
    store.clear();
    resolveFactory(factoryProjection(2));

    await expect(pending).resolves.toEqual({ status: "superseded" });
    expect(store.getSnapshot()).toEqual({ status: "empty", requestedRevision: null, frame: null });
  });
});
