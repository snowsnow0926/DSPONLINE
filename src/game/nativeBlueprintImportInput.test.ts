import { describe, expect, it, vi } from "vitest";

import {
  NATIVE_BLUEPRINT_IMPORT_RAW_BYTES,
  readNativeBlueprintImportFile,
  validateNativeBlueprintImportRaw,
} from "./nativeBlueprintImportInput";

function file(bytes: Uint8Array, reportedSize = bytes.byteLength) {
  return {
    size: reportedSize,
    arrayBuffer: vi.fn(async () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer),
  };
}

describe("native blueprint import raw boundary", () => {
  it("preserves valid pasted UTF-8 source without parsing or trimming", () => {
    const raw = " \n{\"name\":\"蓝图\"}\n";
    expect(validateNativeBlueprintImportRaw(raw)).toEqual({
      ok: true,
      raw,
      rawBytes: new TextEncoder().encode(raw).byteLength,
    });
  });

  it("rejects empty, lone-surrogate, and oversized paste input", () => {
    expect(validateNativeBlueprintImportRaw(" \n\t ")).toEqual({ ok: false, reason: "empty" });
    expect(validateNativeBlueprintImportRaw("{\"x\":\"\ud800\"}"))
      .toEqual({ ok: false, reason: "invalid-unicode" });
    expect(validateNativeBlueprintImportRaw("x".repeat(NATIVE_BLUEPRINT_IMPORT_RAW_BYTES + 1)))
      .toEqual({ ok: false, reason: "too-large" });
  });

  it("refuses file metadata above one MiB before reading any bytes", async () => {
    const source = file(new Uint8Array([0x7b, 0x7d]), NATIVE_BLUEPRINT_IMPORT_RAW_BYTES + 1);
    await expect(readNativeBlueprintImportFile(source)).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(source.arrayBuffer).not.toHaveBeenCalled();
  });

  it("fatal-decodes UTF-8 and rejects a size race", async () => {
    await expect(readNativeBlueprintImportFile(file(new Uint8Array([0xc3, 0x28]))))
      .resolves.toEqual({ ok: false, reason: "invalid-utf8" });
    await expect(readNativeBlueprintImportFile(file(new Uint8Array([0x7b, 0x7d]), 1)))
      .resolves.toEqual({ ok: false, reason: "too-large" });
  });

  it("preserves a UTF-8 BOM through an exact byte round trip", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    const result = await readNativeBlueprintImportFile(file(bytes));
    expect(result).toEqual({ ok: true, raw: "\ufeff{}", rawBytes: 5 });
    expect(new TextEncoder().encode(result.ok ? result.raw : "")).toEqual(bytes);
  });
});
