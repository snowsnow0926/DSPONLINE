import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSavePayloadChecksum, rewrapVerifiedPrimarySaveAsSnapshot,
  rewrapVerifiedPrimarySaveBytesAsSnapshot, serializeSaveEnvelopeToTransfer,
  type SaveTransferVerification } from "./saveTransfer";

const source = { formatVersion: 2, savedAt: 10, mode: "normal" as const };
afterEach(() => vi.restoreAllMocks());

describe("verified primary byte snapshot rewrap", () => {
  for (const mode of ["normal", "speedrun"] as const) {
    for (const reason of ["", "自动快照🚀", 'quoted "reason" \\ \n \ud800']) {
      it(`keeps exact bytes and state proof for ${mode}/${JSON.stringify(reason)}`, () => {
        const state = { version: 47, extension: { 'escaped"key\\': [0, -0, 0.125, 1e30, null],
          text: '中文🚀\u0080\u07ff\u0800\uffff\ufeff\ud800\udfff\n\\"}' }, empty: {} };
        const input = serializeSaveEnvelopeToTransfer(state, { ...source, mode, kind: "primary", slot: "main" });
        const untouched = input.bytes.slice(0);
        const legacy = rewrapVerifiedPrimarySaveAsSnapshot(new TextDecoder().decode(input.bytes), input,
          { ...source, mode }, 999, reason)!;
        const expected = serializeSaveEnvelopeToTransfer(state, { ...source, mode, savedAt: 999, reason, kind: "snapshot", slot: "main" });
        const actual = rewrapVerifiedPrimarySaveBytesAsSnapshot(input.bytes, input, { ...source, mode }, 999, reason)!;
        expect(new Uint8Array(actual.bytes)).toEqual(new Uint8Array(expected.bytes));
        expect(new TextDecoder().decode(actual.bytes)).toBe(legacy.raw);
        expect(actual.verification).toEqual(legacy.verification);
        expect(actual.verification.stateChecksum).toBe(input.stateChecksum);
        expect(new Uint8Array(input.bytes)).toEqual(new Uint8Array(untouched));
      });
    }
  }

  it.each(["é", "中", "🚀"])("validates a %s sequence split across a decoder boundary without whole-body text", (text) => {
    const tiny = serializeSaveEnvelopeToTransfer({ text }, { ...source, kind: "primary", slot: "main" });
    const offset = new TextDecoder().decode(tiny.bytes).indexOf(text);
    const state = { text: "x".repeat(65535 - offset) + text + "z".repeat(131100) };
    const input = serializeSaveEnvelopeToTransfer(state, { ...source, kind: "primary", slot: "main" });
    const expected = serializeSaveEnvelopeToTransfer(state, { ...source, savedAt: 11, kind: "snapshot", slot: "main", reason: "自动快照" });
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const actual = rewrapVerifiedPrimarySaveBytesAsSnapshot(input.bytes, input, source, 11, "自动快照")!;
    const sizes = decode.mock.calls.map(([value]) => value?.byteLength ?? 0);
    expect(sizes.filter((size) => size > 0).length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(input.byteLength / 2);
    expect(encode.mock.calls.every(([value]) => !value || value.length < 1024)).toBe(true);
    decode.mockRestore(); encode.mockRestore();
    expect(new Uint8Array(actual.bytes)).toEqual(new Uint8Array(expected.bytes));
  });

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid snapshot time %s", (savedAt) => {
    const input = serializeSaveEnvelopeToTransfer({}, { ...source, kind: "primary", slot: "main" });
    expect(rewrapVerifiedPrimarySaveBytesAsSnapshot(input.bytes, input, source, savedAt, "自动快照")).toBeNull();
  });

  it.each(["length", "checksum", "state-checksum", "integrity", "source-time", "source-version", "source-mode"])(
    "rejects mismatched %s proof/framing", (damage) => {
      const input = serializeSaveEnvelopeToTransfer({ marker: "keep" }, { ...source, kind: "primary", slot: "main" });
      const proof = { ...input } as SaveTransferVerification;
      const options = { ...source };
      if (damage === "length") proof.byteLength++;
      if (damage === "checksum") proof.payloadChecksum = "00000000";
      if (damage === "state-checksum") proof.stateChecksum = "00000000";
      if (damage === "integrity") proof.integrity = "corrupt" as "valid";
      if (damage === "source-time") options.savedAt++;
      if (damage === "source-version") options.formatVersion++;
      if (damage === "source-mode") options.mode = "speedrun" as "normal";
      expect(rewrapVerifiedPrimarySaveBytesAsSnapshot(input.bytes, proof, options, 11, "自动快照")).toBeNull();
    });

  it.each(["leading-space", "bom", "reordered", "non-object", "extra-tail"])("keeps the exact-frame rejection for %s", (kind) => {
    const input = serializeSaveEnvelopeToTransfer({ marker: "keep" }, { ...source, kind: "primary", slot: "main" });
    const raw = new TextDecoder().decode(input.bytes);
    const altered = kind === "leading-space" ? " " + raw : kind === "bom" ? "\ufeff" + raw
      : kind === "reordered" ? raw.replace('"formatVersion":2,"kind":"primary"', '"kind":"primary","formatVersion":2')
        : kind === "non-object" ? raw.replace('{"marker":"keep"}', '"keep"') : raw + " ";
    const bytes = new TextEncoder().encode(altered).buffer;
    const proof = { ...input, byteLength: bytes.byteLength, payloadChecksum: computeSavePayloadChecksum(bytes) };
    expect(rewrapVerifiedPrimarySaveBytesAsSnapshot(bytes, proof, source, 11, "自动快照")).toBeNull();
    expect(rewrapVerifiedPrimarySaveAsSnapshot(altered, proof, source, 11, "自动快照")).toBeNull();
  });

  it.each([[0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82]].map(invalid => ({ invalid })))(
    "rejects invalid UTF-8 inside a checksum-matching frame: $invalid", ({ invalid }) => {
      const input = serializeSaveEnvelopeToTransfer({ text: "needle" }, { ...source, kind: "primary", slot: "main" });
      const raw = new TextDecoder().decode(input.bytes);
      const offset = raw.indexOf("needle");
      const view = new Uint8Array(input.bytes);
      const bytes = Uint8Array.from([...view.subarray(0, offset), ...invalid, ...view.subarray(offset + 6)]).buffer;
      const proof = { ...input, byteLength: bytes.byteLength, payloadChecksum: computeSavePayloadChecksum(bytes) };
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toThrow();
      expect(rewrapVerifiedPrimarySaveBytesAsSnapshot(bytes, proof, source, 11, "自动快照")).toBeNull();
    });
});
