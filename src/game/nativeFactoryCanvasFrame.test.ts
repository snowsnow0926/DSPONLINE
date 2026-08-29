import { describe, expect, it, vi } from "vitest";

import type {
  DesktopNativeCoreFactoryReadModelResult,
  DesktopNativeCoreViewportProjectionV2Result,
} from "../desktop";
import type { BeltConnection, FactoryEntity } from "./types";
import { NativeFactoryThinViewStore, type NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";
import {
  collectCanvasDragMembers,
  collectCanvasSelectionBeltIds,
  selectFactoryCanvasRows,
  selectNativeAuthoritativeFactoryCanvasFrame,
  type NativeAuthoritativeFactoryCanvasBinding,
} from "./nativeFactoryCanvasFrame";

const BOUNDS: DesktopNativeCoreViewportProjectionV2Result["bounds"] =
  Object.freeze({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
const WORLD_BOUNDS: DesktopNativeCoreViewportProjectionV2Result["worldBounds"] =
  Object.freeze({ minX: -100, minY: -100, maxX: 500, maxY: 500 });

function entity(id: string, x: number, locked = false): FactoryEntity {
  return {
    id,
    kind: "machine",
    planetId: "home",
    position: { x, y: 10 },
    interactionLocked: locked,
    buildingId: "arc_smelter",
    recipeId: "iron_ingot",
    routingCursor: 0,
    machineCount: 1,
    minerCount: 0,
    inputs: { iron_ore: 1 },
    outputs: { iron_ingot: 1 },
    progress: 0,
    utilization: 1,
    productionRate: 60,
  };
}

function belt(id: string, source: string, target: string): BeltConnection {
  return {
    id,
    planetId: "home",
    source,
    target,
    itemId: "iron_ingot",
    lanes: 1,
    tier: 1,
    sorterTier: 1,
    progress: 0,
    priority: 1,
    lastFlow: 1,
  };
}

function factory(revision: number): DesktopNativeCoreFactoryReadModelResult {
  return {
    schemaVersion: 1,
    projectionType: "factory-read-model-v1",
    revision,
    shell: { source: "native-core", activePlanetId: "home" },
    planetNavigation: { activePlanetId: "home" },
    selection: { activePlanetId: "home" },
    construction: { activePlanetId: "home" },
  } as DesktopNativeCoreFactoryReadModelResult;
}

function viewport(
  revision: number,
  entities: FactoryEntity[] = [entity("entity-a", 10), entity("entity-b", 30)],
  belts: BeltConnection[] = [belt("belt-a", "entity-a", "entity-b")],
  bounds: DesktopNativeCoreViewportProjectionV2Result["bounds"] = BOUNDS,
): DesktopNativeCoreViewportProjectionV2Result {
  return {
    schemaVersion: 2,
    projectionType: "viewport-v2",
    revision,
    planetId: "home",
    bounds,
    base: {},
    entities,
    belts,
    pinnedEntityIds: [],
    pinnedBeltIds: [],
    nextEntityCursor: null,
    nextBeltCursor: null,
    planetTotals: { entities: entities.length, belts: belts.length },
    viewportTotals: { entities: entities.length, belts: belts.length },
    worldBounds: WORLD_BOUNDS,
    minimap: {
      bounds: WORLD_BOUNDS,
      entityCount: entities.length,
      beltCount: belts.length,
      occupiedCellCount: 1,
      cellSize: 512,
    },
    broadQueryFallback: false,
  };
}

function snapshot(
  revision = 7,
  projection = viewport(revision),
  sessionId = "session-a",
  runId = "run-a",
): NativeFactoryThinViewSnapshot {
  return {
    status: "ready",
    requestedRevision: revision,
    frame: {
      revision,
      planetId: "home",
      authoritySessionId: sessionId,
      authorityRunId: runId,
      factory: factory(revision),
      viewport: projection,
    },
  };
}

function binding(overrides: Partial<NativeAuthoritativeFactoryCanvasBinding> = {}): NativeAuthoritativeFactoryCanvasBinding {
  return {
    enabled: true,
    sessionId: "session-a",
    runId: "run-a",
    expectedRevision: 7,
    planetId: "home",
    bounds: BOUNDS,
    requestedPinnedEntityIds: [],
    requestedPinnedBeltIds: [],
    requestTruncated: false,
    ...overrides,
  };
}

describe("native authoritative factory canvas frame", () => {
  it("consumes a complete native frame without evaluating the full Web fallback", () => {
    const frame = selectNativeAuthoritativeFactoryCanvasFrame(snapshot(), binding());
    expect(frame).not.toBeNull();
    const createWebRows = vi.fn(() => ({ entities: [], belts: [], entityById: new Map<string, FactoryEntity>() }));

    const rows = selectFactoryCanvasRows(frame, createWebRows);

    expect(rows.source).toBe("native-authoritative");
    expect(rows.revision).toBe(7);
    expect(rows.entities.map((row) => row.id)).toEqual(["entity-a", "entity-b"]);
    expect(rows.belts.map((row) => row.id)).toEqual(["belt-a"]);
    expect(createWebRows).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled", { enabled: false }],
    ["cross-session", { sessionId: "session-b" }],
    ["cross-run", { runId: "run-b" }],
    ["cross-revision", { expectedRevision: 8 }],
    ["moved-viewport", { bounds: { minX: 100, minY: 0, maxX: 200, maxY: 100 } }],
    ["truncated-pins", { requestTruncated: true }],
  ] as const)("atomically rejects %s bindings", (_label, override) => {
    expect(selectNativeAuthoritativeFactoryCanvasFrame(snapshot(), binding(override))).toBeNull();
  });

  it("invokes one complete Web fallback after a failed frame and accepts the next moved viewport atom", () => {
    const movedBounds = { minX: 100, minY: 0, maxX: 200, maxY: 100 };
    const staleForMove = selectNativeAuthoritativeFactoryCanvasFrame(snapshot(), binding({ bounds: movedBounds }));
    const webEntity = entity("web-only", 150);
    const createWebRows = vi.fn(() => ({
      entities: [webEntity],
      belts: [] as BeltConnection[],
      entityById: new Map([[webEntity.id, webEntity]]),
    }));

    expect(selectFactoryCanvasRows(staleForMove, createWebRows)).toMatchObject({
      source: "web-game-state",
      revision: null,
      entities: [webEntity],
    });
    expect(createWebRows).toHaveBeenCalledTimes(1);

    const movedProjection = viewport(7, [entity("entity-moved", 150)], [], movedBounds);
    const movedFrame = selectNativeAuthoritativeFactoryCanvasFrame(
      snapshot(7, movedProjection),
      binding({ bounds: movedBounds }),
    );
    expect(movedFrame?.entities.map((row) => row.id)).toEqual(["entity-moved"]);
  });

  it("rejects an unknown entity field and missing required belt field instead of mixing rows", () => {
    const unknownEntity = { ...entity("entity-a", 10), modPrivateState: 1 } as unknown as FactoryEntity;
    const missingFlow = { ...belt("belt-a", "entity-a", "entity-b") } as Partial<BeltConnection>;
    delete missingFlow.lastFlow;
    const malformedEntity = viewport(7, [unknownEntity, entity("entity-b", 30)]);
    const malformedBelt = viewport(7, undefined, [missingFlow as BeltConnection]);

    expect(selectNativeAuthoritativeFactoryCanvasFrame(snapshot(7, malformedEntity), binding())).toBeNull();
    expect(selectNativeAuthoritativeFactoryCanvasFrame(snapshot(7, malformedBelt), binding())).toBeNull();
  });

  it("keeps cross-boundary belts out of the render atom while retaining their aggregate count", () => {
    const projection = viewport(7, [entity("entity-a", 10)], [belt("belt-cross", "entity-a", "offscreen")]);
    projection.planetTotals = { entities: 2, belts: 1 };
    const frame = selectNativeAuthoritativeFactoryCanvasFrame(snapshot(7, projection), binding());

    expect(frame).toMatchObject({ omittedCrossBoundaryBeltCount: 1 });
    expect(frame?.belts).toEqual([]);
    expect(frame?.projectedBelts.map((row) => row.id)).toEqual(["belt-cross"]);
    expect(frame?.beltById.get("belt-cross")?.target).toBe("offscreen");
    expect(frame?.viewportTotals.belts).toBe(1);
  });

  it("accepts a completely paged viewport only after the final page has the same identity", async () => {
    const store = new NativeFactoryThinViewStore();
    const first = viewport(11, [entity("entity-a", 10)], [belt("belt-a", "entity-a", "entity-b")]);
    first.planetTotals = { entities: 2, belts: 1 };
    first.viewportTotals = { entities: 2, belts: 1 };
    first.minimap.entityCount = 2;
    first.nextEntityCursor = 1;
    const second = viewport(11, [entity("entity-b", 30)], []);
    second.planetTotals = { entities: 2, belts: 1 };
    second.viewportTotals = { entities: 2, belts: 1 };
    second.minimap.entityCount = 2;
    second.minimap.beltCount = 1;
    const source = {
      readVerifiedFactoryReadModel: vi.fn().mockResolvedValue(factory(11)),
      readVerifiedViewportProjectionV2: vi.fn().mockImplementation((request: { entityCursor?: number }) =>
        Promise.resolve((request.entityCursor ?? 0) === 0 ? first : second)),
    };

    const result = await store.refresh(source, {
      expectedRevision: 11,
      authoritySessionId: "session-a",
      authorityRunId: "run-a",
      factory: { selectedEntityIds: [], selectedBeltIds: [] },
      viewport: {
        planetId: "home",
        bounds: BOUNDS,
        entityCursor: 0,
        entityLimit: 1,
        beltCursor: 0,
        beltLimit: 1,
        pinnedEntityIds: [],
        pinnedBeltIds: [],
      },
    });
    const frame = selectNativeAuthoritativeFactoryCanvasFrame(store.getSnapshot(), binding({ expectedRevision: 11 }));

    expect(result.status).toBe("committed");
    expect(source.readVerifiedViewportProjectionV2).toHaveBeenCalledTimes(2);
    expect(frame?.entities.map((row) => row.id)).toEqual(["entity-a", "entity-b"]);
    expect(frame?.belts.map((row) => row.id)).toEqual(["belt-a"]);
  });

  it("moves selection and drag preparation through bounded stable IDs", () => {
    const unlocked = entity("entity-a", 10);
    const locked = entity("entity-b", 30, true);
    const entities = new Map([[unlocked.id, unlocked], [locked.id, locked]]);

    expect(collectCanvasSelectionBeltIds(
      [belt("belt-a", "entity-a", "entity-b"), belt("belt-b", "entity-b", "entity-c")],
      ["entity-a", "entity-b"],
      ["explicit-belt"],
    )).toEqual(["explicit-belt", "belt-a"]);
    expect(collectCanvasDragMembers(entities, ["entity-b", "entity-a", "missing"])).toEqual([
      { id: "entity-a", position: { x: 10, y: 10 } },
    ]);
  });
});
