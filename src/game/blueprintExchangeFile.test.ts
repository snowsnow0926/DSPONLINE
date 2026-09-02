import { describe, expect, it, vi } from "vitest";

import { NATIVE_BLUEPRINT_IMPORT_RAW_BYTES } from "./nativeBlueprintImportInput";
import { dispatchBlueprintExchangeFile, readBlueprintExchangeFile } from "./blueprintExchangeFile";

function file(bytes: Uint8Array, reportedSize = bytes.byteLength) {
  return {
    size: reportedSize,
    arrayBuffer: vi.fn(async () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer),
  };
}

describe("Web blueprint exchange file ingress", () => {
  it("rejects metadata above one MiB without reading the file", async () => {
    const source = file(new Uint8Array([0x7b, 0x7d]), NATIVE_BLUEPRINT_IMPORT_RAW_BYTES + 1);
    await expect(readBlueprintExchangeFile(source)).resolves.toEqual({ ok: false, reason: "too-large" });
    expect(source.arrayBuffer).not.toHaveBeenCalled();
  });

  it("reads arrayBuffer and rejects an exact-size race before returning import text", async () => {
    const source = file(new Uint8Array([0x7b, 0x7d]), 1);
    await expect(readBlueprintExchangeFile(source)).resolves.toEqual({ ok: false, reason: "too-large" });
    expect(source.arrayBuffer).toHaveBeenCalledOnce();

    const grown = file(new Uint8Array(NATIVE_BLUEPRINT_IMPORT_RAW_BYTES + 1), NATIVE_BLUEPRINT_IMPORT_RAW_BYTES);
    await expect(readBlueprintExchangeFile(grown)).resolves.toEqual({ ok: false, reason: "too-large" });
    expect(grown.arrayBuffer).toHaveBeenCalledOnce();
  });

  it("accepts exactly one MiB and dispatches the byte-identical text once", async () => {
    const bytes = new Uint8Array(NATIVE_BLUEPRINT_IMPORT_RAW_BYTES).fill(0x20);
    bytes[0] = 0x7b;
    bytes[1] = 0x7d;
    const onImport = vi.fn();
    const result = await dispatchBlueprintExchangeFile(file(bytes), onImport);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.rawBytes : -1).toBe(NATIVE_BLUEPRINT_IMPORT_RAW_BYTES);
    expect(onImport).toHaveBeenCalledOnce();
    expect(new TextEncoder().encode(onImport.mock.calls[0][0])).toEqual(bytes);
  });

  it("uses fatal UTF-8 and preserves exact bytes through decoding", async () => {
    const onImport = vi.fn();
    await expect(dispatchBlueprintExchangeFile(file(new Uint8Array([0xc3, 0x28])), onImport))
      .resolves.toEqual({ ok: false, reason: "invalid-utf8" });
    expect(onImport).not.toHaveBeenCalled();

    const bytes = new TextEncoder().encode("{\"name\":\"蓝图\"}");
    const result = await dispatchBlueprintExchangeFile(file(bytes), onImport);
    expect(result).toEqual({ ok: true, raw: "{\"name\":\"蓝图\"}", rawBytes: bytes.byteLength });
    expect(new TextEncoder().encode(result.ok ? result.raw : "")).toEqual(bytes);
    expect(onImport).toHaveBeenCalledOnce();
    expect(onImport).toHaveBeenCalledWith("{\"name\":\"蓝图\"}");
  });
});
