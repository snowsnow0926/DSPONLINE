import {
  nativeBlueprintCaptureContextSupportsCommand,
  type NativeBlueprintCaptureContext,
} from "./nativeBlueprintCaptureContext";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

/**
 * Emits only the ordered native selection and expected authority revision.
 * Rust derives the blueprint ID, name, row body, belts and all allocator state.
 */
export function createNativeBlueprintCaptureIntentCommand(
  context: NativeBlueprintCaptureContext,
): SimulationCommandPatch {
  if (!nativeBlueprintCaptureContextSupportsCommand(context)) {
    throw new TypeError("原生蓝图捕获意图无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: context.revision,
    topLevelChanges: [{
      path: ["blueprints", "intent"],
      operation: "set",
      value: {
        kind: "capture",
        entityIds: [...context.request.entityIds],
        revision: context.revision,
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

export function prepareNativeBlueprintCaptureIntentCommand(
  context: NativeBlueprintCaptureContext,
  commandSource: Readonly<{
    sessionId: string;
    runId: string;
    baseRevision: number;
  }> | null,
): SimulationCommandPatch | null {
  if (!commandSource || !nativeBlueprintCaptureContextSupportsCommand(context) ||
      commandSource.sessionId !== context.sessionId || commandSource.runId !== context.runId ||
      commandSource.baseRevision !== context.revision) return null;
  return createNativeBlueprintCaptureIntentCommand(context);
}
