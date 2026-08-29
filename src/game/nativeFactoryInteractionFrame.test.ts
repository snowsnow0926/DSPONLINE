import { describe, expect, it, vi } from "vitest";

import type { DesktopNativeCoreFactoryReadModelResult } from "../desktop";
import { createInitialState } from "./engine";
import type { NativeAuthoritativeFactoryCanvasFrame } from "./nativeFactoryCanvasFrame";
import {
  createNativeFactoryInteractionPinRequest,
  createWebFactoryInteractionRows,
  selectFactoryConnectionReadState,
  selectFactoryInteractionRows,
  selectNativeAuthoritativeFactoryInteractionRows,
  selectNativeFactorySelectionRelatedEntityIds,
  type NativeFactoryInteractionBinding,
} from "./nativeFactoryInteractionFrame";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";
import type { BeltConnection, FactoryEntity, GameState } from "./types";

function entity(id: string, x: number, locked = false): FactoryEntity {
  return {
    id,
    kind: "machine",
    planetId: "home",
    position: { x, y: 10 },
    interactionLocked: locked,
    buildingId: "arc_smelter",
    recipeId: "iron_ingot",
    powerFactor: 1,
    routingCursor: 0,
    machineCount: 1,
    minerCount: 0,
    inputs: { iron_ore: 1 },
    outputs: { iron_ingot: 1 },
    progress: 0.25,
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
    totalTransferred: 10,
    congestion: 0,
  };
}

function frame(input: {
  entities?: FactoryEntity[];
  belts?: BeltConnection[];
  pinnedEntityIds?: string[];
  pinnedBeltIds?: string[];
  sessionId?: string;
  runId?: string;
  revision?: number;
} = {}): NativeAuthoritativeFactoryCanvasFrame {
  const entities = input.entities ?? [entity("source", 10), entity("target", 40)];
  const belts = input.belts ?? [belt("selected-belt", "source", "target")];
  const entityById = new Map(entities.map((row) => [row.id, row] as const));
  const beltById = new Map(belts.map((row) => [row.id, row] as const));
  const pinnedEntityIds = input.pinnedEntityIds ?? ["source", "target"];
  const pinnedBeltIds = input.pinnedBeltIds ?? ["selected-belt"];
  const revision = input.revision ?? 9;
  return {
    source: "native-authoritative",
    sessionId: input.sessionId ?? "authority-a",
    runId: input.runId ?? "run-a",
    revision,
    planetId: "home",
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    worldBounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    planetTotals: { entities: entities.length, belts: belts.length },
    viewportTotals: { entities: entities.length, belts: belts.length },
    entities,
    belts,
    projectedBelts: belts,
    entityById,
    beltById,
    omittedCrossBoundaryBeltCount: 0,
    viewportReadModel: {
      schema: "factory-viewport-read-model-v1",
      source: "native-core",
      revision,
      planetId: "home",
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      pinnedEntityIds,
      pinnedBeltIds,
      planetTotals: { entities: entities.length, belts: belts.length },
      viewportTotals: { entities: entities.length, belts: belts.length },
      worldBounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      entities: entities.map((row) => ({
        id: row.id,
        kind: row.kind,
        buildingId: row.buildingId ?? null,
        x: row.position.x,
        y: row.position.y,
      })),
      belts: belts.map((row) => ({
        id: row.id,
        planetId: row.planetId,
        source: row.source,
        target: row.target,
        itemId: row.itemId,
        lanes: row.lanes,
        tier: row.tier,
        stackSize: row.stackSize ?? 1,
        priority: row.priority,
        targetPortIndex: row.targetPortIndex ?? null,
        routeMode: row.routeMode ?? "auto",
        routeOffsetY: row.routeOffsetY ?? 0,
      })),
      broadQueryFallback: false,
    },
  };
}

function binding(overrides: Partial<NativeFactoryInteractionBinding> = {}): NativeFactoryInteractionBinding {
  return {
    enabled: true,
    sessionId: "authority-a",
    runId: "run-a",
    revision: 9,
    planetId: "home",
    selectedEntityIds: ["source"],
    selectedBeltIds: ["selected-belt"],
    primarySelectedBeltId: "selected-belt",
    connectionEntityIds: ["target"],
    requestedPinnedEntityIds: ["source", "target"],
    requestedPinnedBeltIds: ["selected-belt"],
    requestTruncated: false,
    ...overrides,
  };
}

function throwingRows<Row>(): Row[] {
  return new Proxy([] as Row[], {
    get() {
      throw new Error("full Web row array was touched");
    },
  });
}

describe("native factory interaction atom", () => {
  it("reads selection, inspector and connection candidates while Web arrays are throwing proxies", () => {
    const native = selectNativeAuthoritativeFactoryInteractionRows(frame(), binding());
    expect(native).not.toBeNull();
    const webState = {
      ...createInitialState(),
      entities: throwingRows<FactoryEntity>(),
      belts: throwingRows<BeltConnection>(),
    } satisfies GameState;
    const createWeb = vi.fn(() => createWebFactoryInteractionRows(webState, {
      selectedEntityIds: ["source"],
      selectedBeltIds: ["selected-belt"],
      primarySelectedBeltId: "selected-belt",
    }));

    const rows = selectFactoryInteractionRows(native, createWeb);
    const connectionState = selectFactoryConnectionReadState(webState, frame(), {
      sessionId: "authority-a",
      revision: 9,
      planetId: "home",
    }, "source", "target");

    expect(rows.source).toBe("native-authoritative");
    expect(rows.selectedEntity?.id).toBe("source");
    expect(rows.selectedBelts.map((row) => row.id)).toEqual(["selected-belt"]);
    expect(rows.selectionToolbarReadModel).toMatchObject({ source: "native-core", selectedCount: 1, selectedBeltCount: 1 });
    expect(connectionState.entities.find((row) => row.id === "target")?.id).toBe("target");
    expect(connectionState.belts.find((row) => row.id === "selected-belt")?.source).toBe("source");
    expect(createWeb).not.toHaveBeenCalled();
  });

  it("reads a belt-only inspector and multi-selection without evaluating Web arrays", () => {
    const nativeFrame = frame();
    const beltRows = selectNativeAuthoritativeFactoryInteractionRows(nativeFrame, binding({
      selectedEntityIds: [],
      selectedBeltIds: ["selected-belt"],
      primarySelectedBeltId: "selected-belt",
      connectionEntityIds: [],
    }));
    const multiRows = selectNativeAuthoritativeFactoryInteractionRows(nativeFrame, binding({
      selectedEntityIds: ["source", "target"],
      selectedBeltIds: ["selected-belt"],
      primarySelectedBeltId: null,
      connectionEntityIds: [],
    }));
    const fallback = vi.fn(() => {
      throw new Error("Web fallback must remain lazy");
    });

    expect(selectFactoryInteractionRows(beltRows, fallback).inspectorSummaryReadModel.belt?.beltId).toBe("selected-belt");
    expect(selectFactoryInteractionRows(multiRows, fallback).multiSelectionSummaryReadModel.entityRows.rows.map((row) => row.entityId))
      .toEqual(["source", "target"]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("keeps connection reads atomic when the frame identity is stale or cross-session", () => {
    const webState = createInitialState();
    const nativeFrame = frame();

    expect(selectFactoryConnectionReadState(webState, nativeFrame, {
      sessionId: "authority-b",
      revision: 9,
      planetId: "home",
    }, "source", "target")).toBe(webState);
    expect(selectFactoryConnectionReadState(webState, nativeFrame, {
      sessionId: "authority-a",
      revision: 10,
      planetId: "home",
    }, "source", "target")).toBe(webState);
    expect(selectFactoryConnectionReadState(webState, nativeFrame, {
      sessionId: "authority-a",
      revision: 9,
      planetId: "ashen",
    }, "source", "target")).toBe(webState);
  });

  it.each([
    ["cross-session", { sessionId: "authority-b" }],
    ["cross-run", { runId: "run-b" }],
    ["stale revision", { revision: 10 }],
    ["truncated pin request", { requestTruncated: true }],
    ["missing candidate pin", { connectionEntityIds: ["missing"] }],
  ] as const)("atomically falls back for %s", (_label, override) => {
    const native = selectNativeAuthoritativeFactoryInteractionRows(frame(), binding(override));
    const fallback = vi.fn(() => createWebFactoryInteractionRows(createInitialState(), {
      selectedEntityIds: [],
      selectedBeltIds: [],
      primarySelectedBeltId: null,
    }));

    expect(selectFactoryInteractionRows(native, fallback).source).toBe("web-game-state");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("rejects an open selected-belt network and accepts the endpoint-closed bounded component", () => {
    const source = entity("source", 10);
    const target = entity("target", 40);
    const offscreen = entity("offscreen", 400);
    const selected = belt("selected-belt", "source", "target");
    const crossing = belt("crossing", "target", "offscreen");
    const selectedBinding = binding({
      selectedEntityIds: [],
      selectedBeltIds: ["selected-belt"],
      primarySelectedBeltId: "selected-belt",
      connectionEntityIds: [],
    });
    const open = frame({
      entities: [source, target],
      belts: [selected, crossing],
      pinnedEntityIds: ["source", "target"],
    });
    const closed = frame({
      entities: [source, target, offscreen],
      belts: [selected, crossing],
      pinnedEntityIds: ["source", "target"],
    });

    expect(selectNativeAuthoritativeFactoryInteractionRows(open, selectedBinding)).toBeNull();
    expect(selectNativeAuthoritativeFactoryInteractionRows(closed, selectedBinding)?.selectedBelt?.id).toBe("selected-belt");
  });

  it("fails closed at pin limits instead of silently dropping selected or connection IDs", () => {
    const request = createNativeFactoryInteractionPinRequest({
      selectedEntityIds: Array.from({ length: 31 }, (_, index) => `selected-${index}`),
      selectedBeltIds: Array.from({ length: 64 }, (_, index) => `belt-${index}`),
      primarySelectedBeltId: "belt-primary",
      connectionEntityIds: ["source", "candidate"],
      relatedEntityIds: ["related"],
    });

    expect(request.entityIds).toHaveLength(32);
    expect(request.beltIds).toHaveLength(64);
    expect(request.truncated).toBe(true);
  });

  it("derives selected-belt endpoint pins only from an exact session/revision/ordered selection", () => {
    const revision = 9;
    const selection = {
      schema: "factory-read-model-v1" as const,
      activePlanetId: "home",
      requestedEntityCount: 0,
      requestedBeltCount: 1,
      entityRows: { rows: [], totalCount: 0, truncated: false },
      beltRows: {
        rows: [{
          beltId: "selected-belt",
          planetId: "home",
          sourceEntityId: "source",
          targetEntityId: "target",
          itemId: "iron_ingot",
          lanes: 1,
          tier: 1,
          sorterTier: 1,
          stackSize: 1,
          priority: 1,
          progress: 0,
          lastFlow: 1,
          totalTransferred: 10,
          congestion: 0,
        }],
        totalCount: 1,
        truncated: false,
      },
    };
    const snapshot = {
      status: "ready",
      requestedRevision: revision,
      frame: {
        revision,
        planetId: "home",
        authoritySessionId: "authority-a",
        authorityRunId: "run-a",
        factory: {
          schemaVersion: 1,
          projectionType: "factory-read-model-v1",
          revision,
          shell: { source: "native-core", activePlanetId: "home" },
          planetNavigation: { activePlanetId: "home" },
          selection,
          construction: { activePlanetId: "home" },
        } as unknown as DesktopNativeCoreFactoryReadModelResult,
        viewport: {} as NativeFactoryThinViewSnapshot["frame"] extends infer _Frame
          ? NonNullable<NativeFactoryThinViewSnapshot["frame"]>["viewport"]
          : never,
      },
    } satisfies NativeFactoryThinViewSnapshot;
    const exact = {
      sessionId: "authority-a",
      runId: "run-a",
      revision,
      planetId: "home" as const,
      selectedEntityIds: [],
      selectedBeltIds: ["selected-belt"],
    };

    expect(selectNativeFactorySelectionRelatedEntityIds(snapshot, exact)).toEqual(["source", "target"]);
    expect(selectNativeFactorySelectionRelatedEntityIds(snapshot, { ...exact, sessionId: "authority-b" })).toEqual([]);
    expect(selectNativeFactorySelectionRelatedEntityIds(snapshot, { ...exact, revision: revision + 1 })).toEqual([]);
    expect(selectNativeFactorySelectionRelatedEntityIds(snapshot, { ...exact, selectedBeltIds: ["other"] })).toEqual([]);
  });
});
