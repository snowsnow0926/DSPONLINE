import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSimulationRuntimeDurableBytesSha256 } from "./simulationRuntimeDurableRecovery";
import {
  preferGzipSimulationRuntimeRecoveryCheckpoint,
  type SimulationRuntimeRecoveryRawTransferCheckpoint,
} from "./simulationRuntimeRecoveryCheckpointCompression";

async function rawCheckpoint(bytes: Uint8Array): Promise<SimulationRuntimeRecoveryRawTransferCheckpoint> {
  const buffer = Uint8Array.from(bytes).buffer;
  const sha256 = await computeSimulationRuntimeDurableBytesSha256(buffer);
  return {
    schemaVersion: 1,
    sessionId: "session-compression",
    generation: 1,
    lastSequence: 0,
    stateRevision: 0,
    registryFingerprint: "registry",
    registry: {} as never,
    committedAtMs: 1,
    baseIdentity: { mode: "normal", savedAt: 1, checksum: "checksum", revision: 1 },
    source: "transfer",
    transfer: {
      protocolVersion: 1,
      encoding: "raw",
      buffer,
      storedByteLength: buffer.byteLength,
      originalByteLength: buffer.byteLength,
      storedSha256: sha256,
      originalSha256: sha256,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preferGzipSimulationRuntimeRecoveryCheckpoint", () => {
  it("compresses repetitive bytes while retaining exact source ownership and dual SHA proof", async () => {
    const checkpoint = await rawCheckpoint(new Uint8Array(64 * 1024).fill(65));
    const source = checkpoint.transfer.buffer;
    const prepared = await preferGzipSimulationRuntimeRecoveryCheckpoint(checkpoint);
    expect(prepared.checkpoint.source).toBe("transfer");
    expect(prepared.checkpoint.transfer.encoding).toBe("gzip");
    expect(prepared.metrics).toMatchObject({
      compressionAttempted: true,
      committedEncoding: "gzip",
      originalByteLength: 64 * 1024,
      originalSha256: checkpoint.transfer.originalSha256,
    });
    expect(prepared.metrics.storedByteLength).toBeLessThan(prepared.metrics.originalByteLength);
    expect(checkpoint.transfer.buffer).toBe(source);
    expect(checkpoint.transfer.buffer.byteLength).toBe(64 * 1024);
    const restored = await new Response(
      new Blob([prepared.checkpoint.transfer.buffer]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
    expect(await computeSimulationRuntimeDurableBytesSha256(restored)).toBe(checkpoint.transfer.originalSha256);
  });

  it("uses raw with an explicit unsupported diagnostic", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const checkpoint = await rawCheckpoint(Uint8Array.from([1, 2, 3]));
    const prepared = await preferGzipSimulationRuntimeRecoveryCheckpoint(checkpoint);
    expect(prepared.checkpoint).toBe(checkpoint);
    expect(prepared.metrics).toMatchObject({
      compressionAttempted: false,
      committedEncoding: "raw",
      fallbackReason: "unsupported",
      storedByteLength: 3,
    });
  });

  it("uses raw after a compression exception without detaching the source", async () => {
    vi.stubGlobal("CompressionStream", class {
      constructor() {
        throw new Error("compression unavailable");
      }
    });
    const checkpoint = await rawCheckpoint(Uint8Array.from([4, 5, 6]));
    const prepared = await preferGzipSimulationRuntimeRecoveryCheckpoint(checkpoint);
    expect(prepared.checkpoint).toBe(checkpoint);
    expect(prepared.metrics).toMatchObject({
      compressionAttempted: true,
      committedEncoding: "raw",
      fallbackReason: "compression-error",
    });
    expect([...new Uint8Array(checkpoint.transfer.buffer)]).toEqual([4, 5, 6]);
  });

  it("keeps tiny incompressible payloads raw when gzip is larger", async () => {
    const checkpoint = await rawCheckpoint(Uint8Array.from([9]));
    const prepared = await preferGzipSimulationRuntimeRecoveryCheckpoint(checkpoint);
    expect(prepared.checkpoint).toBe(checkpoint);
    expect(prepared.metrics).toMatchObject({
      compressionAttempted: true,
      committedEncoding: "raw",
      fallbackReason: "not-smaller",
    });
  });
});
