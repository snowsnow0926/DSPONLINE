import type { GameState } from "./types";

const CHUNK_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;

function memberJson(key: string, value: unknown): string | undefined {
  // Native JSON.stringify retains omission, numeric and toJSON(key) semantics.
  const json = JSON.stringify({ [key]: value });
  return json === "{}" ? undefined : json.slice(JSON.stringify(key).length + 2, -1);
}

function* stateJsonPieces(state: GameState): Generator<string> {
  // Runtime states loaded from saves are plain data. Do not fall back to a
  // second full-state JSON string for a custom root serializer.
  if ("toJSON" in state) throw new Error("原生离线来源不支持自定义根序列化");
  yield "{";
  let members = 0;
  for (const key of Object.keys(state)) {
    const value = (state as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value) && !("toJSON" in value)) {
      yield `${members++ > 0 ? "," : ""}${JSON.stringify(key)}:[`;
      const length = value.length;
      for (let index = 0; index < length; index++) {
        if (index > 0) yield ",";
        yield memberJson(String(index), value[index]) ?? "null";
      }
      yield "]";
    } else {
      const json = memberJson(key, value);
      if (json === undefined) continue;
      yield `${members++ > 0 ? "," : ""}${JSON.stringify(key)}:`;
      yield json;
    }
  }
  yield "}";
}

/** Exact v2 runtime envelope, streamed without a complete JSON string or buffer. */
export function* streamNativeOfflineSourceEnvelope(state: GameState, savedAt: number): Generator<ArrayBuffer> {
  if (state.version !== 47 || state.mode !== "normal" || !Number.isSafeInteger(savedAt) || savedAt < 0) {
    throw new Error("原生离线来源身份无效");
  }
  const encoder = new TextEncoder();
  let chunk = new Uint8Array(CHUNK_BYTES);
  let used = 0;
  let emittedBytes = 0;
  let checksum = 0x811c9dc5;
  const updateChecksum = (text: string) => {
    for (let index = 0; index < text.length; index++) checksum = Math.imul(checksum ^ text.charCodeAt(index), 0x01000193);
  };
  function flush(): ArrayBuffer {
    emittedBytes += used;
    if (emittedBytes > MAX_SOURCE_BYTES) throw new Error("原生离线来源超过传输上限");
    const result = used === chunk.byteLength ? chunk.buffer : chunk.buffer.slice(0, used);
    chunk = new Uint8Array(CHUNK_BYTES);
    used = 0;
    return result;
  }
  function* append(text: string): Generator<ArrayBuffer> {
    let offset = 0;
    while (offset < text.length) {
      const encoded = encoder.encodeInto(text.slice(offset), chunk.subarray(used));
      offset += encoded.read;
      used += encoded.written;
      // encodeInto never splits a surrogate pair at the end of a chunk.
      if (offset < text.length || used === chunk.byteLength) yield flush();
    }
  }
  yield* append(`{"formatVersion":2,"kind":"primary","savedAt":${savedAt},"mode":"normal","slot":"main","state":`);
  updateChecksum('{"formatVersion":2,"state":');
  for (const text of stateJsonPieces(state)) {
    updateChecksum(text);
    yield* append(text);
  }
  updateChecksum("}");
  yield* append(`,"checksum":"${(checksum >>> 0).toString(16).padStart(8, "0")}"}`);
  if (used > 0) yield flush();
}
