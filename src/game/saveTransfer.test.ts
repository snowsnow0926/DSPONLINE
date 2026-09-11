import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { computeSaveStateChecksum } from "./saveEnvelopeIntegrity";
import {
  computeSavePayloadChecksum,
  computeSavePayloadTextChecksum,
  decodeVerifiedSaveTransfer,
  serializeSaveEnvelopeToTransfer,
} from "./saveTransfer";
import { inspectSave, parseTrustedWorkerEnvelope, prepareSaveStateForBackground } from "./storage";

describe("transferable save serialization", () => {
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
