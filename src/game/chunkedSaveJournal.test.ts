/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import { createContentPackRegistry } from "./contentPacks";
import { createInitialState } from "./engine";
import {
  buildChunkedSaveJournal,
  clearChunkedSaveJournal,
  chunkedSavePartsForTest,
  persistChunkedSaveJournal,
  restoreChunkedSavePayload,
} from "./chunkedSaveJournal";
import { computeSaveStateChecksum } from "./saveEnvelopeIntegrity";
import { commitLocalSaveInternalRecords, flushLocalSaveWrites, listLocalSaveInternalKeys, readLocalSaveInternalValue, setLocalSaveValue } from "./localSaveStore";
import { projectPersistentSaveState } from "./saveProjection";
import { readLocalSavePayloadWithChunkJournal } from "./storage";

describe("v1 chunked save journal", () => {
  beforeEach(async () => {
    for (const key of await listLocalSaveInternalKeys()) {
      try { window.localStorage.removeItem(key); } catch { /* jsdom storage is optional */ }
    }
  });

  it("partitions and detects a single changed chunk without changing v47 state semantics", () => {
    const registry = createContentPackRegistry();
    const state = createInitialState();
    const first = chunkedSavePartsForTest(projectPersistentSaveState(state, registry));
    const changed = projectPersistentSaveState(structuredClone(state), registry);
    changed.elapsedSeconds += 1;
    const second = buildChunkedSaveJournal(changed, {
      mode: "normal",
      basePrimaryChecksum: "00000000",
      previous: first.manifest,
      previousChunkTexts: first.chunks,
    });
    expect(first.manifest.envelopeFormatVersion).toBe(2);
    expect(first.manifest.stateVersion).toBe(47);
    expect(first.manifest.chunks.some((chunk) => chunk.kind === "entities")).toBe(true);
    expect(second.changedChunkIds).toEqual(["base"]);
    expect(second.totalBytes).toBe(first.totalBytes);
  });

  it("writes changed chunks and restores a valid v2 envelope over the old primary", async () => {
    const registry = createContentPackRegistry();
    const state = createInitialState();
    const projected = chunkedSavePartsForTest(projectPersistentSaveState(state, registry)).projectedState;
    const baseChecksum = computeSaveStateChecksum(2, projected);
    const baseRaw = JSON.stringify({
      formatVersion: 2,
      kind: "primary",
      mode: "normal",
      slot: "main",
      savedAt: 10,
      state: projected,
      checksum: baseChecksum,
    });
    setLocalSaveValue("dsp-idle-network.save.v1", baseRaw);
    await flushLocalSaveWrites();
    const saved = await persistChunkedSaveJournal(projected, {
      mode: "normal",
      basePrimaryChecksum: baseChecksum,
      savedAt: 20,
    });
    expect(saved.success).toBe(true);
    expect(saved.changedChunks).toBeGreaterThan(0);
    const restored = await restoreChunkedSavePayload(baseRaw, "normal");
    expect(restored).not.toBeNull();
    const parsed = JSON.parse(restored!.raw) as { state: typeof projected; checksum: string; savedAt: number };
    expect(parsed.savedAt).toBe(20);
    expect(parsed.state.entities).toHaveLength(projected.entities.length);
    expect(parsed.state.belts).toHaveLength(projected.belts.length);
    expect(parsed.checksum).toBe(computeSaveStateChecksum(2, parsed.state));
    const loadedThroughStore = await readLocalSavePayloadWithChunkJournal("dsp-idle-network.save.v1");
    expect(loadedThroughStore).toBe(restored!.raw);
    await clearChunkedSaveJournal("normal");
  });

  it("rejects a tampered chunk instead of shadowing the compatible v47 primary", async () => {
    const registry = createContentPackRegistry();
    const state = createInitialState();
    const projected = chunkedSavePartsForTest(projectPersistentSaveState(state, registry)).projectedState;
    const baseChecksum = computeSaveStateChecksum(2, projected);
    const baseRaw = JSON.stringify({
      formatVersion: 2,
      kind: "primary",
      mode: "normal",
      slot: "main",
      savedAt: 10,
      state: projected,
      checksum: baseChecksum,
    });
    await persistChunkedSaveJournal(projected, { mode: "normal", basePrimaryChecksum: baseChecksum, savedAt: 20 });
    const chunkKey = (await listLocalSaveInternalKeys("dsp-idle-network.internal.v1.chunked.v1.normal.chunk."))[0];
    const original = await readLocalSaveInternalValue(chunkKey);
    expect(original).not.toBeNull();
    await commitLocalSaveInternalRecords([{ key: chunkKey, value: `${original} ` }]);
    await expect(restoreChunkedSavePayload(baseRaw, "normal")).resolves.toBeNull();
    await clearChunkedSaveJournal("normal");
  });
});
