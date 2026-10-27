import { describe, expect, it } from "vitest";
import { buildCanvasBeltHitIndex, reconcileCanvasBeltHitIndex, collectCanvasBeltIndicesInBounds, findNearestCanvasBelt } from "./canvasBeltSpatialIndex";
import type { CanvasLineBatch } from "./canvasLineBatch";

function batch(): CanvasLineBatch {
  return {
    planetId: "home",
    beltIds: ["straight", "routed"],
    positions: Float32Array.from([0, 0, 300, 0, 0, 100, 300, 100]),
    routeCenters: Float32Array.from([Number.NaN, 200]),
    routeModes: Uint8Array.from([0, 1]),
    segments: 2,
  };
}

describe("canvas belt spatial hit index", () => {
  it("reuses geometry across equal immutable snapshots including absent route centers", () => {
    const first = buildCanvasBeltHitIndex(batch(), 128);
    const currentBatch = batch();
    const next = reconcileCanvasBeltHitIndex(first, currentBatch, 128);
    expect(next.batch).toBe(currentBatch);
    expect(next.buckets).toBe(first.buckets);
    expect(next.routeCoordinates).toBe(first.routeCoordinates);
    expect(findNearestCanvasBelt(next, { x: 150, y: 201 }, 12)?.beltId).toBe("routed");
    expect(collectCanvasBeltIndicesInBounds(next, { left: 120, top: -8, right: 180, bottom: 8 }))
      .toEqual(collectCanvasBeltIndicesInBounds(first, { left: 120, top: -8, right: 180, bottom: 8 }));
  });

  it.each(["positions", "routeCenters", "routeModes"] as const)("rebuilds hits when %s changes", (field) => {
    const first = buildCanvasBeltHitIndex(batch(), 128);
    const nextBatch = batch();
    if (field === "positions") nextBatch.positions[3] = 1_000;
    else if (field === "routeCenters") nextBatch.routeCenters[1] = 1_000;
    else nextBatch.routeModes[1] = 0;
    const next = reconcileCanvasBeltHitIndex(first, nextBatch, 128);
    const query = field === "positions" ? { x: 150, y: 0 } : { x: 150, y: 200 };
    expect(findNearestCanvasBelt(first, query, 12)).not.toBeNull();
    expect(findNearestCanvasBelt(next, query, 12)).toBeNull();
    expect(next.buckets).not.toBe(first.buckets);
  });

  it("rebinds identities correctly when same-position belts are renamed or reordered", () => {
    const first = buildCanvasBeltHitIndex(batch(), 128);
    const nextBatch = batch();
    nextBatch.beltIds = ["replacement", "routed"];
    const next = reconcileCanvasBeltHitIndex(first, nextBatch, 128);
    expect(findNearestCanvasBelt(next, { x: 150, y: 0 }, 12)?.beltId).toBe("replacement");
    const reordered = { ...nextBatch, beltIds: ["routed", "replacement"] };
    const reorderedIndex = reconcileCanvasBeltHitIndex(next, reordered, 128);
    expect(findNearestCanvasBelt(reorderedIndex, { x: 150, y: 0 }, 12)?.beltId).toBe("routed");
  });

  it("rebuilds for added or removed belts and keeps an empty view empty", () => {
    const first = buildCanvasBeltHitIndex(batch(), 128);
    const empty = { ...batch(), beltIds: [], positions: new Float32Array(), routeCenters: new Float32Array(), routeModes: new Uint8Array(), segments: 0 };
    const removed = reconcileCanvasBeltHitIndex(first, empty, 128);
    expect(findNearestCanvasBelt(removed, { x: 150, y: 0 }, 12)).toBeNull();
    const restored = reconcileCanvasBeltHitIndex(removed, batch(), 128);
    expect(findNearestCanvasBelt(restored, { x: 150, y: 0 }, 12)?.beltId).toBe("straight");
  });

  it("keeps planet and cell-size changes scoped to a fresh index", () => {
    const first = buildCanvasBeltHitIndex(batch(), 128);
    const next = reconcileCanvasBeltHitIndex(first, { ...batch(), planetId: "dune" }, 512);
    expect(next.cellSize).toBe(512);
    expect(next.batch.planetId).toBe("dune");
    expect(next.buckets).not.toBe(first.buckets);
    expect(findNearestCanvasBelt(next, { x: 150, y: 201 }, 12)?.beltId).toBe("routed");
  });

  it("finds bezier and routed lines without a DOM edge", () => {
    const index = buildCanvasBeltHitIndex(batch(), 128);
    expect(findNearestCanvasBelt(index, { x: 150, y: 2 }, 12)?.beltId).toBe("straight");
    expect(findNearestCanvasBelt(index, { x: 150, y: 201 }, 12)?.beltId).toBe("routed");
  });

  it("returns null outside the interaction radius and keeps ties stable", () => {
    const index = buildCanvasBeltHitIndex(batch(), 128);
    expect(findNearestCanvasBelt(index, { x: 150, y: 50 }, 10)).toBeNull();
    expect(findNearestCanvasBelt(index, { x: 0, y: 50 }, 60)?.beltId).toBe("routed");
  });

  it("collects stable conservative candidates for the visible world rectangle", () => {
    const index = buildCanvasBeltHitIndex(batch(), 128);
    // Buckets intentionally admit nearby routes; the renderer applies its
    // exact screen-space intersection check before drawing.
    expect(collectCanvasBeltIndicesInBounds(index, { left: 120, top: -8, right: 180, bottom: 8 }))
      .toEqual([0, 1]);
    expect(collectCanvasBeltIndicesInBounds(index, { left: 120, top: 192, right: 180, bottom: 208 }))
      .toContain(1);
    expect(collectCanvasBeltIndicesInBounds(index, { left: 8_000, top: 8_000, right: 8_100, bottom: 8_100 }))
      .toEqual([]);
  });
});
