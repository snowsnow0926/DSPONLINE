import { describe, expect, it } from "vitest";
import {
  LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_EXPIRES_AT,
  LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX,
  acquireLocalSaveNativeAuthorityLease,
  isLocalSaveNativeAuthorityLease,
  localSaveNativeAuthorityLeaseId,
  localSaveWriterLeaseMatchesFence,
  releaseLocalSaveNativeAuthorityLease,
} from "./localSaveAuthorityLease";
import type { LocalSaveWriterLease } from "./localSaveCoordination";

function javascriptLease(overrides: Partial<LocalSaveWriterLease> = {}): LocalSaveWriterLease {
  return {
    schemaVersion: 1,
    ownerId: "tab_primary",
    fencingToken: 7,
    heartbeatAt: 100,
    expiresAt: 15_100,
    ...overrides,
  };
}

describe("local save native-authority lease", () => {
  it("transfers the exact JS writer fence to a durable reserved native owner", () => {
    const current = javascriptLease();
    const acquired = acquireLocalSaveNativeAuthorityLease({
      current,
      expectedWriterFence: { ownerId: current.ownerId, fencingToken: current.fencingToken },
      leaseId: "handoff-1",
      now: 1_000,
    });
    expect(acquired).toMatchObject({
      ok: true,
      changed: true,
      lease: {
        ownerId: `${LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX}handoff-1`,
        fencingToken: 8,
        heartbeatAt: 1_000,
        expiresAt: LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_EXPIRES_AT,
      },
      receipt: {
        leaseId: "handoff-1",
        previousWriterFence: { ownerId: "tab_primary", fencingToken: 7 },
        nativeWriterFence: {
          ownerId: `${LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX}handoff-1`,
          fencingToken: 8,
        },
      },
    });
    if (!acquired.ok) throw new Error("expected acquisition");
    expect(isLocalSaveNativeAuthorityLease(acquired.lease)).toBe(true);
    expect(localSaveNativeAuthorityLeaseId(acquired.lease)).toBe("handoff-1");
    expect(localSaveWriterLeaseMatchesFence(acquired.lease, acquired.receipt.previousWriterFence)).toBe(false);
  });

  it("is idempotent only for the deterministic result of the same acquisition", () => {
    const current = javascriptLease();
    const first = acquireLocalSaveNativeAuthorityLease({
      current,
      expectedWriterFence: { ownerId: current.ownerId, fencingToken: current.fencingToken },
      leaseId: "handoff-retry",
      now: 2_000,
    });
    if (!first.ok) throw new Error("expected acquisition");
    expect(acquireLocalSaveNativeAuthorityLease({
      current: first.lease,
      expectedWriterFence: first.receipt.previousWriterFence,
      leaseId: first.receipt.leaseId,
      now: 3_000,
    })).toMatchObject({ ok: true, changed: false, lease: first.lease, receipt: first.receipt });
    expect(acquireLocalSaveNativeAuthorityLease({
      current: first.lease,
      expectedWriterFence: first.receipt.previousWriterFence,
      leaseId: "different-handoff",
      now: 3_000,
    })).toEqual({ ok: false, reason: "native-held" });
  });

  it("rejects stale/cross-writer acquisition and malformed native lease IDs", () => {
    const current = javascriptLease();
    expect(acquireLocalSaveNativeAuthorityLease({
      current,
      expectedWriterFence: { ownerId: current.ownerId, fencingToken: current.fencingToken - 1 },
      leaseId: "handoff-stale",
    })).toEqual({ ok: false, reason: "cas-mismatch" });
    expect(acquireLocalSaveNativeAuthorityLease({
      current,
      expectedWriterFence: { ownerId: "tab_other", fencingToken: current.fencingToken },
      leaseId: "handoff-stale",
    })).toEqual({ ok: false, reason: "cas-mismatch" });
    expect(acquireLocalSaveNativeAuthorityLease({
      current,
      expectedWriterFence: { ownerId: current.ownerId, fencingToken: current.fencingToken },
      leaseId: "contains whitespace",
    })).toEqual({ ok: false, reason: "invalid" });
  });

  it("returns the lease with another token increment so stale JS work cannot pass after hand-back", () => {
    const original = javascriptLease();
    const acquired = acquireLocalSaveNativeAuthorityLease({
      current: original,
      expectedWriterFence: { ownerId: original.ownerId, fencingToken: original.fencingToken },
      leaseId: "handoff-release",
      now: 4_000,
    });
    if (!acquired.ok) throw new Error("expected acquisition");
    const released = releaseLocalSaveNativeAuthorityLease({
      current: acquired.lease,
      receipt: acquired.receipt,
      targetWriterId: original.ownerId,
      now: 5_000,
    });
    expect(released).toMatchObject({
      ok: true,
      changed: true,
      lease: {
        ownerId: original.ownerId,
        fencingToken: 9,
        heartbeatAt: 5_000,
        expiresAt: 5_000 + 15_000,
      },
    });
    if (!released.ok) throw new Error("expected release");
    expect(localSaveWriterLeaseMatchesFence(released.lease, {
      ownerId: original.ownerId,
      fencingToken: original.fencingToken,
    })).toBe(false);
    expect(releaseLocalSaveNativeAuthorityLease({
      current: released.lease,
      receipt: acquired.receipt,
      targetWriterId: original.ownerId,
      now: 6_000,
    })).toMatchObject({ ok: true, changed: false, lease: released.lease });
  });

  it("never accepts a different native receipt or an exhausted fencing token", () => {
    const exhausted = javascriptLease({ fencingToken: Number.MAX_SAFE_INTEGER });
    expect(acquireLocalSaveNativeAuthorityLease({
      current: exhausted,
      expectedWriterFence: { ownerId: exhausted.ownerId, fencingToken: exhausted.fencingToken },
      leaseId: "handoff-exhausted",
    })).toEqual({ ok: false, reason: "token-exhausted" });

    const original = javascriptLease();
    const acquired = acquireLocalSaveNativeAuthorityLease({
      current: original,
      expectedWriterFence: { ownerId: original.ownerId, fencingToken: original.fencingToken },
      leaseId: "handoff-a",
    });
    if (!acquired.ok) throw new Error("expected acquisition");
    const other = acquireLocalSaveNativeAuthorityLease({
      current: original,
      expectedWriterFence: { ownerId: original.ownerId, fencingToken: original.fencingToken },
      leaseId: "handoff-b",
    });
    if (!other.ok) throw new Error("expected second independent acquisition proof");
    expect(releaseLocalSaveNativeAuthorityLease({
      current: acquired.lease,
      receipt: other.receipt,
      targetWriterId: original.ownerId,
    })).toEqual({ ok: false, reason: "cas-mismatch" });
  });
});
