import { measureSaveStateJson } from "./saveEnvelopeIntegrity";
import type { SaveMode } from "./types";
import { computeSavePayloadTextChecksum } from "./payloadTextChecksum";
export { computeSavePayloadTextChecksum } from "./payloadTextChecksum";

export type SaveTransferSlot = "main" | 1 | 2 | 3;

export interface SaveTransferOptions {
  formatVersion: number;
  savedAt: number;
  kind: "primary" | "slot" | "snapshot";
  reason?: string;
  mode: SaveMode;
  slot: SaveTransferSlot;
}

export interface SaveTransferVerification {
  integrity: "valid";
  stateChecksum: string;
  payloadChecksum: string;
  byteLength: number;
}

export interface SerializedSaveTransfer extends SaveTransferVerification {
  bytes: ArrayBuffer;
}

function saveEnvelopePrefix(options: SaveTransferOptions): string {
  return [
    `{"formatVersion":${JSON.stringify(options.formatVersion)}`,
    `,"kind":${JSON.stringify(options.kind)}`,
    options.reason ? `,"reason":${JSON.stringify(options.reason)}` : "",
    `,"savedAt":${JSON.stringify(options.savedAt)}`,
    `,"mode":${JSON.stringify(options.mode)}`,
    `,"slot":${JSON.stringify(options.slot)}`,
    ',"state":',
  ].join("");
}

function saveEnvelopeSuffix(stateChecksum: string): string {
  return `,"checksum":${JSON.stringify(stateChecksum)}}`;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function writeUtf8(encoder: TextEncoder, target: Uint8Array, offset: number, value: string): number {
  const result = encoder.encodeInto(value, target.subarray(offset));
  if (result.read !== value.length) throw new Error("存档 UTF-8 编码空间不足");
  return offset + result.written;
}

export function computeSavePayloadChecksum(bytes: ArrayBuffer | ArrayBufferView): string {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let hash = 0x811c9dc5;
  for (let index = 0; index < view.length; index += 1) {
    hash ^= view[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Serialize one authoritative state JSON string directly into a transferable
 * UTF-8 buffer. The worker never constructs a second full envelope string or
 * parses its own output back into another 20+ MB object.
 */
export function serializeSaveEnvelopeToTransfer(state: unknown, options: SaveTransferOptions): SerializedSaveTransfer {
  const stateJson = JSON.stringify(state);
  if (typeof stateJson !== "string") throw new Error("存档状态无法序列化");
  const { stateChecksum, byteLength: stateByteLength } = measureSaveStateJson(options.formatVersion, stateJson);
  const prefix = saveEnvelopePrefix(options);
  const suffix = saveEnvelopeSuffix(stateChecksum);
  const byteLength = utf8Length(prefix) + stateByteLength + utf8Length(suffix);
  const bytes = new ArrayBuffer(byteLength);
  const view = new Uint8Array(bytes);
  const encoder = new TextEncoder();
  let offset = writeUtf8(encoder, view, 0, prefix);
  offset = writeUtf8(encoder, view, offset, stateJson);
  offset = writeUtf8(encoder, view, offset, suffix);
  if (offset !== byteLength) throw new Error("存档 UTF-8 长度自检失败");
  const payloadChecksum = computeSavePayloadChecksum(bytes);
  return { bytes, byteLength, stateChecksum, payloadChecksum, integrity: "valid" };
}

/**
 * Reuse the state JSON of a just-committed local primary as a recovery snapshot.
 * Callers must already have verified the primary's durable read-back. Accept
 * only the local serializer's exact v2 framing and recheck its whole payload;
 * external/legacy framing returns null for the normal serializer fallback.
 * The state text and its checksum remain identical, while the snapshot header
 * and whole-payload proof are new. No state is parsed, cloned or serialized.
 */
export function rewrapVerifiedPrimarySaveAsSnapshot(
  raw: string,
  verification: SaveTransferVerification,
  source: Pick<SaveTransferOptions, "formatVersion" | "savedAt" | "mode">,
  savedAt: number,
  reason: string,
): { raw: string; verification: SaveTransferVerification } | null {
  if (source.formatVersion !== 2 || !Number.isSafeInteger(source.savedAt) || source.savedAt < 0 ||
    !Number.isSafeInteger(savedAt) || savedAt < 0 ||
    (source.mode !== "normal" && source.mode !== "speedrun") || verification.integrity !== "valid" ||
    !/^[a-f0-9]{8}$/.test(verification.stateChecksum) || !/^[a-f0-9]{8}$/.test(verification.payloadChecksum)) return null;
  const prefix = saveEnvelopePrefix({ ...source, kind: "primary", slot: "main" });
  const suffix = saveEnvelopeSuffix(verification.stateChecksum);
  if (!raw.startsWith(prefix) || !raw.endsWith(suffix) || raw.length <= prefix.length + suffix.length ||
    raw[prefix.length] !== "{" || raw[raw.length - suffix.length - 1] !== "}") return null;
  const sourcePayload = computeSavePayloadTextChecksum(raw);
  if (sourcePayload.checksum !== verification.payloadChecksum || sourcePayload.byteLength !== verification.byteLength) return null;
  const snapshotRaw = saveEnvelopePrefix({ ...source, kind: "snapshot", slot: "main", savedAt, reason }) +
    raw.slice(prefix.length, raw.length - suffix.length) + suffix;
  const payload = computeSavePayloadTextChecksum(snapshotRaw);
  return {
    raw: snapshotRaw,
    verification: {
      integrity: "valid",
      stateChecksum: verification.stateChecksum,
      payloadChecksum: payload.checksum,
      byteLength: payload.byteLength,
    },
  };
}

export function decodeVerifiedSaveTransfer(bytes: ArrayBuffer, verification: SaveTransferVerification): string {
  if (verification.integrity !== "valid" || bytes.byteLength !== verification.byteLength) {
    throw new Error("后台存档传输长度校验失败");
  }
  if (computeSavePayloadChecksum(bytes) !== verification.payloadChecksum) {
    throw new Error("后台存档传输哈希校验失败");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
