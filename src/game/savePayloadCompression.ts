import { sha256Bytes } from "./payloadDigest";

export type SavePayloadTransportEncoding = "raw" | "gzip";

export interface PreparedSavePayloadTransport {
  buffer: ArrayBuffer;
  encoding: SavePayloadTransportEncoding;
  originalByteLength: number;
  storedByteLength: number;
  storedSha256: string;
  compressionDurationMs: number;
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - startedAt);
}

/**
 * Compress a save before it crosses the UI/persistence Worker boundary. The
 * raw buffer stays owned by the serializer Worker and is never cloned through
 * the renderer. A raw fallback is retained for older embedded browsers.
 */
export async function prepareSavePayloadTransport(
  raw: ArrayBuffer,
  rawSha256: string,
): Promise<PreparedSavePayloadTransport> {
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  if (typeof CompressionStream === "undefined" || typeof Blob === "undefined" || typeof Response === "undefined") {
    return {
      buffer: raw,
      encoding: "raw",
      originalByteLength: raw.byteLength,
      storedByteLength: raw.byteLength,
      storedSha256: rawSha256,
      compressionDurationMs: elapsedSince(startedAt),
    };
  }
  try {
    const compressed = await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    if (compressed.byteLength >= raw.byteLength) {
      return {
        buffer: raw,
        encoding: "raw",
        originalByteLength: raw.byteLength,
        storedByteLength: raw.byteLength,
        storedSha256: rawSha256,
        compressionDurationMs: elapsedSince(startedAt),
      };
    }
    return {
      buffer: compressed,
      encoding: "gzip",
      originalByteLength: raw.byteLength,
      storedByteLength: compressed.byteLength,
      storedSha256: await sha256Bytes(compressed),
      compressionDurationMs: elapsedSince(startedAt),
    };
  } catch {
    return {
      buffer: raw,
      encoding: "raw",
      originalByteLength: raw.byteLength,
      storedByteLength: raw.byteLength,
      storedSha256: rawSha256,
      compressionDurationMs: elapsedSince(startedAt),
    };
  }
}

export async function decodeSavePayloadTransport(
  stored: ArrayBuffer,
  encoding: SavePayloadTransportEncoding,
): Promise<ArrayBuffer> {
  if (encoding === "raw") return stored;
  if (typeof DecompressionStream === "undefined" || typeof Blob === "undefined" || typeof Response === "undefined") {
    throw new Error("当前环境不支持 gzip 存档解压");
  }
  try {
    return await new Response(
      new Blob([stored]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
  } catch {
    throw new Error("gzip 存档传输解压失败");
  }
}
