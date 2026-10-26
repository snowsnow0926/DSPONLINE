import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Bytes } from "./payloadDigest";
import { decodeSavePayloadTransport, prepareSavePayloadTransport } from "./savePayloadCompression";

afterEach(() => vi.unstubAllGlobals());

describe("save payload compression", () => {
  it("keeps explicitly uncompressed transfers byte-identical without starting a compressor", async () => {
    const compressor = vi.fn(() => { throw new Error("compressor must not run"); });
    vi.stubGlobal("CompressionStream", compressor);
    const source = new TextEncoder().encode("材料🧪".repeat(1024)).buffer;
    const sourceSha = await sha256Bytes(source);
    const prepared = await prepareSavePayloadTransport(source, sourceSha, false);
    expect(prepared.buffer).toBe(source);
    expect(prepared).toMatchObject({ encoding: "raw", originalByteLength: source.byteLength,
      storedByteLength: source.byteLength, storedSha256: sourceSha });
    expect(compressor).not.toHaveBeenCalled();
    expect(await sha256Bytes(await decodeSavePayloadTransport(prepared.buffer, prepared.encoding))).toBe(sourceSha);
  });

  it("gzip-compresses a repetitive large payload and restores the exact bytes", async () => {
    const source = new TextEncoder().encode(`{"state":"${"factory-belt-".repeat(32_768)}"}`).buffer;
    const sourceSha = await sha256Bytes(source);
    const prepared = await prepareSavePayloadTransport(source, sourceSha);
    expect(prepared.encoding).toBe("gzip");
    expect(prepared.storedByteLength).toBeLessThan(prepared.originalByteLength / 10);
    expect(prepared.storedSha256).toMatch(/^[0-9a-f]{64}$/);
    const decoded = await decodeSavePayloadTransport(prepared.buffer, prepared.encoding);
    expect(decoded.byteLength).toBe(source.byteLength);
    expect(await sha256Bytes(decoded)).toBe(sourceSha);
  });

  it("keeps an exact raw fallback when CompressionStream is unavailable", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const source = Uint8Array.from([1, 2, 3, 4]).buffer;
    const sourceSha = await sha256Bytes(source);
    const prepared = await prepareSavePayloadTransport(source, sourceSha);
    expect(prepared).toMatchObject({
      encoding: "raw",
      originalByteLength: 4,
      storedByteLength: 4,
      storedSha256: sourceSha,
    });
    expect(prepared.buffer).toBe(source);
  });
});
