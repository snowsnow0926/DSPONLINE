import { describe, expect, it } from "vitest";
import { computeSavePayloadTextChecksum } from "./payloadTextChecksum";
import { computeSavePayloadChecksum } from "./saveTransfer";

function expectEncodedChecksum(value: string): void {
  const bytes = new TextEncoder().encode(value);
  expect(computeSavePayloadTextChecksum(value)).toEqual({
    checksum: computeSavePayloadChecksum(bytes),
    byteLength: bytes.byteLength,
  });
}

describe("UTF-8 payload text checksum", () => {
  it("preserves known FNV-1a values and every UTF-8 encoding boundary", () => {
    expect(computeSavePayloadTextChecksum("")).toEqual({ checksum: "811c9dc5", byteLength: 0 });
    expect(computeSavePayloadTextChecksum("hello")).toEqual({ checksum: "4f9f2cab", byteLength: 5 });
    for (const value of [
      "\u0000\u001f\u007f\u0080\u07ff\u0800\ud7ff\ue000\uffff",
      "磁石工厂🚀🌏", "\ud800", "\udbff", "\udc00", "\udfff",
      "\ud800\udc00", "\udbff\udfff", "\ud800x\udfff", "\udfff\ud800",
      "\ud800\ud800\udc00\udc00", "\udbff\udbff\udfff\udfff",
      '"escaped": "\\\\\\\"\n\r\t"',
    ]) expectEncodedChecksum(value);
  });

  it("matches TextEncoder for a sequence containing all UTF-16 code units", () => {
    const units = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code));
    expectEncodedChecksum(units.join(""));
    expectEncodedChecksum(units.reverse().join(""));
  });

  it("matches the byte-hash oracle for deterministic random Unicode and JSON text", () => {
    let seed = 0x127f0047;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const boundaries = [0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff];
    for (let sample = 0; sample < 128; sample += 1) {
      const value = Array.from({ length: next() % 1025 }, () => {
        const code = next();
        return String.fromCharCode(code % 3 === 0 ? boundaries[code % boundaries.length] : code & 0xffff);
      }).join("");
      expectEncodedChecksum(value);
      expectEncodedChecksum(JSON.stringify({ value, sample }));
    }
  });
});
