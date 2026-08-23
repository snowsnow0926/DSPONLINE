import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inspectSave, migrateGame, serializeEnvelope } from "./storage";
import { inspectCanonicalSaveEnvelopeOrThrow } from "./canonicalSaveEnvelopeInspection";

const environment = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined>; memoryUsage?: () => NodeJS.MemoryUsage };
}).process;

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
}

function byteAttribution(records: readonly Record<string, unknown>[]) {
  const result = new Map<string, { bytes: number; present: number; defaultLike: number }>();
  for (const record of records) {
    for (const [field, value] of Object.entries(record)) {
      if (value === undefined) continue;
      const row = result.get(field) ?? { bytes: 0, present: 0, defaultLike: 0 };
      row.bytes += jsonBytes(field) + jsonBytes(value) + 2;
      row.present += 1;
      if (value === 0 || value === false || value === null || value === "" ||
        Array.isArray(value) && value.length === 0 ||
        value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
        row.defaultLike += 1;
      }
      result.set(field, row);
    }
  }
  return [...result.entries()]
    .map(([field, row]) => ({ field, ...row }))
    .sort((left, right) => right.bytes - left.bytes);
}

describe("1.1.5 real large-save memory and compression benchmark", () => {
  it.skipIf(!environment?.env?.DSP_V115_REAL_FIXTURE)(
    "profiles the supplied player save read-only without retaining player data",
    () => {
      const sourcePath = environment!.env!.DSP_V115_REAL_FIXTURE!;
      const before = statSync(sourcePath);
      const sourceRaw = readFileSync(sourcePath, "utf8");
      const sourceHash = createHash("sha256").update(sourceRaw, "utf8").digest("hex");
      const inspection = inspectSave(sourceRaw);
      expect(inspection).toMatchObject({ valid: true, checksum: "valid", formatVersion: 2, stateVersion: 47 });
      const state = migrateGame(inspection.state);
      expect(state).not.toBeNull();
      const compactRaw = serializeEnvelope(state!, 1_787_488_000_000);
      const compactInspection = inspectSave(compactRaw);
      expect(compactInspection).toMatchObject({ valid: true, checksum: "valid", formatVersion: 2, stateVersion: 47 });
      expect(compactInspection.state).not.toBeNull();
      const rangeInspection = inspectCanonicalSaveEnvelopeOrThrow(compactRaw);
      expect(rangeInspection).toMatchObject({
        formatVersion: 2,
        kind: "primary",
        mode: "normal",
        slot: "main",
        recordedChecksum: compactInspection.recordedChecksum,
        computedChecksum: compactInspection.computedChecksum,
        state: {
          version: 47,
          entityCount: compactInspection.state!.entities.length,
          beltCount: compactInspection.state!.belts.length,
        },
      });

      const compactEnvelope = JSON.parse(compactRaw) as { state: Record<string, unknown> & {
        entities: Record<string, unknown>[];
        belts: Record<string, unknown>[];
      } };
      const compactState = compactEnvelope.state;
      const topLevel = Object.entries(compactState)
        .map(([field, value]) => ({ field, bytes: jsonBytes(value), count: Array.isArray(value) ? value.length : null }))
        .sort((left, right) => right.bytes - left.bytes);
      const compactBytes = Buffer.byteLength(compactRaw, "utf8");
      const gzipBytes = gzipSync(compactRaw, { level: 6 }).byteLength;
      const report = {
        sourceBytes: before.size,
        compactBytes,
        reductionBytes: before.size - compactBytes,
        gzipBytes,
        gzipRatio: Number((gzipBytes / compactBytes).toFixed(4)),
        entityCount: compactInspection.state!.entities.length,
        beltCount: compactInspection.state!.belts.length,
        topLevel: topLevel.slice(0, 12),
        entityFields: byteAttribution(compactState.entities).slice(0, 40),
        beltFields: byteAttribution(compactState.belts).slice(0, 30),
        memory: environment?.memoryUsage?.(),
      };
      console.log(`V115_REAL_SAVE_PROFILE ${JSON.stringify(report)}`);

      const after = statSync(sourcePath);
      const afterRaw = readFileSync(sourcePath, "utf8");
      expect({ size: after.size, mtimeMs: after.mtimeMs, hash: createHash("sha256").update(afterRaw, "utf8").digest("hex") })
        .toEqual({ size: before.size, mtimeMs: before.mtimeMs, hash: sourceHash });
    },
    120_000,
  );
});
