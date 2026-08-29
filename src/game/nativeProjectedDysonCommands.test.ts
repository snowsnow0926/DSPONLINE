import { describe, expect, it } from "vitest";
import type { DesktopNativeCoreDysonSystemRow } from "../desktop";
import type { NativeDysonWorkspaceFrame } from "./nativeDysonWorkspaceStore";
import {
  createNativeProjectedDysonLaunchEnabledCommand,
  createNativeProjectedDysonLaunchModeCommand,
  createNativeProjectedDysonLaunchThrottleCommand,
} from "./nativeProjectedDysonCommands";

const engineering = {
  launchMode: "balanced",
  launchThrottle: 1,
  launchEnabled: true,
} as DesktopNativeCoreDysonSystemRow["engineering"];

function frame(): NativeDysonWorkspaceFrame {
  const system = { systemId: "sol", engineering } as DesktopNativeCoreDysonSystemRow;
  return {
    source: "native-core",
    sourceMode: "player-authority",
    sessionId: "session-a",
    revision: 44,
    registryFingerprint: "registry-a",
    selectedSystemId: "sol",
    projection: { revision: 44, registryFingerprint: "registry-a", selectedSystemId: "sol" } as NativeDysonWorkspaceFrame["projection"],
    systems: [system], layers: [], orbits: [], nodes: [], frames: [], shells: [],
    systemsById: new Map([["sol", system]]), layersById: new Map(), orbitsById: new Map(),
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
  });
});
