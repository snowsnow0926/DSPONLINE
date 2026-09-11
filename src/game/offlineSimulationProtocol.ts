import type { GameState } from "./types";

export const OFFLINE_SIMULATION_PROTOCOL_VERSION = 1 as const;

export type OfflineSimulationStatePayloadKind = "game-state-json" | "save-envelope-json";

export interface OfflineSimulationStatePayload {
  protocolVersion: typeof OFFLINE_SIMULATION_PROTOCOL_VERSION;
  kind: OfflineSimulationStatePayloadKind;
  bytes: ArrayBuffer;
}

const WIRE_TAG = "\u0000dsp-offline-worker-v1";
const WIRE_UNDEFINED = Object.freeze({ [WIRE_TAG]: "undefined" });
const RESTORED_UNDEFINED = Symbol("restored-offline-worker-undefined");

function ensureSupportedPayload(payload: OfflineSimulationStatePayload, expectedKind?: OfflineSimulationStatePayloadKind): void {
  if (payload.protocolVersion !== OFFLINE_SIMULATION_PROTOCOL_VERSION) {
    throw new Error(`离线 Worker 协议版本不匹配：${String(payload.protocolVersion)}`);
  }
  if (!(payload.bytes instanceof ArrayBuffer)) throw new Error("离线 Worker 状态载荷不是可转移缓冲区");
  if (expectedKind && payload.kind !== expectedKind) {
    throw new Error(`离线 Worker 状态载荷类型不匹配：${payload.kind}`);
  }
}

export function createOfflineSimulationTextPayload(
  text: string,
  kind: OfflineSimulationStatePayloadKind,
): OfflineSimulationStatePayload {
  if (typeof TextEncoder === "undefined") throw new Error("当前环境不支持离线 Worker UTF-8 编码");
  const bytes = new TextEncoder().encode(text);
  return { protocolVersion: OFFLINE_SIMULATION_PROTOCOL_VERSION, kind, bytes: bytes.buffer };
}

export function decodeOfflineSimulationTextPayload(
  payload: OfflineSimulationStatePayload,
  expectedKind?: OfflineSimulationStatePayloadKind,
): string {
  ensureSupportedPayload(payload, expectedKind);
  if (typeof TextDecoder === "undefined") throw new Error("当前环境不支持离线 Worker UTF-8 解码");
  return new TextDecoder("utf-8", { fatal: true }).decode(payload.bytes);
}

export function serializeOfflineSimulationState(state: GameState): OfflineSimulationStatePayload {
  let raw: string;
  try {
    raw = JSON.stringify(state, (field, value: unknown) => {
      if (value === undefined) return WIRE_UNDEFINED;
      if (value === WIRE_UNDEFINED) return value;
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error(`离线 Worker 状态包含非有限数值：${field || "<root>"}`);
      }
      if (typeof value === "bigint") {
        throw new Error(`离线 Worker 状态包含不可序列化 bigint：${field || "<root>"}`);
      }
      if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, WIRE_TAG)) {
        throw new Error(`离线 Worker 状态包含保留协议字段：${field || "<root>"}`);
      }
      return value;
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "离线 Worker 状态序列化失败");
  }
  return createOfflineSimulationTextPayload(raw, "game-state-json");
}

function restoreUndefinedValues(value: unknown): unknown | typeof RESTORED_UNDEFINED {
  if (!value || typeof value !== "object") return value;
  if (!Array.isArray(value)) {
    const tagged = value as Record<string, unknown>;
    if (Object.keys(tagged).length === 1 && tagged[WIRE_TAG] === "undefined") return RESTORED_UNDEFINED;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const restored = restoreUndefinedValues(value[index]);
      value[index] = restored === RESTORED_UNDEFINED ? undefined : restored;
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    const restored = restoreUndefinedValues(record[field]);
    record[field] = restored === RESTORED_UNDEFINED ? undefined : restored;
  }
  return record;
}

export function deserializeOfflineSimulationState(payload: OfflineSimulationStatePayload): GameState {
  const raw = decodeOfflineSimulationTextPayload(payload, "game-state-json");
  let parsed: unknown;
  try {
    parsed = restoreUndefinedValues(JSON.parse(raw));
  } catch {
    throw new Error("离线 Worker 返回的状态 JSON 无法解析");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("离线 Worker 返回的状态不是对象");
  const candidate = parsed as Partial<GameState>;
  if (!Number.isSafeInteger(candidate.version) || !Array.isArray(candidate.entities) || !Array.isArray(candidate.belts)) {
    throw new Error("离线 Worker 返回的状态缺少合法版本、建筑或传送带列表");
  }
  return candidate as GameState;
}
