import { describe, expect, it } from "vitest";

import {
  canCommitLegacyAuthorityAsyncLease,
  canContinueLegacyAuthorityAsyncLease,
  createLegacyAuthorityAsyncLeaseFence,
  issueLegacyAuthorityAsyncLease,
  reconcileLegacyAuthorityAsyncLeaseFence,
  type LegacyAuthorityAsyncLeaseFence,
} from "./legacyAuthorityAsyncLease";

describe("legacy authority async lease fence", () => {
  it("starts bootstrap-blocked by default and can start JavaScript-authoritative explicitly", () => {
    const pending = createLegacyAuthorityAsyncLeaseFence();
    expect(pending).toEqual({ authority: "bootstrap-pending", generation: 0 });
    expect(issueLegacyAuthorityAsyncLease(pending)).toBeNull();

    const javascript = createLegacyAuthorityAsyncLeaseFence("javascript");
    const token = issueLegacyAuthorityAsyncLease(javascript);
    expect(token).toEqual({ generation: 0 });
    expect(canContinueLegacyAuthorityAsyncLease(token, javascript)).toBe(true);
    expect(canCommitLegacyAuthorityAsyncLease(token, javascript)).toBe(true);
  });

  it("invalidates a JavaScript lease when native ownership changes false to true", () => {
    const javascript = createLegacyAuthorityAsyncLeaseFence("javascript");
    const token = issueLegacyAuthorityAsyncLease(javascript);
    const native = reconcileLegacyAuthorityAsyncLeaseFence(javascript, "native");

    expect(native).toEqual({ authority: "native", generation: 1 });
    expect(issueLegacyAuthorityAsyncLease(native)).toBeNull();
    expect(canContinueLegacyAuthorityAsyncLease(token, native)).toBe(false);
    expect(canCommitLegacyAuthorityAsyncLease(token, native)).toBe(false);
  });

  it("prevents false-to-true-to-false ABA from reviving an old lease", () => {
    const firstJavascript = createLegacyAuthorityAsyncLeaseFence("javascript");
    const oldToken = issueLegacyAuthorityAsyncLease(firstJavascript);
    const native = reconcileLegacyAuthorityAsyncLeaseFence(firstJavascript, "native");
    const returnedJavascript = reconcileLegacyAuthorityAsyncLeaseFence(native, "javascript");
    const currentToken = issueLegacyAuthorityAsyncLease(returnedJavascript);

    expect(returnedJavascript).toEqual({ authority: "javascript", generation: 2 });
    expect(oldToken).toEqual({ generation: 0 });
    expect(currentToken).toEqual({ generation: 2 });
    expect(canContinueLegacyAuthorityAsyncLease(oldToken, returnedJavascript)).toBe(false);
    expect(canCommitLegacyAuthorityAsyncLease(oldToken, returnedJavascript)).toBe(false);
    expect(canContinueLegacyAuthorityAsyncLease(currentToken, returnedJavascript)).toBe(true);
    expect(canCommitLegacyAuthorityAsyncLease(currentToken, returnedJavascript)).toBe(true);
  });

  it("keeps one inherited lease stale across a nested async native-to-JavaScript ABA", async () => {
    let fence = createLegacyAuthorityAsyncLeaseFence("javascript");
    const inheritedToken = issueLegacyAuthorityAsyncLease(fence);
    let releaseAwait = (): void => {
      throw new Error("await boundary was not initialized");
    };
    const awaitBoundary = new Promise<void>((resolve) => {
      releaseAwait = resolve;
    });
    const nestedContinuation = async () => {
      await awaitBoundary;
      return canContinueLegacyAuthorityAsyncLease(inheritedToken, fence);
    };

    const pending = nestedContinuation();
    fence = reconcileLegacyAuthorityAsyncLeaseFence(fence, "native");
    fence = reconcileLegacyAuthorityAsyncLeaseFence(fence, "javascript");
    releaseAwait();

    expect(await pending).toBe(false);
    expect(canContinueLegacyAuthorityAsyncLease(issueLegacyAuthorityAsyncLease(fence), fence)).toBe(true);
  });

  it("unblocks and advances the fence when bootstrap resolves to JavaScript", () => {
    const pending = createLegacyAuthorityAsyncLeaseFence("bootstrap-pending");
    const javascript = reconcileLegacyAuthorityAsyncLeaseFence(pending, "javascript");
    const token = issueLegacyAuthorityAsyncLease(javascript);

    expect(javascript).toEqual({ authority: "javascript", generation: 1 });
    expect(token).toEqual({ generation: 1 });
    expect(canContinueLegacyAuthorityAsyncLease(token, javascript)).toBe(true);
    expect(canCommitLegacyAuthorityAsyncLease(token, javascript)).toBe(true);
  });

  it("stays blocked and advances the fence when bootstrap resolves to native", () => {
    const pending = createLegacyAuthorityAsyncLeaseFence("bootstrap-pending");
    const native = reconcileLegacyAuthorityAsyncLeaseFence(pending, "native");

    expect(native).toEqual({ authority: "native", generation: 1 });
    expect(issueLegacyAuthorityAsyncLease(native)).toBeNull();
    expect(canContinueLegacyAuthorityAsyncLease(null, native)).toBe(false);
    expect(canCommitLegacyAuthorityAsyncLease(null, native)).toBe(false);
  });

  it.each(["bootstrap-pending", "javascript", "native"] as const)(
    "does not advance generation for repeated %s state",
    (authority) => {
      const current = createLegacyAuthorityAsyncLeaseFence(authority);
      const repeated = reconcileLegacyAuthorityAsyncLeaseFence(current, authority);

      expect(repeated).toBe(current);
      expect(repeated.generation).toBe(0);
    },
  );

  it("fails closed instead of wrapping an exhausted generation", () => {
    const exhausted: LegacyAuthorityAsyncLeaseFence = {
      authority: "javascript",
      generation: Number.MAX_SAFE_INTEGER,
    };

    expect(() => reconcileLegacyAuthorityAsyncLeaseFence(exhausted, "native")).toThrow(RangeError);
  });
});
