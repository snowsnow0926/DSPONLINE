import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { computeSaveStateChecksum } from "./saveEnvelopeIntegrity";
import {
  computeSavePayloadChecksum,
  computeSavePayloadTextChecksum,
  decodeVerifiedSaveTransfer,
  rewrapVerifiedPrimarySaveAsSnapshot,
  serializeSaveEnvelopeToTransfer,
} from "./saveTransfer";
import { inspectSave, parseTrustedWorkerEnvelope, prepareSaveStateForBackground } from "./storage";

describe("transferable save serialization", () => {
  it("rewraps a verified primary as exact fresh snapshot bytes without changing state JSON", () => {
    for (const mode of ["normal", "speedrun"] as const) {
      const state = { version: 47, mode, data: { text: '磁石🚀\ud800\n\\\"checksum\\\":\\\"abcdef00\\\"}', empty: {}, list: [] } };
      const source = { formatVersion: 2, mode, savedAt: 1800000000000 };
      const savedAt = source.savedAt + 1200;
      const reason = "自动快照/🚀\udfff\n";
      const primary = serializeSaveEnvelopeToTransfer(state, { ...source, kind: "primary", slot: "main" });
      const primaryRaw = decodeVerifiedSaveTransfer(primary.bytes, primary);
      const snapshot = rewrapVerifiedPrimarySaveAsSnapshot(primaryRaw, primary, source, savedAt, reason);
      const expected = serializeSaveEnvelopeToTransfer(state, { ...source, savedAt, kind: "snapshot", slot: "main", reason });
      expect(snapshot).not.toBeNull();
      expect(snapshot!.raw).toBe(decodeVerifiedSaveTransfer(expected.bytes, expected));
      expect(snapshot!.verification).toEqual({ integrity: "valid", stateChecksum: expected.stateChecksum, payloadChecksum: expected.payloadChecksum, byteLength: expected.byteLength });
      expect(snapshot!.verification.stateChecksum).toBe(primary.stateChecksum);
      expect(snapshot!.verification.payloadChecksum).not.toBe(primary.payloadChecksum);
      expect(JSON.parse(snapshot!.raw)).toMatchObject({ kind: "snapshot", reason, savedAt, mode, slot: "main", state });
      expect(JSON.parse(primaryRaw)).toMatchObject({ kind: "primary", savedAt: source.savedAt });
    }
  });

  it("declines altered proofs, payloads and noncanonical primary framing", () => {
    const state = { version: 47, mode: "normal", value: 123 };
    const source = { formatVersion: 2, mode: "normal" as const, savedAt: 100 };
    const primary = serializeSaveEnvelopeToTransfer(state, { ...source, kind: "primary", slot: "main" });
    const raw = decodeVerifiedSaveTransfer(primary.bytes, primary);
    const rewrap = (value: string, proof = primary, options = source, savedAt = 200) =>
      rewrapVerifiedPrimarySaveAsSnapshot(value, proof, options, savedAt, "自动快照");
    expect(rewrap(raw.replace('"value":123', '"value":124'))).toBeNull();
    expect(rewrap(raw.slice(0, -1))).toBeNull();
    expect(rewrap(raw, { ...primary, byteLength: primary.byteLength + 1 })).toBeNull();
    expect(rewrap(raw, { ...primary, payloadChecksum: "00000000" })).toBeNull();
    expect(rewrap(raw, { ...primary, stateChecksum: "00000000" })).toBeNull();
    expect(rewrap(raw, primary, { ...source, savedAt: 101 })).toBeNull();
    expect(rewrap(raw, primary, { ...source, formatVersion: 3 })).toBeNull();
    expect(rewrap(raw, primary, source, Number.NaN)).toBeNull();
    const parsed = JSON.parse(raw);
    for (const reordered of [JSON.stringify({ savedAt: parsed.savedAt, ...parsed }), ` ${raw}`, raw.replace('"kind":"primary"', '"kind":"snapshot"')]) {
      const payload = computeSavePayloadTextChecksum(reordered);
      expect(rewrap(reordered, { ...primary, payloadChecksum: payload.checksum, byteLength: payload.byteLength })).toBeNull();
    }
  });

  it("preserves exact envelope bytes for empty, Unicode and escaped states and headers", () => {
    const states = [
      null, false, 0, "", {}, [],
      { ascii: "iron_ore", unicode: "磁石🚀", twoByte: "\u0080\u07ff", threeByte: "\u0800\uffff" },
      { control: "\u0000\u001f\n\r\t\"\\", lone: "\ud800x\udfff", pair: "\udbff\udfff" },
      { 12: "numeric keys", 2: "before 12", nested: [{ empty: {} }, [], null], absent: undefined },
    ];
    for (const state of states) {
      for (const reason of [undefined, "", "自动保存/🚀\ud800\n"]) {
        const options = { formatVersion: 2, kind: "snapshot" as const, reason, savedAt: 1800000000000, mode: "normal" as const, slot: 2 as const };
        const checksum = computeSaveStateChecksum(options.formatVersion, state);
        const raw = JSON.stringify({
          formatVersion: options.formatVersion,
          kind: options.kind,
          ...(reason ? { reason } : {}),
          savedAt: options.savedAt,
          mode: options.mode,
          slot: options.slot,
          state,
          checksum,
        });
        const expectedBytes = new TextEncoder().encode(raw);
        const actual = serializeSaveEnvelopeToTransfer(state, options);
        expect(new Uint8Array(actual.bytes)).toEqual(expectedBytes);
        expect(actual).toMatchObject({
          stateChecksum: checksum,
          byteLength: expectedBytes.byteLength,
          payloadChecksum: computeSavePayloadChecksum(expectedBytes),
          integrity: "valid",
        });
        expect(decodeVerifiedSaveTransfer(actual.bytes, actual)).toBe(raw);
      }
    }
  });

  it("serializes state once and retains rejection of unserializable state", () => {
    const options = { formatVersion: 2, kind: "primary" as const, savedAt: 1, mode: "normal" as const, slot: "main" as const };
    let calls = 0;
    const transfer = serializeSaveEnvelopeToTransfer({ toJSON: () => ({ call: ++calls, label: "一次🚀" }) }, options);
    expect(calls).toBe(1);
    expect(JSON.parse(decodeVerifiedSaveTransfer(transfer.bytes, transfer)).state).toEqual({ call: 1, label: "一次🚀" });
    expect(() => serializeSaveEnvelopeToTransfer(undefined, options)).toThrow("存档状态无法序列化");
    expect(() => serializeSaveEnvelopeToTransfer(() => 1, options)).toThrow("存档状态无法序列化");
    expect(() => serializeSaveEnvelopeToTransfer(1n, options)).toThrow(TypeError);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => serializeSaveEnvelopeToTransfer(circular, options)).toThrow(TypeError);
  });

  it("serializes one authoritative state JSON and preserves the v2 checksum", () => {
    const state = prepareSaveStateForBackground(createInitialState());
    state.blueprints[0] = {
      id: "unicode-fixture",
      name: "磁石🚀工厂边界\ud800替换测试",
      entities: [],
      belts: [],
    };
    const transfer = serializeSaveEnvelopeToTransfer(state, {
      formatVersion: 2,
      kind: "primary",
      reason: "自动保存/完整性",
      savedAt: 1_786_377_600_000,
      mode: "normal",
      slot: "main",
    });
    const raw = decodeVerifiedSaveTransfer(transfer.bytes, transfer);
    const parsed = JSON.parse(raw) as { state: unknown; checksum: string };
    expect(parsed.checksum).toBe(computeSaveStateChecksum(2, parsed.state));
    expect(transfer.stateChecksum).toBe(parsed.checksum);
    expect(inspectSave(raw)).toMatchObject({ valid: true, checksum: "valid", mode: "normal" });
    expect(computeSavePayloadTextChecksum(raw)).toEqual({
      checksum: transfer.payloadChecksum,
      byteLength: transfer.byteLength,
    });
  });

  it("rejects truncated or modified transferable payloads before JSON parsing", () => {
    const transfer = serializeSaveEnvelopeToTransfer({ version: 46, mode: "normal", text: "单极磁石" }, {
      formatVersion: 2,
      kind: "snapshot",
      savedAt: 10,
      mode: "normal",
      slot: 2,
    });
    const modified = transfer.bytes.slice(0);
    new Uint8Array(modified)[Math.floor(modified.byteLength / 2)] ^= 1;
    expect(computeSavePayloadChecksum(modified)).not.toBe(transfer.payloadChecksum);
    expect(() => decodeVerifiedSaveTransfer(modified, transfer)).toThrow(/哈希/);
    expect(() => decodeVerifiedSaveTransfer(transfer.bytes.slice(0, -1), transfer)).toThrow(/长度/);
  });

  it("keeps speedrun mode and numeric slots in the transferable envelope", () => {
    const transfer = serializeSaveEnvelopeToTransfer({ version: 46, mode: "speedrun" }, {
      formatVersion: 2,
      kind: "slot",
      savedAt: 20,
      mode: "speedrun",
      slot: 3,
    });
    const parsed = JSON.parse(decodeVerifiedSaveTransfer(transfer.bytes, transfer));
    expect(parsed).toMatchObject({ formatVersion: 2, kind: "slot", savedAt: 20, mode: "speedrun", slot: 3 });
  });

  it("parses a verified sparse Worker envelope once and rejects a mismatched proof", () => {
    const source = createInitialState();
    const transfer = serializeSaveEnvelopeToTransfer(prepareSaveStateForBackground(source), {
      formatVersion: 2,
      kind: "primary",
      savedAt: 30,
      mode: "normal",
      slot: "main",
    });
    const raw = decodeVerifiedSaveTransfer(transfer.bytes, transfer);
    expect(parseTrustedWorkerEnvelope(raw, transfer)).toMatchObject({ version: source.version, mode: "normal" });
    expect(() => parseTrustedWorkerEnvelope(raw, { ...transfer, stateChecksum: "00000000" })).toThrow(/完整性证明/);
  });

  it("accepts a complete Worker runtime without creating a migration copy", () => {
    const source = createInitialState();
    const transfer = serializeSaveEnvelopeToTransfer(source, {
      formatVersion: 2,
      kind: "primary",
      savedAt: 40,
      mode: "normal",
      slot: "main",
    });
    const raw = decodeVerifiedSaveTransfer(transfer.bytes, transfer);
    const restored = parseTrustedWorkerEnvelope(raw, transfer, undefined, { persistentProjection: false });
    expect(restored).toEqual(JSON.parse(JSON.stringify(source)));
  });
});
