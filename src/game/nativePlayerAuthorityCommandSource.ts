import type {
  DesktopBridge,
  DesktopNativeCoreCommandResult,
  DesktopNativePlayerAuthorityClockState,
  DesktopNativePlayerAuthorityState,
} from "../desktop";
import {
  normalizeNativePlayerAuthorityClockFrame,
} from "./nativePlayerAuthorityClock";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
  type SimulationValuePatch,
} from "./simulationRuntimeProtocol";

const COMMAND_KEYS = Object.freeze([
  "protocolVersion",
  "baseRevision",
  "topLevelChanges",
  "changedEntities",
  "addedEntities",
  "removedEntityIds",
  "changedBelts",
  "addedBelts",
  "removedBeltIds",
] as const);
const RECEIPT_KEYS = Object.freeze([
  "previousRevision",
  "revision",
  "changedEntityIds",
  "changedBeltIds",
  "topologyDirty",
] as const);
const MAX_DURABLE_COMMAND_BYTES = 1_750_000;
const MAX_CHANGED_IDS = 65_536;
const MAX_VALUE_PATCHES = 65_536;
const MAX_RECORD_CHANGES = 16_384;
const MAX_PATCH_PATH_DEPTH = 64;
const MAX_OPAQUE_ID_BYTES = 512;
const MAX_PATH_KEY_BYTES = 512;
const MAX_JSON_DEPTH = 96;
const COMMAND_ID_PATTERN = /^renderer-local-[0-9a-z]+-[0-9a-z]+$/;
const MAX_COMMAND_ID_BYTES = 96;

const SAFE_TOP_LEVEL_PROJECTION_ROOTS = new Set([
  "paused",
  "elapsedSeconds",
  "lastSavedAt",
  "totalProduced",
  "productionHistory",
  "metrics",
  "planetMetrics",
  "powerGridMetrics",
  "canvasBookmarks",
  "canvasRegions",
  "timeWarp",
  "idleSettlement",
]);
const SAFE_ENTITY_PROJECTION_ROOTS = new Set([
  "position",
  "inputs",
  "outputs",
  "progress",
  "routingCursor",
  "utilization",
  "productionRate",
  "powerFactor",
  "stationProgress",
  "stationTrips",
  "stationLastTransfer",
  "stationDrones",
  "stationVessels",
  "stationWarpers",
  "stationCongestion",
  "stationDispatchCursor",
  "stationLastSupplyPeerBySlot",
  "stationRoutes",
  "fuelRemainingMj",
  "powerOutputKw",
  "powerInputKw",
  "storedEnergyMj",
  "orbitalCargoProgress",
  "orbitalCargoTotalUploaded",
  "blackHolePorts",
  "proliferatorBonusProgress",
]);
const SAFE_BELT_PROJECTION_ROOTS = new Set([
  "progress",
  "totalTransferred",
  "congestion",
  "lastFlow",
  "monitorEnabled",
]);

const textEncoder = new TextEncoder();
let nextLocalCommandSequence = 0;

export type NativePlayerAuthorityCommandSourceErrorCode =
  | "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE"
  | "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_BUSY"
  | "NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID"
  | "NATIVE_PLAYER_AUTHORITY_COMMAND_REVISION_MISMATCH"
  | "NATIVE_PLAYER_AUTHORITY_COMMAND_FRAME_STALE"
  | "NATIVE_PLAYER_AUTHORITY_COMMAND_TRANSPORT_UNCERTAIN"
  | "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID";

export class NativePlayerAuthorityCommandSourceError extends Error {
  readonly code: NativePlayerAuthorityCommandSourceErrorCode;
  /** Renderer-local correlation only. It never crosses the desktop bridge. */
  readonly commandId: string | null;

  constructor(
    message: string,
    code: NativePlayerAuthorityCommandSourceErrorCode,
    commandId: string | null = null,
  ) {
    super(message);
    this.name = "NativePlayerAuthorityCommandSourceError";
    this.code = code;
    this.commandId = commandId;
  }
}

export interface NativePlayerAuthorityCommandReceipt extends Omit<
  DesktopNativeCoreCommandResult,
  "changedEntityIds" | "changedBeltIds"
> {
  /**
   * Renderer-local invocation identity. Main derives and owns the durable
   * command ID; this value is never sent through `applyNativeCoreCommand`.
   */
  readonly commandId: string;
  readonly changedEntityIds: readonly string[];
  readonly changedBeltIds: readonly string[];
}

export interface NativePlayerAuthorityCommandSource {
  readonly sessionId: string;
  readonly runId: string;
  readonly baseRevision: number;
  /**
   * One exact active frame admits at most one mutation. Success, stale state,
   * or any uncertain transport outcome consumes the source permanently.
   */
  applyCommand(command: SimulationCommandPatch): Promise<NativePlayerAuthorityCommandReceipt>;
  /** Read-only main receipt lookup; never dispatches or retries the command. */
  reconcileCommand(
    command: SimulationCommandPatch,
  ): Promise<NativePlayerAuthorityCommandReconciliationOutcome>;
}

export type NativePlayerAuthorityCommandReconciliationOutcome = Readonly<
  | { status: "committed"; receipt: DesktopNativeCoreCommandResult }
  | {
    status: "pending" | "not-committed" | "conflict";
    baseRevision: number;
    currentRevision: number;
  }
  | { status: "unavailable" }
>;

type NativePlayerAuthorityCommandBridge = Pick<
  DesktopBridge,
  "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand"
>;

interface NormalizedCommand {
  readonly command: SimulationCommandPatch;
  readonly changedEntityIds: readonly string[];
  readonly changedBeltIds: readonly string[];
  readonly topologyDirty: boolean;
}

function sourceError(
  code: NativePlayerAuthorityCommandSourceErrorCode,
  message: string,
  commandId: string | null = null,
): NativePlayerAuthorityCommandSourceError {
  return new NativePlayerAuthorityCommandSourceError(message, code, commandId);
}

function withCommandId(
  error: NativePlayerAuthorityCommandSourceError,
  commandId: string | null,
): NativePlayerAuthorityCommandSourceError {
  return commandId !== null && error.commandId === null
    ? sourceError(error.code, error.message, commandId)
    : error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every(
    (key) => typeof key === "string" && expected.includes(key),
  ) && expected.every((key) => Object.hasOwn(value, key));
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validBoundedString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") &&
    hasWellFormedUnicode(value) && textEncoder.encode(value).byteLength <= maximumBytes;
}

function requireOpaqueId(value: unknown, label: string): string {
  if (!validBoundedString(value, MAX_OPAQUE_ID_BYTES)) {
    throw sourceError(
      "NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID",
      `${label} 包含非法 ID`,
    );
  }
  return value;
}

function assertJsonValue(
  value: unknown,
  label: string,
  depth = 0,
  ancestors: Set<object> = new Set(),
  allowOmittedObjectValues = false,
): void {
  if (depth > MAX_JSON_DEPTH) {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} 嵌套过深`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} 包含非有限数值`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} 不是 JSON 值`);
  }
  if (ancestors.has(value)) {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} 包含循环引用`);
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} 包含非普通对象`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry === undefined) {
        throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} 数组包含空值`);
      }
      assertJsonValue(entry, label, depth + 1, ancestors, allowOmittedObjectValues);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} 包含符号键`);
      }
      const entry = value[key];
      if (entry === undefined && allowOmittedObjectValues) continue;
      assertJsonValue(entry, label, depth + 1, ancestors, allowOmittedObjectValues);
    }
  }
  ancestors.delete(value);
}

function assertPatchPath(path: unknown, label: string): asserts path is Array<string | number> {
  if (!Array.isArray(path) || path.length < 1 || path.length > MAX_PATCH_PATH_DEPTH) {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} 路径非法`);
  }
  for (const segment of path) {
    if (typeof segment === "string") {
      if (!validBoundedString(segment, MAX_PATH_KEY_BYTES)) {
        throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} 路径键非法`);
      }
    } else if (!Number.isSafeInteger(segment) || segment < 0) {
      throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} 路径索引非法`);
    }
  }
}

function assertValuePatch(value: unknown, label: string): asserts value is SimulationValuePatch {
  if (!isRecord(value) || typeof value.operation !== "string" ||
    !["set", "delete"].includes(value.operation)) {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} 结构非法`);
  }
  const expectedKeys = value.operation === "set"
    ? ["path", "operation", "value"]
    : ["path", "operation"];
  if (!hasExactKeys(value, expectedKeys)) {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} 字段非法`);
  }
  assertPatchPath(value.path, label);
  // The existing TS diff represents deletion of an optional object field as
  // an own `value: undefined` on a `set` patch. Accept only that exact shape;
  // normalize it to an explicit wire `delete` before JSON serialization.
  if (value.operation === "set") {
    if (value.value === undefined) {
      if (typeof value.path[value.path.length - 1] !== "string") {
        throw sourceError(
          "NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID",
          `${label} 不能删除数组成员`,
        );
      }
    } else {
      assertJsonValue(value.value, `${label}.value`);
    }
  }
}

function canonicalizeValuePatchForWire(change: SimulationValuePatch): SimulationValuePatch {
  if (change.operation === "set" && change.value === undefined) {
    return { path: [...change.path], operation: "delete" };
  }
  return change.operation === "set"
    ? { path: [...change.path], operation: "set", value: change.value }
    : { path: [...change.path], operation: "delete" };
}

function canonicalizeCommandForWire(command: SimulationCommandPatch): SimulationCommandPatch {
  return {
    protocolVersion: command.protocolVersion,
    baseRevision: command.baseRevision,
    topLevelChanges: command.topLevelChanges.map(canonicalizeValuePatchForWire),
    changedEntities: command.changedEntities.map((record) => ({
      id: record.id,
      changes: record.changes.map(canonicalizeValuePatchForWire),
    })),
    addedEntities: command.addedEntities,
    removedEntityIds: command.removedEntityIds,
    changedBelts: command.changedBelts.map((record) => ({
      id: record.id,
      changes: record.changes.map(canonicalizeValuePatchForWire),
    })),
    addedBelts: command.addedBelts,
    removedBeltIds: command.removedBeltIds,
  };
}

function assertUniqueId(set: Set<string>, id: string, label: string): void {
  if (set.has(id)) {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label} ID 重复或冲突`);
  }
  set.add(id);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function stableSortedIds(ids: Iterable<string>): readonly string[] {
  return Object.freeze([...ids]
    .map((id) => ({ id, bytes: textEncoder.encode(id) }))
    .sort((left, right) => compareBytes(left.bytes, right.bytes))
    .map(({ id }) => id));
}

function topLevelChangeIsProjectionSafe(change: SimulationValuePatch): boolean {
  const path = change.path;
  if (path.length === 2 && path[0] === "recipeFocus" &&
    (path[1] === "itemId" || path[1] === "mode")) return true;
  if (path.length === 3 && path[0] === "recipeFocus" && path[1] === "position" &&
    (path[2] === "x" || path[2] === "y")) return true;
  if (path.length === 3 && path[0] === "planetViewports" && typeof path[1] === "string" &&
    (path[2] === "x" || path[2] === "y" || path[2] === "zoom") &&
    change.operation === "set" && Object.hasOwn(change, "value")) return true;
  return typeof path[0] === "string" && SAFE_TOP_LEVEL_PROJECTION_ROOTS.has(path[0]);
}

function commandTopologyIsDirty(command: SimulationCommandPatch): boolean {
  if (command.addedEntities.length > 0 || command.removedEntityIds.length > 0 ||
    command.addedBelts.length > 0 || command.removedBeltIds.length > 0) return true;
  if (command.topLevelChanges.some((change) => !topLevelChangeIsProjectionSafe(change))) return true;
  if (command.changedEntities.some((record) => record.changes.some((change) =>
    typeof change.path[0] !== "string" || !SAFE_ENTITY_PROJECTION_ROOTS.has(change.path[0])))) return true;
  return command.changedBelts.some((record) => record.changes.some((change) =>
    typeof change.path[0] !== "string" || !SAFE_BELT_PROJECTION_ROOTS.has(change.path[0])));
}

function assertCommandStructure(value: unknown, expectedRevision: number): NormalizedCommand {
  if (!isRecord(value) || !hasExactKeys(value, COMMAND_KEYS) ||
    value.protocolVersion !== SIMULATION_RUNTIME_PROTOCOL_VERSION ||
    value.baseRevision !== expectedRevision ||
    !Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0 ||
    (value.baseRevision as number) >= Number.MAX_SAFE_INTEGER ||
    COMMAND_KEYS.slice(2).some((key) => !Array.isArray(value[key]))) {
    throw sourceError(
      value && typeof value === "object" && "baseRevision" in value && value.baseRevision !== expectedRevision
        ? "NATIVE_PLAYER_AUTHORITY_COMMAND_REVISION_MISMATCH"
        : "NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID",
      "原生玩家命令结构或 revision 非法",
    );
  }

  const command = value as unknown as SimulationCommandPatch;
  const entityIds = new Set<string>();
  const beltIds = new Set<string>();
  let valuePatchCount = command.topLevelChanges.length;
  if (valuePatchCount > MAX_VALUE_PATCHES) {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", "原生玩家命令 patch 超过上限");
  }
  command.topLevelChanges.forEach((change, index) =>
    assertValuePatch(change, `topLevelChanges[${index}]`));
  if (command.topLevelChanges.some((change) => change.path[0] === "paused")) {
    throw sourceError(
      "NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID",
      "暂停与继续必须由 Windows 主进程的专用持久化生命周期处理",
    );
  }

  const validateChangedRecords = (
    records: unknown[],
    ids: Set<string>,
    label: string,
  ) => records.forEach((record, index) => {
    if (!isRecord(record) || !hasExactKeys(record, ["id", "changes"]) ||
      !Array.isArray(record.changes) || record.changes.length < 1 ||
      record.changes.length > MAX_RECORD_CHANGES) {
      throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label}[${index}] 结构非法`);
    }
    const id = requireOpaqueId(record.id, `${label}[${index}]`);
    assertUniqueId(ids, id, label);
    valuePatchCount += record.changes.length;
    if (valuePatchCount > MAX_VALUE_PATCHES) {
      throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", "原生玩家命令 patch 超过上限");
    }
    record.changes.forEach((change, changeIndex) =>
      assertValuePatch(change, `${label}[${index}].changes[${changeIndex}]`));
  });

  const validateAddedRecords = (
    records: unknown[],
    ids: Set<string>,
    label: string,
  ) => records.forEach((record, index) => {
    if (!isRecord(record) || !hasExactKeys(record, ["index", "value"]) ||
      !Number.isSafeInteger(record.index) || (record.index as number) < 0 ||
      !isRecord(record.value)) {
      throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", `${label}[${index}] 结构非法`);
    }
    const id = requireOpaqueId(record.value.id, `${label}[${index}].value`);
    assertUniqueId(ids, id, label);
    assertJsonValue(record.value, `${label}[${index}].value`, 0, new Set(), true);
  });

  const validateRemovedIds = (values: unknown[], ids: Set<string>, label: string) =>
    values.forEach((value, index) => {
      const id = requireOpaqueId(value, `${label}[${index}]`);
      assertUniqueId(ids, id, label);
    });

  validateChangedRecords(command.changedEntities, entityIds, "changedEntities");
  validateAddedRecords(command.addedEntities, entityIds, "addedEntities");
  validateRemovedIds(command.removedEntityIds, entityIds, "removedEntityIds");
  validateChangedRecords(command.changedBelts, beltIds, "changedBelts");
  validateAddedRecords(command.addedBelts, beltIds, "addedBelts");
  validateRemovedIds(command.removedBeltIds, beltIds, "removedBeltIds");
  if (entityIds.size + beltIds.size > MAX_CHANGED_IDS) {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", "原生玩家命令 changed ID 超过上限");
  }
  if (valuePatchCount === 0 && entityIds.size === 0 && beltIds.size === 0) {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", "原生玩家命令为空");
  }
  return {
    command,
    changedEntityIds: stableSortedIds(entityIds),
    changedBeltIds: stableSortedIds(beltIds),
    topologyDirty: commandTopologyIsDirty(command),
  };
}

function normalizeCommand(value: unknown, expectedRevision: number): NormalizedCommand {
  // Validate the caller-owned wrappers before JSON serialization so an extra
  // `undefined` key cannot disappear and accidentally become canonical.
  const validated = assertCommandStructure(value, expectedRevision);
  const wireCommand = canonicalizeCommandForWire(validated.command);
  let encoded: string;
  try {
    encoded = JSON.stringify(wireCommand);
  } catch {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", "原生玩家命令不可序列化");
  }
  if (textEncoder.encode(encoded).byteLength > MAX_DURABLE_COMMAND_BYTES) {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", "原生玩家命令超过 durable 上限");
  }
  let detached: unknown;
  try {
    detached = JSON.parse(encoded);
  } catch {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID", "原生玩家命令 JSON 非法");
  }
  return assertCommandStructure(detached, expectedRevision);
}

function normalizeStableReceiptIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_CHANGED_IDS) {
    throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID", `${label} 超过上限`);
  }
  const result: string[] = [];
  let previousBytes: Uint8Array | null = null;
  for (const rawId of value) {
    if (!validBoundedString(rawId, MAX_OPAQUE_ID_BYTES)) {
      throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID", `${label} 包含非法 ID`);
    }
    const bytes = textEncoder.encode(rawId);
    if (previousBytes && compareBytes(previousBytes, bytes) >= 0) {
      throw sourceError("NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID", `${label} 顺序或唯一性非法`);
    }
    previousBytes = bytes;
    result.push(rawId);
  }
  return Object.freeze(result);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function normalizeReceipt(value: unknown, command: NormalizedCommand): DesktopNativeCoreCommandResult {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS) ||
    !Number.isSafeInteger(value.previousRevision) || !Number.isSafeInteger(value.revision) ||
    value.previousRevision !== command.command.baseRevision ||
    value.revision !== command.command.baseRevision + 1 ||
    typeof value.topologyDirty !== "boolean") {
    throw sourceError(
      "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
      "原生玩家命令回执 revision 或字段非法",
    );
  }
  const changedEntityIds = normalizeStableReceiptIds(value.changedEntityIds, "原生实体 changed IDs");
  const changedBeltIds = normalizeStableReceiptIds(value.changedBeltIds, "原生线路 changed IDs");
  if (changedEntityIds.length + changedBeltIds.length > MAX_CHANGED_IDS ||
    !sameIds(changedEntityIds, command.changedEntityIds) ||
    !sameIds(changedBeltIds, command.changedBeltIds) ||
    value.topologyDirty !== command.topologyDirty) {
    throw sourceError(
      "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
      "原生玩家命令回执与确定性 changed 集不一致",
    );
  }
  return Object.freeze({
    previousRevision: value.previousRevision as number,
    revision: value.revision as number,
    changedEntityIds: [...changedEntityIds],
    changedBeltIds: [...changedBeltIds],
    topologyDirty: value.topologyDirty,
  });
}

function normalizeReconciliation(
  value: unknown,
  command: NormalizedCommand,
): NativePlayerAuthorityCommandReconciliationOutcome {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw sourceError(
      "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
      "原生玩家命令对账回执结构非法",
    );
  }
  if (value.status === "committed" && hasExactKeys(value, ["status", "receipt"])) {
    return Object.freeze({
      status: "committed" as const,
      receipt: normalizeReceipt(value.receipt, command),
    });
  }
  if ((value.status === "pending" || value.status === "not-committed" ||
      value.status === "conflict") &&
      hasExactKeys(value, ["status", "baseRevision", "currentRevision"]) &&
      value.baseRevision === command.command.baseRevision &&
      Number.isSafeInteger(value.currentRevision) && (value.currentRevision as number) >= 0) {
    return Object.freeze({
      status: value.status,
      baseRevision: command.command.baseRevision,
      currentRevision: value.currentRevision as number,
    });
  }
  throw sourceError(
    "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
    "原生玩家命令对账回执与原命令不一致",
  );
}

function normalizeSettledActiveFrame(value: unknown): DesktopNativePlayerAuthorityClockState | null {
  let frame: DesktopNativePlayerAuthorityState;
  try {
    frame = normalizeNativePlayerAuthorityClockFrame(value);
  } catch {
    return null;
  }
  return frame.schemaVersion === 1 && frame.phase === "active" && frame.sessionId !== null &&
    frame.runId !== null && frame.revision !== null && frame.acknowledgedSequence !== null &&
    frame.nextSequence !== null && frame.nextDeadlineMs !== null && !frame.inFlight &&
    frame.currentOperation === null && frame.queuedCommands === 0 && frame.lastErrorCode === null
    ? frame
    : null;
}

function sameBoundFrame(
  left: DesktopNativePlayerAuthorityClockState,
  right: DesktopNativePlayerAuthorityClockState,
): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.revision === right.revision &&
    left.acknowledgedSequence === right.acknowledgedSequence &&
    left.nextSequence === right.nextSequence && left.nextDeadlineMs === right.nextDeadlineMs;
}

function isContiguousPostCommandFrame(
  before: DesktopNativePlayerAuthorityClockState,
  after: DesktopNativePlayerAuthorityClockState,
  revision: number,
): boolean {
  return after.sessionId === before.sessionId && after.runId === before.runId &&
    after.revision === revision &&
    after.acknowledgedSequence === before.acknowledgedSequence! + 1 &&
    after.nextSequence === before.nextSequence! + 1 &&
    after.nextDeadlineMs === before.nextDeadlineMs;
}

async function pullSettledFrame(
  bridge: NativePlayerAuthorityCommandBridge,
): Promise<DesktopNativePlayerAuthorityClockState> {
  let raw: unknown;
  try {
    raw = await bridge.getNativePlayerAuthorityState!();
  } catch {
    throw sourceError(
      "NATIVE_PLAYER_AUTHORITY_COMMAND_TRANSPORT_UNCERTAIN",
      "无法确认原生玩家权威时钟",
    );
  }
  const frame = normalizeSettledActiveFrame(raw);
  if (!frame) {
    throw sourceError(
      "NATIVE_PLAYER_AUTHORITY_COMMAND_FRAME_STALE",
      "原生玩家权威不再处于 schema-v1 settled active frame",
    );
  }
  return frame;
}

function issueLocalCommandId(revision: number): string {
  if (nextLocalCommandSequence >= Number.MAX_SAFE_INTEGER) {
    throw sourceError(
      "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
      "renderer 本地命令序列已耗尽",
    );
  }
  nextLocalCommandSequence += 1;
  const commandId = `renderer-local-${revision.toString(36)}-${nextLocalCommandSequence.toString(36)}`;
  if (!COMMAND_ID_PATTERN.test(commandId) || textEncoder.encode(commandId).byteLength > MAX_COMMAND_ID_BYTES) {
    throw sourceError(
      "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
      "renderer 本地命令 ID 非法",
    );
  }
  return commandId;
}

/**
 * Creates a single-frame mutation source for the main-owned Rust authority.
 *
 * Both preflight and postflight read the main-owned schema-v1 clock. The
 * renderer forwards a detached `SimulationCommandPatch`, validates the exact
 * deterministic receipt, and never applies or predicts local renderer state.
 */
export function createNativePlayerAuthorityCommandSource(
  bridge: NativePlayerAuthorityCommandBridge | null,
  activeFrame: DesktopNativePlayerAuthorityClockState | null,
): NativePlayerAuthorityCommandSource | null {
  if (!bridge || typeof bridge.applyNativeCoreCommand !== "function" ||
    typeof bridge.getNativePlayerAuthorityState !== "function") return null;
  const boundFrame = normalizeSettledActiveFrame(activeFrame);
  if (!boundFrame) return null;
  const { sessionId, runId, revision } = boundFrame;
  if (sessionId === null || runId === null || revision === null) return null;

  let inFlight = false;
  let consumed = false;
  const source: NativePlayerAuthorityCommandSource = {
    sessionId,
    runId,
    baseRevision: revision,
    async reconcileCommand(rawCommand) {
      const command = normalizeCommand(rawCommand, revision);
      if (typeof bridge.reconcileNativeCoreCommand !== "function") {
        return Object.freeze({ status: "unavailable" as const });
      }
      let raw: unknown;
      try {
        raw = await bridge.reconcileNativeCoreCommand({
          sessionId,
          command: command.command as unknown as Record<string, unknown>,
        });
      } catch {
        return Object.freeze({ status: "unavailable" as const });
      }
      return normalizeReconciliation(raw, command);
    },
    async applyCommand(rawCommand) {
      if (inFlight) {
        throw sourceError(
          "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_BUSY",
          "同一原生玩家权威 frame 已有命令在途",
        );
      }
      if (consumed) {
        throw sourceError(
          "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
          "原生玩家权威 command source 已耗尽，请等待新 frame",
        );
      }
      const command = normalizeCommand(rawCommand, revision);
      inFlight = true;
      let commandId: string | null = null;
      let sent = false;
      try {
        const preflight = await pullSettledFrame(bridge);
        if (!sameBoundFrame(boundFrame, preflight)) {
          throw sourceError(
            "NATIVE_PLAYER_AUTHORITY_COMMAND_FRAME_STALE",
            "原生玩家权威 frame 已变化",
          );
        }
        commandId = issueLocalCommandId(revision);
        sent = true;
        let rawReceipt: unknown;
        try {
          rawReceipt = await bridge.applyNativeCoreCommand({
            sessionId,
            command: command.command as unknown as Record<string, unknown>,
          });
        } catch {
          throw sourceError(
            "NATIVE_PLAYER_AUTHORITY_COMMAND_TRANSPORT_UNCERTAIN",
            "原生玩家命令结果不确定，禁止 renderer 重试或猜测提交",
            commandId,
          );
        }
        const receipt = normalizeReceipt(rawReceipt, command);
        const postflight = await pullSettledFrame(bridge);
        if (!isContiguousPostCommandFrame(preflight, postflight, receipt.revision)) {
          throw sourceError(
            "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
            "原生玩家命令后的权威 frame 不连续",
            commandId,
          );
        }
        consumed = true;
        return Object.freeze({
          commandId,
          previousRevision: receipt.previousRevision,
          revision: receipt.revision,
          changedEntityIds: Object.freeze([...receipt.changedEntityIds]),
          changedBeltIds: Object.freeze([...receipt.changedBeltIds]),
          topologyDirty: receipt.topologyDirty,
        });
      } catch (error) {
        // Once preflight starts this source is bound to a clock observation.
        // A failed pull is stale; after send, the durable outcome is unknown.
        consumed = true;
        if (error instanceof NativePlayerAuthorityCommandSourceError) {
          throw withCommandId(error, commandId);
        }
        throw sourceError(
          sent
            ? "NATIVE_PLAYER_AUTHORITY_COMMAND_TRANSPORT_UNCERTAIN"
            : "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
          sent
            ? "原生玩家命令结果不确定，禁止 renderer 猜测提交"
            : "原生玩家命令源不可用",
          commandId,
        );
      } finally {
        inFlight = false;
      }
    },
  };
  return Object.freeze(source);
}
