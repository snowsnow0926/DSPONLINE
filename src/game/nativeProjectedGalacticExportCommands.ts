import type {
  DesktopNativeCoreGalacticExportProjectId,
} from "../desktop";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { NativeGalaxyWorkspaceFrame } from "./nativeCampaignGalaxyWorkspaceStore";
import type { NativeProjectedEntityConfigurationBinding } from "./nativeProjectedEntityConfigurationCommands";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,15})$/;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991n;
const TEXT_ENCODER = new TextEncoder();
const PROJECT_IDS = new Set<DesktopNativeCoreGalacticExportProjectId>([
  "universe_archive",
  "solar_sail_array",
  "carrier_rocket_fleet",
  "antimatter_exchange",
]);
const PROJECT_ITEM_IDS = new Map<DesktopNativeCoreGalacticExportProjectId, string>([
  ["universe_archive", "universe_matrix"],
  ["solar_sail_array", "solar_sail"],
  ["carrier_rocket_fleet", "small_carrier_rocket"],
  ["antimatter_exchange", "antimatter_fuel_rod"],
]);

export type NativeProjectedGalacticExportIntent =
  | Readonly<{ type: "set-auto-dispatch"; enabled: boolean }>
  | Readonly<{ type: "set-dispatch-throttle"; throttle: 0.25 | 0.5 | 1 }>
  | Readonly<{
      type: "set-project-enabled";
      projectId: DesktopNativeCoreGalacticExportProjectId;
      enabled: boolean;
    }>
  | Readonly<{
      type: "set-project-priority";
      projectId: DesktopNativeCoreGalacticExportProjectId;
      priority: 1 | 2 | 3;
    }>
  | Readonly<{
      type: "manual-dispatch";
      projectId: DesktopNativeCoreGalacticExportProjectId;
      requestedAmount: string;
    }>;

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

function validFrame(frame: NativeGalaxyWorkspaceFrame): boolean {
  const projects = frame.projection.galacticExports.projects;
  return LOGICAL_ID_PATTERN.test(frame.sessionId) && LOGICAL_ID_PATTERN.test(frame.runId) &&
    Number.isSafeInteger(frame.revision) && frame.revision >= 0 &&
    frame.projection.sessionId === frame.sessionId && frame.projection.runId === frame.runId &&
    frame.projection.revision === frame.revision &&
    frame.projection.registryFingerprint === frame.registryFingerprint &&
    frame.projection.galacticExports.unlocked &&
    projects.length === PROJECT_IDS.size && new Set(projects.map((row) => row.id)).size === PROJECT_IDS.size &&
    projects.every((row) => PROJECT_IDS.has(row.id) && PROJECT_ITEM_IDS.get(row.id) === row.itemId);
}

function validOpaqueId(value: string): boolean {
  return value.length > 0 && TEXT_ENCODER.encode(value).byteLength <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function createNativeProjectedGalacticExportCommand(
  frame: NativeGalaxyWorkspaceFrame,
  intent: NativeProjectedGalacticExportIntent,
): SimulationCommandPatch | null {
  if (!validFrame(frame)) throw new TypeError("原生银河出口投影无效或尚未解锁");
  const exports = frame.projection.galacticExports;
  let value: NativeProjectedGalacticExportIntent;
  if (intent.type === "set-auto-dispatch") {
    if (exports.inputMode !== "legacy-network" || typeof intent.enabled !== "boolean") {
      throw new TypeError("原生银河出口自动调度意图无效");
    }
    if (exports.autoDispatch === intent.enabled) return null;
    value = { type: intent.type, enabled: intent.enabled };
  } else if (intent.type === "set-dispatch-throttle") {
    if (exports.inputMode !== "legacy-network" || ![0.25, 0.5, 1].includes(intent.throttle)) {
      throw new TypeError("原生银河出口节流意图无效");
    }
    if (exports.dispatchThrottle === intent.throttle) return null;
    value = { type: intent.type, throttle: intent.throttle };
  } else if (intent.type === "set-project-enabled") {
    const project = exports.projects.find((row) => row.id === intent.projectId);
    if (exports.inputMode !== "legacy-network" || !project || typeof intent.enabled !== "boolean") {
      throw new TypeError("原生银河出口项目开关意图无效");
    }
    if (project.enabled === intent.enabled) return null;
    value = { type: intent.type, projectId: intent.projectId, enabled: intent.enabled };
  } else if (intent.type === "set-project-priority") {
    const project = exports.projects.find((row) => row.id === intent.projectId);
    if (!project || ![1, 2, 3].includes(intent.priority)) {
      throw new TypeError("原生银河出口优先级意图无效");
    }
    if (project.priority === intent.priority) return null;
    value = { type: intent.type, projectId: intent.projectId, priority: intent.priority };
  } else {
    const project = exports.projects.find((row) => row.id === intent.projectId);
    if (exports.inputMode !== "legacy-network" || !project ||
        !DECIMAL_PATTERN.test(intent.requestedAmount)) {
      throw new TypeError("原生银河出口手动交付意图无效");
    }
    const amount = BigInt(intent.requestedAmount);
    if (amount <= 0n || amount > MAX_SAFE_INTEGER) {
      throw new TypeError("原生银河出口手动交付数量超限");
    }
    value = {
      type: intent.type,
      projectId: intent.projectId,
      requestedAmount: amount.toString(),
    };
  }
  const command = emptyCommand(frame.revision);
  command.topLevelChanges = [{
    path: ["galacticExports", "intent"],
    operation: "set",
    value,
  }];
  return command;
}

export function createNativeProjectedGalacticExporterPauseCommand(
  binding: NativeProjectedEntityConfigurationBinding,
  paused: boolean,
): SimulationCommandPatch | null {
  const entity = binding.entity;
  if (!LOGICAL_ID_PATTERN.test(binding.sessionId) || !LOGICAL_ID_PATTERN.test(binding.runId) ||
      !Number.isSafeInteger(binding.revision) || binding.revision < 0 ||
      !validOpaqueId(entity.id) || entity.planetId !== binding.activePlanetId ||
      entity.kind !== "machine" || entity.buildingId !== "galactic_material_exporter" ||
      entity.interactionLocked || typeof entity.galacticExporterPaused !== "boolean" ||
      typeof paused !== "boolean") {
    throw new TypeError("原生银河出口建筑暂停意图无效");
  }
  if (entity.galacticExporterPaused === paused) return null;
  const command = emptyCommand(binding.revision);
  command.changedEntities = [{
    id: entity.id,
    changes: [{
      path: ["galacticExporter", "pauseIntent"],
      operation: "set",
      value: { paused },
    }],
  }];
  return command;
}
