"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const {
  NativePlayerAuthorityRuntime,
} = require("./native-player-authority-runtime.cjs");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function summary(revision, authorityEligible = true) {
  return {
    revision,
    stateVersion: 47,
    mode: "normal",
    paused: false,
    canonicalSha256: HASH_B,
    domainSha256: HASH_C,
    coverage: { authorityEligible },
  };
}

function leaseReceipt(phase, checkpoint, settledDeadlineMs, authorityEligible = true) {
  return {
    lease: {
      kind: "native-core-exact-realtime-player-authority-lease-v1",
      phase,
      runId: "player-run-1",
      mode: "normal",
      slot: "normal-main",
      checkpoint,
      acknowledged: {
        sequence: 0,
        revision: checkpoint.revision,
        checkpoint,
        settledDeadlineMs,
      },
      pendingTick: null,
    },
    summary: summary(checkpoint.revision, authorityEligible),
  };
}

function fixture(overrides = {}) {
  let now = 10_000;
  const timers = [];
  const calls = [];
  const checkpoint = { generation: 3, rootHash: HASH_A, revision: 7 };
  const registry = {
    async preparePlayerAuthority(ownerId, request) {
      calls.push(["prepare", ownerId, request]);
      return leaseReceipt("prepared", checkpoint, request.settledDeadlineMs);
    },
    async activatePlayerAuthority(ownerId, request) {
      calls.push(["activate", ownerId, request]);
      return leaseReceipt("active", checkpoint, 10_000);
    },
    async commitPlayerAuthorityTick(ownerId, request) {
      calls.push(["tick", ownerId, request]);
      const revision = 7 + request.sequence;
      return {
        sequence: request.sequence,
        revision,
        duplicate: false,
        checkpoint: { generation: 3 + request.sequence, rootHash: HASH_A, revision },
        summary: summary(revision),
      };
    },
    ...overrides.registry,
  };
  const runtime = new NativePlayerAuthorityRuntime({
    registry,
    ownerId: "main-player-authority",
    now: () => now,
    schedule: (callback, delay) => {
      const token = { callback, delay, cancelled: false };
      timers.push(token);
      return token;
    },
    cancel: (token) => { token.cancelled = true; },
    minimumYieldMs: 1,
  });
  return {
    runtime,
    checkpoint,
    calls,
    timers,
    setNow(value) { now = value; },
  };
}

test("activation stays main-owned and arms one anchored exact-second timer", async () => {
  const value = fixture();
  const activated = await value.runtime.activate({
    sessionId: "core-main-1",
    runId: "player-run-1",
    expectedCheckpoint: value.checkpoint,
    settledDeadlineMs: 10_000,
  });

  assert.equal(activated.phase, "active");
  assert.equal(activated.revision, 7);
  assert.equal(activated.nextSequence, 1);
  assert.equal(activated.nextDeadlineMs, 11_000);
  assert.equal(activated.inFlight, false);
  assert.equal(value.timers.length, 1);
  assert.equal(value.timers[0].delay, 1_000);
  assert.deepEqual(value.calls.map(([operation, owner]) => [operation, owner]), [
    ["prepare", "main-player-authority"],
    ["activate", "main-player-authority"],
  ]);
});

test("only one tick is in flight and successful receipts advance exactly once", async () => {
  let resolveTick;
  const value = fixture({
    registry: {
      commitPlayerAuthorityTick(ownerId, request) {
        value.calls.push(["tick", ownerId, request]);
        return new Promise((resolve) => { resolveTick = resolve; });
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  value.setNow(11_000);
  const first = value.runtime.settleDue();
  const duplicateCall = value.runtime.settleDue();
  assert.equal(first, duplicateCall);
  assert.equal(value.calls.filter(([operation]) => operation === "tick").length, 1);

  resolveTick({
    sequence: 1,
    revision: 8,
    duplicate: false,
    checkpoint: { generation: 4, rootHash: HASH_A, revision: 8 },
    summary: summary(8),
  });
  const settled = await first;
  assert.equal(settled.revision, 8);
  assert.equal(settled.acknowledgedSequence, 1);
  assert.equal(settled.nextSequence, 2);
  assert.equal(settled.nextDeadlineMs, 12_000);
  assert.equal(settled.inFlight, false);
});

test("lost tick response preserves the same sequence for explicit idempotent retry", async () => {
  let attempts = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthorityTick(ownerId, request) {
        value.calls.push(["tick", ownerId, request]);
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
        return {
          sequence: request.sequence,
          revision: 8,
          duplicate: true,
          checkpoint: { generation: 4, rootHash: HASH_A, revision: 8 },
          summary: summary(8),
        };
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  value.setNow(11_000);
  await assert.rejects(value.runtime.settleDue(), (error) => {
    assert.equal(error.code, "NATIVE_PLAYER_AUTHORITY_TICK_UNCERTAIN");
    return true;
  });
  assert.equal(value.runtime.snapshot().phase, "uncertain");
  assert.equal(value.runtime.snapshot().nextSequence, 1);

  const recovered = await value.runtime.retryUncertain();
  assert.equal(recovered.phase, "active");
  assert.equal(recovered.revision, 8);
  assert.deepEqual(
    value.calls.filter(([operation]) => operation === "tick").map((call) => call[2].sequence),
    [1, 1],
  );
});

test("coverage, checkpoint, and revision mismatches fail closed", async () => {
  const ineligible = fixture({
    registry: {
      async preparePlayerAuthority(_ownerId, request) {
        return leaseReceipt("prepared", ineligible.checkpoint, request.settledDeadlineMs, false);
      },
    },
  });
  await assert.rejects(ineligible.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: ineligible.checkpoint, settledDeadlineMs: 10_000,
  }), (error) => {
    assert.equal(error.code, "NATIVE_PLAYER_AUTHORITY_COVERAGE_INCOMPLETE");
    return true;
  });
  assert.equal(ineligible.runtime.snapshot().phase, "faulted");

  const mismatch = fixture({
    registry: {
      async commitPlayerAuthorityTick(_ownerId, request) {
        return {
          sequence: request.sequence,
          revision: 99,
          duplicate: false,
          checkpoint: { generation: 4, rootHash: HASH_A, revision: 99 },
          summary: summary(99),
        };
      },
    },
  });
  await mismatch.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: mismatch.checkpoint, settledDeadlineMs: 10_000,
  });
  mismatch.setNow(11_000);
  await assert.rejects(mismatch.runtime.settleDue(), (error) => {
    assert.equal(error.code, "NATIVE_PLAYER_AUTHORITY_TICK_RECEIPT_INVALID");
    return true;
  });
  assert.equal(mismatch.runtime.snapshot().phase, "uncertain");
  assert.equal(mismatch.runtime.snapshot().revision, 7);
  assert.equal(mismatch.runtime.snapshot().nextSequence, 1);
});

test("shutdown cancels only the process timer and leaves durable recovery to Rust", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const snapshot = value.runtime.shutdownForProcessExit();
  assert.equal(snapshot.phase, "shutdown");
  assert.equal(value.timers[0].cancelled, true);
  await assert.rejects(value.runtime.retryUncertain(), /no uncertain tick/);
});

test("the authority clock is instantiated in main and is absent from renderer IPC", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  const preload = readFileSync("desktop/preload.cjs", "utf8");

  assert.match(main, /new NativePlayerAuthorityRuntime\(\{[\s\S]*?registry:\s*nativeCoreSessions/);
  assert.match(main, /nativePlayerAuthorityRuntime\?\.shutdownForProcessExit\(\)/);
  assert.doesNotMatch(preload, /PlayerAuthority|player-authority/);
});
