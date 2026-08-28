import { describe, expect, it, vi } from "vitest";

import type {
  DesktopNativeCoreBeltProjection,
  DesktopNativeCoreEntityProjection,
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
  const worldBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    schemaVersion: 2,
    projectionType: "viewport-v2",
    revision,
    planetId,
    bounds,
    base: {},
    entities: [{
      id: "entity-1",
      kind: "vein",
      planetId: planetId as DesktopNativeCoreEntityProjection["planetId"],
      position: { x: 0, y: 0 },
      resourceId: "iron_ore",
      inputs: {},
      outputs: { iron_ore: 1 },
    }],
    belts: [],
    pinnedEntityIds: [],
    pinnedBeltIds: [],
    nextEntityCursor: null,
    nextBeltCursor: null,
    planetTotals: { entities: 1, belts: 0 },
    viewportTotals: { entities: 1, belts: 0 },
    worldBounds,
    minimap: { bounds: worldBounds, entityCount: 1, beltCount: 0, occupiedCellCount: 1, cellSize: 512 },
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

  it("closes independent entity and belt cursors without duplicating pinned rows", async () => {
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const worldBounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const entityRows: DesktopNativeCoreEntityProjection[] = [
      { id: "entity-0", kind: "vein", planetId: "planet-a" as never, position: { x: 0, y: 0 } },
      { id: "entity-1", kind: "vein", planetId: "planet-a" as never, position: { x: 1, y: 1 } },
      { id: "entity-2", kind: "vein", planetId: "planet-a" as never, position: { x: 2, y: 2 } },
      { id: "entity-4", kind: "vein", planetId: "planet-a" as never, position: { x: 100, y: 100 } },
    ];
    const beltRows = [
      { id: "belt-0", planetId: "planet-a" as never, source: "entity-0", target: "entity-1", itemId: "iron_ore" as never },
      { id: "belt-1", planetId: "planet-a" as never, source: "entity-2", target: "entity-3", itemId: "iron_ore" as never },
      { id: "belt-2", planetId: "planet-a" as never, source: "entity-4", target: "entity-3", itemId: "iron_ore" as never },
      { id: "belt-3", planetId: "planet-a" as never, source: "entity-3", target: "entity-3", itemId: "iron_ore" as never },
    ];
    const reads: Array<[number, number]> = [];
    const pagedSource: NativeFactoryThinViewSource = {
      readVerifiedFactoryReadModel: vi.fn().mockResolvedValue(factoryProjection(20)),
      readVerifiedViewportProjectionV2: vi.fn(async (pageRequest): Promise<DesktopNativeCoreViewportProjectionV2Result> => {
        const entityCursor = pageRequest.entityCursor ?? 0;
        const beltCursor = pageRequest.beltCursor ?? 0;
        reads.push([entityCursor, beltCursor]);
        const ordinaryEntities = entityRows.slice(0, 3).slice(entityCursor, entityCursor + pageRequest.entityLimit);
        const ordinaryBelts = beltRows.slice(0, 3).slice(beltCursor, beltCursor + pageRequest.beltLimit);
        return {
          schemaVersion: 2,
          projectionType: "viewport-v2",
          revision: 20,
          planetId: "planet-a",
          bounds,
          base: {},
          entities: [...ordinaryEntities, entityRows[3]].sort((left, right) => left.id.localeCompare(right.id)),
          belts: [...ordinaryBelts, beltRows[3]].sort((left, right) => left.id.localeCompare(right.id)),
          pinnedEntityIds: ["entity-4"],
          pinnedBeltIds: ["belt-3"],
          nextEntityCursor: entityCursor + ordinaryEntities.length < 3 ? entityCursor + ordinaryEntities.length : null,
          nextBeltCursor: beltCursor + ordinaryBelts.length < 3 ? beltCursor + ordinaryBelts.length : null,
          planetTotals: { entities: 5, belts: 4 },
          viewportTotals: { entities: 3, belts: 3 },
          worldBounds,
          minimap: { bounds: worldBounds, entityCount: 5, beltCount: 4, occupiedCellCount: 2, cellSize: 512 },
          broadQueryFallback: false,
        };
      }),
    };
    const pagedRequest = request(20);
    pagedRequest.viewport.bounds = bounds;
    pagedRequest.viewport.entityLimit = 2;
    pagedRequest.viewport.beltLimit = 2;
    pagedRequest.viewport.pinnedEntityIds = ["entity-4"];
    pagedRequest.viewport.pinnedBeltIds = ["belt-3"];

    await expect(new NativeFactoryThinViewStore().refresh(pagedSource, pagedRequest)).resolves.toMatchObject({
      status: "committed",
      frame: {
        viewport: {
          nextEntityCursor: null,
          nextBeltCursor: null,
          viewportTotals: { entities: 3, belts: 3 },
        },
      },
    });
    expect(reads).toEqual([[0, 0], [2, 2]]);
    const result = await new NativeFactoryThinViewStore().refresh(pagedSource, pagedRequest);
    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(new Set(result.frame.viewport.entities.map((row) => row.id))).toEqual(new Set(["entity-0", "entity-1", "entity-2", "entity-4"]));
      expect(new Set(result.frame.viewport.belts.map((row) => row.id))).toEqual(new Set(["belt-0", "belt-1", "belt-2", "belt-3"]));
    }
  });

  it("fails closed for non-monotonic cursors or a page that cannot close its totals", async () => {
    const nonMonotonic = viewportProjection(21);
    nonMonotonic.nextEntityCursor = 0;
    const nonMonotonicSource = source(factoryProjection(21), nonMonotonic);
    await expect(new NativeFactoryThinViewStore().refresh(nonMonotonicSource, request(21))).resolves.toEqual({
      status: "unavailable",
    });

    const missing = viewportProjection(22);
    missing.entities = [];
    const missingSource = source(factoryProjection(22), missing);
    await expect(new NativeFactoryThinViewStore().refresh(missingSource, request(22))).resolves.toEqual({
      status: "unavailable",
    });
  });

  it.each([
    { name: "entity cursor ends first", entityTotal: 1, beltTotal: 3 },
    { name: "belt cursor ends first", entityTotal: 3, beltTotal: 1 },
  ])("closes when $name", async ({ entityTotal, beltTotal }) => {
    const revision = 23;
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const entities: DesktopNativeCoreEntityProjection[] = Array.from({ length: entityTotal }, (_, index) => ({
      id: `entity-${index}`,
      kind: "vein",
      planetId: "planet-a" as never,
      position: { x: index, y: index },
    }));
    const belts: DesktopNativeCoreBeltProjection[] = Array.from({ length: beltTotal }, (_, index) => ({
      id: `belt-${index}`,
      planetId: "planet-a" as never,
      source: "entity-0",
      target: "entity-0",
      itemId: "iron_ore" as never,
    }));
    const reads: Array<[number, number]> = [];
    const pagedSource: NativeFactoryThinViewSource = {
      readVerifiedFactoryReadModel: vi.fn().mockResolvedValue(factoryProjection(revision)),
      readVerifiedViewportProjectionV2: vi.fn(async (pageRequest): Promise<DesktopNativeCoreViewportProjectionV2Result> => {
        const entityCursor = pageRequest.entityCursor ?? 0;
        const beltCursor = pageRequest.beltCursor ?? 0;
        reads.push([entityCursor, beltCursor]);
        const entityPage = entities.slice(entityCursor, entityCursor + 1);
        const beltPage = belts.slice(beltCursor, beltCursor + 1);
        return {
          schemaVersion: 2,
          projectionType: "viewport-v2",
          revision,
          planetId: "planet-a",
          bounds,
          base: {},
          entities: entityPage,
          belts: beltPage,
          pinnedEntityIds: [],
          pinnedBeltIds: [],
          nextEntityCursor: entityCursor + entityPage.length < entityTotal ? entityCursor + entityPage.length : null,
          nextBeltCursor: beltCursor + beltPage.length < beltTotal ? beltCursor + beltPage.length : null,
          planetTotals: { entities: entityTotal, belts: beltTotal },
          viewportTotals: { entities: entityTotal, belts: beltTotal },
          worldBounds: bounds,
          minimap: { bounds, entityCount: entityTotal, beltCount: beltTotal, occupiedCellCount: 1, cellSize: 512 },
          broadQueryFallback: false,
        };
      }),
    };
    const pagedRequest = request(revision);
    pagedRequest.viewport.bounds = bounds;
    pagedRequest.viewport.entityLimit = 1;
    pagedRequest.viewport.beltLimit = 1;

    const result = await new NativeFactoryThinViewStore().refresh(pagedSource, pagedRequest);

    expect(result.status).toBe("committed");
    expect(reads).toHaveLength(Math.max(entityTotal, beltTotal));
    if (entityTotal < beltTotal) expect(reads.slice(1).every(([entityCursor]) => entityCursor === entityTotal)).toBe(true);
    if (beltTotal < entityTotal) expect(reads.slice(1).every(([, beltCursor]) => beltCursor === beltTotal)).toBe(true);
  });

  it("accepts exactly 64 complete pages and rejects a required 65th page", async () => {
    const pagedSource = (revision: number, total: number): NativeFactoryThinViewSource => ({
      readVerifiedFactoryReadModel: vi.fn().mockResolvedValue(factoryProjection(revision)),
      readVerifiedViewportProjectionV2: vi.fn(async (pageRequest): Promise<DesktopNativeCoreViewportProjectionV2Result> => {
        const cursor = pageRequest.entityCursor ?? 0;
        const entity: DesktopNativeCoreEntityProjection = {
          id: `entity-${cursor}`,
          kind: "vein",
          planetId: "planet-a" as never,
          position: { x: cursor, y: 0 },
        };
        const bounds = { minX: 0, minY: 0, maxX: total, maxY: 1 };
        return {
          schemaVersion: 2,
          projectionType: "viewport-v2",
          revision,
          planetId: "planet-a",
          bounds,
          base: {},
          entities: [entity],
          belts: [],
          pinnedEntityIds: [],
          pinnedBeltIds: [],
          nextEntityCursor: cursor + 1 < total ? cursor + 1 : null,
          nextBeltCursor: null,
          planetTotals: { entities: total, belts: 0 },
          viewportTotals: { entities: total, belts: 0 },
          worldBounds: bounds,
          minimap: { bounds, entityCount: total, beltCount: 0, occupiedCellCount: 1, cellSize: 512 },
          broadQueryFallback: false,
        };
      }),
    });
    const request64 = request(24);
    request64.viewport.bounds = { minX: 0, minY: 0, maxX: 64, maxY: 1 };
    request64.viewport.entityLimit = 1;
    const request65 = request(25);
    request65.viewport.bounds = { minX: 0, minY: 0, maxX: 65, maxY: 1 };
    request65.viewport.entityLimit = 1;

    await expect(new NativeFactoryThinViewStore().refresh(pagedSource(24, 64), request64)).resolves.toMatchObject({
      status: "committed",
    });
    await expect(new NativeFactoryThinViewStore().refresh(pagedSource(25, 65), request65)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("rejects a pinned row whose record changes between pages", async () => {
    const revision = 26;
    const bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const pagedSource: NativeFactoryThinViewSource = {
      readVerifiedFactoryReadModel: vi.fn().mockResolvedValue(factoryProjection(revision)),
      readVerifiedViewportProjectionV2: vi.fn(async (pageRequest): Promise<DesktopNativeCoreViewportProjectionV2Result> => {
        const cursor = pageRequest.entityCursor ?? 0;
        const pinned: DesktopNativeCoreEntityProjection = {
          id: "pinned",
          kind: "vein",
          planetId: "planet-a" as never,
          position: { x: 100 + cursor, y: 100 },
        };
        const ordinary: DesktopNativeCoreEntityProjection = {
          id: `entity-${cursor}`,
          kind: "vein",
          planetId: "planet-a" as never,
          position: { x: cursor, y: 0 },
        };
        const worldBounds = { minX: 0, minY: 0, maxX: 101, maxY: 100 };
        return {
          schemaVersion: 2,
          projectionType: "viewport-v2",
          revision,
          planetId: "planet-a",
          bounds,
          base: {},
          entities: [ordinary, pinned],
          belts: [],
          pinnedEntityIds: ["pinned"],
          pinnedBeltIds: [],
          nextEntityCursor: cursor === 0 ? 1 : null,
          nextBeltCursor: null,
          planetTotals: { entities: 3, belts: 0 },
          viewportTotals: { entities: 2, belts: 0 },
          worldBounds,
          minimap: { bounds: worldBounds, entityCount: 3, beltCount: 0, occupiedCellCount: 2, cellSize: 512 },
          broadQueryFallback: false,
        };
      }),
    };
    const pagedRequest = request(revision);
    pagedRequest.viewport.bounds = bounds;
    pagedRequest.viewport.entityLimit = 1;
    pagedRequest.viewport.pinnedEntityIds = ["pinned"];

    await expect(new NativeFactoryThinViewStore().refresh(pagedSource, pagedRequest)).resolves.toEqual({
      status: "unavailable",
    });
  });
});
