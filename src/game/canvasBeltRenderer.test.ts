import { describe, expect, it, vi } from "vitest";
import {
  CANVAS_BELT_OFFSCREEN_THRESHOLD,
  CANVAS_BELT_OVERSCAN,
  normalizeCanvasBeltDpr,
  paintCanvasBeltLayer,
  summarizeCanvasBeltTimings,
  type CanvasBeltRenderGeometry,
} from "./canvasBeltRenderer";

function context() {
  return {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    stroke: vi.fn(),
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: "",
  } as unknown as CanvasRenderingContext2D;
}

const geometry: CanvasBeltRenderGeometry = {
  positions: Float32Array.from([0, 0, 100, 0, 0, 20, 100, 20]),
  routeCenters: Float32Array.from([Number.NaN, 50]),
  routeModes: Uint8Array.from([0, 1]),
  colors: ["#111111", "#222222"],
};

describe("canvas belt renderer", () => {
  it("keeps the worker threshold and DPR bounded", () => {
    expect(CANVAS_BELT_OFFSCREEN_THRESHOLD).toBe(2_048);
    expect(normalizeCanvasBeltDpr(4)).toBe(1.25);
    expect(normalizeCanvasBeltDpr(Number.NaN)).toBe(1);
  });

  it("draws immutable topology independently from selection and flow", () => {
    const target = context();
    const result = paintCanvasBeltLayer(
      target,
      geometry,
      Uint32Array.from([0, 1]),
      { x: 0, y: 0, zoom: 1 },
      { width: 800, height: 600, dpr: 1, overscan: CANVAS_BELT_OVERSCAN },
      "topology",
      Uint8Array.from([1, 0]),
      Float32Array.from([0, 1]),
    );
    expect(result).toEqual({ candidateSegments: 2, drawnSegments: 2 });
    expect(target.stroke).toHaveBeenCalledTimes(2);
  });

  it("dynamic overlay skips idle rows but includes selected and flowing rows", () => {
    const target = context();
    const result = paintCanvasBeltLayer(
      target,
      geometry,
      Uint32Array.from([0, 1]),
      { x: 0, y: 0, zoom: 1 },
      { width: 800, height: 600, dpr: 1, overscan: CANVAS_BELT_OVERSCAN },
      "telemetry",
      Uint8Array.from([1, 0]),
      Float32Array.from([0, 0.8]),
    );
    expect(result.drawnSegments).toBe(2);
    expect(target.stroke).toHaveBeenCalledTimes(2);

    const idleTarget = context();
    const idle = paintCanvasBeltLayer(
      idleTarget,
      geometry,
      Uint32Array.from([0, 1]),
      { x: 0, y: 0, zoom: 1 },
      { width: 800, height: 600, dpr: 1, overscan: CANVAS_BELT_OVERSCAN },
      "telemetry",
      new Uint8Array(2),
      new Float32Array(2),
    );
    expect(idle.drawnSegments).toBe(0);
    expect(idleTarget.stroke).not.toHaveBeenCalled();
  });

  it("reports bounded P50/P95/P99 and long-task evidence", () => {
    const summary = summarizeCanvasBeltTimings([
      ...Array.from({ length: 125 }, (_, index) => index),
      Number.NaN,
      -1,
    ]);
    expect(summary.sampleCount).toBe(120);
    expect(summary.p50Ms).toBe(64);
    expect(summary.p95Ms).toBe(118);
    expect(summary.p99Ms).toBe(122);
    expect(summary.maxMs).toBe(124);
    expect(summary.longTaskCount).toBe(74);
  });
});
