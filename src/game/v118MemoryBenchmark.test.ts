import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createContentPackRegistry } from "./contentPacks";
import { buildChunkedSaveJournal } from "./chunkedSaveJournal";
import { inspectSave, migrateGame, serializeEnvelope } from "./storage";
import { projectPersistentSaveState } from "./saveProjection";

const environment = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined>; memoryUsage?: () => NodeJS.MemoryUsage };
}).process;

describe("1.1.8 real-save memory optimization benchmark", () => {
  it.skipIf(!environment?.env?.DSP_V118_REAL_FIXTURE)(
    "compares full serialization with the v1 changed-chunk journal read-only",
    () => {
      const sourcePath = environment!.env!.DSP_V118_REAL_FIXTURE!;
      const before = statSync(sourcePath);
      const sourceRaw = readFileSync(sourcePath, "utf8");
      const sourceHash = createHash("sha256").update(sourceRaw, "utf8").digest("hex");
      const inspection = inspectSave(sourceRaw);
      expect(inspection).toMatchObject({ valid: true, checksum: "valid", formatVersion: 2, stateVersion: 47 });
      const state = migrateGame(inspection.state);
      expect(state).not.toBeNull();
      const registry = createContentPackRegistry();
      const memoryBefore = environment.memoryUsage?.();
      const { firstManifest, firstTotalBytes } = (() => {
        const firstBuild = buildChunkedSaveJournal(projectPersistentSaveState(state!, registry), {
          mode: state!.mode,
          basePrimaryChecksum: inspection.recordedChecksum ?? "00000000",
          retainAllChunks: false,
        });
        return { firstManifest: firstBuild.manifest, firstTotalBytes: firstBuild.totalBytes };
      })();
      // The real persistence path commits the seed and then releases its
      // changed chunk texts before the next autosave. Do the same here so the
      // incremental memory sample does not accidentally retain a 77 MiB test
      // map that production never keeps.
      if (typeof (globalThis as { gc?: () => void }).gc === "function") (globalThis as { gc: () => void }).gc();
      const memoryAfterFirst = environment.memoryUsage?.();
      state!.elapsedSeconds += 1;
      const second = (() => {
        const secondBuild = buildChunkedSaveJournal(projectPersistentSaveState(state!, registry), {
          mode: state!.mode,
          basePrimaryChecksum: inspection.recordedChecksum ?? "00000000",
          previous: firstManifest,
          previousChunkIds: new Set(firstManifest.chunks.map((chunk) => chunk.id)),
          retainAllChunks: false,
        });
        return {
          changedChunkIds: secondBuild.changedChunkIds,
          changedBytes: secondBuild.changedBytes,
          totalBytes: secondBuild.totalBytes,
        };
      })();
      const memoryDuringIncremental = environment.memoryUsage?.();
      if (typeof (globalThis as { gc?: () => void }).gc === "function") (globalThis as { gc: () => void }).gc();
      const memoryAfterIncremental = environment.memoryUsage?.();
      const fullStarted = performance.now();
      const fullRaw = serializeEnvelope(state!, 1_787_488_000_000);
      const fullDurationMs = performance.now() - fullStarted;
      const memoryDuringFull = environment.memoryUsage?.();
      if (typeof (globalThis as { gc?: () => void }).gc === "function") (globalThis as { gc: () => void }).gc();
      const memoryAfterFull = environment.memoryUsage?.();
      const report = {
        fixtureBytes: before.size,
        fullEnvelopeBytes: Buffer.byteLength(fullRaw, "utf8"),
        chunkedPayloadBytes: firstTotalBytes,
        chunkCount: firstManifest.chunks.length,
        changedChunks: second.changedChunkIds.length,
        changedChunkBytes: second.changedBytes,
        changedRatio: Number((second.changedBytes / Math.max(1, second.totalBytes)).toFixed(6)),
        fullDurationMs: Number(fullDurationMs.toFixed(3)),
        memory: {
          before: memoryBefore,
          afterFirst: memoryAfterFirst,
          duringIncremental: memoryDuringIncremental,
          afterIncremental: memoryAfterIncremental,
          duringFull: memoryDuringFull,
          afterFull: memoryAfterFull,
        },
        entities: state!.entities.length,
        belts: state!.belts.length,
        gcAvailable: typeof (globalThis as { gc?: () => void }).gc === "function",
      };
      console.log(`V118_MEMORY_BENCHMARK ${JSON.stringify(report)}`);
      expect(firstManifest.stateVersion).toBe(47);
      expect(second.changedChunkIds).toContain("base");
      expect(second.changedBytes).toBeLessThan(second.totalBytes);
      expect(inspectSave(fullRaw)).toMatchObject({ valid: true, checksum: "valid", stateVersion: 47 });
      const after = statSync(sourcePath);
      const afterRaw = readFileSync(sourcePath, "utf8");
      expect({ size: after.size, mtimeMs: after.mtimeMs, hash: createHash("sha256").update(afterRaw, "utf8").digest("hex") })
        .toEqual({ size: before.size, mtimeMs: before.mtimeMs, hash: sourceHash });
    },
    180_000,
  );
});
