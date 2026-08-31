import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import {
  nativeConstructionQueueDeployBindingMatchesFrame,
  type NativeBlueprintWorkspaceFrame,
  type NativeConstructionQueueDeployBinding,
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

/** Emits only the Rust-owned queue ID and expected authority revision. */
export function createNativeConstructionQueueDeployIntentCommand(
  baseRevision: number,
  queueEntryId: string,
): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      baseRevision >= Number.MAX_SAFE_INTEGER || !validOpaqueQueueEntryId(queueEntryId)) {
    throw new TypeError("原生施工队列部署意图无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [{
      path: ["constructionQueue", "intent"],
      operation: "set",
      value: { kind: "deploy", id: queueEntryId, revision: baseRevision },
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

/** Rechecks the exact Rust-ready visible row immediately before dispatch. */
export function prepareNativeConstructionQueueDeployIntentCommand(
  binding: NativeConstructionQueueDeployBinding,
  frame: NativeBlueprintWorkspaceFrame | null,
  commandSource: Readonly<{
    sessionId: string;
    runId: string;
    baseRevision: number;
  }> | null,
): SimulationCommandPatch | null {
  if (!frame || !commandSource ||
      !nativeConstructionQueueDeployBindingMatchesFrame(binding, frame) ||
      commandSource.sessionId !== binding.sessionId ||
      commandSource.runId !== binding.runId ||
      commandSource.baseRevision !== binding.revision) return null;
  return createNativeConstructionQueueDeployIntentCommand(binding.revision, binding.queueEntryId);
}
