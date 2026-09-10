import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { streamNativeOfflineSourceEnvelope } from "./nativeOfflineSource";
import { decodeVerifiedSaveTransfer, serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import type { GameState } from "./types";

function collect(state: GameState) {
  const chunks = [...streamNativeOfflineSourceEnvelope(state, 42)];
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    expect(chunk.byteLength).toBeGreaterThan(0);
    expect(chunk.byteLength).toBeLessThanOrEqual(256 * 1024);
    result.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return { chunks, result };
}

describe("streamed native offline source envelope", () => {
  it("emits exactly the established v2 bytes and UTF-16 checksum", () => {
    const state = createInitialState();
    const expected = serializeSaveEnvelopeToTransfer(state, {
      formatVersion: 2, kind: "primary", mode: "normal", slot: "main", savedAt: 42,
    });
    const { result } = collect(state);
    expect(result).toEqual(new Uint8Array(expected.bytes));
    expect(JSON.parse(decodeVerifiedSaveTransfer(result.buffer, expected)).state).toEqual(JSON.parse(JSON.stringify(state)));
  });

  it("preserves surrogate escaping, omission, sparse arrays and nested toJSON keys", () => {
    const state = { ...createInitialState(),
      textFixture: { missing: undefined, text: "临界🚀\ud800\udfff\u2028", number: -0 },
      arrayFixture: [undefined, , null, { toJSON: (key: string) => ({ key, label: "工厂" }) }],
    } as GameState;
    const expected = serializeSaveEnvelopeToTransfer(state, {
      formatVersion: 2, kind: "primary", mode: "normal", slot: "main", savedAt: 42,
    });
    expect(collect(state).result).toEqual(new Uint8Array(expected.bytes));
  });

  it("streams a multi-chunk factory without changing the loaded runtime", () => {
    const state = createInitialState();
    const entity = state.entities[0];
    state.entities = Array.from({ length: 2048 }, (_, index) => ({ ...entity, id: `stream-${index}` }));
    const before = JSON.stringify(state);
    const expected = serializeSaveEnvelopeToTransfer(state, {
      formatVersion: 2, kind: "primary", mode: "normal", slot: "main", savedAt: 42,
    });
    const { chunks, result } = collect(state);
    expect(chunks.length).toBeGreaterThan(1);
    expect(result).toEqual(new Uint8Array(expected.bytes));
    expect(JSON.stringify(state)).toBe(before);
  });

  it("rejects invalid source identity before yielding any bytes", () => {
    expect(() => [...streamNativeOfflineSourceEnvelope({ ...createInitialState(), version: 46 }, 42)]).toThrow("身份无效");
    expect(() => [...streamNativeOfflineSourceEnvelope(createInitialState(), -1)]).toThrow("身份无效");
  });
});
