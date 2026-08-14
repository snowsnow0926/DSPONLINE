import { describe, expect, it } from "vitest";
import {
  CANVAS_DETAIL_COMPACT_ENTER_VISIBLE,
  CANVAS_DETAIL_COMPACT_EXIT_VISIBLE,
  CANVAS_DETAIL_MEDIUM_ENTER_VISIBLE,
  CANVAS_DETAIL_MEDIUM_EXIT_VISIBLE,
  CANVAS_STACK_ENTER_PX,
  CANVAS_STACK_EXIT_PX,
  countVisibleCanvasNodes,
  groupCanvasNodeStacks,
  resolveCanvasDetailStage,
} from "./canvasDensityPresentation";

describe("visible-density canvas presentation", () => {
  it("uses raw viewport-visible counts rather than active-planet totals", () => {
    const nodes = Array.from({ length: 2_000 }, (_, index) => ({ id: `node-${index}`, x: index * 40, y: 20 }));
    expect(countVisibleCanvasNodes(nodes, { left: 0, top: 0, right: 3_999, bottom: 500 })).toBe(100);
    expect(countVisibleCanvasNodes(nodes, { left: 0, top: 0, right: 19_999, bottom: 500 })).toBe(500);
    expect(countVisibleCanvasNodes(nodes, { left: 0, top: 0, right: 80_000, bottom: 500 })).toBe(2_000);
  });

  it("moves between full, medium and compact with separate enter/exit thresholds", () => {
    expect(CANVAS_DETAIL_MEDIUM_EXIT_VISIBLE).toBeLessThan(CANVAS_DETAIL_MEDIUM_ENTER_VISIBLE);
    expect(CANVAS_DETAIL_COMPACT_EXIT_VISIBLE).toBeLessThan(CANVAS_DETAIL_COMPACT_ENTER_VISIBLE);
    expect(resolveCanvasDetailStage("auto", 100, "full")).toBe("full");
    expect(resolveCanvasDetailStage("auto", CANVAS_DETAIL_MEDIUM_ENTER_VISIBLE, "full")).toBe("medium");
    expect(resolveCanvasDetailStage("auto", CANVAS_DETAIL_MEDIUM_EXIT_VISIBLE, "medium")).toBe("medium");
    expect(resolveCanvasDetailStage("auto", CANVAS_DETAIL_MEDIUM_EXIT_VISIBLE - 1, "medium")).toBe("full");
    expect(resolveCanvasDetailStage("auto", CANVAS_DETAIL_COMPACT_ENTER_VISIBLE, "medium")).toBe("compact");
    expect(resolveCanvasDetailStage("auto", CANVAS_DETAIL_COMPACT_EXIT_VISIBLE, "compact")).toBe("compact");
    expect(resolveCanvasDetailStage("auto", CANVAS_DETAIL_COMPACT_EXIT_VISIBLE - 1, "compact")).toBe("medium");
    expect(resolveCanvasDetailStage("full", 2_000, "compact")).toBe("full");
    expect(resolveCanvasDetailStage("minimal", 1, "full")).toBe("compact");
  });

  it("groups exact stacks in one spatial pass and preserves protected interaction leaders", () => {
    const nodes = Array.from({ length: 2_000 }, (_, index) => ({ id: `stack-${index}`, x: 100, y: 200 }));
    const startedAt = performance.now();
    const grouped = groupCanvasNodeStacks(nodes, 1, new Set(["stack-1777"]));
    expect(performance.now() - startedAt).toBeLessThan(50);
    expect(grouped.groupCount).toBe(1);
    expect(grouped.hiddenCount).toBe(1_999);
    expect(grouped.byNodeId.get("stack-1777")).toMatchObject({ hidden: false, halo: true, count: 2_000 });
    expect(grouped.byNodeId.get("stack-0")).toMatchObject({ hidden: true, halo: false, count: 2_000 });
  });

  it("aggregates alerts from hidden members onto the sole stack leader", () => {
    const nodes = Array.from({ length: 50 }, (_, index) => ({ id: `stack-${index}`, x: 100, y: 200 }));
    const grouped = groupCanvasNodeStacks(
      nodes,
      1,
      new Set(),
      new Map(),
      new Set(["stack-12", "stack-34"]),
      new Set(["stack-34"]),
    );
    expect(grouped.byNodeId.get("stack-0")).toMatchObject({
      hidden: false,
      halo: true,
      alertCount: 2,
      criticalAlertCount: 1,
    });
    expect(grouped.byNodeId.get("stack-34")).toMatchObject({ hidden: true, alertCount: 0, criticalAlertCount: 0 });
  });

  it("uses screen-space near-identity plus membership hysteresis without joining distant cards", () => {
    expect(CANVAS_STACK_EXIT_PX).toBeGreaterThan(CANVAS_STACK_ENTER_PX);
    const first = groupCanvasNodeStacks([
      { id: "anchor", x: 0, y: 0 },
      { id: "near", x: CANVAS_STACK_ENTER_PX - 1, y: 0 },
      { id: "distinct", x: 80, y: 0 },
    ], 1);
    expect(first.hiddenCount).toBe(1);
    const retained = groupCanvasNodeStacks([
      { id: "anchor", x: 0, y: 0 },
      { id: "near", x: CANVAS_STACK_ENTER_PX + 3, y: 0 },
      { id: "distinct", x: 80, y: 0 },
    ], 1, new Set(), first.membership);
    expect(retained.hiddenCount).toBe(1);
    const separated = groupCanvasNodeStacks([
      { id: "anchor", x: 0, y: 0 },
      { id: "near", x: CANVAS_STACK_EXIT_PX + 1, y: 0 },
    ], 1, new Set(), retained.membership);
    expect(separated.hiddenCount).toBe(0);
  });
});
