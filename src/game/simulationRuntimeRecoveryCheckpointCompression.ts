import {
  computeSimulationRuntimeDurableBytesSha256,
  type SimulationRuntimeDurableTransferCheckpoint,
} from "./simulationRuntimeDurableRecovery";

export type SimulationRuntimeRecoveryRawTransferCheckpoint = SimulationRuntimeDurableTransferCheckpoint & {
  transfer: SimulationRuntimeDurableTransferCheckpoint["transfer"] & { encoding: "raw" };
};

export type SimulationRuntimeRecoveryCheckpointCompressionFallbackReason =
  | "unsupported"
  | "compression-error"
  | "not-smaller";

export interface SimulationRuntimeRecoveryCheckpointCompressionMetrics {
  compressionAttempted: boolean;
  committedEncoding: "raw" | "gzip";
  originalByteLength: number;
  storedByteLength: number;
  originalSha256: string;
  storedSha256: string;
  compressionDurationMs: number;
  fallbackReason?: SimulationRuntimeRecoveryCheckpointCompressionFallbackReason;
}

export interface SimulationRuntimeRecoveryPreparedCheckpointCompression {
  checkpoint: SimulationRuntimeDurableTransferCheckpoint;
  metrics: SimulationRuntimeRecoveryCheckpointCompressionMetrics;
}

function durationSince(startedAt: number): number {
  return Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - startedAt);
}

function rawResult(
  checkpoint: SimulationRuntimeRecoveryRawTransferCheckpoint,
  startedAt: number,
  fallbackReason: SimulationRuntimeRecoveryCheckpointCompressionFallbackReason,
  compressionAttempted: boolean,
): SimulationRuntimeRecoveryPreparedCheckpointCompression {
  return {
    checkpoint,
    metrics: {
      compressionAttempted,
      committedEncoding: "raw",
      originalByteLength: checkpoint.transfer.originalByteLength,
      storedByteLength: checkpoint.transfer.storedByteLength,
      originalSha256: checkpoint.transfer.originalSha256,
      storedSha256: checkpoint.transfer.storedSha256,
      compressionDurationMs: durationSince(startedAt),
      fallbackReason,
    },
  };
}

/**
 * Worker-safe, zero-copy raw ownership boundary. The source buffer remains on
 * the input checkpoint; only the smaller gzip buffer is installed into the
 * derived checkpoint. Callers can transfer the original buffer back even if
 * compression or the later IndexedDB transaction fails.
 */
export async function preferGzipSimulationRuntimeRecoveryCheckpoint(
  checkpoint: SimulationRuntimeRecoveryRawTransferCheckpoint,
): Promise<SimulationRuntimeRecoveryPreparedCheckpointCompression> {
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  if (typeof CompressionStream === "undefined" || typeof Blob === "undefined" || typeof Response === "undefined") {
    return rawResult(checkpoint, startedAt, "unsupported", false);
  }
  try {
    const compressed = await new Response(
      new Blob([checkpoint.transfer.buffer]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    if (compressed.byteLength >= checkpoint.transfer.buffer.byteLength) {
      return rawResult(checkpoint, startedAt, "not-smaller", true);
    }
    const storedSha256 = await computeSimulationRuntimeDurableBytesSha256(compressed);
    return {
      checkpoint: {
        ...checkpoint,
        transfer: {
          ...checkpoint.transfer,
          encoding: "gzip",
          buffer: compressed,
          storedByteLength: compressed.byteLength,
          storedSha256,
        },
      },
      metrics: {
        compressionAttempted: true,
        committedEncoding: "gzip",
        originalByteLength: checkpoint.transfer.originalByteLength,
        storedByteLength: compressed.byteLength,
        originalSha256: checkpoint.transfer.originalSha256,
        storedSha256,
        compressionDurationMs: durationSince(startedAt),
      },
    };
  } catch {
    return rawResult(checkpoint, startedAt, "compression-error", true);
  }
}
