import { describe, expect, it } from "vitest";
import type {
  DesktopNativeCoreFactoryReadModelResult,
  DesktopNativeCoreViewportProjectionV2Result,
} from "../desktop";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";
import {
  createNativeProjectedPlanetViewportCommand,
  selectNativePlanetViewportReadModel,
} from "./nativePlanetViewportReadModel";

function snapshot(base: Record<string, unknown>): NativeFactoryThinViewSnapshot {
  return {
    status: "ready",
    requestedRevision: 12,
    frame: {
      revision: 12,
      planetId: "home",
      authoritySessionId: "session-a",
      authorityRunId: "run-a",
      factory: {} as DesktopNativeCoreFactoryReadModelResult,
      viewport: {
        schemaVersion: 2,
        projectionType: "viewport-v2",
        revision: 12,
        planetId: "home",
        base,
      } as DesktopNativeCoreViewportProjectionV2Result,
    },
  } as NativeFactoryThinViewSnapshot;
}

const binding = {
  enabled: true,
  sessionId: "session-a",
  runId: "run-a",
  expectedRevision: 12,
  activePlanetId: "home",
} as const;

describe("native planet viewport read model", () => {
  it("selects an exact same-session camera directory and emits changed leaves only", () => {
    const model = selectNativePlanetViewportReadModel(snapshot({
      planetViewports: {
        home: { x: 510, y: 250, zoom: 0.84 },
        "MOD-行星/β": { x: -20, y: 30, zoom: 1.2 },
      },
    }), binding)!;
    expect(model.viewports.get("MOD-行星/β")).toEqual({ x: -20, y: 30, zoom: 1.2 });
    expect(createNativeProjectedPlanetViewportCommand(model, "home", {
      x: 512, y: 250, zoom: 1,
    })?.topLevelChanges).toEqual([
      { path: ["planetViewports", "home", "x"], operation: "set", value: 512 },
      { path: ["planetViewports", "home", "zoom"], operation: "set", value: 1 },
    ]);
    expect(createNativeProjectedPlanetViewportCommand(model, "home", {
      x: 510, y: 250, zoom: 0.84,
    })).toBeNull();
  });

  it("fails closed for stale identity, partial rows, unsafe zoom, or missing targets", () => {
    const valid = snapshot({ planetViewports: { home: { x: 510, y: 250, zoom: 0.84 } } });
    expect(selectNativePlanetViewportReadModel(valid, { ...binding, expectedRevision: 13 })).toBeNull();
    expect(selectNativePlanetViewportReadModel(snapshot({ planetViewports: { home: { x: 1, y: 2 } } }), binding)).toBeNull();
    expect(selectNativePlanetViewportReadModel(snapshot({ planetViewports: { home: { x: 1, y: 2, zoom: 2 } } }), binding)).toBeNull();
    const model = selectNativePlanetViewportReadModel(valid, binding)!;
    expect(() => createNativeProjectedPlanetViewportCommand(model, "missing", { x: 1, y: 2, zoom: 1 })).toThrow(TypeError);
    expect(() => createNativeProjectedPlanetViewportCommand(model, "home", { x: 1, y: 2, zoom: Number.NaN })).toThrow(TypeError);
  });
});
