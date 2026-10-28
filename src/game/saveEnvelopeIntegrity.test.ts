import { describe, expect, it } from "vitest";
import { computeSaveStateChecksumFromJson, measureSaveStateJson } from "./saveEnvelopeIntegrity";

describe("combined save JSON measurement", () => {
  it("matches the v2 checksum and TextEncoder at every UTF-8 boundary", () => {
    const values = [
      "", "null", "{}", "[]", "ASCII 0123456789",
      "\u0000\u0001\u001f\u007f\u0080\u07ff\u0800\uffff",
      "磁石工厂🚀😀", "\ud800", "\udbff", "\udc00", "\udfff",
      "\ud800\udc00", "\udbff\udfff", "\ud800x\udc00", "\ud800\ud800\udc00\udc00",
    ];
    for (const formatVersion of [2, 47, -0, 2.5, 1e30, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const value of values) {
        expect(measureSaveStateJson(formatVersion, value)).toEqual({
          stateChecksum: computeSaveStateChecksumFromJson(formatVersion, value),
          byteLength: new TextEncoder().encode(value).byteLength,
        });
      }
    }
  });

  it("matches independent hash and encoding passes for deterministic UTF-16 mixtures", () => {
    let seed = 0x1275a9;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const boundaries = [0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff];
    for (let sample = 0; sample < 128; sample += 1) {
      const value = Array.from({ length: next() % 513 }, () => {
        const code = next();
        return String.fromCharCode(code % 3 === 0 ? boundaries[code % boundaries.length] : code & 0xffff);
      }).join("");
      for (const stateJson of [value, JSON.stringify({ value, index: sample })]) {
        expect(measureSaveStateJson(2, stateJson)).toEqual({
          stateChecksum: computeSaveStateChecksumFromJson(2, stateJson),
          byteLength: new TextEncoder().encode(stateJson).byteLength,
        });
      }
    }
  });
});
