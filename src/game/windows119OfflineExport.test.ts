import { describe, expect, it } from "vitest";
import { buildChunkedSaveJournal } from "./chunkedSaveJournal";
import { createContentPackRegistry } from "./contentPacks";
import { createInitialState } from "./engine";
import { projectPersistentSaveState } from "./saveProjection";
import { exportGame, importGame, inspectSave } from "./storage";
// @ts-expect-error This Node ESM helper intentionally lives outside the browser TypeScript graph.
import { chunkedManifestKey, chunkedRecordKey, joinMaterializedSave, materializeWindows119Save } from "../../scripts/windows-119-save-export-lib.mjs";

describe("Windows 1.1.9 offline exporter compatibility", () => {
  it("rebuilds a chunked v47 sidecar into a payload accepted by the canonical importer", async () => {
    const initial = createInitialState(11_900, false);
    const primaryRaw = exportGame(initial);
    const primary = inspectSave(primaryRaw);
    expect(primary.valid).toBe(true);
    expect(primary.formatVersion).toBe(2);
    expect(primary.stateVersion).toBe(47);

    const latest = structuredClone(initial);
    latest.elapsedSeconds += 119;
    const projected = projectPersistentSaveState(latest, createContentPackRegistry());
    const journal = buildChunkedSaveJournal(projected, {
      mode: "normal",
      basePrimaryChecksum: primary.recordedChecksum!,
      savedAt: 1_700_000_119_000,
    });
    const records = new Map<string, string>([
      [chunkedManifestKey("normal"), JSON.stringify(journal.manifest)],
      ...[...journal.chunks].map(([id, value]) => [chunkedRecordKey("normal", id), value] as const),
    ]);

    const materialized = await materializeWindows119Save({
      baseRaw: primaryRaw,
      mode: "normal",
      readInternalRecord: async (key: string) => records.get(key) ?? null,
    });
    const exportedRaw = joinMaterializedSave(materialized);
    const exportedInspection = inspectSave(exportedRaw);
    const imported = importGame(exportedRaw, "normal", "main");

    expect(materialized.source).toBe("chunked-sidecar");
    expect(exportedInspection).toMatchObject({ valid: true, formatVersion: 2, stateVersion: 47, mode: "normal", slot: "main" });
    expect(JSON.parse(exportedRaw).state).toEqual(projected);
    expect(imported).not.toBeNull();
    expect(imported?.elapsedSeconds).toBe(projected.elapsedSeconds);
    expect(imported?.entities.map((entity) => entity.id)).toEqual(projected.entities.map((entity) => entity.id));
    expect(imported?.belts.map((belt) => belt.id)).toEqual(projected.belts.map((belt) => belt.id));
  });
});
