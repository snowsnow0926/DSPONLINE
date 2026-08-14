import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advancePersistentSimulationRuntime,
  createPersistentSimulationRuntime,
} from "./engine";
import { inspectSave } from "./storage";
import { createSimulationProjection } from "./simulationProjection";
import type { GameState } from "./types";

const environment = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(json(value), "utf8");
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "entities" || key === "belts") continue;
    if (json(before[key]) !== json(after[key])) patch[key] = after[key] === undefined ? null : after[key];
  }
  return patch;
}

function recordPatches<T extends { id: string; planetId: string }>(before: T[], after: T[]) {
  expect(after.map((record) => record.id)).toEqual(before.map((record) => record.id));
  return after.flatMap((record, index) => {
    const fields = changedFields(before[index] as Record<string, unknown>, record as Record<string, unknown>);
    return Object.keys(fields).length > 0 ? [[index, fields] as const] : [];
  });
}

describe("1.0.44 simulation runtime transport probe", () => {
  it.skipIf(!environment?.DSP_LARGE_SAVE_FIXTURE)(
    "measures alias-safe field patches on the supplied read-only large save",
    () => {
      const path = environment!.DSP_LARGE_SAVE_FIXTURE!;
      const rawBefore = readFileSync(path, "utf8");
      const sourceHash = createHash("sha256").update(rawBefore).digest("hex");
      const inspection = inspectSave(rawBefore);
      expect(inspection.valid).toBe(true);
      const state = inspection.state!;
      state.paused = false;
      const runtime = createPersistentSimulationRuntime(state);
      // The first request fills optional runtime-only empty records. Measure a
      // subsequent steady request so the transport budget is not polluted by
      // one-time shape normalization.
      advancePersistentSimulationRuntime(runtime, 1, 1);
      const before = structuredClone(runtime.state);
      const startedAt = performance.now();
      const result = advancePersistentSimulationRuntime(runtime, 1, 1);
      const durationMs = performance.now() - startedAt;

      const topLevel = changedFields(before as unknown as Record<string, unknown>, result.state as unknown as Record<string, unknown>);
      const entityPatches = recordPatches(before.entities, result.state.entities);
      const beltPatches = recordPatches(before.belts, result.state.belts);
      const activePlanetId = result.state.activePlanetId;
      const activeEntityPatches = entityPatches.filter(([index]) => result.state.entities[index].planetId === activePlanetId);
      const activeBeltPatches = beltPatches.filter(([index]) => result.state.belts[index].planetId === activePlanetId);
      const projection = createSimulationProjection(before, result.state, { compact: true });
      const projectionResponseBytes = utf8Bytes({
        id: 1,
        changed: true,
        durationMs,
        protocol: "projection",
        stateRevision: 2,
        projection,
      });
      const originalBeforePlanetId = before.activePlanetId;
      const originalCurrentPlanetId = result.state.activePlanetId;
      before.activePlanetId = "inferno";
      result.state.activePlanetId = "inferno";
      const denseProjection = createSimulationProjection(before, result.state, { compact: true });
      const denseProjectionResponseBytes = utf8Bytes({
        id: 2,
        changed: true,
        durationMs,
        protocol: "projection",
        stateRevision: 2,
        projection: denseProjection,
      });
      const synthetic2xProjection = {
        ...denseProjection,
        changedEntityIds: [...denseProjection.changedEntityIds, ...denseProjection.changedEntityIds.map((id) => `${id}__2x`)],
        changedBeltIds: [...denseProjection.changedBeltIds, ...denseProjection.changedBeltIds.map((id) => `${id}__2x`)],
        entityColumns: Object.fromEntries(Object.entries(denseProjection.entityColumns).map(([field, values]) => [
          field,
          [...values, ...values.map(([index, value]) => [index + result.state.entities.length, value] as [number, unknown])],
        ])),
        beltColumns: Object.fromEntries(Object.entries(denseProjection.beltColumns).map(([field, values]) => [
          field,
          [...values, ...values.map(([index, value]) => [index + result.state.belts.length, value] as [number, unknown])],
        ])),
        entityCount: denseProjection.entityCount * 2,
        beltCount: denseProjection.beltCount * 2,
      };
      const synthetic2xProjectionResponseBytes = utf8Bytes({
        id: 3,
        changed: true,
        durationMs: durationMs * 2,
        protocol: "projection",
        stateRevision: 2,
        projection: synthetic2xProjection,
      });
      before.activePlanetId = originalBeforePlanetId;
      result.state.activePlanetId = originalCurrentPlanetId;
      const planetPatchBytes = [...new Set(result.state.entities.map((entity) => entity.planetId))]
        .map((planetId) => ({
          planetId,
          bytes: utf8Bytes({
            topLevel,
            entityPatches: entityPatches.filter(([index]) => result.state.entities[index].planetId === planetId),
            beltPatches: beltPatches.filter(([index]) => result.state.belts[index].planetId === planetId),
          }),
        }))
        .sort((left, right) => right.bytes - left.bytes);
      const entityFieldCounts: Record<string, number> = {};
      const beltFieldCounts: Record<string, number> = {};
      for (const [, fields] of entityPatches) for (const field of Object.keys(fields)) entityFieldCounts[field] = (entityFieldCounts[field] ?? 0) + 1;
      for (const [, fields] of beltPatches) for (const field of Object.keys(fields)) beltFieldCounts[field] = (beltFieldCounts[field] ?? 0) + 1;
      const report = {
        durationMs,
        fullStateBytes: utf8Bytes(result.state),
        topLevelPatchBytes: utf8Bytes(topLevel),
        fieldPatchBytes: utf8Bytes({ topLevel, entityPatches, beltPatches }),
        activePlanetPatchBytes: utf8Bytes({ topLevel, entityPatches: activeEntityPatches, beltPatches: activeBeltPatches }),
        projectionResponseBytes,
        denseProjectionResponseBytes,
        synthetic2xProjectionResponseBytes,
        entityPatchCount: entityPatches.length,
        beltPatchCount: beltPatches.length,
        activeEntityPatchCount: activeEntityPatches.length,
        activeBeltPatchCount: activeBeltPatches.length,
        topLevelFields: Object.keys(topLevel),
        topLevelFieldBytes: Object.fromEntries(Object.entries(topLevel).map(([field, value]) => [field, utf8Bytes(value)])),
        entityFieldCounts,
        beltFieldCounts,
        planetPatchBytes,
      };
      console.log(`SIMULATION_RUNTIME_1044 ${json(report)}`);

      expect(projectionResponseBytes).toBeLessThanOrEqual(1024 * 1024);
      expect(denseProjectionResponseBytes).toBeLessThanOrEqual(1024 * 1024);
      expect(synthetic2xProjectionResponseBytes).toBeLessThanOrEqual(2 * 1024 * 1024);

      const rawAfter = readFileSync(path, "utf8");
      expect(createHash("sha256").update(rawAfter).digest("hex")).toBe(sourceHash);
      expect(rawAfter).toBe(rawBefore);
    },
    60_000,
  );
});
