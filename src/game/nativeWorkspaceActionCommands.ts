import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const MAX_IDS = 4_096;
const MAX_ID_BYTES = 512;
const MAX_COMMAND_BYTES = 1_750_000;
const encoder = new TextEncoder();

export type NativeWorkspaceActionIntent =
  | Readonly<{ kind: "handcraft-enqueue"; recipeId: string; batches: number }>
  | Readonly<{ kind: "handcraft-cancel"; entryId: string }>
  | Readonly<{ kind: "construction-discard"; constructionId: string }>
  | Readonly<{ kind: "tray-discard"; itemId: string; amount: number }>
  | Readonly<{ kind: "spray-detach"; entityId: string }>
  | Readonly<{ kind: "collector-item"; entityId: string; itemId: string }>
  | Readonly<{
      kind: "region-add";
      planetId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      name?: string;
      fillColor?: string;
      borderColor?: string;
    }>
  | Readonly<{ kind: "region-update"; regionId: string; name?: string; fillColor?: string; borderColor?: string }>
  | Readonly<{ kind: "region-resize"; regionId: string; x: number; y: number; width: number; height: number }>
  | Readonly<{ kind: "region-remove"; regionId: string }>
  | Readonly<{ kind: "bookmark-add"; planetId: string; x: number; y: number; zoom: number; name?: string }>
  | Readonly<{ kind: "bookmark-rename"; bookmarkId: string; name: string }>
  | Readonly<{ kind: "bookmark-remove"; bookmarkId: string }>
  | Readonly<{ kind: "quantum-attach"; entityIds: readonly string[] }>
  | Readonly<{ kind: "collector-quantum-mode"; entityIds: readonly string[]; enabled: boolean }>
  | Readonly<{ kind: "station-upgrade-scope"; systemId: string | null }>
  | Readonly<{ kind: "quantum-attach-scope"; systemId: string | null }>
  | Readonly<{ kind: "collector-quantum-scope"; systemId: string | null; enabled: boolean }>
  | Readonly<{ kind: "system-explore"; systemId: string }>
  | Readonly<{ kind: "planet-colonize"; planetId: string }>
  | Readonly<{ kind: "planet-metadata"; planetId: string; customName: string; note: string; tags: readonly string[] }>
  | Readonly<{ kind: "system-rename"; systemId: string; name: string }>;

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

function validText(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) &&
    wellFormedUnicode(value) && encoder.encode(value).byteLength <= MAX_ID_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateIds(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_IDS ||
      values.some((value) => !validText(value)) || new Set(values).size !== values.length) {
    throw new TypeError("原生工作区命令的目标范围无效");
  }
  return [...values];
}

function normalizeIntent(intent: NativeWorkspaceActionIntent): Record<string, unknown> {
  if (!intent || typeof intent !== "object" || typeof intent.kind !== "string") {
    throw new TypeError("原生工作区命令无效");
  }
  switch (intent.kind) {
    case "handcraft-enqueue":
      if (!validText(intent.recipeId) || !Number.isSafeInteger(intent.batches) || intent.batches < 1 || intent.batches > 1_000_000) {
        throw new TypeError("原生手搓队列参数无效");
      }
      return { kind: intent.kind, recipeId: intent.recipeId, batches: intent.batches };
    case "handcraft-cancel":
      if (!validText(intent.entryId)) throw new TypeError("原生手搓队列条目无效");
      return { kind: intent.kind, entryId: intent.entryId };
    case "construction-discard":
      if (!validText(intent.constructionId)) throw new TypeError("原生施工库存条目无效");
      return { kind: intent.kind, constructionId: intent.constructionId };
    case "tray-discard":
      if (!validText(intent.itemId) || !Number.isSafeInteger(intent.amount) || intent.amount < 1 ||
          intent.amount > Number.MAX_SAFE_INTEGER) throw new TypeError("原生托盘永久丢弃参数无效");
      return { kind: intent.kind, itemId: intent.itemId, amount: intent.amount };
    case "spray-detach":
      if (!validText(intent.entityId)) throw new TypeError("原生喷涂模块目标无效");
      return { kind: intent.kind, entityId: intent.entityId };
    case "collector-item":
      if (!validText(intent.entityId) || !validText(intent.itemId)) throw new TypeError("原生轨道采集器参数无效");
      return { kind: intent.kind, entityId: intent.entityId, itemId: intent.itemId };
    case "region-add": {
      if (!validText(intent.planetId) || ![intent.x, intent.y, intent.width, intent.height].every(validNumber) ||
          intent.width < 40 || intent.height < 40 || intent.name !== undefined && !validText(intent.name, true) ||
          intent.fillColor !== undefined && !/^#[0-9a-f]{6}$/iu.test(intent.fillColor) ||
          intent.borderColor !== undefined && !/^#[0-9a-f]{6}$/iu.test(intent.borderColor)) {
        throw new TypeError("原生生产区域参数无效");
      }
      return { ...intent };
    }
    case "region-update":
      if (!validText(intent.regionId) ||
          intent.name === undefined && intent.fillColor === undefined && intent.borderColor === undefined ||
          intent.name !== undefined && !validText(intent.name, true) ||
          intent.fillColor !== undefined && !/^#[0-9a-f]{6}$/iu.test(intent.fillColor) ||
          intent.borderColor !== undefined && !/^#[0-9a-f]{6}$/iu.test(intent.borderColor)) {
        throw new TypeError("原生生产区域更新无效");
      }
      return { ...intent };
    case "region-resize":
      if (!validText(intent.regionId) || ![intent.x, intent.y, intent.width, intent.height].every(validNumber)) {
        throw new TypeError("原生生产区域尺寸无效");
      }
      return { ...intent };
    case "region-remove":
      if (!validText(intent.regionId)) throw new TypeError("原生生产区域目标无效");
      return { kind: intent.kind, regionId: intent.regionId };
    case "bookmark-add":
      if (!validText(intent.planetId) || ![intent.x, intent.y, intent.zoom].every(validNumber) ||
          intent.name !== undefined && !validText(intent.name, true)) {
        throw new TypeError("原生视角书签参数无效");
      }
      return { ...intent };
    case "bookmark-rename":
      if (!validText(intent.bookmarkId) || !validText(intent.name)) throw new TypeError("原生视角书签名称无效");
      return { kind: intent.kind, bookmarkId: intent.bookmarkId, name: intent.name };
    case "bookmark-remove":
      if (!validText(intent.bookmarkId)) throw new TypeError("原生视角书签目标无效");
      return { kind: intent.kind, bookmarkId: intent.bookmarkId };
    case "quantum-attach":
      return { kind: intent.kind, entityIds: validateIds(intent.entityIds) };
    case "collector-quantum-mode":
      if (typeof intent.enabled !== "boolean") throw new TypeError("原生量子采集器模式无效");
      return { kind: intent.kind, entityIds: validateIds(intent.entityIds), enabled: intent.enabled };
    case "station-upgrade-scope":
    case "quantum-attach-scope":
      if (intent.systemId !== null && !validText(intent.systemId)) throw new TypeError("原生恒星系批量范围无效");
      return { kind: intent.kind, systemId: intent.systemId };
    case "collector-quantum-scope":
      if (intent.systemId !== null && !validText(intent.systemId) || typeof intent.enabled !== "boolean") {
        throw new TypeError("原生轨道采集器批量范围无效");
      }
      return { kind: intent.kind, systemId: intent.systemId, enabled: intent.enabled };
    case "system-explore":
      if (!validText(intent.systemId)) throw new TypeError("原生恒星系勘探目标无效");
      return { kind: intent.kind, systemId: intent.systemId };
    case "planet-colonize":
      if (!validText(intent.planetId)) throw new TypeError("原生行星殖民目标无效");
      return { kind: intent.kind, planetId: intent.planetId };
    case "planet-metadata": {
      if (!validText(intent.planetId) || !validText(intent.customName, true) ||
          !validText(intent.note, true) || !Array.isArray(intent.tags) || intent.tags.length > 8 ||
          intent.tags.some((tag) => !validText(tag, true))) {
        throw new TypeError("原生行星资料无效");
      }
      return {
        kind: intent.kind,
        planetId: intent.planetId,
        customName: intent.customName,
        note: intent.note,
        tags: [...intent.tags],
      };
    }
    case "system-rename":
      if (!validText(intent.systemId) || !validText(intent.name, true)) {
        throw new TypeError("原生恒星系名称无效");
      }
      return { kind: intent.kind, systemId: intent.systemId, name: intent.name };
    default: {
      const exhaustive: never = intent;
      throw new TypeError(`不支持的原生工作区命令：${String(exhaustive)}`);
    }
  }
}

/** Build one compact marker; Rust derives every authoritative mutation. */
export function createNativeWorkspaceActionCommand(
  baseRevision: number,
  intent: NativeWorkspaceActionIntent,
): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || baseRevision >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError("原生工作区命令 revision 无效");
  }
  const command: SimulationCommandPatch = {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [{
      path: ["workspaceAction", "intent"],
      operation: "set",
      value: normalizeIntent(intent),
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
  if (encoder.encode(JSON.stringify(command)).byteLength > MAX_COMMAND_BYTES) {
    throw new TypeError("原生工作区命令超过 durable 上限");
  }
  return command;
}
