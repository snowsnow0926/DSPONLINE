export interface CanonicalSaveEnvelopeStateSummary {
  mode: "normal" | "speedrun";
  version: number;
  activePlanetId: string;
  entityCount: number;
  beltCount: number;
  elapsedSeconds: number;
  completedTechCount: number;
  structurePoints: number;
}

export interface CanonicalSaveEnvelopeInspection {
  formatVersion: number;
  kind: "primary" | "slot" | "snapshot";
  savedAt: number;
  mode: "normal" | "speedrun";
  slot: "main" | 1 | 2 | 3;
  recordedChecksum: string;
  computedChecksum: string;
  state: CanonicalSaveEnvelopeStateSummary;
}

interface JsonRange {
  start: number;
  end: number;
}

const MAX_SCALAR_CHARS = 4_096;

function skipWhitespace(raw: string, index: number, end: number): number {
  while (index < end && /[\t\n\r ]/.test(raw[index])) index += 1;
  return index;
}

function skipJsonString(raw: string, start: number, end: number): number {
  if (raw[start] !== '"') throw new Error("expected JSON string");
  for (let index = start + 1; index < end; index += 1) {
    const code = raw.charCodeAt(index);
    if (code === 0x22) return index + 1;
    if (code < 0x20) throw new Error("invalid JSON control character");
    if (code !== 0x5c) continue;
    index += 1;
    if (index >= end || !'"\\/bfnrtu'.includes(raw[index])) throw new Error("invalid JSON escape");
    if (raw[index] === "u") {
      if (index + 4 >= end || !/^[0-9a-fA-F]{4}$/.test(raw.slice(index + 1, index + 5))) {
        throw new Error("invalid JSON unicode escape");
      }
      index += 4;
    }
  }
  throw new Error("unterminated JSON string");
}

function skipCompositeJsonValue(raw: string, start: number, end: number): number {
  const stack: string[] = [raw[start]];
  for (let index = start + 1; index < end; index += 1) {
    const char = raw[index];
    if (char === '"') {
      index = skipJsonString(raw, index, end) - 1;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const open = stack.pop();
      if (open !== (char === "}" ? "{" : "[")) throw new Error("mismatched JSON container");
      if (stack.length === 0) return index + 1;
    }
  }
  throw new Error("unterminated JSON container");
}

function skipJsonValue(raw: string, start: number, end: number): number {
  const index = skipWhitespace(raw, start, end);
  const first = raw[index];
  if (first === '"') return skipJsonString(raw, index, end);
  if (first === "{" || first === "[") return skipCompositeJsonValue(raw, index, end);
  let cursor = index;
  while (cursor < end && !/[,}\]\t\n\r ]/.test(raw[cursor])) cursor += 1;
  if (cursor === index) throw new Error("missing JSON value");
  return cursor;
}

function objectPropertyRanges(raw: string, range: JsonRange): Map<string, JsonRange> {
  let cursor = skipWhitespace(raw, range.start, range.end);
  if (raw[cursor] !== "{") throw new Error("expected JSON object");
  cursor = skipWhitespace(raw, cursor + 1, range.end);
  const properties = new Map<string, JsonRange>();
  if (raw[cursor] === "}") return properties;
  while (cursor < range.end) {
    const keyStart = cursor;
    const keyEnd = skipJsonString(raw, keyStart, range.end);
    const keyRaw = raw.slice(keyStart, keyEnd);
    if (keyRaw.length > 512) throw new Error("JSON key too long");
    const key = JSON.parse(keyRaw) as unknown;
    if (typeof key !== "string" || properties.has(key)) throw new Error("invalid or duplicate JSON key");
    cursor = skipWhitespace(raw, keyEnd, range.end);
    if (raw[cursor] !== ":") throw new Error("missing JSON colon");
    const valueStart = skipWhitespace(raw, cursor + 1, range.end);
    const valueEnd = skipJsonValue(raw, valueStart, range.end);
    properties.set(key, { start: valueStart, end: valueEnd });
    cursor = skipWhitespace(raw, valueEnd, range.end);
    if (raw[cursor] === "}") return properties;
    if (raw[cursor] !== ",") throw new Error("missing JSON comma");
    cursor = skipWhitespace(raw, cursor + 1, range.end);
  }
  throw new Error("unterminated JSON object");
}

function requiredRange(properties: Map<string, JsonRange>, key: string): JsonRange {
  const range = properties.get(key);
  if (!range) throw new Error(`missing JSON property ${key}`);
  return range;
}

function parseScalar(raw: string, range: JsonRange): unknown {
  if (range.end - range.start > MAX_SCALAR_CHARS) throw new Error("JSON scalar too large");
  return JSON.parse(raw.slice(range.start, range.end)) as unknown;
}

function finiteInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid non-negative integer");
  return value;
}

function finiteNonNegativeFloor(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid non-negative number");
  return Math.floor(value);
}

function saveMode(value: unknown): "normal" | "speedrun" {
  if (value !== "normal" && value !== "speedrun") throw new Error("invalid save mode");
  return value;
}

function saveKind(value: unknown): "primary" | "slot" | "snapshot" {
  if (value !== "primary" && value !== "slot" && value !== "snapshot") throw new Error("invalid save kind");
  return value;
}

function saveSlot(value: unknown): "main" | 1 | 2 | 3 {
  if (value !== "main" && value !== 1 && value !== 2 && value !== 3) throw new Error("invalid save slot");
  return value;
}

function countArrayElements(raw: string, range: JsonRange): number {
  let cursor = skipWhitespace(raw, range.start, range.end);
  if (raw[cursor] !== "[") throw new Error("expected JSON array");
  cursor = skipWhitespace(raw, cursor + 1, range.end);
  if (raw[cursor] === "]") return 0;
  let count = 0;
  while (cursor < range.end) {
    cursor = skipJsonValue(raw, cursor, range.end);
    count += 1;
    if (!Number.isSafeInteger(count)) throw new Error("JSON array too large");
    cursor = skipWhitespace(raw, cursor, range.end);
    if (raw[cursor] === "]") return count;
    if (raw[cursor] !== ",") throw new Error("missing JSON array comma");
    cursor = skipWhitespace(raw, cursor + 1, range.end);
  }
  throw new Error("unterminated JSON array");
}

function checksumRange(formatVersion: number, raw: string, state: JsonRange): string {
  let hash = 0x811c9dc5;
  const mix = (value: string, start = 0, end = value.length) => {
    for (let index = start; index < end; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  mix(`{"formatVersion":${JSON.stringify(formatVersion)},"state":`);
  mix(raw, state.start, state.end);
  mix("}");
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Inspect a canonical envelope without JSON.parse-ing the multi-megabyte
 * state. Only scalar slices are materialized; entities and belts are counted
 * by a string/range scanner and the state checksum is computed in-place.
 */
function inspectCanonicalSaveEnvelopeUnsafe(raw: string): CanonicalSaveEnvelopeInspection {
    const envelopeRange = { start: 0, end: raw.length };
    const envelope = objectPropertyRanges(raw, envelopeRange);
    const formatVersion = finiteInteger(parseScalar(raw, requiredRange(envelope, "formatVersion")));
    const kind = saveKind(parseScalar(raw, requiredRange(envelope, "kind")));
    const savedAt = finiteInteger(parseScalar(raw, requiredRange(envelope, "savedAt")));
    const mode = saveMode(parseScalar(raw, requiredRange(envelope, "mode")));
    const slot = saveSlot(parseScalar(raw, requiredRange(envelope, "slot")));
    const recordedChecksumValue = parseScalar(raw, requiredRange(envelope, "checksum"));
    if (typeof recordedChecksumValue !== "string" || !/^[0-9a-f]{8}$/.test(recordedChecksumValue)) {
      throw new Error("invalid recorded checksum");
    }
    const stateRange = requiredRange(envelope, "state");
    const state = objectPropertyRanges(raw, stateRange);
    const stateMode = saveMode(parseScalar(raw, requiredRange(state, "mode")));
    const research = objectPropertyRanges(raw, requiredRange(state, "research"));
    const dysonSphere = objectPropertyRanges(raw, requiredRange(state, "dysonSphere"));
    const activePlanetId = parseScalar(raw, requiredRange(state, "activePlanetId"));
    if (typeof activePlanetId !== "string" || activePlanetId.length > 128) throw new Error("invalid active planet id");
    return {
      formatVersion,
      kind,
      savedAt,
      mode,
      slot,
      recordedChecksum: recordedChecksumValue,
      computedChecksum: checksumRange(formatVersion, raw, stateRange),
      state: {
        mode: stateMode,
        version: finiteInteger(parseScalar(raw, requiredRange(state, "version"))),
        activePlanetId,
        entityCount: countArrayElements(raw, requiredRange(state, "entities")),
        beltCount: countArrayElements(raw, requiredRange(state, "belts")),
        elapsedSeconds: finiteNonNegativeFloor(parseScalar(raw, requiredRange(state, "elapsedSeconds"))),
        completedTechCount: countArrayElements(raw, requiredRange(research, "completedTechIds")),
        structurePoints: finiteInteger(parseScalar(raw, requiredRange(dysonSphere, "structurePoints"))),
      },
    };
}

export function inspectCanonicalSaveEnvelopeOrThrow(raw: string): CanonicalSaveEnvelopeInspection {
  return inspectCanonicalSaveEnvelopeUnsafe(raw);
}

export function inspectCanonicalSaveEnvelope(raw: string): CanonicalSaveEnvelopeInspection | null {
  try {
    return inspectCanonicalSaveEnvelopeUnsafe(raw);
  } catch {
    return null;
  }
}
