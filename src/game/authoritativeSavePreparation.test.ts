import { describe, expect, it } from "vitest";
import { createContentPackRegistry } from "./contentPacks";
import { createInitialState } from "./engine";
import {
  applyAuthoritativeSaveCheckpointOverlay,
  prepareAuthoritativeSavePayload,
} from "./authoritativeSavePreparation";
import { computeAuthoritativeSaveProofBindingSha256 } from "./authoritativeSaveProof";
import { sha256Bytes } from "./payloadDigest";
import { projectPersistentSaveState } from "./saveProjection";
import { serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import type { PlanetId } from "./types";

describe("authoritative save preparation", () => {
  it("is byte-identical to the canonical compatibility serializer", async () => {
    const registry = createContentPackRegistry();
    const source = createInitialState();
    const savedAt = 1_787_139_200_123;
    const viewport = source.planetViewports[source.activePlanetId];
    const checkpointOverlay = {
      planetViewports: [{
        planetId: source.activePlanetId,
        viewport: { x: viewport.x + 20, y: viewport.y - 40, zoom: Math.max(0.25, viewport.zoom) },
      }],
      timeWarp: { pendingSimulationSeconds: 7, pendingWallSeconds: 3 },
    };

    const prepared = await prepareAuthoritativeSavePayload(source, {
      formatVersion: 2,
      savedAt,
      kind: "primary",
      slot: "main",
      contentPackRegistry: registry,
      checkpointOverlay,
    });
    const overlaid = applyAuthoritativeSaveCheckpointOverlay(source, checkpointOverlay);
    const persistent = projectPersistentSaveState(overlaid, registry);
    const reference = serializeSaveEnvelopeToTransfer(persistent, {
      formatVersion: 2,
      kind: "primary",
      mode: "normal",
      slot: "main",
      savedAt,
    });

    expect(new Uint8Array(prepared.bytes)).toEqual(new Uint8Array(reference.bytes));
    expect(prepared.proof).toMatchObject({
      integrity: "valid",
      byteLength: reference.byteLength,
      payloadChecksum: reference.payloadChecksum,
      stateChecksum: reference.stateChecksum,
      payloadSha256: await sha256Bytes(reference.bytes),
    });
    const { bindingSha256: _binding, ...proofWithoutBinding } = prepared.proof;
    expect(prepared.proof.bindingSha256).toBe(
      await computeAuthoritativeSaveProofBindingSha256(proofWithoutBinding, prepared.catalogSeed),
    );
    expect(source.timeWarp.pendingSimulationSeconds).not.toBe(7);
    expect(source.planetViewports[source.activePlanetId]).toEqual(viewport);
  });

  it("rejects an unbounded or unknown UI overlay before serialization", async () => {
    const source = createInitialState();
    await expect(prepareAuthoritativeSavePayload(source, {
      formatVersion: 2,
      savedAt: 1,
      kind: "primary",
      slot: "main",
      contentPackRegistry: createContentPackRegistry(),
      checkpointOverlay: {
        planetViewports: [{ planetId: "missing" as PlanetId, viewport: { x: 0, y: 0, zoom: 1 } }],
        timeWarp: { pendingSimulationSeconds: Number.POSITIVE_INFINITY, pendingWallSeconds: 0 },
      },
    })).rejects.toThrow(/overlay 不合法/);
  });

  it("prepares an automatic snapshot with the same canonical bytes and bound metadata as the compatibility serializer", async () => {
    const registry = createContentPackRegistry();
    const source = createInitialState();
    const savedAt = 1_787_139_500_456;
    const prepared = await prepareAuthoritativeSavePayload(source, {
      formatVersion: 2,
      savedAt,
      kind: "snapshot",
      slot: "main",
      reason: "自动快照",
      contentPackRegistry: registry,
    });
    const persistent = projectPersistentSaveState(source, registry);
    const reference = serializeSaveEnvelopeToTransfer(persistent, {
      formatVersion: 2,
      savedAt,
      kind: "snapshot",
      slot: "main",
      reason: "自动快照",
      mode: "normal",
    });

    expect(new Uint8Array(prepared.bytes)).toEqual(new Uint8Array(reference.bytes));
    expect(prepared.summary).toMatchObject({ kind: "snapshot", slot: "main", reason: "自动快照", savedAt });
    expect(prepared.catalogSeed).toMatchObject({ kind: "snapshot", slot: "main", reason: "自动快照", savedAt });
    expect(prepared.proof.payloadSha256).toBe(await sha256Bytes(reference.bytes));
  });
});
