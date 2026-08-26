import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { streamChunkedSaveJournalFromRuntimeState, type ChunkedSaveJournalContext } from "./chunkedSaveJournal";
import { createContentPackRegistry } from "./contentPacks";
import { inspectSave, migrateGame } from "./storage";

const fixturePath = process.env.DSPIDLE_REAL_SAVE_PATH;
const enabled = process.env.DSP_RUN_V121_SAVE_REUSE_BENCHMARK === "1" && Boolean(fixturePath);

describe.skipIf(!enabled)("1.2.1 real-save unchanged streaming reuse gate", () => {
  it("does not project or transfer unchanged entity and belt pages twice", { timeout: 120_000 }, async () => {
    const inspection = inspectSave(readFileSync(fixturePath!, "utf8"));
    const registry = createContentPackRegistry();
    const state = inspection.state ? migrateGame(inspection.state, registry) : null;
    expect(state).not.toBeNull();
    const basePrimaryChecksum = "00000000";
    const emptyContext: ChunkedSaveJournalContext = {
      mode: state!.mode,
      basePrimaryChecksum,
      previous: null,
      previousChunkIds: [],
      existingKeys: [],
    };
    let firstWriteRecords = 0;
    const firstStartedAt = performance.now();
    const first = await streamChunkedSaveJournalFromRuntimeState(
      state!,
      registry,
      { mode: state!.mode, basePrimaryChecksum, savedAt: 1 },
      emptyContext,
      async (records) => { firstWriteRecords += records.length; },
    );
    const firstDurationMs = performance.now() - firstStartedAt;
    const secondContext: ChunkedSaveJournalContext = {
      mode: state!.mode,
      basePrimaryChecksum,
      previous: first.manifest,
      previousChunkIds: first.manifest.chunks.map((chunk) => chunk.id),
      existingKeys: [],
    };
    let secondWriteRecords = 0;
    const secondStartedAt = performance.now();
    const second = await streamChunkedSaveJournalFromRuntimeState(
      state!,
      registry,
      { mode: state!.mode, basePrimaryChecksum, savedAt: 2 },
      secondContext,
      async (records) => { secondWriteRecords += records.length; },
      {
        entityCount: first.manifest.entityCount,
        beltCount: first.manifest.beltCount,
        chunks: first.manifest.chunks.filter((chunk) => chunk.kind !== "base"),
      },
    );
    const secondDurationMs = performance.now() - secondStartedAt;
    expect(second.changedChunks).toBe(0);
    expect(second.manifest.chunkRootChecksum).toBe(first.manifest.chunkRootChecksum);
    expect(secondWriteRecords).toBe(1);
    console.info("v121-real-save-streaming-reuse", JSON.stringify({
      entities: state!.entities.length,
      belts: state!.belts.length,
      firstDurationMs: Math.round(firstDurationMs),
      secondDurationMs: Math.round(secondDurationMs),
      firstWriteRecords,
      secondWriteRecords,
      savedProjectionReductionPercent: Number((100 * (1 - secondDurationMs / firstDurationMs)).toFixed(2)),
    }));
  });
});
