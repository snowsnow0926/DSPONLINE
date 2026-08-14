import { computeSaveStateChecksumFromJson } from "./saveEnvelopeIntegrity";
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
  const stateChecksum = computeSaveStateChecksumFromJson(options.formatVersion, stateJson);
  const prefix = [
    `{"formatVersion":${JSON.stringify(options.formatVersion)}`,
    `,"kind":${JSON.stringify(options.kind)}`,
    options.reason ? `,"reason":${JSON.stringify(options.reason)}` : "",
    `,"savedAt":${JSON.stringify(options.savedAt)}`,
    `,"mode":${JSON.stringify(options.mode)}`,
    `,"slot":${JSON.stringify(options.slot)}`,
    ',"state":',
  ].join("");
  const suffix = `,"checksum":${JSON.stringify(stateChecksum)}}`;
  const byteLength = utf8Length(prefix) + utf8Length(stateJson) + utf8Length(suffix);
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

export function decodeVerifiedSaveTransfer(bytes: ArrayBuffer, verification: SaveTransferVerification): string {
  if (verification.integrity !== "valid" || bytes.byteLength !== verification.byteLength) {
    throw new Error("后台存档传输长度校验失败");
  }
  if (computeSavePayloadChecksum(bytes) !== verification.payloadChecksum) {
    throw new Error("后台存档传输哈希校验失败");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
