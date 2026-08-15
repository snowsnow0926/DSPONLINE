import { describe, expect, it } from "vitest";
import {
  canonicalAuthoritativeSaveJson,
  computeAuthoritativeSaveProofBindingSha256,
} from "./authoritativeSaveProof";

const seed = {
  mode: "normal" as const,
  kind: "primary" as const,
  slot: "main" as const,
  savedAt: 1,
  stateVersion: 46,
  entityCount: 1,
  beltCount: 1,
  elapsedSeconds: 2,
  completedTechCount: 3,
  activePlanetId: "home",
  structurePoints: 4,
  stateChecksum: "1234abcd",
  reason: null,
  settings: { volume: 0.5 } as never,
};

const proof = {
  integrity: "valid" as const,
  payloadChecksum: "deadbeef",
  payloadSha256: "a".repeat(64),
  byteLength: 10,
  stateChecksum: "1234abcd",
};

describe("authoritative save proof binding", () => {
  it("is stable across object insertion order and changes on seed/payload tampering", async () => {
    const first = await computeAuthoritativeSaveProofBindingSha256(proof, seed);
    const reorderedSeed = {
      settings: { volume: 0.5 } as never, reason: null, stateChecksum: "1234abcd", structurePoints: 4,
      activePlanetId: "home", completedTechCount: 3, elapsedSeconds: 2, beltCount: 1,
      entityCount: 1, stateVersion: 46, savedAt: 1, slot: "main" as const,
      kind: "primary" as const, mode: "normal" as const,
    };
    const reordered = await computeAuthoritativeSaveProofBindingSha256(proof, reorderedSeed);
    const changed = await computeAuthoritativeSaveProofBindingSha256({ ...proof, payloadSha256: "b".repeat(64) }, seed);
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("rejects cycles, BigInt, non-finite values, sparse arrays, and unsupported values", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalAuthoritativeSaveJson(cycle)).toThrow(/循环/);
    expect(() => canonicalAuthoritativeSaveJson({ value: BigInt(1) })).toThrow(/bigint/);
    expect(() => canonicalAuthoritativeSaveJson({ value: Number.NaN })).toThrow(/非有限/);
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => canonicalAuthoritativeSaveJson(sparse)).toThrow(/稀疏/);
    expect(() => canonicalAuthoritativeSaveJson({ value: undefined })).toThrow(/undefined/);
  });
});
