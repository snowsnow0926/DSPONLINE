import type { NativeDysonWorkspaceFrame } from "./nativeDysonWorkspaceStore";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { DysonLaunchMode, DysonLaunchThrottle } from "./types";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

function validFrame(frame: NativeDysonWorkspaceFrame): boolean {
  return frame.source === "native-core" && frame.sourceMode === "player-authority" &&
    Number.isSafeInteger(frame.revision) && frame.revision >= 0 &&
    LOGICAL_ID_PATTERN.test(frame.sessionId) && frame.sessionId.length <= 128 &&
    LOGICAL_ID_PATTERN.test(frame.registryFingerprint) && frame.registryFingerprint.length <= 256 &&
    frame.projection.revision === frame.revision &&
    frame.projection.registryFingerprint === frame.registryFingerprint &&
    frame.projection.selectedSystemId === frame.selectedSystemId &&
    frame.systemsById.get(frame.selectedSystemId) !== undefined;
}

function launchCommand(
  frame: NativeDysonWorkspaceFrame,
  field: "launchMode" | "launchThrottle" | "launchEnabled",
  value: DysonLaunchMode | DysonLaunchThrottle | boolean,
): SimulationCommandPatch {
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: frame.revision,
    topLevelChanges: [{ path: ["dysonEngineering", field], operation: "set", value }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

export function createNativeProjectedDysonLaunchModeCommand(
  frame: NativeDysonWorkspaceFrame,
  target: DysonLaunchMode,
): SimulationCommandPatch | null {
  if (!validFrame(frame) || !["balanced", "swarm", "sphere"].includes(target)) {
    throw new TypeError("原生戴森发射模式投影或目标无效");
  }
  const current = frame.systemsById.get(frame.selectedSystemId)!.engineering.launchMode;
  return current === target ? null : launchCommand(frame, "launchMode", target);
}

export function createNativeProjectedDysonLaunchThrottleCommand(
  frame: NativeDysonWorkspaceFrame,
  target: DysonLaunchThrottle,
): SimulationCommandPatch | null {
  if (!validFrame(frame) || ![0.25, 0.5, 0.75, 1].includes(target)) {
    throw new TypeError("原生戴森发射节流投影或目标无效");
  }
  const current = frame.systemsById.get(frame.selectedSystemId)!.engineering.launchThrottle;
  return current === target ? null : launchCommand(frame, "launchThrottle", target);
}

export function createNativeProjectedDysonLaunchEnabledCommand(
  frame: NativeDysonWorkspaceFrame,
  target: boolean,
): SimulationCommandPatch | null {
  if (!validFrame(frame) || typeof target !== "boolean") {
    throw new TypeError("原生戴森发射开关投影或目标无效");
  }
  const current = frame.systemsById.get(frame.selectedSystemId)!.engineering.launchEnabled;
  return current === target ? null : launchCommand(frame, "launchEnabled", target);
}
