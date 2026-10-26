import type { SaveTransferVerification } from "./saveTransfer";

export const DEFAULT_SAVE_TRANSFER_DECODE_CHUNK_BYTES = 512 * 1024;

export interface SaveTransferDecodeProgress {
  processedBytes: number;
  totalBytes: number;
}

export interface SaveTransferDecodeOptions {
  chunkBytes?: number;
  yieldControl?: () => Promise<void>;
  onProgress?: (progress: SaveTransferDecodeProgress) => void;
  signal?: AbortSignal;
  /** Keep only the source buffer; decode once after its full proof passes. */
  lowMemory?: boolean;
}

function defaultYieldControl(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return scheduler.yield();
    // A chain of boosted scheduler continuations can still starve ordinary
    // timers and rendering. End each continuation with a timer task; the
    // intervening scheduler task also resets nested-timer clamping.
    return scheduler.yield().then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  // Hidden pages do not need UI fairness; timer throttling there can stretch
  // a large save into minutes on browsers without the scheduler API.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Verify and decode a large Worker-produced save without one monolithic
 * hash loop on the UI thread. Streaming mode also splits UTF-8 decoding;
 * lowMemory mode retains only the source buffer and performs one native decode
 * after validation. Both return only after the original complete payload proof.
 */
export async function decodeVerifiedSaveTransferChunked(
  bytes: ArrayBuffer,
  verification: SaveTransferVerification,
  options: SaveTransferDecodeOptions = {},
): Promise<string> {
  if (verification.integrity !== "valid" || bytes.byteLength !== verification.byteLength) {
    throw new Error("后台存档传输长度校验失败");
  }
  const requestedChunkBytes = options.chunkBytes ?? DEFAULT_SAVE_TRANSFER_DECODE_CHUNK_BYTES;
  const chunkBytes = Math.max(16 * 1024, Math.floor(requestedChunkBytes));
  const yieldControl = options.yieldControl ?? defaultYieldControl;
  const source = new Uint8Array(bytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decoded: string[] = [];
  let hash = 0x811c9dc5;
  for (let offset = 0; offset < source.byteLength; offset += chunkBytes) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Save decode aborted", "AbortError");
    const chunk = source.subarray(offset, Math.min(source.byteLength, offset + chunkBytes));
    for (let index = 0; index < chunk.byteLength; index += 1) {
      hash ^= chunk[index];
      hash = Math.imul(hash, 0x01000193);
    }
    if (!options.lowMemory) decoded.push(decoder.decode(chunk, { stream: offset + chunk.byteLength < source.byteLength }));
    const processedBytes = offset + chunk.byteLength;
    options.onProgress?.({ processedBytes, totalBytes: source.byteLength });
    if (processedBytes < source.byteLength) await yieldControl();
  }
  if (!options.lowMemory) decoded.push(decoder.decode());
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Save decode aborted", "AbortError");
  if ((hash >>> 0).toString(16).padStart(8, "0") !== verification.payloadChecksum) {
    throw new Error("后台存档传输哈希校验失败");
  }
  return options.lowMemory ? decoder.decode(source) : decoded.join("");
}
