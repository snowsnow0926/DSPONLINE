import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import {
  nativeBlueprintDeleteBindingMatchesFrame,
  type NativeBlueprintDeleteBinding,
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

/** Emits exactly one compare-and-delete marker and no blueprint body. */
export function createNativeBlueprintDeleteIntentCommand(
  baseRevision: number,
  id: string,
  currentRowRevision: number,
): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      baseRevision >= Number.MAX_SAFE_INTEGER || !validOpaqueBlueprintId(id) ||
      !Number.isSafeInteger(currentRowRevision) || currentRowRevision < 1 ||
      currentRowRevision > Number.MAX_SAFE_INTEGER) {
    throw new TypeError("原生蓝图删除意图无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [{
      path: ["blueprints", "intent"],
      operation: "set",
      value: { kind: "delete", id, revision: currentRowRevision },
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

/** Rechecks the exact selected row and authority source immediately before dispatch. */
export function prepareNativeBlueprintDeleteIntentCommand(
  binding: NativeBlueprintDeleteBinding,
  frame: NativeBlueprintWorkspaceFrame | null,
  commandSource: Readonly<{
    sessionId: string;
    runId: string;
    baseRevision: number;
  }> | null,
): SimulationCommandPatch | null {
  if (!frame || !commandSource ||
      !nativeBlueprintDeleteBindingMatchesFrame(binding, frame) ||
      commandSource.sessionId !== binding.sessionId ||
      commandSource.runId !== binding.runId ||
      commandSource.baseRevision !== binding.revision) return null;
  return createNativeBlueprintDeleteIntentCommand(
    binding.revision,
    binding.blueprintId,
    binding.currentRowRevision,
  );
}
