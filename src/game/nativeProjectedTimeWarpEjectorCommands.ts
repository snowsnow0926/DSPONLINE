import type {
  DesktopBridge,
  DesktopNativeCoreDysonOrbitRow,
  DesktopNativeCoreDysonWorkspaceProjectionRequest,
} from "../desktop";
import type { FactoryTimeWarpReadModel } from "./factoryReadModels";
import type { NativeProjectedEntityConfigurationBinding } from "./nativeProjectedEntityConfigurationCommands";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const BUILTIN_REGISTRY_FINGERPRINT = "7df8cf3a";
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const TEXT_ENCODER = new TextEncoder();
const MAX_LOGICAL_ID_BYTES = 256;
const MAX_OPAQUE_ID_BYTES = 512;
const MAX_PLAYER_ENTITY_OR_ORBIT_ID_BYTES = 160;
const MAX_ORBITS_PER_SYSTEM = 8;

function validLogicalId(value: unknown): value is string {
  return typeof value === "string" && LOGICAL_ID_PATTERN.test(value) &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_LOGICAL_ID_BYTES;
}

function validOpaqueId(value: unknown, maximumBytes = MAX_OPAQUE_ID_BYTES): value is string {
  return typeof value === "string" && value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= maximumBytes &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function emptyCommand(baseRevision: number): SimulationCommandPatch {
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

export interface NativeProjectedTimeWarpControllerBinding
  extends NativeProjectedEntityConfigurationBinding {
  readonly registryFingerprint: string;
  readonly simulationSpeed: number;
  readonly timeWarp: FactoryTimeWarpReadModel;
}

export interface NativeProjectedTimeWarpControllerState {
  readonly controllerEntityId: string;
  readonly enabled: boolean;
  readonly requestedMultiplier: number;
  readonly effectiveMultiplier: number;
  readonly requiredPowerKw: number;
  readonly allocatedPowerKw: number;
}

/** Returns a writable control atom only for the selected built-in controller. */
export function getNativeProjectedTimeWarpControllerState(
  binding: NativeProjectedTimeWarpControllerBinding | null,
): NativeProjectedTimeWarpControllerState | null {
  if (!binding || binding.registryFingerprint !== BUILTIN_REGISTRY_FINGERPRINT ||
      !validLogicalId(binding.sessionId) || !validLogicalId(binding.runId) ||
      !Number.isSafeInteger(binding.revision) || binding.revision < 0 ||
      !validOpaqueId(binding.activePlanetId) ||
      !validOpaqueId(binding.entity.id, MAX_PLAYER_ENTITY_OR_ORBIT_ID_BYTES) ||
      binding.entity.planetId !== binding.activePlanetId || binding.entity.kind !== "machine" ||
      binding.entity.buildingId !== "time_warp_device" || binding.entity.interactionLocked !== false ||
      !Number.isSafeInteger(binding.simulationSpeed) || binding.simulationSpeed < 1 ||
      binding.timeWarp.controllerEntityId !== binding.entity.id ||
      typeof binding.timeWarp.enabled !== "boolean" ||
      !Number.isSafeInteger(binding.timeWarp.requestedMultiplier) ||
      binding.timeWarp.requestedMultiplier < 5 ||
      !Number.isSafeInteger(binding.timeWarp.effectiveMultiplier) ||
      binding.timeWarp.effectiveMultiplier < binding.simulationSpeed ||
      !Number.isFinite(binding.timeWarp.requiredPowerKw) || binding.timeWarp.requiredPowerKw < 0 ||
      !Number.isFinite(binding.timeWarp.allocatedPowerKw) || binding.timeWarp.allocatedPowerKw < 0 ||
      binding.timeWarp.allocatedPowerKw > binding.timeWarp.requiredPowerKw) return null;
  return Object.freeze({
    controllerEntityId: binding.entity.id,
    enabled: binding.timeWarp.enabled,
    requestedMultiplier: binding.timeWarp.requestedMultiplier,
    effectiveMultiplier: binding.timeWarp.effectiveMultiplier,
    requiredPowerKw: binding.timeWarp.requiredPowerKw,
    allocatedPowerKw: binding.timeWarp.allocatedPowerKw,
  });
}

export type NativeTimeWarpSemanticIntent = Readonly<
  | { controllerEntityId: string; enabled: boolean }
  | { controllerEntityId: string; requestedMultiplier: number }
>;

/**
 * Encodes only the global time-warp intent. Rust re-reads the selected
 * controller, active planet, registry, lock and all derived power fields,
 * then expands this marker identically for live commit and cold WAL replay.
 */
export function createNativeTimeWarpSemanticIntentCommand(
  baseRevision: number,
  intent: NativeTimeWarpSemanticIntent,
): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      !validOpaqueId(intent.controllerEntityId, MAX_PLAYER_ENTITY_OR_ORBIT_ID_BYTES)) {
    throw new TypeError("原生时间扭曲命令身份无效");
  }
  const hasEnabled = "enabled" in intent;
  const hasMultiplier = "requestedMultiplier" in intent;
  if (hasEnabled === hasMultiplier ||
      hasEnabled && typeof intent.enabled !== "boolean" ||
      hasMultiplier && (!Number.isSafeInteger(intent.requestedMultiplier) ||
        intent.requestedMultiplier < 5)) {
    throw new TypeError("原生时间扭曲语义意图无效");
  }
  const command = emptyCommand(baseRevision);
  command.topLevelChanges = [{
    path: ["timeWarp", "intent"],
    operation: "set",
    value: hasEnabled
      ? { controllerEntityId: intent.controllerEntityId, enabled: intent.enabled }
      : {
        controllerEntityId: intent.controllerEntityId,
        requestedMultiplier: intent.requestedMultiplier,
      },
  }];
  return command;
}

export function createNativeProjectedTimeWarpEnabledCommand(
  binding: NativeProjectedTimeWarpControllerBinding,
  enabled: boolean,
): SimulationCommandPatch | null {
  const current = getNativeProjectedTimeWarpControllerState(binding);
  if (!current || typeof enabled !== "boolean") {
    throw new TypeError("原生时间扭曲控制器投影无效");
  }
  if (current.enabled === enabled) return null;
  return createNativeTimeWarpSemanticIntentCommand(binding.revision, {
    controllerEntityId: current.controllerEntityId,
    enabled,
  });
}

export function createNativeProjectedTimeWarpRequestedMultiplierCommand(
  binding: NativeProjectedTimeWarpControllerBinding,
  requestedMultiplier: number,
): SimulationCommandPatch | null {
  const current = getNativeProjectedTimeWarpControllerState(binding);
  if (!current || !Number.isSafeInteger(requestedMultiplier) || requestedMultiplier < 5) {
    throw new TypeError("原生时间扭曲目标倍率无效");
  }
  if (current.requestedMultiplier === requestedMultiplier) return null;
  return createNativeTimeWarpSemanticIntentCommand(binding.revision, {
    controllerEntityId: current.controllerEntityId,
    requestedMultiplier,
  });
}

export interface NativeProjectedEjectorOrbitIdentity
  extends NativeProjectedEntityConfigurationBinding {
  readonly registryFingerprint: string;
  readonly activeSystemId: string;
}

export interface NativeProjectedEjectorOrbitFrame extends NativeProjectedEjectorOrbitIdentity {
  readonly source: "native-core";
  readonly orbits: readonly DesktopNativeCoreDysonOrbitRow[];
  readonly orbitsById: ReadonlyMap<string, DesktopNativeCoreDysonOrbitRow>;
}

const EJECTOR_ORBIT_PAGE_REQUEST = Object.freeze({
  systemCursor: 0,
  systemLimit: 1,
  layerCursor: 0,
  layerLimit: 1,
  orbitCursor: 0,
  orbitLimit: MAX_ORBITS_PER_SYSTEM,
  nodeCursor: 0,
  nodeLimit: 1,
  frameCursor: 0,
  frameLimit: 1,
  shellCursor: 0,
  shellLimit: 1,
});

function validEjectorIdentity(identity: NativeProjectedEjectorOrbitIdentity): boolean {
  return identity.registryFingerprint === BUILTIN_REGISTRY_FINGERPRINT &&
    validLogicalId(identity.sessionId) && validLogicalId(identity.runId) &&
    Number.isSafeInteger(identity.revision) && identity.revision >= 0 &&
    validOpaqueId(identity.activePlanetId) && validOpaqueId(identity.activeSystemId) &&
    validOpaqueId(identity.entity.id, MAX_PLAYER_ENTITY_OR_ORBIT_ID_BYTES) &&
    identity.entity.planetId === identity.activePlanetId && identity.entity.kind === "machine" &&
    identity.entity.buildingId === "em_rail_ejector" && identity.entity.interactionLocked === false &&
    (identity.entity.targetDysonOrbitId === undefined ||
      validOpaqueId(identity.entity.targetDysonOrbitId, MAX_PLAYER_ENTITY_OR_ORBIT_ID_BYTES));
}

function exactEjectorProjectionRequest(
  request: Omit<DesktopNativeCoreDysonWorkspaceProjectionRequest, "sessionId">,
  identity: NativeProjectedEjectorOrbitIdentity,
): boolean {
  return request.expectedRevision === identity.revision &&
    request.expectedRegistryFingerprint === identity.registryFingerprint &&
    request.selectedSystemId === identity.activeSystemId &&
    Object.entries(EJECTOR_ORBIT_PAGE_REQUEST).every(([key, value]) =>
      request[key as keyof typeof EJECTOR_ORBIT_PAGE_REQUEST] === value);
}

/** Reads one bounded Dyson page: all <=8 orbit choices, but at most one row from every other table. */
export async function readNativeProjectedEjectorOrbitFrame(
  bridge: Pick<DesktopBridge, "getNativeCoreDysonWorkspaceProjection"> | null,
  identity: NativeProjectedEjectorOrbitIdentity,
): Promise<NativeProjectedEjectorOrbitFrame | null> {
  if (!validEjectorIdentity(identity) ||
      typeof bridge?.getNativeCoreDysonWorkspaceProjection !== "function") return null;
  try {
    const projection = await bridge.getNativeCoreDysonWorkspaceProjection({
      sessionId: identity.sessionId,
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      selectedSystemId: identity.activeSystemId,
      ...EJECTOR_ORBIT_PAGE_REQUEST,
    });
    const page = projection.orbits;
    if (projection.schemaVersion !== 1 || projection.projectionType !== "dyson-workspace-v1" ||
        projection.stateVersion !== 47 || projection.revision !== identity.revision ||
        projection.registryFingerprint !== identity.registryFingerprint ||
        projection.activePlanetId !== identity.activePlanetId ||
        projection.activeSystemId !== identity.activeSystemId ||
        projection.selectedSystemId !== identity.activeSystemId ||
        projection.selectedSystem.systemId !== identity.activeSystemId ||
        !projection.technology.swarmReady ||
        !exactEjectorProjectionRequest(projection.request, identity) ||
        page.cursor !== 0 || page.limit !== MAX_ORBITS_PER_SYSTEM ||
        page.totalCount < 1 || page.totalCount > MAX_ORBITS_PER_SYSTEM ||
        page.rows.length !== page.totalCount || page.nextCursor !== null ||
        projection.selectedSystem.orbitCount !== page.totalCount) return null;
    const orbitsById = new Map<string, DesktopNativeCoreDysonOrbitRow>();
    for (const orbit of page.rows) {
      if (!validOpaqueId(orbit.orbitId, MAX_PLAYER_ENTITY_OR_ORBIT_ID_BYTES) ||
          orbitsById.has(orbit.orbitId) || typeof orbit.name !== "string" ||
          TEXT_ENCODER.encode(orbit.name).byteLength > MAX_OPAQUE_ID_BYTES ||
          !Number.isFinite(orbit.radius) || !Number.isFinite(orbit.inclination) ||
          !Number.isFinite(orbit.longitude)) return null;
      orbitsById.set(orbit.orbitId, orbit);
    }
    return Object.freeze({
      ...identity,
      source: "native-core" as const,
      orbits: Object.freeze([...page.rows]),
      orbitsById,
    });
  } catch {
    return null;
  }
}

/** The renderer submits only the selected entity ID and one verified target orbit ID. */
export function createNativeProjectedEjectorOrbitCommand(
  frame: NativeProjectedEjectorOrbitFrame,
  targetOrbitId: string,
): SimulationCommandPatch | null {
  if (!validEjectorIdentity(frame) || frame.source !== "native-core" ||
      !validOpaqueId(targetOrbitId, MAX_PLAYER_ENTITY_OR_ORBIT_ID_BYTES) ||
      !frame.orbitsById.has(targetOrbitId) ||
      frame.orbits.length !== frame.orbitsById.size ||
      !frame.orbits.every((orbit) => frame.orbitsById.get(orbit.orbitId) === orbit)) {
    throw new TypeError("原生弹射器轨道投影或目标无效");
  }
  if (frame.entity.targetDysonOrbitId === targetOrbitId) return null;
  const command = emptyCommand(frame.revision);
  command.changedEntities = [{
    id: frame.entity.id,
    changes: [{ path: ["targetDysonOrbitId"], operation: "set", value: targetOrbitId }],
  }];
  return command;
}
