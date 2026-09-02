import { describe, expect, it } from "vitest";
import { safeExportFileName } from "./fileExport";

describe("native-safe file export names", () => {
  it("removes reserved path characters without discarding the extension", () => {
    expect(safeExportFileName('a/b:c*?"d<e>|.json')).toBe("a-b-c---d-e--.json");
  });

  it("uses a stable fallback and bounds excessively long names", () => {
    expect(safeExportFileName("   ")).toBe("dsp-export.json");
    expect(safeExportFileName("a".repeat(200))).toHaveLength(120);
  });

  it("prefixes every Win32 ASCII and superscript device alias, including extensions", () => {
    const devices = [
      "CON", "PRN", "AUX", "NUL",
      ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
      ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
      "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³",
    ];
    for (const device of devices) {
      expect(safeExportFileName(device)).toBe(`_${device}`);
      expect(safeExportFileName(`${device.toLowerCase()}.json`)).toBe(`_${device.toLowerCase()}.json`);
    }
    expect(safeExportFileName("COM0.json")).toBe("COM0.json");
    expect(safeExportFileName("COM⁴.json")).toBe("COM⁴.json");
  });

  it("removes Windows-trimmed suffixes and preserves the extension at the 120-character boundary", () => {
    expect(safeExportFileName("report.   ")).toBe("report");
    expect(safeExportFileName("...   ")).toBe("dsp-export.json");
    const exact = `${"a".repeat(115)}.json`;
    expect(safeExportFileName(exact)).toBe(exact);
    const over = `${"a".repeat(116)}.json`;
    expect(safeExportFileName(over)).toBe(`${"a".repeat(115)}.json`);
    expect(safeExportFileName(over)).toHaveLength(120);
    const compound = `${"b".repeat(120)}.json.gz`;
    expect(safeExportFileName(compound)).toBe(`${"b".repeat(112)}.json.gz`);
    expect(safeExportFileName(compound)).toHaveLength(120);
  });
});
