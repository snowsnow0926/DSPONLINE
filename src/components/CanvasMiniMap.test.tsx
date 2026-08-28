import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CanvasMiniMap, projectCanvasMiniMap } from "./CanvasMiniMap";

describe("CanvasMiniMap native projection boundary", () => {
  it("uses verified whole-world bounds without deriving extent from every node", () => {
    const projection = projectCanvasMiniMap(
      [],
      { x: 0, y: 0, zoom: 1 },
      100,
      80,
      { minX: -200, minY: -100, maxX: 400, maxY: 300 },
    );

    expect(projection.minX).toBe(-200);
    expect(projection.minY).toBe(-100);
    expect(projection.scale).toBeGreaterThan(0);
  });

  it("exposes the read-only projection provenance without changing navigation callbacks", () => {
    const onCenter = vi.fn();
    const onZoom = vi.fn();
    const markup = renderToStaticMarkup(<CanvasMiniMap
      nodes={[{ id: "entity-a", kind: "vein", x: 1, y: 2 }]}
      worldBounds={{ minX: 1, minY: 2, maxX: 1, maxY: 2 }}
      projectionSource="native-core"
      projectionRevision={77}
      planetEntityCount={1}
      planetBeltCount={3}
      viewport={{ x: 0, y: 0, zoom: 1 }}
      canvasWidth={800}
      canvasHeight={600}
      lightTheme={false}
      onCenter={onCenter}
      onZoom={onZoom}
      onUnavailable={vi.fn()}
    />);

    expect(markup).toContain('data-projection-source="native-core"');
    expect(markup).toContain('data-projection-revision="77"');
    expect(markup).toContain('data-planet-entity-count="1"');
    expect(markup).toContain('data-planet-belt-count="3"');
    expect(onCenter).not.toHaveBeenCalled();
    expect(onZoom).not.toHaveBeenCalled();
  });
});
