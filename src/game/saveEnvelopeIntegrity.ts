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
      hash = appendSaveChecksumCodeUnit(hash, chunk.charCodeAt(index));
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function appendSaveChecksumCodeUnit(hash: number, codeUnit: number): number {
  return Math.imul(hash ^ codeUnit, 0x01000193);
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

/**
 * The transfer serializer needs both the v2 UTF-16 checksum and the UTF-8
 * allocation size. Read the large state JSON once for both, while retaining
 * both UTF-16 code units in the checksum of each four-byte surrogate pair.
 * byteLength describes stateJson only, excluding the checksum wrapper.
 */
export function measureSaveStateJson(formatVersion: number, stateJson: string): { stateChecksum: string; byteLength: number } {
  const prefix = `{"formatVersion":${JSON.stringify(formatVersion)},"state":`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < prefix.length; index += 1) {
    hash = appendSaveChecksumCodeUnit(hash, prefix.charCodeAt(index));
  }
  let byteLength = 0;
  for (let index = 0; index < stateJson.length; index += 1) {
    const code = stateJson.charCodeAt(index);
    hash = appendSaveChecksumCodeUnit(hash, code);
    if (code <= 0x7f) byteLength += 1;
    else if (code <= 0x7ff) byteLength += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < stateJson.length) {
      const low = stateJson.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        hash = appendSaveChecksumCodeUnit(hash, low);
        byteLength += 4;
        index += 1;
      } else byteLength += 3;
    } else byteLength += 3;
  }
  hash = appendSaveChecksumCodeUnit(hash, 0x7d);
  return { stateChecksum: (hash >>> 0).toString(16).padStart(8, "0"), byteLength };
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
