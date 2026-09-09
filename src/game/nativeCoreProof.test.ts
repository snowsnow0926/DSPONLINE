import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createInitialState } from "./engine";
import type { GameState } from "./types";
import {
  canonicalNativeCoreSha256,
  createNativeCoreRevisionProof,
  nativeCoreDomainSha256,
} from "./nativeCoreProof";

function canonicalReference(value: unknown): string {
  const hash = createHash("sha256");
  const visit = (current: unknown, arrayEntry = false) => {
    if (current === undefined || typeof current === "function" || typeof current === "symbol") {
      if (arrayEntry) hash.update("null");
      return;
    }
    if (current === null || typeof current !== "object") {
      hash.update(JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      hash.update("[");
      current.forEach((entry, index) => {
        if (index > 0) hash.update(",");
        visit(entry, true);
      });
      hash.update("]");
      return;
    }
    hash.update("{");
    const record = current as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    keys.forEach((key, index) => {
      if (index > 0) hash.update(",");
      hash.update(JSON.stringify(key));
      hash.update(":");
      visit(record[key]);
    });
    hash.update("}");
  };
  visit(value);
  return hash.digest("hex");
}

describe("native core JavaScript checkpoint proofs", () => {
  it("streams canonical JSON without changing ECMAScript number or object semantics", () => {
    const value = {
      z: [null, true, -0, 1e-7, "中文🙂", undefined],
      a: { omitted: undefined, b: 2, a: 1 },
    };
    expect(canonicalNativeCoreSha256(value)).toBe(canonicalReference(value));
  });

  it("matches WebCrypto across block and padding boundaries", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 4_097, 131_071]) {
      const value = "中🙂x".repeat(length);
      const expected = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      expect(canonicalNativeCoreSha256(value), `length=${length}`).toBe(expected);
    }
  });

  it("creates a revision-bound full and domain proof without mutating state", () => {
    const state = createInitialState(0x1234abcd);
    const before = structuredClone(state);
    const proof = createNativeCoreRevisionProof(state, 7, "a".repeat(64), "core");
    expect(proof).toEqual({
      revision: 7,
      rootHash: "a".repeat(64),
      canonicalSha256: canonicalReference(state),
      domainSha256: nativeCoreDomainSha256(state, 7),
      registryFingerprint: "core",
    });
    expect(state).toEqual(before);
  });

  it("matches an explicit binary domain vector across revision and float boundaries", () => {
    const state = {
      version: 47, mode: "normal", activePlanetId: "星球🙂", elapsedSeconds: 123.25, paused: false,
      entities: [
        { id: "e1", kind: "machine", planetId: "星球🙂", buildingId: "assembler",
          inputs: { z: 2, iron: -0, ignored: Infinity }, outputs: { assembler: 2.5, new: -Number.MAX_VALUE },
          progress: Number.MIN_VALUE, utilization: NaN, productionRate: -0 },
        { id: "e2", kind: "storage", planetId: "星球🙂", buildingId: "box", resourceId: "iron",
          inputs: {}, outputs: { iron: Number.MIN_VALUE }, progress: Number.MAX_VALUE, productionRate: Infinity },
      ],
      belts: [{ id: "带🙂", planetId: "星球🙂", source: "e1", target: "e2", itemId: "copper",
        progress: -123.5, totalTransferred: 2 ** 40 + 0.5, lastFlow: -0 }],
    } as unknown as GameState;
    const before = structuredClone(state);
    const float = (value: number) => {
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleLE(value);
      return bytes;
    };
    // A hand-written wire vector, independently hashed by Node's crypto;
    // inventory order uses existing native symbols before newly interned items.
    for (const revision of [Number.MAX_SAFE_INTEGER, 0, 2 ** 32 + 5]) {
      const revisionBytes = Buffer.alloc(8);
      revisionBytes.writeBigUInt64LE(BigInt(revision));
      const pieces = [
        "dsp-native-domain-v1\0", revisionBytes, '47\0"normal"\0"星球🙂"\0' + "123.25\0false\0",
        "e1\0iron", float(-0), "z", float(2), "|assembler", float(2.5), "new", float(-Number.MAX_VALUE),
        float(Number.MIN_VALUE), float(0), float(-0),
        "e2\0|iron", float(Number.MIN_VALUE), float(Number.MAX_VALUE), float(0), float(0),
        "带🙂", float(-123.5), float(2 ** 40 + 0.5), float(-0),
      ];
      const expected = createHash("sha256");
      for (const piece of pieces) expected.update(piece);
      expect(nativeCoreDomainSha256(state, revision)).toBe(expected.digest("hex"));
      expect(canonicalNativeCoreSha256({ after: revision, value: "中🙂".repeat(64) }))
        .toBe(canonicalReference({ after: revision, value: "中🙂".repeat(64) }));
    }
    expect(state).toEqual(before);
    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => nativeCoreDomainSha256(state, revision)).toThrow(RangeError);
    }
  });
});
