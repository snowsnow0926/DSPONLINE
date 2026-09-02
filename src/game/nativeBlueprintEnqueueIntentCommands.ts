import {
  nativeBlueprintEnqueueContextSupportsCommand,
  type NativeBlueprintEnqueueContext,
} from "./nativeBlueprintEnqueueContext";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

export interface NativeBlueprintEnqueuePosition {
  readonly x: number;
  readonly y: number;
}

function validPosition(position: NativeBlueprintEnqueuePosition): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y);
}

/**
 * Emits only the exact blueprint row identity and untrusted finite canvas
 * coordinates. Planet, queue ID, transform, version and blueprint body remain
 * Rust-owned and never cross the mutation boundary.
 */
export function createNativeBlueprintEnqueueIntentCommand(
  context: NativeBlueprintEnqueueContext,
  position: NativeBlueprintEnqueuePosition,
): SimulationCommandPatch {
  if (!nativeBlueprintEnqueueContextSupportsCommand(context) || !validPosition(position)) {
    throw new TypeError("原生蓝图入队意图无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: context.revision,
    topLevelChanges: [{
      path: ["constructionQueue", "intent"],
      operation: "set",
      value: {
        kind: "enqueue",
        blueprintId: context.request.blueprintId,
        blueprintRevision: context.request.blueprintRevision,
        position: { x: position.x, y: position.y },
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

export function prepareNativeBlueprintEnqueueIntentCommand(
  context: NativeBlueprintEnqueueContext,
  position: NativeBlueprintEnqueuePosition,
  commandSource: Readonly<{
    sessionId: string;
    runId: string;
    baseRevision: number;
  }> | null,
): SimulationCommandPatch | null {
  if (!commandSource || !nativeBlueprintEnqueueContextSupportsCommand(context) ||
      commandSource.sessionId !== context.sessionId ||
      commandSource.runId !== context.runId ||
      commandSource.baseRevision !== context.revision || !validPosition(position)) return null;
  return createNativeBlueprintEnqueueIntentCommand(context, position);
}
