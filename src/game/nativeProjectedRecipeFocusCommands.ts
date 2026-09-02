import { ITEMS } from "./content";
import type { NativeFactoryProjectionIdentity } from "./factoryReadModels";
import type { RecipeFocusReadModel } from "./recipeFocusReadModel";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
  type SimulationValuePatch,
} from "./simulationRuntimeProtocol";
import type { ItemId, RecipeFocusMode } from "./types";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const TEXT_ENCODER = new TextEncoder();

function validLogicalId(value: unknown): value is string {
  return typeof value === "string" && LOGICAL_ID_PATTERN.test(value) &&
    TEXT_ENCODER.encode(value).byteLength <= 256;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validItemId(value: unknown): value is ItemId {
  return typeof value === "string" && Object.hasOwn(ITEMS, value);
}

function validMode(value: unknown): value is RecipeFocusMode {
  return value === "two-level" || value === "full";
}

function validCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 8;
}

function validateBinding(
  identity: NativeFactoryProjectionIdentity,
  model: RecipeFocusReadModel,
): void {
  if (!validLogicalId(identity.sessionId) || !validLogicalId(identity.runId) ||
      !validOpaqueId(identity.planetId) || !Number.isSafeInteger(identity.revision) ||
      identity.revision < 0 || model.schema !== "recipe-focus-read-model-v1" ||
      model.source !== "native-core" || model.revision !== identity.revision ||
      model.itemId !== null && !validItemId(model.itemId) || !validMode(model.mode) ||
      !validCoordinate(model.position.x) || !validCoordinate(model.position.y)) {
    throw new TypeError("原生生产链聚焦投影 identity 或内容无效");
  }
}

function command(
  identity: NativeFactoryProjectionIdentity,
  changes: SimulationValuePatch[],
): SimulationCommandPatch | null {
  if (changes.length === 0) return null;
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: identity.revision,
    topLevelChanges: changes,
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

export function createNativeProjectedRecipeFocusItemCommand(
  identity: NativeFactoryProjectionIdentity,
  model: RecipeFocusReadModel,
  targetItemId: ItemId | null,
): SimulationCommandPatch | null {
  validateBinding(identity, model);
  if (targetItemId !== null && !validItemId(targetItemId)) {
    throw new TypeError("原生生产链聚焦物料无效");
  }
  return command(identity, model.itemId === targetItemId ? [] : [{
    path: ["recipeFocus", "itemId"],
    operation: "set",
    value: targetItemId,
  }]);
}

export function createNativeProjectedRecipeFocusModeCommand(
  identity: NativeFactoryProjectionIdentity,
  model: RecipeFocusReadModel,
  targetMode: RecipeFocusMode,
): SimulationCommandPatch | null {
  validateBinding(identity, model);
  if (!validMode(targetMode)) throw new TypeError("原生生产链聚焦层级无效");
  return command(identity, model.mode === targetMode ? [] : [{
    path: ["recipeFocus", "mode"],
    operation: "set",
    value: targetMode,
  }]);
}

export function createNativeProjectedRecipeFocusPositionCommand(
  identity: NativeFactoryProjectionIdentity,
  model: RecipeFocusReadModel,
  target: Readonly<{ x: number; y: number }>,
): SimulationCommandPatch | null {
  validateBinding(identity, model);
  if (!validCoordinate(target.x) || !validCoordinate(target.y)) {
    throw new TypeError("原生生产链聚焦位置无效");
  }
  const changes: SimulationValuePatch[] = [];
  if (target.x !== model.position.x) changes.push({
    path: ["recipeFocus", "position", "x"], operation: "set", value: target.x,
  });
  if (target.y !== model.position.y) changes.push({
    path: ["recipeFocus", "position", "y"], operation: "set", value: target.y,
  });
  return command(identity, changes);
}
