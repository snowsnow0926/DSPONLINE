import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { ConstructionAutomationTargetId } from "./types";

const TEXT_ENCODER = new TextEncoder();
const MAX_PLAYER_TARGET_ID_BYTES = 160;
const MAX_CONSTRUCTION_AUTOMATION_TARGET = 100_000_000;

function validTargetId(value: unknown): value is ConstructionAutomationTargetId {
  return typeof value === "string" && value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_PLAYER_TARGET_ID_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function emptyCommand(baseRevision: number): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new TypeError("原生建筑制造中心命令版本无效");
  }
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

function booleanIntentCommand(
  baseRevision: number,
  kind: "enabled" | "quantumSupplyEnabled",
  enabled: boolean,
): SimulationCommandPatch {
  if (typeof enabled !== "boolean") {
    throw new TypeError("原生建筑制造中心开关意图无效");
  }
  const command = emptyCommand(baseRevision);
  command.topLevelChanges = [{
    path: ["constructionAutomation", "intent"],
    operation: "set",
    value: { kind, enabled },
  }];
  return command;
}

/** Rust re-reads the current v47 policy and expands only the durable enabled leaf. */
export function createNativeConstructionAutomationEnabledIntentCommand(
  baseRevision: number,
  enabled: boolean,
): SimulationCommandPatch {
  return booleanIntentCommand(baseRevision, "enabled", enabled);
}

/** Rust proves the built-in quantum network and writes/deletes the sparse v47 source flag. */
export function createNativeConstructionAutomationQuantumSupplyIntentCommand(
  baseRevision: number,
  enabled: boolean,
): SimulationCommandPatch {
  return booleanIntentCommand(baseRevision, "quantumSupplyEnabled", enabled);
}

/**
 * Sends one target ID and integer only. Rust owns catalog, technology, mode and
 * stock-limit validation and preserves every unrelated target/job/inventory.
 */
export function createNativeConstructionAutomationTargetStockIntentCommand(
  baseRevision: number,
  targetId: ConstructionAutomationTargetId,
  target: number,
): SimulationCommandPatch {
  if (!validTargetId(targetId) || !Number.isSafeInteger(target) || target < 0 ||
      target > MAX_CONSTRUCTION_AUTOMATION_TARGET) {
    throw new TypeError("原生建筑制造中心目标意图无效");
  }
  const command = emptyCommand(baseRevision);
  command.topLevelChanges = [{
    path: ["constructionAutomation", "intent"],
    operation: "set",
    value: { kind: "targetStock", targetId, target },
  }];
  return command;
}

/**
 * Sends one integer policy only. Rust derives the complete set of unlocked
 * built-in building targets from the same authoritative v47 revision; the
 * renderer never supplies a target-ID list or any inventory/job state.
 */
export function createNativeConstructionAutomationBatchBuildingTargetStockIntentCommand(
  baseRevision: number,
  target: number,
): SimulationCommandPatch {
  if (!Number.isSafeInteger(target) || target < 1 ||
      target > MAX_CONSTRUCTION_AUTOMATION_TARGET) {
    throw new TypeError("原生建筑制造中心批量建筑目标意图无效");
  }
  const command = emptyCommand(baseRevision);
  command.topLevelChanges = [{
    path: ["constructionAutomation", "intent"],
    operation: "set",
    value: { kind: "batchBuildingTargetStock", target },
  }];
  return command;
}
