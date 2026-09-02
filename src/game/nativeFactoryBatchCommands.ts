import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const MAX_ENTITY_ROWS = 4_096;
const MAX_BELT_ROWS = 8_192;
const MAX_OPAQUE_ID_BYTES = 512;
const MAX_DURABLE_COMMAND_BYTES = 1_750_000;
const textEncoder = new TextEncoder();

export type NativeFactoryBatchIntent =
  | Readonly<{ kind: "increase"; entityIds: readonly string[]; beltIds: readonly string[]; amount: number }>
  | Readonly<{ kind: "remove"; entityIds: readonly string[]; beltIds: readonly string[] }>
  | Readonly<{ kind: "upgrade-buildings"; entityIds: readonly string[]; beltIds?: readonly [] }>
  | Readonly<{ kind: "upgrade-belts"; entityIds?: readonly []; beltIds: readonly string[] }>;

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function validateIds(values: readonly string[], limit: number, label: string): string[] {
  if (!Array.isArray(values) || values.length > limit || new Set(values).size !== values.length ||
      values.some((value) => typeof value !== "string" || value.length < 1 ||
        !wellFormedUnicode(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
        textEncoder.encode(value).byteLength > MAX_OPAQUE_ID_BYTES)) {
    throw new TypeError(`原生批量命令${label}范围无效`);
  }
  return [...values];
}

/**
 * Encode one selection-wide semantic mutation.  No renderer-derived price,
 * refund, stack target or upgraded tier is included; Rust calculates those
 * facts again at the exact durable base revision.
 */
export function createNativeFactoryBatchCommand(
  baseRevision: number,
  intent: NativeFactoryBatchIntent,
): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || baseRevision >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError("原生批量命令 revision 无效");
  }
  const entityIds = validateIds(intent.entityIds ?? [], MAX_ENTITY_ROWS, "建筑");
  const beltIds = validateIds(intent.beltIds ?? [], MAX_BELT_ROWS, "线路");
  if (entityIds.length === 0 && beltIds.length === 0) throw new TypeError("原生批量命令范围为空");
  if (intent.kind === "upgrade-buildings" && (entityIds.length === 0 || beltIds.length > 0) ||
      intent.kind === "upgrade-belts" && (beltIds.length === 0 || entityIds.length > 0)) {
    throw new TypeError("原生批量升级范围无效");
  }
  const amount = intent.kind === "increase" ? intent.amount : undefined;
  if (intent.kind === "increase" && (!Number.isSafeInteger(amount) || amount! < 1 || amount! > 1_000_000)) {
    throw new TypeError("原生批量增加量无效");
  }
  const command: SimulationCommandPatch = {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [{
      path: ["factoryBatch", "intent"],
      operation: "set",
      value: {
        kind: intent.kind,
        entityIds,
        beltIds,
        ...(amount === undefined ? {} : { amount }),
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
    throw new TypeError("原生批量命令超过 durable 上限");
  }
  return command;
}

