import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import {
  nativeConstructionQueueFundBindingMatchesFrame,
  type NativeBlueprintWorkspaceFrame,
  type NativeConstructionQueueFundBinding,
  type NativeConstructionQueueFundScope,
} from "./nativeBlueprintWorkspaceStore";

const UTF8_ENCODER = new TextEncoder();
const MAX_QUEUE_ENTRY_ID_BYTES = 512;
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

function validOpaqueQueueEntryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && wellFormedUnicode(value) &&
    UTF8_ENCODER.encode(value).byteLength <= MAX_QUEUE_ENTRY_ID_BYTES &&
    !CONTROL_CHARACTER.test(value);
}

function validScope(value: unknown): value is NativeConstructionQueueFundScope {
  return value === "construction" || value === "fleet" || value === "all";
}

/** Emits only the stable row ID, requested scope, and expected authority revision. */
export function createNativeConstructionQueueFundIntentCommand(
  baseRevision: number,
  queueEntryId: string,
  scope: NativeConstructionQueueFundScope,
): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      baseRevision >= Number.MAX_SAFE_INTEGER || !validOpaqueQueueEntryId(queueEntryId) ||
      !validScope(scope)) {
    throw new TypeError("原生施工队列领料意图无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [{
      path: ["constructionQueue", "intent"],
      operation: "set",
      value: { kind: "fund", id: queueEntryId, scope, revision: baseRevision },
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

/** Rechecks the exact visible pending row and command lineage just before dispatch. */
export function prepareNativeConstructionQueueFundIntentCommand(
  binding: NativeConstructionQueueFundBinding,
  scope: NativeConstructionQueueFundScope,
  frame: NativeBlueprintWorkspaceFrame | null,
  commandSource: Readonly<{
    sessionId: string;
    runId: string;
    baseRevision: number;
  }> | null,
): SimulationCommandPatch | null {
  if (!frame || !commandSource || !validScope(scope) ||
      !nativeConstructionQueueFundBindingMatchesFrame(binding, frame) ||
      commandSource.sessionId !== binding.sessionId ||
      commandSource.runId !== binding.runId ||
      commandSource.baseRevision !== binding.revision) return null;
  return createNativeConstructionQueueFundIntentCommand(
    binding.revision,
    binding.queueEntryId,
    scope,
  );
}

