import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const MAX_SELECTION_ROWS = 4_096;
const MAX_OPAQUE_ID_BYTES = 512;
const MAX_DURABLE_COMMAND_BYTES = 1_750_000;
const textEncoder = new TextEncoder();

function validateBaseRevision(baseRevision: number): void {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      baseRevision >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError("原生自动布局命令 revision 无效");
  }
}

function hasWellFormedUnicode(value: string): boolean {
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

function validOpaqueEntityId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    hasWellFormedUnicode(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    textEncoder.encode(value).byteLength <= MAX_OPAQUE_ID_BYTES;
}

/**
 * Creates one compact semantic layout intent. Coordinates, locks, active
 * planet and the complete belt graph remain Rust-owned and are re-derived at
 * the exact durable base revision.
 */
export function createNativeFactoryAutoLayoutCommand(
  baseRevision: number,
  entityIds?: readonly string[],
): SimulationCommandPatch {
  validateBaseRevision(baseRevision);
  const selection = entityIds?.length ? [...entityIds] : [];
  if (selection.length > MAX_SELECTION_ROWS ||
      selection.some((entityId) => !validOpaqueEntityId(entityId)) ||
      new Set(selection).size !== selection.length) {
    throw new TypeError("原生自动布局命令建筑范围无效");
  }
  const command: SimulationCommandPatch = {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [{
      path: ["factoryAutoLayout", "intent"],
      operation: "set",
      value: {
        kind: "apply",
        scope: selection.length > 0 ? "selection" : "all",
        entityIds: selection,
      },
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
  if (textEncoder.encode(JSON.stringify(command)).byteLength > MAX_DURABLE_COMMAND_BYTES) {
    throw new TypeError("原生自动布局命令超过 durable 上限");
  }
  return command;
}
