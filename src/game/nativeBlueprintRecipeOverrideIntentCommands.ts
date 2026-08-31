import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import {
  nativeBlueprintRecipeOverrideBindingMatchesFrame,
  type NativeBlueprintRecipeOverrideBinding,
  type NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";

const UTF8_ENCODER = new TextEncoder();
const MAX_OPAQUE_ID_BYTES = 512;
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

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && wellFormedUnicode(value) &&
    UTF8_ENCODER.encode(value).byteLength <= MAX_OPAQUE_ID_BYTES &&
    !CONTROL_CHARACTER.test(value);
}

/** Emits one semantic marker; no blueprint body, catalog, or override map crosses IPC. */
export function createNativeBlueprintRecipeOverrideIntentCommand(
  baseRevision: number,
  blueprintId: string,
  sourceRecipeId: string,
  targetRecipeId: string,
): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      baseRevision >= Number.MAX_SAFE_INTEGER || !validOpaqueId(blueprintId) ||
      !validOpaqueId(sourceRecipeId) || !validOpaqueId(targetRecipeId)) {
    throw new TypeError("原生蓝图配方覆盖意图无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [{
      path: ["blueprints", "intent"],
      operation: "set",
      value: {
        kind: "recipe-override",
        id: blueprintId,
        sourceRecipeId,
        targetRecipeId,
      },
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

export function prepareNativeBlueprintRecipeOverrideIntentCommand(
  binding: NativeBlueprintRecipeOverrideBinding,
  targetRecipeId: string,
  frame: NativeBlueprintWorkspaceFrame | null,
  commandSource: Readonly<{
    sessionId: string;
    runId: string;
    baseRevision: number;
  }> | null,
): SimulationCommandPatch | null {
  if (!frame || !commandSource || !validOpaqueId(targetRecipeId) ||
      !nativeBlueprintRecipeOverrideBindingMatchesFrame(binding, frame) ||
      commandSource.sessionId !== binding.sessionId ||
      commandSource.runId !== binding.runId ||
      commandSource.baseRevision !== binding.revision ||
      targetRecipeId === binding.currentTargetRecipeId) return null;
  const group = frame.detail?.recipeOverrideGroups.find((candidate) =>
    candidate.sourceRecipeId === binding.sourceRecipeId);
  if (!group?.options.some((option) => option.id === targetRecipeId)) return null;
  return createNativeBlueprintRecipeOverrideIntentCommand(
    binding.revision,
    binding.blueprintId,
    binding.sourceRecipeId,
    targetRecipeId,
  );
}
