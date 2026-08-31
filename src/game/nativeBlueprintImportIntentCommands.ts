import {
  nativeBlueprintImportContextSupportsCommand,
  type NativeBlueprintImportContext,
} from "./nativeBlueprintImportContext";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const UTF8_ENCODER = new TextEncoder();

/** Emits only the Rust-prepared, digest-bound import marker; raw exchange text never enters WAL. */
export function createNativeBlueprintImportIntentCommand(
  context: NativeBlueprintImportContext,
): SimulationCommandPatch {
  if (!nativeBlueprintImportContextSupportsCommand(context)) {
    throw new TypeError("原生蓝图导入意图无效");
  }
  const command: SimulationCommandPatch = {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: context.revision,
    topLevelChanges: [{
      path: ["blueprints", "intent"],
      operation: "set",
      value: context.preparedIntent,
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
  let commandBytes = Number.POSITIVE_INFINITY;
  try {
    commandBytes = UTF8_ENCODER.encode(JSON.stringify(command)).byteLength;
  } catch {
    // The verified prepared marker is JSON, but a caller could still forge the
    // in-memory object between type boundaries. Fail closed before dispatch.
  }
  if (commandBytes > context.limits.commandBytes) {
    throw new TypeError("原生蓝图导入命令超过安全上限");
  }
  return command;
}

export function prepareNativeBlueprintImportIntentCommand(
  context: NativeBlueprintImportContext,
  commandSource: Readonly<{
    sessionId: string;
    runId: string;
    baseRevision: number;
  }> | null,
): SimulationCommandPatch | null {
  if (!commandSource || !nativeBlueprintImportContextSupportsCommand(context) ||
      commandSource.sessionId !== context.sessionId || commandSource.runId !== context.runId ||
      commandSource.baseRevision !== context.revision) return null;
  return createNativeBlueprintImportIntentCommand(context);
}
