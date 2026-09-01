import { describe, expect, it } from "vitest";
import type {
  DesktopNativeCoreDysonLayerRow,
  DesktopNativeCoreDysonOrbitRow,
  DesktopNativeCoreDysonSystemRow,
} from "../desktop";
import type { NativeDysonWorkspaceFrame } from "./nativeDysonWorkspaceStore";
import {
  createNativeProjectedDysonActiveLayerCommand,
  createNativeProjectedDysonActiveOrbitCommand,
  createNativeProjectedDysonLaunchEnabledCommand,
  createNativeProjectedDysonLaunchModeCommand,
  createNativeProjectedDysonLaunchThrottleCommand,
  createNativeProjectedDysonOrbitGeometryCommand,
} from "./nativeProjectedDysonCommands";

const engineering = {
  launchMode: "balanced",
  launchThrottle: 1,
  launchEnabled: true,
} as DesktopNativeCoreDysonSystemRow["engineering"];

function frame(): NativeDysonWorkspaceFrame {
  const system = {
    systemId: "sol",
    activeLayerId: "layer:old",
    activeOrbitId: "orbit:old",
    engineering,
  } as DesktopNativeCoreDysonSystemRow;
  const layer = (layerId: string): DesktopNativeCoreDysonLayerRow => ({
    layerId,
    name: layerId,
    nameTruncated: false,
    radius: 12_000,
    inclination: 0,
    longitude: 0,
    structureAllocationFloor: 0,
    shellAllocationFloor: 0,
    nodeCount: 0,
    frameCount: 0,
    shellCount: 0,
    plannedStructurePoints: 0,
    completedStructurePoints: 0,
    sailCapacity: 0,
    absorbedSails: 0,
  });
  const orbit = (
    orbitId: string,
    radius: number,
    inclination: number,
    longitude: number,
  ): DesktopNativeCoreDysonOrbitRow => ({
    orbitId,
    name: orbitId,
    nameTruncated: false,
    radius,
    inclination,
    longitude,
    sailsInOrbit: 0,
    totalLaunched: 0,
    totalExpired: 0,
    decayProgress: 0,
    generationKw: 0,
  });
  const layers = [layer("layer:old"), layer("mod:层/新🚀")];
  const orbits = [orbit("orbit:old", 12_000, 0, 0), orbit("mod:轨道/新🚀", 24_000, -12, 359.9)];
  return {
    source: "native-core",
    sourceMode: "player-authority",
    sessionId: "session-a",
    runId: "run-a",
    revision: 44,
    registryFingerprint: "registry-a",
    selectedSystemId: "sol",
    projection: { revision: 44, registryFingerprint: "registry-a", selectedSystemId: "sol" } as NativeDysonWorkspaceFrame["projection"],
    systems: [system], layers, orbits, nodes: [], frames: [], shells: [],
    systemsById: new Map([["sol", system]]),
    layersById: new Map(layers.map((layer) => [layer.layerId, layer])),
    orbitsById: new Map(orbits.map((orbit) => [orbit.orbitId, orbit])),
    nodesByLayerId: new Map(), framesByLayerId: new Map(), shellsByLayerId: new Map(),
  };
}

describe("native projected Dyson launch commands", () => {
  it("emits only the requested launch leaf from the exact native frame", () => {
    expect(createNativeProjectedDysonLaunchModeCommand(frame(), "sphere")?.topLevelChanges)
      .toEqual([{ path: ["dysonEngineering", "launchMode"], operation: "set", value: "sphere" }]);
    expect(createNativeProjectedDysonLaunchThrottleCommand(frame(), 0.5)?.topLevelChanges)
      .toEqual([{ path: ["dysonEngineering", "launchThrottle"], operation: "set", value: 0.5 }]);
    expect(createNativeProjectedDysonLaunchEnabledCommand(frame(), false)?.topLevelChanges)
      .toEqual([{ path: ["dysonEngineering", "launchEnabled"], operation: "set", value: false }]);
  });

  it("returns null for unchanged values", () => {
    expect(createNativeProjectedDysonLaunchModeCommand(frame(), "balanced")).toBeNull();
    expect(createNativeProjectedDysonLaunchThrottleCommand(frame(), 1)).toBeNull();
    expect(createNativeProjectedDysonLaunchEnabledCommand(frame(), true)).toBeNull();
  });

  it("selects only a projected layer or orbit in the current stellar system", () => {
    expect(createNativeProjectedDysonActiveLayerCommand(frame(), "mod:层/新🚀")?.topLevelChanges)
      .toEqual([{ path: ["dysonPlans", "sol", "activeLayerId"], operation: "set", value: "mod:层/新🚀" }]);
    expect(createNativeProjectedDysonActiveOrbitCommand(frame(), "mod:轨道/新🚀")?.topLevelChanges)
      .toEqual([{ path: ["dysonEngineering", "activeOrbitBySystem", "sol"], operation: "set", value: "mod:轨道/新🚀" }]);
    expect(createNativeProjectedDysonActiveLayerCommand(frame(), "layer:old")).toBeNull();
    expect(createNativeProjectedDysonActiveOrbitCommand(frame(), "orbit:old")).toBeNull();
  });

  it("emits canonical orbit geometry leaves in a stable order", () => {
    expect(createNativeProjectedDysonOrbitGeometryCommand(frame(), "mod:轨道/新🚀", {
      longitude: 12.3,
      radius: 30_000,
      inclination: 45,
    })?.topLevelChanges).toEqual([
      { path: ["dysonEngineering", "orbitsBySystem", "sol", 1, "radius"], operation: "set", value: 30_000 },
      { path: ["dysonEngineering", "orbitsBySystem", "sol", 1, "inclination"], operation: "set", value: 45 },
      { path: ["dysonEngineering", "orbitsBySystem", "sol", 1, "longitude"], operation: "set", value: 12.3 },
    ]);
    expect(createNativeProjectedDysonOrbitGeometryCommand(frame(), "mod:轨道/新🚀", {
      radius: 24_000,
      inclination: -12,
    })).toBeNull();
  });

  it("fails closed for stale frames and malformed targets", () => {
    const current = frame();
    const stale = {
      ...current,
      projection: { ...current.projection, revision: 43 },
    } as NativeDysonWorkspaceFrame;
    expect(() => createNativeProjectedDysonLaunchEnabledCommand(stale, false)).toThrow(TypeError);
    expect(() => createNativeProjectedDysonLaunchModeCommand(frame(), "wide" as "balanced")).toThrow(TypeError);
    expect(() => createNativeProjectedDysonLaunchThrottleCommand(frame(), 0.4 as 0.5)).toThrow(TypeError);
    expect(() => createNativeProjectedDysonLaunchEnabledCommand(frame(), 1 as unknown as boolean)).toThrow(TypeError);
    expect(() => createNativeProjectedDysonActiveLayerCommand(frame(), "layer:missing")).toThrow(TypeError);
    expect(() => createNativeProjectedDysonActiveOrbitCommand(frame(), "orbit:missing")).toThrow(TypeError);
    expect(() => createNativeProjectedDysonOrbitGeometryCommand(frame(), "orbit:old", { radius: 4_999 })).toThrow(TypeError);
    expect(() => createNativeProjectedDysonOrbitGeometryCommand(frame(), "orbit:old", { inclination: 90.5 })).toThrow(TypeError);
    expect(() => createNativeProjectedDysonOrbitGeometryCommand(frame(), "orbit:old", { longitude: 360 })).toThrow(TypeError);
    expect(() => createNativeProjectedDysonOrbitGeometryCommand(frame(), "orbit:old", {})).toThrow(TypeError);
  });
});
