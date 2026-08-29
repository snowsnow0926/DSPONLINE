import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  LOCAL_SAVE_NATIVE_AUTHORITY_HANDOFF_JOURNAL_KIND,
  LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_EXPIRES_AT,
  acquireLocalSaveNativeAuthorityHandoff,
  localSaveNativeAuthorityHandoffJournalKey,
  parseLocalSaveNativeAuthorityHandoffJournal,
  reconcileLocalSaveNativeAuthorityHandoff,
  releaseLocalSaveNativeAuthorityHandoff,
  type LocalSaveNativeAuthorityBrowserFencedJournal,
  type LocalSaveNativeAuthorityHandoffReconcileDecision,
  type LocalSaveNativeAuthorityRustLeaseObservation,
} from "./localSaveAuthorityLease";
import type { LocalSaveWriterLease } from "./localSaveCoordination";

const ROOT_HASH = "a".repeat(64);
const OTHER_ROOT_HASH = "b".repeat(64);
const STORE_SOURCE = readFileSync(resolve("src/game/localSaveStore.ts"), "utf8");

function sourceBlock(start: string, end: string): string {
  const startIndex = STORE_SOURCE.indexOf(start);
  const endIndex = STORE_SOURCE.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source end marker: ${end}`).toBeGreaterThan(startIndex);
  return STORE_SOURCE.slice(startIndex, endIndex);
}

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

function acquireFixture(overrides: Partial<Parameters<typeof acquireLocalSaveNativeAuthorityHandoff>[0]> = {}) {
  const currentLease = javascriptLease();
  const result = acquireLocalSaveNativeAuthorityHandoff({
    currentLease,
    currentJournal: null,
    expectedWriterFence: { ownerId: currentLease.ownerId, fencingToken: currentLease.fencingToken },
    runId: "run-1",
    sessionId: "core-session-1",
    checkpoint: { generation: 4, rootHash: ROOT_HASH, revision: 19 },
    now: 1_000,
    ...overrides,
  });
  if (!result.ok) throw new Error(`fixture acquisition failed: ${result.reason}`);
  return result;
}

function activeRust(
  journal: LocalSaveNativeAuthorityBrowserFencedJournal,
  overrides: Partial<Extract<LocalSaveNativeAuthorityRustLeaseObservation, { state: "active" }>> = {},
): Extract<LocalSaveNativeAuthorityRustLeaseObservation, { state: "active" }> {
  return {
    state: "active",
    runId: journal.runId,
    sessionId: journal.sessionId,
    stateVersion: 47,
    mode: "normal",
    checkpoint: journal.checkpoint,
    ...overrides,
  };
}

function releaseDecision(
  journal: LocalSaveNativeAuthorityBrowserFencedJournal,
): Extract<LocalSaveNativeAuthorityHandoffReconcileDecision, { action: "release-browser-fence" }> {
  const decision = reconcileLocalSaveNativeAuthorityHandoff({
    journal,
    currentLease: {
      schemaVersion: 1,
      ownerId: journal.nativeWriterFence.ownerId,
      fencingToken: journal.nativeWriterFence.fencingToken,
      heartbeatAt: journal.createdAt,
      expiresAt: LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_EXPIRES_AT,
    },
    rustLease: { state: "absent" },
    releaseAuthorized: true,
  });
  if (decision.action !== "release-browser-fence") throw new Error("expected release decision");
  return decision;
}

describe("local save native-authority handoff journal", () => {
  it("keeps acquire/release journal mutations in one existing-v2 records transaction and inspect read-only", () => {
    expect(STORE_SOURCE).toMatch(/const DATABASE_VERSION = 2;/);
    const acquire = sourceBlock(
      "export async function acquireLocalSaveNativeAuthorityHandoff",
      "/** Explicit hand-back for a handoff",
    );
    expect(acquire.match(/database\.transaction\(RECORD_STORE, "readwrite"\)/g)).toHaveLength(1);
    expect(acquire).toMatch(/Promise\.all\(\[[\s\S]*?LOCAL_SAVE_WRITER_LEASE_KEY[\s\S]*?journalKey/);
    expect(acquire).toMatch(/putStoredValue\([\s\S]*?LOCAL_SAVE_WRITER_LEASE_KEY[\s\S]*?putStoredValue\([\s\S]*?journalKey[\s\S]*?await done/);

    const release = sourceBlock(
      "export async function releaseLocalSaveNativeAuthorityHandoff",
      "/** Read-only, same-snapshot inspection",
    );
    expect(release.match(/database\.transaction\(RECORD_STORE, "readwrite"\)/g)).toHaveLength(1);
    expect(release).toMatch(/Promise\.all\(\[[\s\S]*?LOCAL_SAVE_WRITER_LEASE_KEY[\s\S]*?journalKey/);
    expect(release).toMatch(/putStoredValue\([\s\S]*?LOCAL_SAVE_WRITER_LEASE_KEY[\s\S]*?putStoredValue\([\s\S]*?journalKey[\s\S]*?await done/);

    const inspect = sourceBlock(
      "export async function inspectLocalSaveNativeAuthorityHandoff",
      "async function claimWriterLease",
    );
    expect(inspect).toContain('database.transaction(RECORD_STORE, "readonly")');
    expect(inspect).not.toContain("putStoredValue(");
    expect(inspect).not.toContain('database.transaction(RECORD_STORE, "readwrite")');
  });

  it("binds one v47 normal checkpoint to the same run/lease ID and strict writer fences", () => {
    const acquired = acquireFixture();
    expect(acquired).toMatchObject({
      changed: true,
      lease: {
        ownerId: "native_authority:run-1",
        fencingToken: 8,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      receipt: { leaseId: "run-1" },
      journal: {
        schemaVersion: 1,
        kind: LOCAL_SAVE_NATIVE_AUTHORITY_HANDOFF_JOURNAL_KIND,
        runId: "run-1",
        sessionId: "core-session-1",
        stateVersion: 47,
        mode: "normal",
        checkpoint: { generation: 4, rootHash: ROOT_HASH, revision: 19 },
        previousWriterFence: { ownerId: "tab_primary", fencingToken: 7 },
        nativeWriterFence: { ownerId: "native_authority:run-1", fencingToken: 8 },
        phase: "browser-fenced",
        createdAt: 1_000,
      },
    });
    expect(localSaveNativeAuthorityHandoffJournalKey("run-1")).toContain(".native-authority-handoff.run-1");
    expect(localSaveNativeAuthorityHandoffJournalKey("bad run")).toBeNull();
    expect(parseLocalSaveNativeAuthorityHandoffJournal(JSON.stringify(acquired.journal))).toEqual(acquired.journal);
  });

  it("strictly rejects unknown top-level/nested keys and every incompatible identity", () => {
    const journal = acquireFixture().journal;
    const mutations: unknown[] = [
      { ...journal, extra: true },
      { ...journal, checkpoint: { ...journal.checkpoint, extra: true } },
      { ...journal, previousWriterFence: { ...journal.previousWriterFence, extra: true } },
      { ...journal, previousWriterFence: { ownerId: "native_authority:older", fencingToken: 7 } },
      { ...journal, nativeWriterFence: { ...journal.nativeWriterFence, extra: true } },
      { ...journal, schemaVersion: 2 },
      { ...journal, kind: "other" },
      { ...journal, runId: "different-run" },
      { ...journal, sessionId: "bad session" },
      { ...journal, stateVersion: 46 },
      { ...journal, mode: "speedrun" },
      { ...journal, checkpoint: { ...journal.checkpoint, generation: 0 } },
      { ...journal, checkpoint: { ...journal.checkpoint, rootHash: "A".repeat(64) } },
      { ...journal, checkpoint: { ...journal.checkpoint, revision: -1 } },
      { ...journal, nativeWriterFence: { ...journal.nativeWriterFence, fencingToken: 9 } },
      { ...journal, phase: "active" },
      { ...journal, createdAt: 1.5 },
    ];
    for (const mutation of mutations) {
      expect(parseLocalSaveNativeAuthorityHandoffJournal(JSON.stringify(mutation))).toBeNull();
    }
    expect(parseLocalSaveNativeAuthorityHandoffJournal("not-json")).toBeNull();
  });

  it("allows only an exact idempotent retry and never backfills an orphan lease or reuses a tombstone", () => {
    const acquired = acquireFixture();
    expect(acquireLocalSaveNativeAuthorityHandoff({
      currentLease: acquired.lease,
      currentJournal: acquired.journal,
      expectedWriterFence: acquired.receipt.previousWriterFence,
      runId: acquired.journal.runId,
      sessionId: acquired.journal.sessionId,
      checkpoint: acquired.journal.checkpoint,
      now: 2_000,
    })).toMatchObject({ ok: true, changed: false, journal: acquired.journal });

    expect(acquireLocalSaveNativeAuthorityHandoff({
      currentLease: acquired.lease,
      currentJournal: null,
      expectedWriterFence: acquired.receipt.previousWriterFence,
      runId: acquired.journal.runId,
      sessionId: acquired.journal.sessionId,
      checkpoint: acquired.journal.checkpoint,
      now: 2_000,
    })).toEqual({ ok: false, reason: "journal-conflict" });

    expect(acquireLocalSaveNativeAuthorityHandoff({
      currentLease: acquired.lease,
      currentJournal: acquired.journal,
      expectedWriterFence: acquired.receipt.previousWriterFence,
      runId: acquired.journal.runId,
      sessionId: "different-session",
      checkpoint: acquired.journal.checkpoint,
      now: 2_000,
    })).toEqual({ ok: false, reason: "journal-conflict" });

    const decision = releaseDecision(acquired.journal);
    const released = releaseLocalSaveNativeAuthorityHandoff({
      currentLease: acquired.lease,
      currentJournal: acquired.journal,
      receipt: acquired.receipt,
      targetWriterId: "tab_primary",
      decision,
      now: 3_000,
    });
    if (!released.ok) throw new Error("expected release");
    expect(acquireLocalSaveNativeAuthorityHandoff({
      currentLease: released.lease,
      currentJournal: released.journal,
      expectedWriterFence: { ownerId: released.lease.ownerId, fencingToken: released.lease.fencingToken },
      runId: acquired.journal.runId,
      sessionId: acquired.journal.sessionId,
      checkpoint: acquired.journal.checkpoint,
      now: 4_000,
    })).toEqual({ ok: false, reason: "journal-conflict" });
  });

  it("reconciles only exact active Rust identity or explicitly authorized absence", () => {
    const acquired = acquireFixture();
    const input = {
      journal: acquired.journal,
      currentLease: acquired.lease,
    };
    expect(reconcileLocalSaveNativeAuthorityHandoff({
      ...input,
      rustLease: activeRust(acquired.journal),
      releaseAuthorized: false,
    })).toMatchObject({ action: "resume-native", runId: "run-1" });
    expect(reconcileLocalSaveNativeAuthorityHandoff({
      ...input,
      rustLease: { state: "absent" },
      releaseAuthorized: true,
    })).toMatchObject({ action: "release-browser-fence", runId: "run-1" });
  });

  it.each([
    ["active run mismatch", (journal: LocalSaveNativeAuthorityBrowserFencedJournal) => activeRust(journal, { runId: "other-run" }), true, "rust-active-mismatch"],
    ["active session mismatch", (journal: LocalSaveNativeAuthorityBrowserFencedJournal) => activeRust(journal, { sessionId: "other-session" }), true, "rust-active-mismatch"],
    ["active checkpoint generation mismatch", (journal: LocalSaveNativeAuthorityBrowserFencedJournal) => activeRust(journal, { checkpoint: { ...journal.checkpoint, generation: journal.checkpoint.generation + 1 } }), true, "rust-active-mismatch"],
    ["active checkpoint hash mismatch", (journal: LocalSaveNativeAuthorityBrowserFencedJournal) => activeRust(journal, { checkpoint: { ...journal.checkpoint, rootHash: OTHER_ROOT_HASH } }), true, "rust-active-mismatch"],
    ["active revision mismatch", (journal: LocalSaveNativeAuthorityBrowserFencedJournal) => activeRust(journal, { checkpoint: { ...journal.checkpoint, revision: journal.checkpoint.revision + 1 } }), true, "rust-active-mismatch"],
    ["active state version mismatch", (journal: LocalSaveNativeAuthorityBrowserFencedJournal) => ({ ...activeRust(journal), stateVersion: 46 }), true, "rust-active-mismatch"],
    ["active mode mismatch", (journal: LocalSaveNativeAuthorityBrowserFencedJournal) => ({ ...activeRust(journal), mode: "speedrun" }), true, "rust-active-mismatch"],
    ["explicit absence without authorization", () => ({ state: "absent" as const }), false, "rust-lease-absent-release-not-authorized"],
    ["unknown even with authorization", () => ({ state: "unknown" as const }), true, "rust-lease-state-unknown"],
    ["unknown without authorization", () => ({ state: "unknown" as const }), false, "rust-lease-state-unknown"],
    ["malformed active observation", () => ({ state: "active" as const, extra: true }), true, "rust-active-mismatch"],
    ["malformed absence observation", () => ({ state: "absent" as const, extra: true }), true, "rust-lease-state-unknown"],
    ["non-object observation", () => null, true, "rust-lease-state-unknown"],
  ])("fails closed for %s", (_label, rustFactory, releaseAuthorized, reason) => {
    const acquired = acquireFixture();
    expect(reconcileLocalSaveNativeAuthorityHandoff({
      journal: acquired.journal,
      currentLease: acquired.lease,
      rustLease: rustFactory(acquired.journal),
      releaseAuthorized,
    })).toEqual({ action: "fail-closed", reason, runId: "run-1" });
  });

  it("fails closed when the durable browser fence is missing, returned, expired, or mismatched", () => {
    const acquired = acquireFixture();
    const rustLease = activeRust(acquired.journal);
    const invalidInputs = [
      { journal: null, currentLease: acquired.lease, reason: "browser-fence-invalid", runId: null },
      { journal: acquired.journal, currentLease: null, reason: "browser-fence-invalid", runId: "run-1" },
      { journal: acquired.journal, currentLease: { ...acquired.lease, fencingToken: 9 }, reason: "browser-fence-invalid", runId: "run-1" },
      { journal: acquired.journal, currentLease: { ...acquired.lease, expiresAt: 2_000 }, reason: "browser-fence-invalid", runId: "run-1" },
    ];
    for (const input of invalidInputs) {
      expect(reconcileLocalSaveNativeAuthorityHandoff({
        journal: input.journal,
        currentLease: input.currentLease,
        rustLease,
        releaseAuthorized: true,
      })).toEqual({ action: "fail-closed", reason: input.reason, runId: input.runId });
    }

    const released = releaseLocalSaveNativeAuthorityHandoff({
      currentLease: acquired.lease,
      currentJournal: acquired.journal,
      receipt: acquired.receipt,
      targetWriterId: "tab_primary",
      decision: releaseDecision(acquired.journal),
      now: 3_000,
    });
    if (!released.ok) throw new Error("expected release");
    expect(reconcileLocalSaveNativeAuthorityHandoff({
      journal: released.journal,
      currentLease: released.lease,
      rustLease,
      releaseAuthorized: true,
    })).toEqual({ action: "fail-closed", reason: "journal-not-browser-fenced", runId: "run-1" });
  });

  it("atomically plans N+2 hand-back plus an auditable tombstone and supports exact retry", () => {
    const acquired = acquireFixture();
    const decision = releaseDecision(acquired.journal);
    const released = releaseLocalSaveNativeAuthorityHandoff({
      currentLease: acquired.lease,
      currentJournal: acquired.journal,
      receipt: acquired.receipt,
      targetWriterId: "tab_recovery",
      decision,
      now: 3_000,
    });
    expect(released).toMatchObject({
      ok: true,
      changed: true,
      lease: { ownerId: "tab_recovery", fencingToken: 9 },
      journal: {
        phase: "handed-back",
        runId: "run-1",
        handedBackAt: 3_000,
        returnedWriterFence: { ownerId: "tab_recovery", fencingToken: 9 },
      },
    });
    if (!released.ok) throw new Error("expected release");
    expect(parseLocalSaveNativeAuthorityHandoffJournal(JSON.stringify(released.journal))).toEqual(released.journal);
    expect(releaseLocalSaveNativeAuthorityHandoff({
      currentLease: released.lease,
      currentJournal: released.journal,
      receipt: acquired.receipt,
      targetWriterId: "tab_recovery",
      decision,
      now: 4_000,
    })).toMatchObject({ ok: true, changed: false, journal: released.journal });

    expect(parseLocalSaveNativeAuthorityHandoffJournal(JSON.stringify({
      ...released.journal,
      extra: true,
    }))).toBeNull();
    expect(parseLocalSaveNativeAuthorityHandoffJournal(JSON.stringify({
      ...released.journal,
      returnedWriterFence: { ...released.journal.returnedWriterFence, fencingToken: 8 },
    }))).toBeNull();
  });

  it("rejects hand-back without the exact reconcile decision, receipt, journal, and native lease", () => {
    const acquired = acquireFixture();
    const decision = releaseDecision(acquired.journal);
    const cases = [
      { decision: { action: "fail-closed", reason: "rust-lease-state-unknown", runId: "run-1" } as const },
      { decision: { ...decision, extra: true } as unknown as typeof decision },
      { decision: { ...decision, sessionId: "other-session" } },
      { receipt: { ...acquired.receipt, leaseId: "other-run" } },
      { currentJournal: { ...acquired.journal, sessionId: "other-session" } },
      { currentLease: { ...acquired.lease, fencingToken: acquired.lease.fencingToken + 1 } },
    ];
    for (const override of cases) {
      expect(releaseLocalSaveNativeAuthorityHandoff({
        currentLease: acquired.lease,
        currentJournal: acquired.journal,
        receipt: acquired.receipt,
        targetWriterId: "tab_primary",
        decision,
        now: 3_000,
        ...override,
      }).ok).toBe(false);
    }
  });
});
