import type { NativeDysonWorkspaceFrame } from "./nativeDysonWorkspaceStore";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { DysonLaunchMode, DysonLaunchThrottle } from "./types";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const textEncoder = new TextEncoder();

function validOpaqueId(value: string): boolean {
  return value.length > 0 && textEncoder.encode(value).byteLength <= 1_024 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    !Array.from(value).some((character) => {
      const unit = character.charCodeAt(0);
      return character.length === 1 && unit >= 0xd800 && unit <= 0xdfff;
    });
}

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

function topLevelCommand(
  frame: NativeDysonWorkspaceFrame,
  topLevelChanges: SimulationCommandPatch["topLevelChanges"],
): SimulationCommandPatch {
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: frame.revision,
    topLevelChanges,
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

export type NativeProjectedDysonPlanIntentKind = "auto-connect" | "plan-shell" | "clear-shell";

export type NativeProjectedDysonLayerIntentKind =
  | "add-layer"
  | "add-standard-layer"
  | "set-layer-orbit"
  | "remove-layer";

function sameUndirectedEdge(
  leftSource: string,
  leftTarget: string,
  rightSource: string,
  rightTarget: string,
): boolean {
  return leftSource === rightSource && leftTarget === rightTarget ||
    leftSource === rightTarget && leftTarget === rightSource;
}

function createNativeProjectedDysonPlanIntentCommand(
  frame: NativeDysonWorkspaceFrame,
  layerId: string,
  kind: NativeProjectedDysonPlanIntentKind,
): SimulationCommandPatch | null {
  const layer = frame.layersById.get(layerId);
  const programReady = frame.projection.technology?.programReady === true;
  if (!validFrame(frame) || !validOpaqueId(layerId) || !layer || !programReady ||
      !["auto-connect", "plan-shell", "clear-shell"].includes(kind)) {
    throw new TypeError("原生戴森壳层规划投影或目标无效");
  }
  const nodes = [...(frame.nodesByLayerId.get(layerId) ?? [])]
    .sort((left, right) => left.angle - right.angle);
  const frames = frame.framesByLayerId.get(layerId) ?? [];
  const shells = frame.shellsByLayerId.get(layerId) ?? [];
  if (kind !== "clear-shell" && nodes.length < 3) {
    throw new TypeError("原生戴森壳层至少需要三个节点");
  }
  if (kind === "plan-shell" && frame.projection.technology?.shellReady !== true) {
    throw new TypeError("原生戴森壳面科技尚未解锁");
  }
  const missingFrame = nodes.some((node, index) => {
    const target = nodes[(index + 1) % nodes.length];
    return !frames.some((candidate) => sameUndirectedEdge(
      candidate.sourceNodeId,
      candidate.targetNodeId,
      node.nodeId,
      target.nodeId,
    ));
  });
  const missingShell = nodes.some((node, index) => {
    const target = nodes[(index + 1) % nodes.length];
    return !shells.some((candidate) => sameUndirectedEdge(
      candidate.sourceNodeId,
      candidate.targetNodeId,
      node.nodeId,
      target.nodeId,
    ));
  });
  if (kind === "auto-connect" && !missingFrame ||
      kind === "plan-shell" && !missingFrame && !missingShell ||
      kind === "clear-shell" && shells.length === 0) return null;
  return topLevelCommand(frame, [{
    path: ["dysonPlans", "intent"],
    operation: "set",
    value: { kind, systemId: frame.selectedSystemId, layerId },
  }]);
}

export function createNativeProjectedDysonAutoConnectCommand(
  frame: NativeDysonWorkspaceFrame,
  layerId: string,
): SimulationCommandPatch | null {
  return createNativeProjectedDysonPlanIntentCommand(frame, layerId, "auto-connect");
}

export function createNativeProjectedDysonPlanShellCommand(
  frame: NativeDysonWorkspaceFrame,
  layerId: string,
): SimulationCommandPatch | null {
  return createNativeProjectedDysonPlanIntentCommand(frame, layerId, "plan-shell");
}

export function createNativeProjectedDysonClearShellCommand(
  frame: NativeDysonWorkspaceFrame,
  layerId: string,
): SimulationCommandPatch | null {
  return createNativeProjectedDysonPlanIntentCommand(frame, layerId, "clear-shell");
}

export function createNativeProjectedDysonAddLayerCommand(
  frame: NativeDysonWorkspaceFrame,
  standard: boolean,
): SimulationCommandPatch | null {
  const system = frame.systemsById.get(frame.selectedSystemId);
  if (!validFrame(frame) || typeof standard !== "boolean" || !system || !system.unlocked ||
      frame.projection.technology?.programReady !== true) {
    throw new TypeError("原生戴森壳层新增投影无效或科技尚未解锁");
  }
  if (frame.layers.length >= 8) return null;
  return topLevelCommand(frame, [{
    path: ["dysonPlans", "intent"],
    operation: "set",
    value: {
      kind: standard ? "add-standard-layer" : "add-layer",
      systemId: frame.selectedSystemId,
    },
  }]);
}

export interface NativeProjectedDysonLayerGeometry {
  readonly radius?: number;
  readonly inclination?: number;
  readonly longitude?: number;
}

export function createNativeProjectedDysonLayerGeometryCommand(
  frame: NativeDysonWorkspaceFrame,
  layerId: string,
  target: NativeProjectedDysonLayerGeometry,
): SimulationCommandPatch | null {
  const requestedKeys = Object.keys(target);
  const layer = frame.layersById.get(layerId);
  if (!validFrame(frame) || !validOpaqueId(layerId) || !layer ||
      frame.projection.technology?.programReady !== true || requestedKeys.length === 0 ||
      requestedKeys.length > 3 || requestedKeys.some((key) => !["radius", "inclination", "longitude"].includes(key))) {
    throw new TypeError("原生戴森壳层轨道命令无效");
  }
  const changes: NativeProjectedDysonLayerGeometry = {};
  for (const field of ["radius", "inclination", "longitude"] as const) {
    const value = target[field];
    if (value === undefined) continue;
    if (!validOrbitGeometry(field, value) || !validOrbitGeometry(field, layer[field])) {
      throw new TypeError("原生戴森壳层轨道值无效");
    }
    if (value !== layer[field]) Object.assign(changes, { [field]: value });
  }
  if (Object.keys(changes).length === 0) return null;
  return topLevelCommand(frame, [{
    path: ["dysonPlans", "intent"],
    operation: "set",
    value: { kind: "set-layer-orbit", systemId: frame.selectedSystemId, layerId, changes },
  }]);
}

export function createNativeProjectedDysonRemoveLayerCommand(
  frame: NativeDysonWorkspaceFrame,
  layerId: string,
): SimulationCommandPatch {
  const system = frame.systemsById.get(frame.selectedSystemId);
  if (!validFrame(frame) || !validOpaqueId(layerId) || !frame.layersById.has(layerId) ||
      !system?.unlocked || frame.projection.technology?.programReady !== true) {
    throw new TypeError("原生戴森壳层删除投影或目标无效");
  }
  return topLevelCommand(frame, [{
    path: ["dysonPlans", "intent"],
    operation: "set",
    value: { kind: "remove-layer", systemId: frame.selectedSystemId, layerId },
  }]);
}

export function createNativeProjectedDysonAddOrbitCommand(
  frame: NativeDysonWorkspaceFrame,
): SimulationCommandPatch | null {
  const system = frame.systemsById.get(frame.selectedSystemId);
  if (!validFrame(frame) || !system?.unlocked || frame.projection.technology?.swarmReady !== true) {
    throw new TypeError("原生太阳帆轨道新增投影无效或科技尚未解锁");
  }
  if (frame.orbits.length >= 8) return null;
  return topLevelCommand(frame, [{
    path: ["dysonEngineering", "intent"],
    operation: "set",
    value: { kind: "add-orbit", systemId: frame.selectedSystemId },
  }]);
}

export function createNativeProjectedDysonRemoveOrbitCommand(
  frame: NativeDysonWorkspaceFrame,
  orbitId: string,
): SimulationCommandPatch | null {
  const system = frame.systemsById.get(frame.selectedSystemId);
  if (!validFrame(frame) || !validOpaqueId(orbitId) || !frame.orbitsById.has(orbitId) ||
      !system?.unlocked || frame.projection.technology?.swarmReady !== true) {
    throw new TypeError("原生太阳帆轨道删除投影或目标无效");
  }
  if (frame.orbits.length <= 1) return null;
  return topLevelCommand(frame, [{
    path: ["dysonEngineering", "intent"],
    operation: "set",
    value: { kind: "remove-orbit", systemId: frame.selectedSystemId, orbitId },
  }]);
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

export function createNativeProjectedDysonActiveLayerCommand(
  frame: NativeDysonWorkspaceFrame,
  targetLayerId: string,
): SimulationCommandPatch | null {
  if (!validFrame(frame) || !validOpaqueId(targetLayerId) || !frame.layersById.has(targetLayerId)) {
    throw new TypeError("原生戴森活动壳层投影或目标无效");
  }
  const current = frame.systemsById.get(frame.selectedSystemId)!.activeLayerId;
  return current === targetLayerId ? null : topLevelCommand(frame, [{
    path: ["dysonPlans", frame.selectedSystemId, "activeLayerId"],
    operation: "set",
    value: targetLayerId,
  }]);
}

export function createNativeProjectedDysonActiveOrbitCommand(
  frame: NativeDysonWorkspaceFrame,
  targetOrbitId: string,
): SimulationCommandPatch | null {
  if (!validFrame(frame) || !validOpaqueId(targetOrbitId) || !frame.orbitsById.has(targetOrbitId)) {
    throw new TypeError("原生戴森活动太阳帆轨道投影或目标无效");
  }
  const current = frame.systemsById.get(frame.selectedSystemId)!.activeOrbitId;
  return current === targetOrbitId ? null : topLevelCommand(frame, [{
    path: ["dysonEngineering", "activeOrbitBySystem", frame.selectedSystemId],
    operation: "set",
    value: targetOrbitId,
  }]);
}

export interface NativeProjectedDysonOrbitGeometry {
  readonly radius?: number;
  readonly inclination?: number;
  readonly longitude?: number;
}

function validOrbitGeometry(field: keyof NativeProjectedDysonOrbitGeometry, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (field === "radius") return Number.isInteger(value) && value >= 5_000 && value <= 50_000;
  if (field === "inclination") return Number.isInteger(value) && value >= -90 && value <= 90;
  return value >= 0 && value < 360 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
}

export function createNativeProjectedDysonOrbitGeometryCommand(
  frame: NativeDysonWorkspaceFrame,
  orbitId: string,
  target: NativeProjectedDysonOrbitGeometry,
): SimulationCommandPatch | null {
  const requestedKeys = Object.keys(target);
  if (!validFrame(frame) || !validOpaqueId(orbitId) || requestedKeys.length === 0 ||
      requestedKeys.length > 3 || requestedKeys.some((key) => !["radius", "inclination", "longitude"].includes(key))) {
    throw new TypeError("原生戴森太阳帆轨道几何命令无效");
  }
  const orbitIndex = frame.orbits.findIndex((orbit) => orbit.orbitId === orbitId);
  const orbit = orbitIndex >= 0 ? frame.orbits[orbitIndex] : null;
  if (!orbit || frame.orbitsById.get(orbitId) !== orbit) {
    throw new TypeError("原生戴森太阳帆轨道不属于当前恒星系");
  }
  const changes: SimulationCommandPatch["topLevelChanges"] = [];
  for (const field of ["radius", "inclination", "longitude"] as const) {
    const value = target[field];
    if (value === undefined) continue;
    if (!validOrbitGeometry(field, value) || !validOrbitGeometry(field, orbit[field])) {
      throw new TypeError("原生戴森太阳帆轨道几何值无效");
    }
    if (value !== orbit[field]) {
      changes.push({
        path: ["dysonEngineering", "orbitsBySystem", frame.selectedSystemId, orbitIndex, field],
        operation: "set",
        value,
      });
    }
  }
  return changes.length === 0 ? null : topLevelCommand(frame, changes);
}
