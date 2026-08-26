import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createInitialState } from "./engine";
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
});

