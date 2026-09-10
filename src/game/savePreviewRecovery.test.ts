/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearChunkedSaveJournal, persistChunkedSaveJournal } from "./chunkedSaveJournal";
import { createInitialState } from "./engine";
import * as localStore from "./localSaveStore";
import * as saveInspection from "./saveInspection";
import { readMenuSavePayload, resolveMenuContinueSave, resolveMenuSavePayload } from "./savePreviewPayload";
import { inspectSave, loadGame, loadInspectedGame, serializeEnvelope } from "./storage";

const SAVE_KEY = "dsp-idle-network.save.v1";

async function seed(advance = false) {
  const primaryRaw = serializeEnvelope(createInitialState(), 10);
  const envelope = JSON.parse(primaryRaw);
  localStore.setLocalSaveValue(SAVE_KEY, primaryRaw);
  await localStore.flushLocalSaveWrites();
  const state = structuredClone(envelope.state);
  if (advance) {
    state.elapsedSeconds += 5;
    state.tray.iron_ore = 25;
    state.planetTrays.home = { ...state.tray };
  }
  const persisted = await persistChunkedSaveJournal(state, {
    mode: "normal", basePrimaryChecksum: envelope.checksum, savedAt: advance ? 20 : 10,
  });
  expect(persisted.success).toBe(true);
  return { primaryRaw, state };
}

describe("menu primary catalog and verified journal recovery", () => {
  beforeEach(async () => {
    await clearChunkedSaveJournal("normal");
    window.localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])("accepts verified recovered bytes bound to the cataloged primary (advance=%s)", async advance => {
    const { primaryRaw, state } = await seed(advance);
    const before = { ...window.localStorage };
    const resolved = await resolveMenuContinueSave("normal");
    expect(resolved).not.toBeNull();
    expect(resolved!.raw).not.toBe(primaryRaw);
    expect(resolved!.primaryRaw).toBe(primaryRaw);
    expect(JSON.parse(resolved!.raw).state).toEqual(state);
    expect(resolved!.inspection).toMatchObject({ valid: true, savedAt: advance ? 20 : 10 });
    expect(await readMenuSavePayload(SAVE_KEY)).toBe(resolved!.raw);
    expect((await resolveMenuSavePayload(SAVE_KEY, "normal"))!.raw).toBe(resolved!.raw);
    expect({ ...window.localStorage }).toEqual(before);
  });

  it.each(["payloadChecksum", "byteLength"] as const)("still rejects a primary catalog %s mismatch", async field => {
    await seed(true);
    const catalog = localStore.getLocalSaveCatalog(SAVE_KEY)!;
    vi.spyOn(localStore, "getLocalSaveCatalog").mockReturnValue({ ...catalog,
      [field]: field === "byteLength" ? catalog.byteLength + 1 : "00000000" });
    const before = { ...window.localStorage };
    expect(await resolveMenuSavePayload(SAVE_KEY, "normal")).toBeNull();
    expect(await readMenuSavePayload(SAVE_KEY)).toBeNull();
    expect({ ...window.localStorage }).toEqual(before);
  });

  it("retains the verified primary when the journal is corrupt and rejects the wrong mode", async () => {
    const { primaryRaw } = await seed(true);
    await localStore.commitLocalSaveInternalRecords([
      { key: "dsp-idle-network.internal.v1.chunked.v1.normal.manifest", value: "{broken" },
    ]);
    expect((await resolveMenuContinueSave("normal"))?.raw).toBe(primaryRaw);
    expect(await resolveMenuSavePayload(SAVE_KEY, "speedrun")).toBeNull();
    expect(window.localStorage.getItem(SAVE_KEY)).toBe(primaryRaw);
  });

  it("rejects a primary replaced while the recovered candidate is being inspected", async () => {
    await seed(true);
    const replacement = createInitialState(); replacement.tray.iron_ore = 77;
    const replacementRaw = serializeEnvelope(replacement, 30);
    const inspect = saveInspection.inspectSavePayloadInWorker;
    vi.spyOn(saveInspection, "inspectSavePayloadInWorker").mockImplementationOnce(async (...args) => {
      const result = await inspect(...args);
      localStore.setLocalSaveValue(SAVE_KEY, replacementRaw);
      await localStore.flushLocalSaveWrites();
      return result;
    });
    expect(await resolveMenuSavePayload(SAVE_KEY, "normal")).toBeNull();
    expect(window.localStorage.getItem(SAVE_KEY)).toBe(replacementRaw);
  });

  it("keeps a newer primary timestamp when an older journal shares its state checksum", async () => {
    const { primaryRaw } = await seed(true);
    const newerPrimary = serializeEnvelope(JSON.parse(primaryRaw).state, 30);
    expect(JSON.parse(newerPrimary).checksum).toBe(JSON.parse(primaryRaw).checksum);
    localStore.setLocalSaveValue(SAVE_KEY, newerPrimary);
    await localStore.flushLocalSaveWrites();
    const resolved = await resolveMenuContinueSave("normal");
    expect(resolved?.raw).toBe(newerPrimary);
    expect(resolved?.inspection.savedAt).toBe(30);
  });

  it.each([
    { paused: true, seconds: 5 },
    { paused: false, seconds: 0.5 },
    { paused: false, seconds: 1 },
    { paused: false, seconds: 5.125 },
  ])("loads inspected state with the legacy offline semantics (%j)", async ({ paused, seconds }) => {
    const state = createInitialState(); state.paused = paused;
    const savedAt = 1_788_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(savedAt + seconds * 1000);
    const raw = serializeEnvelope(state, savedAt);
    localStore.setLocalSaveValue(SAVE_KEY, raw);
    await localStore.flushLocalSaveWrites();
    const before = { ...window.localStorage };
    expect(loadInspectedGame(inspectSave(raw))).toEqual(loadGame());
    expect({ ...window.localStorage }).toEqual(before);
    expect(loadInspectedGame(inspectSave(raw), "speedrun")).toBeNull();
    expect(loadInspectedGame({ ...inspectSave(raw), valid: false })).toBeNull();
    expect(loadInspectedGame(inspectSave(raw), "normal", "backup")?.recovery?.source).toBe("backup");
  });
});
