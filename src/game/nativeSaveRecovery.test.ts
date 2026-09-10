// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop";
import { buildChunkedSaveJournal, restoreChunkedSavePayloadFromRecords } from "./chunkedSaveJournal";
import { createInitialState } from "./engine";
import { serializeEnvelope } from "./storage";
import { restoreWindowsNativeSavePayload } from "./nativeSaveRecovery";

const desktopWindow = window as Window & { dspDesktop?: DesktopBridge };

function fixture() {
  const state = createInitialState();
  const raw = serializeEnvelope(state, 10);
  const journal = buildChunkedSaveJournal(state, { mode: "normal", basePrimaryChecksum: JSON.parse(raw).checksum, savedAt: 20, retainAllChunks: true });
  const prefix = "dsp-idle-network.internal.v1.chunked.v1.normal.";
  const records = new Map([...journal.chunks].map(([key, value]) => [prefix + "chunk." + encodeURIComponent(key), value]));
  const manifestKey = prefix + "manifest";
  records.set(manifestKey, JSON.stringify(journal.manifest));
  const recovery = { slot: "normal-main", mode: "normal", stateVersion: 47, generation: 2, rootHash: "a".repeat(64), recordKeys: [...records.keys()] };
  const read = vi.fn(async (request) => ({ ...request, value: records.get(request.key) ?? null }));
  desktopWindow.dspDesktop = { getNativePerformanceStatus: vi.fn(async () => ({ available: true, nativeFormatVersion: 1 })), recoverNativeSave: vi.fn(async () => recovery), readNativeSave: read } as unknown as DesktopBridge;
  return { raw, records, recovery, read, manifestKey };
}
afterEach(() => { delete desktopWindow.dspDesktop; });

describe("native checkpoint manifest-first recovery", () => {
  it("reconstructs exactly the existing adapter result after checking the manifest", async () => {
    const f = fixture();
    const expected = restoreChunkedSavePayloadFromRecords(f.raw, "normal", f.records);
    expect(expected).not.toBeNull();
    expect(await restoreWindowsNativeSavePayload(f.raw, "normal")).toEqual(expected);
    expect(f.read.mock.calls[0][0].key).toBe(f.manifestKey);
    expect(f.read).toHaveBeenCalledTimes(f.records.size);
  });
  it("rejects an obsolete native checkpoint after one small read", async () => {
    const f = fixture();
    const other = createInitialState(); other.elapsedSeconds += 1;
    expect(await restoreWindowsNativeSavePayload(serializeEnvelope(other, 30), "normal")).toBeNull();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.read.mock.calls[0][0].key).toBe(f.manifestKey);
  });
  it("rejects an older native checkpoint even when the newer primary state checksum is unchanged", async () => {
    const f = fixture();
    const newer = JSON.stringify({ ...JSON.parse(f.raw), savedAt: 30 });
    expect(JSON.parse(newer).checksum).toBe(JSON.parse(f.raw).checksum);
    expect(restoreChunkedSavePayloadFromRecords(newer, "normal", f.records)).toBeNull();
    expect(await restoreWindowsNativeSavePayload(newer, "normal")).toBeNull();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.read.mock.calls[0][0].key).toBe(f.manifestKey);
  });
  it.each(["missing", "corrupt", "generation", "duplicate", "invalid-primary"])("preserves the primary on %s readback", async (failure) => {
    const f = fixture();
    const key = [...f.records.keys()][0];
    if (failure === "missing") f.records.delete(key);
    if (failure === "corrupt") f.records.set(key, f.records.get(key) + " ");
    if (failure === "generation") f.read.mockImplementation(async request => ({ ...request, generation: 99, value: f.records.get(request.key) ?? null }));
    if (failure === "duplicate") f.recovery.recordKeys.push(key);
    const raw = failure === "invalid-primary" ? f.raw.replace('"version":47', '"version":46') : f.raw;
    expect(await restoreWindowsNativeSavePayload(raw, "normal")).toBeNull();
    if (failure === "duplicate" || failure === "invalid-primary") expect(f.read).not.toHaveBeenCalled();
  });
});
