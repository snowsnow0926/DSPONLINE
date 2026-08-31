import {
  nativeBlueprintDirectDeployContextSupportsCommand,
  type NativeBlueprintDirectDeployContext,
} from "./nativeBlueprintDirectDeployContext";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

export interface NativeBlueprintDirectDeployPosition {
  readonly x: number;
  readonly y: number;
}

function validPosition(position: NativeBlueprintDirectDeployPosition): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y);
}

/**
 * Emits only the exact blueprint row identity, finite placement point and
 * expected revision. Rust derives every material, allocator and topology
 * effect from its authoritative v47 state.
 */
export function createNativeBlueprintDirectDeployIntentCommand(
  context: NativeBlueprintDirectDeployContext,
): SimulationCommandPatch {
  if (!nativeBlueprintDirectDeployContextSupportsCommand(context) ||
      !validPosition(context.request.position)) {
    throw new TypeError("原生蓝图直接部署意图无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: context.revision,
    topLevelChanges: [{
      path: ["constructionQueue", "intent"],
      operation: "set",
      value: {
        kind: "direct-deploy",
        blueprintId: context.request.blueprintId,
        blueprintRevision: context.request.blueprintRevision,
        position: {
          x: context.request.position.x,
          y: context.request.position.y,
        },
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

export function prepareNativeBlueprintDirectDeployIntentCommand(
  context: NativeBlueprintDirectDeployContext,
  commandSource: Readonly<{
    sessionId: string;
    runId: string;
    baseRevision: number;
  }> | null,
): SimulationCommandPatch | null {
  if (!commandSource || !nativeBlueprintDirectDeployContextSupportsCommand(context) ||
      commandSource.sessionId !== context.sessionId ||
      commandSource.runId !== context.runId ||
      commandSource.baseRevision !== context.revision) return null;
  return createNativeBlueprintDirectDeployIntentCommand(context);
}
