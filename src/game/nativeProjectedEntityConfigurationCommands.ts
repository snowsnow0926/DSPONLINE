import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { FactoryEntity, PlanetId, PowerPriority } from "./types";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_LOGICAL_ID_BYTES = 256;
const MAX_OPAQUE_ID_BYTES = 512;
const TEXT_ENCODER = new TextEncoder();

const BUILTIN_POWER_PRIORITY_BUILDINGS = new Set([
  "arc_smelter",
  "assembling_machine_mk1",
  "assembling_machine_mk2",
  "assembling_machine_mk3",
  "chemical_plant",
  "em_rail_ejector",
  "fractionator",
  "matrix_lab",
  "miniature_particle_collider",
  "oil_refinery",
  "plane_smelter",
  "quantum_chemical_plant",
  "spray_coater",
  "vertical_launching_silo",
]);

export type NativeProjectedSplitterDistributionMode = "balanced" | "priority";

/**
 * One full entity row pinned into the bounded native canvas projection. The
 * identity belongs to the same Rust revision; callers must discard this atom
 * as soon as any member changes.
 */
export interface NativeProjectedEntityConfigurationBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly activePlanetId: PlanetId;
  readonly entity: FactoryEntity;
}

function validLogicalId(value: unknown): value is string {
  return typeof value === "string" && LOGICAL_ID_PATTERN.test(value) &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_LOGICAL_ID_BYTES;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_OPAQUE_ID_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validBindingBase(binding: NativeProjectedEntityConfigurationBinding): boolean {
  return validLogicalId(binding.sessionId) && validLogicalId(binding.runId) &&
    Number.isSafeInteger(binding.revision) && binding.revision >= 0 &&
    validOpaqueId(binding.activePlanetId) && validOpaqueId(binding.entity.id) &&
    binding.entity.planetId === binding.activePlanetId &&
    typeof binding.entity.interactionLocked === "boolean" && !binding.entity.interactionLocked;
}

/** Returns null for every stale, malformed, foreign-planet or unsupported row. */
export function getNativeProjectedPowerPriority(
  binding: NativeProjectedEntityConfigurationBinding | null,
): PowerPriority | null {
  if (!binding || !validBindingBase(binding) || binding.entity.kind !== "machine" ||
      !binding.entity.buildingId ||
      !BUILTIN_POWER_PRIORITY_BUILDINGS.has(binding.entity.buildingId)) return null;
  const priority = binding.entity.powerPriority ?? 2;
  return priority === 1 || priority === 2 || priority === 3 ? priority : null;
}

/** Returns null unless the row is the built-in four-way splitter. */
export function getNativeProjectedSplitterDistributionMode(
  binding: NativeProjectedEntityConfigurationBinding | null,
): NativeProjectedSplitterDistributionMode | null {
  if (!binding || !validBindingBase(binding) || binding.entity.kind !== "splitter" ||
      binding.entity.buildingId !== "splitter_4way") return null;
  const mode = binding.entity.distributionMode ?? "balanced";
  return mode === "balanced" || mode === "priority" ? mode : null;
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

/** Builds exactly one built-in ordinary consumer power-priority leaf. */
export function createNativeProjectedEntityPowerPriorityCommand(
  binding: NativeProjectedEntityConfigurationBinding,
  targetPriority: PowerPriority,
): SimulationCommandPatch | null {
  const current = getNativeProjectedPowerPriority(binding);
  if (current === null || (targetPriority !== 1 && targetPriority !== 2 && targetPriority !== 3)) {
    throw new TypeError("原生建筑供电优先级投影无效或不受支持");
  }
  if (current === targetPriority) return null;
  const command = emptyCommand(binding.revision);
  command.changedEntities = [{
    id: binding.entity.id,
    changes: [{ path: ["powerPriority"], operation: "set", value: targetPriority }],
  }];
  return command;
}

/** Builds exactly one built-in splitter distribution-mode leaf. */
export function createNativeProjectedSplitterDistributionModeCommand(
  binding: NativeProjectedEntityConfigurationBinding,
  targetMode: NativeProjectedSplitterDistributionMode,
): SimulationCommandPatch | null {
  const current = getNativeProjectedSplitterDistributionMode(binding);
  if (current === null || (targetMode !== "balanced" && targetMode !== "priority")) {
    throw new TypeError("原生分流器模式投影无效或不受支持");
  }
  if (current === targetMode) return null;
  const command = emptyCommand(binding.revision);
  command.changedEntities = [{
    id: binding.entity.id,
    changes: [{ path: ["distributionMode"], operation: "set", value: targetMode }],
  }];
  return command;
}
