import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSavePayloadChecksum, type SaveTransferVerification } from "./saveTransfer";
import { decodeVerifiedSaveTransferChunked } from "./saveTransferDecode";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function fixture(text: string): { bytes: ArrayBuffer; verification: SaveTransferVerification } {
  const encoded = new TextEncoder().encode(text);
  const bytes = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  return {
    bytes,
    verification: {
      integrity: "valid",
      stateChecksum: "state-proof",
      payloadChecksum: computeSavePayloadChecksum(bytes),
      byteLength: bytes.byteLength,
    },
  };
}

describe("chunked verified save transfer decode", () => {
  it.each([false, true])("preserves exact UTF-8 text across chunks while yielding (lowMemory=%s)", async (lowMemory) => {
    const text = `${"工厂🌌".repeat(12_000)}-exact-tail`;
    const { bytes, verification } = fixture(text);
    const yieldControl = vi.fn(async () => undefined);
    const progress: number[] = [];
    await expect(decodeVerifiedSaveTransferChunked(bytes, verification, {
      chunkBytes: 16 * 1024,
      lowMemory,
      yieldControl,
      onProgress: (entry) => progress.push(entry.processedBytes),
    })).resolves.toBe(text);
    expect(yieldControl).toHaveBeenCalled();
    expect(progress.at(-1)).toBe(bytes.byteLength);
  });

  it.each([false, true])("rejects length and byte corruption (lowMemory=%s)", async (lowMemory) => {
    const source = fixture("verified payload");
    await expect(decodeVerifiedSaveTransferChunked(source.bytes, { ...source.verification, byteLength: source.bytes.byteLength + 1 }, { lowMemory }))
      .rejects.toThrow("长度");
    const corrupted = source.bytes.slice(0);
    new Uint8Array(corrupted)[0] ^= 1;
    await expect(decodeVerifiedSaveTransferChunked(corrupted, source.verification, { lowMemory, yieldControl: async () => undefined }))
      .rejects.toThrow("哈希");
  });

  it.each([false, true])("stops an aborted decode before returning partial text (lowMemory=%s)", async (lowMemory) => {
    const source = fixture("x".repeat(80_000));
    const controller = new AbortController();
    let chunks = 0;
    await expect(decodeVerifiedSaveTransferChunked(source.bytes, source.verification, {
      chunkBytes: 16 * 1024, signal: controller.signal, lowMemory,
      yieldControl: async () => { controller.abort(); }, onProgress: () => { chunks++; },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(chunks).toBe(1);
  });

  it.each([false, true])("rejects invalid UTF-8 even with a matching byte checksum (lowMemory=%s)", async (lowMemory) => {
    const bytes = Uint8Array.from([0xc3, 0x28]).buffer;
    await expect(decodeVerifiedSaveTransferChunked(bytes, {
      integrity: "valid", byteLength: bytes.byteLength,
      stateChecksum: "state-proof", payloadChecksum: computeSavePayloadChecksum(bytes),
    }, { lowMemory })).rejects.toThrow();
  });

  it("keeps visible-page timer tasks fair after each scheduler continuation", async () => {
    vi.useFakeTimers();
    const source = fixture("x".repeat(40_000));
    const schedulerYield = vi.fn(async () => undefined);
    vi.stubGlobal("scheduler", { yield: schedulerYield });
    vi.stubGlobal("document", { visibilityState: "visible" });
    const pending = decodeVerifiedSaveTransferChunked(source.bytes, source.verification, { chunkBytes: 16 * 1024 });
    await vi.runAllTimersAsync();
    expect(await pending).toBe("x".repeat(40_000));
    expect(schedulerYield).toHaveBeenCalledTimes(2);
  });

  it("avoids throttled timer hops in hidden pages when scheduler yielding is available", async () => {
    vi.useFakeTimers();
    const source = fixture("x".repeat(40_000));
    const schedulerYield = vi.fn(async () => undefined);
    vi.stubGlobal("scheduler", { yield: schedulerYield });
    vi.stubGlobal("document", { visibilityState: "hidden" });
    expect(await decodeVerifiedSaveTransferChunked(source.bytes, source.verification, { chunkBytes: 16 * 1024 })).toBe("x".repeat(40_000));
    expect(vi.getTimerCount()).toBe(0);
    expect(schedulerYield).toHaveBeenCalledTimes(2);
  });

  it("finishes hidden-page verification without throttled timers when scheduler is unavailable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("scheduler", undefined);
    vi.stubGlobal("document", { visibilityState: "hidden" });
    const source = fixture("x".repeat(40_000));
    expect(await decodeVerifiedSaveTransferChunked(source.bytes, source.verification, { chunkBytes: 16 * 1024 })).toBe("x".repeat(40_000));
    expect(vi.getTimerCount()).toBe(0);
  });
});
