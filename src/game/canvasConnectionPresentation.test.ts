import { describe, expect, it } from "vitest";
import {
  CONNECTION_VIEWPORT_ENTER_OVERSCAN_PX,
  CONNECTION_VIEWPORT_EXIT_OVERSCAN_PX,
  createLatestFramePublisher,
  getCanvasWorldRectangle,
  getConnectionViewportBounds,
  getNodeConnectionPresentationToken,
  nodeIsInsideConnectionViewport,
  resolveNodeConnectionPresentation,
} from "./canvasConnectionPresentation";

describe("connection-time canvas presentation", () => {
  it("converts the screen viewport into a pure world rectangle with bounded overscan", () => {
    expect(CONNECTION_VIEWPORT_ENTER_OVERSCAN_PX).toBeGreaterThanOrEqual(250);
    expect(CONNECTION_VIEWPORT_EXIT_OVERSCAN_PX).toBeLessThanOrEqual(400);
    expect(CONNECTION_VIEWPORT_EXIT_OVERSCAN_PX).toBeGreaterThan(CONNECTION_VIEWPORT_ENTER_OVERSCAN_PX);
    expect(getCanvasWorldRectangle({ x: 100, y: 50, zoom: 2 }, { width: 1_000, height: 600 }, 300)).toEqual({
      left: -200,
      top: -175,
      right: 600,
      bottom: 425,
    });
  });

  it("uses an enter/exit hysteresis band instead of churning near the overscan edge", () => {
    const bounds = getConnectionViewportBounds({ x: 0, y: 0, zoom: 1 }, { width: 1_000, height: 600 });
    const nearExitEdge = { x: 1_330, y: 100, width: 20, height: 20 };
    expect(nodeIsInsideConnectionViewport(nearExitEdge, bounds, false)).toBe(false);
    expect(nodeIsInsideConnectionViewport(nearExitEdge, bounds, true)).toBe(true);
    expect(nodeIsInsideConnectionViewport({ ...nearExitEdge, x: 1_410 }, bounds, true)).toBe(false);
  });

  it("expands only source, selected, current candidate and viewport nodes by default", () => {
    const base = {
      connectionActive: true,
      expandAll: false,
      source: false,
      selected: false,
      candidate: false,
      viewport: false,
      preserveFullDetail: false,
      blockingInteraction: false,
      denseNodeLodActive: false,
      zoom: 1,
    };
    expect(resolveNodeConnectionPresentation({ ...base, source: true })).toMatchObject({ lod: "full", reason: "source" });
    expect(resolveNodeConnectionPresentation({ ...base, selected: true })).toMatchObject({ lod: "full", reason: "selected" });
    expect(resolveNodeConnectionPresentation({ ...base, candidate: true })).toMatchObject({ lod: "full", reason: "candidate" });
    expect(resolveNodeConnectionPresentation({ ...base, viewport: true })).toMatchObject({ lod: "full", reason: "viewport" });
    expect(resolveNodeConnectionPresentation(base)).toMatchObject({ lod: "medium", full: false, exposeConnectionDraft: false });
    expect(resolveNodeConnectionPresentation({ ...base, expandAll: true })).toMatchObject({ lod: "full", reason: "expand-all" });
  });

  it("keeps ordinary small canvases full until a connection starts", () => {
    const ordinary = resolveNodeConnectionPresentation({
      connectionActive: false,
      expandAll: false,
      source: false,
      selected: false,
      candidate: false,
      viewport: false,
      preserveFullDetail: false,
      blockingInteraction: false,
      denseNodeLodActive: false,
      zoom: 1,
    });
    expect(ordinary).toMatchObject({ full: true, lod: "full", reason: "ordinary" });
  });

  it("does not grow the full-node set as Ctrl/Shift continuous drafts reach 10 or 100 routes", () => {
    for (const routeCount of [10, 100]) {
      const fullIds = new Set<string>();
      for (let index = 0; index <= routeCount; index += 1) {
        const id = index === 0 ? "source" : `target-${index}`;
        const presentation = resolveNodeConnectionPresentation({
          connectionActive: true,
          expandAll: false,
          source: id === "source",
          selected: false,
          candidate: id === `target-${routeCount}`,
          viewport: index <= 4,
          preserveFullDetail: false,
          blockingInteraction: false,
          denseNodeLodActive: true,
          zoom: 0.4,
        });
        if (presentation.full) fullIds.add(id);
      }
      expect(fullIds).toEqual(new Set(["source", "target-1", "target-2", "target-3", "target-4", `target-${routeCount}`]));
    }
  });

  it("uses a per-node draft token instead of invalidating every logical node", () => {
    const draft = { nodeId: "source", handleId: "out:iron_ore", itemId: "iron_ore", handleType: "source" as const };
    expect(getNodeConnectionPresentationToken(draft, "source", true)).toBe("connection:origin:source:out:iron_ore:iron_ore");
    expect(getNodeConnectionPresentationToken(draft, "candidate", true)).toBe("connection:context:source:out:iron_ore:iron_ore");
    expect(getNodeConnectionPresentationToken(draft, "far-away", false)).toBe("connection:none");
  });

  it("coalesces pan and zoom bursts into one animation-frame publication", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    const published: number[] = [];
    let sequence = 0;
    const publisher = createLatestFramePublisher<number>(
      (callback) => { const id = ++sequence; callbacks.set(id, callback); return id; },
      (id) => { callbacks.delete(id); },
      (value) => { published.push(value); },
    );
    for (let index = 0; index < 100; index += 1) publisher.push(index);
    expect(callbacks.size).toBe(1);
    expect(publisher.pending()).toBe(true);
    callbacks.values().next().value?.(16);
    expect(published).toEqual([99]);
    expect(publisher.pending()).toBe(false);
  });

  it("classifies an anonymous 100-node viewport fixture well inside 50ms", () => {
    const bounds = getConnectionViewportBounds({ x: 120, y: -40, zoom: 0.75 }, { width: 1_440, height: 900 });
    const startedAt = performance.now();
    let visible = 0;
    for (let pass = 0; pass < 100; pass += 1) {
      for (let index = 0; index < 100; index += 1) {
        if (nodeIsInsideConnectionViewport({ x: index * 220, y: (index % 10) * 180 }, bounds, false)) visible += 1;
      }
    }
    expect(visible).toBeGreaterThan(0);
    expect(performance.now() - startedAt).toBeLessThan(50);
  });
});
