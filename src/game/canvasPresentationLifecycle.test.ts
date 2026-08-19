import { describe, expect, it } from "vitest";
import {
  indexCanvasPresentationNodes,
  reconcileCanvasNodePublication,
  selectCanvasRuntimeRecords,
} from "./canvasPresentationLifecycle";

interface TestNode {
  id: string;
  data: { staticPresentation: boolean; value: number };
}

describe("canvas presentation lifecycle", () => {
  it("selects only mounted dynamic records for a runtime-only publication", () => {
    const records = new Map([
      ["a", { id: "a", value: 1 }],
      ["b", { id: "b", value: 2 }],
    ]);
    expect(selectCanvasRuntimeRecords(["b", "missing"], records)).toEqual([{ id: "b", value: 2 }]);
  });

  it("keeps the exact outer array when runtime data publishes through the keyed store", () => {
    const current: TestNode[] = [
      { id: "a", data: { staticPresentation: true, value: 1 } },
      { id: "b", data: { staticPresentation: false, value: 2 } },
    ];
    const publication = reconcileCanvasNodePublication(
      current,
      [current[1]],
      false,
      indexCanvasPresentationNodes(current),
    );
    expect(publication.nodes).toBe(current);
    expect(publication.changedNodeCount).toBe(0);
    expect(publication.dynamicNodeIds).toBeNull();
  });

  it("patches an unexpected runtime presentation drift without rebuilding unaffected nodes", () => {
    const current: TestNode[] = [
      { id: "a", data: { staticPresentation: true, value: 1 } },
      { id: "b", data: { staticPresentation: false, value: 2 } },
    ];
    const replacement = { ...current[1], data: { ...current[1].data, value: 3 } };
    const publication = reconcileCanvasNodePublication(
      current,
      [replacement],
      false,
      indexCanvasPresentationNodes(current),
    );
    expect(publication.nodes).not.toBe(current);
    expect(publication.nodes[0]).toBe(current[0]);
    expect(publication.nodes[1]).toBe(replacement);
    expect(publication.changedNodeCount).toBe(1);
  });

  it("derives the runtime refresh set only at a full presentation boundary", () => {
    const current: TestNode[] = [{ id: "a", data: { staticPresentation: true, value: 1 } }];
    const derived: TestNode[] = [
      current[0],
      { id: "b", data: { staticPresentation: false, value: 2 } },
    ];
    const publication = reconcileCanvasNodePublication(
      current,
      derived,
      true,
      indexCanvasPresentationNodes(current),
    );
    expect(publication.changedNodeCount).toBe(1);
    expect(publication.dynamicNodeIds).toEqual(["b"]);
  });
});
