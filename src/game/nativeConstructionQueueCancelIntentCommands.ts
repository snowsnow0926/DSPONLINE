import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import {
  nativeConstructionQueueCancelBindingMatchesFrame,
  type NativeBlueprintWorkspaceFrame,
  type NativeConstructionQueueCancelBinding,
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

/** Emits only the stable queue entry ID and the expected authority revision. */
export function createNativeConstructionQueueCancelIntentCommand(
  baseRevision: number,
  queueEntryId: string,
): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      baseRevision >= Number.MAX_SAFE_INTEGER || !validOpaqueQueueEntryId(queueEntryId)) {
    throw new TypeError("原生施工队列取消意图无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [{
      path: ["constructionQueue", "intent"],
      operation: "set",
      value: { kind: "cancel", id: queueEntryId, revision: baseRevision },
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

/** Rechecks the visible queue row and exact command lineage just before dispatch. */
export function prepareNativeConstructionQueueCancelIntentCommand(
  binding: NativeConstructionQueueCancelBinding,
  frame: NativeBlueprintWorkspaceFrame | null,
  commandSource: Readonly<{
    sessionId: string;
    runId: string;
    baseRevision: number;
  }> | null,
): SimulationCommandPatch | null {
  if (!frame || !commandSource ||
      !nativeConstructionQueueCancelBindingMatchesFrame(binding, frame) ||
      commandSource.sessionId !== binding.sessionId ||
      commandSource.runId !== binding.runId ||
      commandSource.baseRevision !== binding.revision) return null;
  return createNativeConstructionQueueCancelIntentCommand(binding.revision, binding.queueEntryId);
}
