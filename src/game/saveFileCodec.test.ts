import { describe, expect, it } from "vitest";
import { compressSaveTextToGzipBlob, decodeSaveFileBytes, readSaveFileBytes, readSaveFileText } from "./saveFileCodec";

describe("save file codec", () => {
  it("round-trips compressed .json.gz files and keeps legacy JSON imports", async () => {
    const raw = JSON.stringify({ formatVersion: 2, state: { marker: "belt".repeat(50_000) } });
    const compressed = await compressSaveTextToGzipBlob(raw);
    expect(compressed).not.toBeNull();
    expect(compressed!.size).toBeLessThan(new TextEncoder().encode(raw).byteLength / 10);
    expect(await readSaveFileText(new File([compressed!], "save.json.gz", { type: "application/gzip" }))).toBe(raw);
    expect(await readSaveFileText(new File([raw], "save.json", { type: "application/json" }))).toBe(raw);
  });

  it("reads local files as bounded UTF-8 bytes without changing the legacy text API", async () => {
    const raw = JSON.stringify({ marker: "量子仓库🚀".repeat(100) });
    const file = new File([raw], "save.json", { type: "application/json" });
    const bytes = await readSaveFileBytes(file);
    expect(bytes.byteLength).toBe(new TextEncoder().encode(raw).byteLength);
    expect(decodeSaveFileBytes(bytes)).toBe(raw);

    const compressed = await compressSaveTextToGzipBlob(raw);
    expect(compressed).not.toBeNull();
    const compressedBytes = await readSaveFileBytes(new File([compressed!], "save.json.gz"));
    expect(decodeSaveFileBytes(compressedBytes)).toBe(raw);
  });

  it("rejects empty and corrupt gzip files with a stable player-facing reason", async () => {
    await expect(readSaveFileText(new File([], "empty.json"))).rejects.toThrow(/为空/);
    await expect(readSaveFileText(new File([Uint8Array.from([0x1f, 0x8b, 0, 1, 2])], "broken.json.gz")))
      .rejects.toThrow(/损坏|解压/);
  });
});
