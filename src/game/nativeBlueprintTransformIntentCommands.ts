import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import {
  nativeBlueprintTransformBindingMatchesFrame,
  type NativeBlueprintMirror,
  type NativeBlueprintRotation,
  type NativeBlueprintTransformBinding,
  type NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";

const UTF8_ENCODER = new TextEncoder();
const MAX_BLUEPRINT_ID_BYTES = 512;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validOpaqueBlueprintId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && wellFormedUnicode(value) &&
    UTF8_ENCODER.encode(value).byteLength <= MAX_BLUEPRINT_ID_BYTES &&
    !CONTROL_CHARACTER.test(value);
}

function validRotation(value: unknown): value is NativeBlueprintRotation {
  return Number.isInteger(value) && [0, 90, 180, 270].includes(value as number);
}

function validMirror(value: unknown): value is NativeBlueprintMirror {
  return value === "none" || value === "horizontal";
}

/** Emits exactly one target-state transform marker and no blueprint body. */
export function createNativeBlueprintTransformIntentCommand(
  baseRevision: number,
  id: string,
  rotation: NativeBlueprintRotation,
  mirror: NativeBlueprintMirror,
): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      baseRevision >= Number.MAX_SAFE_INTEGER ||
      !validOpaqueBlueprintId(id) || !validRotation(rotation) || !validMirror(mirror)) {
    throw new TypeError("原生蓝图变换意图无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [{
      path: ["blueprints", "intent"],
      operation: "set",
      value: { kind: "transform", id, rotation, mirror },
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

/**
 * Rechecks the exact selected row and current authority revision immediately
 * before dispatch. The target pair is explicit and a target-state no-op is
 * rejected rather than turned into a revision-only write.
 */
export function prepareNativeBlueprintTransformIntentCommand(
  binding: NativeBlueprintTransformBinding,
  rotation: NativeBlueprintRotation,
  mirror: NativeBlueprintMirror,
  frame: NativeBlueprintWorkspaceFrame | null,
  commandSource: Readonly<{
    sessionId: string;
    runId: string;
    baseRevision: number;
  }> | null,
): SimulationCommandPatch | null {
  if (!frame || !commandSource ||
      !nativeBlueprintTransformBindingMatchesFrame(binding, frame) ||
      commandSource.sessionId !== binding.sessionId ||
      commandSource.runId !== binding.runId ||
      commandSource.baseRevision !== binding.revision ||
      !validRotation(rotation) || !validMirror(mirror) ||
      rotation === binding.currentRotation && mirror === binding.currentMirror) return null;
  return createNativeBlueprintTransformIntentCommand(
    binding.revision,
    binding.blueprintId,
    rotation,
    mirror,
  );
}
