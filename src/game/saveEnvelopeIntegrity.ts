export type SaveEnvelopeChecksumStatus = "valid" | "missing" | "invalid";

export interface SaveEnvelopeChecksumInspection {
  parsed: Record<string, unknown> | null;
  formatVersion: number | null;
  state: Record<string, unknown> | null;
  recordedChecksum: string | null;
  computedChecksum: string | null;
  status: SaveEnvelopeChecksumStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Save envelope v2 uses FNV-1a over JavaScript UTF-16 code units. */
export function computeSaveStateChecksum(formatVersion: number, state: unknown): string {
  const payload = JSON.stringify({ formatVersion, state });
  return computeSaveChecksumChunks([payload]);
}

function computeSaveChecksumChunks(chunks: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      hash ^= chunk.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Compute the v2 checksum from the exact JSON text that will be embedded in
 * the envelope. This lets save workers serialize the large state only once.
 */
export function computeSaveStateChecksumFromJson(formatVersion: number, stateJson: string): string {
  return computeSaveChecksumChunks([
    `{"formatVersion":${JSON.stringify(formatVersion)},"state":`,
    stateJson,
    "}",
  ]);
}

export function inspectSaveEnvelopeChecksum(raw: string): SaveEnvelopeChecksumInspection {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { parsed: null, formatVersion: null, state: null, recordedChecksum: null, computedChecksum: null, status: "invalid" };
    }
    const state = isRecord(parsed.state) ? parsed.state : null;
    const formatVersion = typeof parsed.formatVersion === "number" && Number.isFinite(parsed.formatVersion)
      ? Math.floor(parsed.formatVersion)
      : null;
    const recordedChecksum = typeof parsed.checksum === "string" && parsed.checksum.length > 0 ? parsed.checksum : null;
    if (!state || formatVersion === null) {
      return { parsed, formatVersion, state, recordedChecksum, computedChecksum: null, status: recordedChecksum ? "invalid" : "missing" };
    }
    const computedChecksum = computeSaveStateChecksum(formatVersion, state);
    return {
      parsed,
      formatVersion,
      state,
      recordedChecksum,
      computedChecksum,
      status: recordedChecksum === null ? "missing" : recordedChecksum === computedChecksum ? "valid" : "invalid",
    };
  } catch {
    return { parsed: null, formatVersion: null, state: null, recordedChecksum: null, computedChecksum: null, status: "invalid" };
  }
}
