import { afterEach, describe, expect, it, vi } from "vitest";
import { rewrapAuthoritativePrimarySnapshot } from "./authoritativeSnapshotRewrap";
import { computeAuthoritativeSaveProofBindingSha256 } from "./authoritativeSaveProof";
import { createInitialState, createSpeedrunInitialState } from "./engine";
import { loadContentPackRegistry } from "./contentPacks";
import { projectPersistentSaveState } from "./saveProjection";
import { serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import { sha256Bytes } from "./payloadDigest";
import { decodeSavePayloadTransport, prepareSavePayloadTransport } from "./savePayloadCompression";
import type { AuthoritativePrimarySnapshotSource } from "./authoritativeSaveSerializationProtocol";

async function fixture(mode: "normal" | "speedrun" = "normal", compress = true) {
  const state = mode === "normal" ? createInitialState(44130) : createSpeedrunInitialState(1700000000000, "rewrap_snapshot_001");
  state.elapsedSeconds = 1234;
  state.entities[0].inputs.iron_ore = 941;
  const persistent = projectPersistentSaveState(state, loadContentPackRegistry());
  const transfer = serializeSaveEnvelopeToTransfer(persistent, { formatVersion: 2, savedAt: 10, mode, kind: "primary", slot: "main" });
  const payloadSha256 = await sha256Bytes(transfer.bytes);
  const transport = compress ? await prepareSavePayloadTransport(transfer.bytes, payloadSha256) : {
    buffer: transfer.bytes, encoding: "raw" as const, storedByteLength: transfer.byteLength, storedSha256: payloadSha256,
  };
  const catalogSeed: AuthoritativePrimarySnapshotSource["catalogSeed"] = {
    mode, kind: "primary", slot: "main", savedAt: 10, stateVersion: state.version, entityCount: state.entities.length,
    beltCount: state.belts.length, elapsedSeconds: 1234, completedTechCount: state.research.completedTechIds.length,
    activePlanetId: state.activePlanetId, structurePoints: 0, stateChecksum: transfer.stateChecksum, modeExplicit: true,
    reason: null, settings: state.settings,
  };
  const proof = {
    integrity: "valid" as const, payloadChecksum: transfer.payloadChecksum, payloadSha256,
    byteLength: transfer.byteLength, stateChecksum: transfer.stateChecksum,
    transportEncoding: transport.encoding, storedByteLength: transport.storedByteLength, storedSha256: transport.storedSha256,
  };
  const source: AuthoritativePrimarySnapshotSource = {
    bytes: transport.buffer, catalogSeed,
    proof: { ...proof, bindingSha256: await computeAuthoritativeSaveProofBindingSha256(proof, catalogSeed) },
    summary: { ...catalogSeed, kind: "primary", slot: "main", uploadedWhiteMatrix: 0, integrity: "valid", computedStateChecksum: transfer.stateChecksum },
  };
  return { source, persistent };
}

afterEach(() => vi.restoreAllMocks());

describe("authoritative snapshot primary reuse", () => {
  for (const mode of ["normal", "speedrun"] as const) for (const compress of [false, true]) {
    it(`preserves the entire ${mode} state from ${compress ? "gzip" : "raw"} without parsing or serializing GameState`, async () => {
      const { source, persistent } = await fixture(mode, compress);
      if (compress) expect(source.proof.transportEncoding).toBe("gzip");
      const parse = vi.spyOn(JSON, "parse");
      const stringify = vi.spyOn(JSON, "stringify");
      const snapshot = await rewrapAuthoritativePrimarySnapshot(source, 11, "自动快照");
      // Node's first Response/CompressionStream initialization may parse its
      // own "{}" configuration. Only large payload parsing is forbidden.
      expect(parse.mock.calls.filter(([value]) => typeof value === "string" && value.length >= 1024)).toEqual([]);
      expect(stringify.mock.calls.some(([value]) => value && typeof value === "object" && "entities" in value)).toBe(false);
      parse.mockRestore(); stringify.mockRestore();
      const bytes = await decodeSavePayloadTransport(snapshot.bytes, snapshot.proof.transportEncoding);
      const expected = serializeSaveEnvelopeToTransfer(persistent, {
        formatVersion: 2, savedAt: 11, mode, kind: "snapshot", slot: "main", reason: "自动快照",
      });
      expect(new Uint8Array(bytes)).toEqual(new Uint8Array(expected.bytes));
      expect(snapshot.catalogSeed).toEqual({ ...source.catalogSeed, savedAt: 11, kind: "snapshot", reason: "自动快照" });
      const { bindingSha256, ...proof } = snapshot.proof;
      expect(await computeAuthoritativeSaveProofBindingSha256(proof, snapshot.catalogSeed)).toBe(bindingSha256);
      expect(source.bytes.byteLength).toBe(source.proof.storedByteLength);
    });
  }

  for (const damage of ["bytes", "length", "seed", "binding", "raw-digest", "state-checksum", "summary-mode"] as const) {
    it(`rejects ${damage} mismatch before creating a snapshot`, async () => {
      const { source } = await fixture();
      if (damage === "bytes") new Uint8Array(source.bytes)[0] ^= 1;
      if (damage === "length") source.bytes = source.bytes.slice(1);
      if (damage === "seed") source.catalogSeed.elapsedSeconds++;
      if (damage === "binding") source.proof.bindingSha256 = "0".repeat(64);
      if (damage === "state-checksum") source.catalogSeed.stateChecksum = "00000000";
      if (damage === "summary-mode") source.summary.mode = "speedrun";
      if (damage === "raw-digest") {
        source.proof.payloadSha256 = "0".repeat(64);
        const { bindingSha256: _binding, ...proof } = source.proof;
        source.proof.bindingSha256 = await computeAuthoritativeSaveProofBindingSha256(proof, source.catalogSeed);
      }
      await expect(rewrapAuthoritativePrimarySnapshot(source, 11, "自动快照")).rejects.toThrow(/不匹配/);
    });
  }

  it("rejects invalid timestamp and a snapshot presented as a primary", async () => {
    const { source } = await fixture();
    await expect(rewrapAuthoritativePrimarySnapshot(source, NaN, "自动快照")).rejects.toThrow();
    source.catalogSeed.kind = "snapshot";
    await expect(rewrapAuthoritativePrimarySnapshot(source, 11, "自动快照")).rejects.toThrow();
  });
});
