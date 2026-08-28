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

function playerCommand(baseRevision, commandId, value = true) {
  return {
    commandId,
    baseRevision,
    command: {
      protocolVersion: 1,
      baseRevision,
      topLevelChanges: [{ path: ["playerCommandProbe"], operation: "set", value }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    },
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
    async commitPlayerAuthorityCommand(ownerId, request) {
      calls.push(["command", ownerId, request]);
      const revision = request.baseRevision + 1;
      return {
        sequence: revision - checkpoint.revision,
        commandId: request.commandId,
        baseRevision: request.baseRevision,
        revision,
        settledDeadlineMs: 10_000,
        duplicate: false,
        checkpoint: { generation: 3 + revision - checkpoint.revision, rootHash: HASH_A, revision },
        summary: summary(revision),
      };
    },
    async recoverPlayerAuthorityCommand() {
      throw new Error("no pending player-authority command");
    },
    inspectSession(ownerId, sessionId) {
      return {
        kind: "native-core-session-owner-state-v1",
        sessionId,
        ownerId,
        slot: "normal-main",
        ownerEpoch: 1,
        state: "owned",
        inFlight: 0,
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

test("a synchronous tick owner failure becomes uncertain and rejects queued commands", async () => {
  const value = fixture({
    registry: {
      commitPlayerAuthorityTick() {
        throw Object.assign(new Error("session owner changed"), { code: "OWNER_CHANGED" });
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  value.setNow(11_000);
  const tick = value.runtime.settleDue();
  const queued = value.runtime.commitCommand(playerCommand(8, "queued-after-sync-failure", 1));
  await assert.rejects(tick, (error) => error.code === "NATIVE_PLAYER_AUTHORITY_TICK_UNCERTAIN");
  await assert.rejects(
    queued,
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_QUEUE_ABORTED",
  );
  assert.equal(value.runtime.snapshot().phase, "uncertain");
  assert.equal(value.runtime.snapshot().queuedCommands, 0);
  assert.equal(value.runtime.snapshot().revision, 7);
});

test("player commands form one FIFO revision chain and ticks cannot overtake them", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const results = await Promise.all([
    value.runtime.commitCommand(playerCommand(7, "command-1", 1)),
    value.runtime.commitCommand(playerCommand(8, "command-2", 2)),
    value.runtime.commitCommand(playerCommand(9, "command-3", 3)),
  ]);
  assert.deepEqual(results.map((result) => result.revision), [8, 9, 10]);
  assert.deepEqual(
    value.calls.filter(([operation]) => operation === "command").map((call) => call[2].commandId),
    ["command-1", "command-2", "command-3"],
  );
  assert.equal(value.runtime.snapshot().acknowledgedSequence, 3);
  assert.equal(value.runtime.snapshot().nextDeadlineMs, 11_000);

  value.setNow(11_000);
  value.timers[0].callback();
  await value.runtime.inFlight;
  assert.deepEqual(value.calls.slice(-2).map(([operation]) => operation), ["command", "tick"]);
  assert.equal(value.runtime.snapshot().revision, 11);
  assert.equal(value.runtime.snapshot().acknowledgedSequence, 4);
  assert.equal(value.runtime.snapshot().nextDeadlineMs, 12_000);
});

test("a command queued behind an in-flight tick waits and uses the next exact revision", async () => {
  let resolveTick;
  const value = fixture({
    registry: {
      commitPlayerAuthorityTick(ownerId, request) {
        value.calls.push(["tick", ownerId, request]);
        return new Promise((resolve) => { resolveTick = resolve; });
      },
      async commitPlayerAuthorityCommand(ownerId, request) {
        value.calls.push(["command", ownerId, request]);
        return {
          sequence: 2,
          commandId: request.commandId,
          baseRevision: request.baseRevision,
          revision: 9,
          settledDeadlineMs: 11_000,
          duplicate: false,
          checkpoint: { generation: 5, rootHash: HASH_A, revision: 9 },
          summary: summary(9),
        };
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  value.setNow(11_000);
  const tick = value.runtime.settleDue();
  const command = value.runtime.commitCommand(playerCommand(8, "after-tick", 1));
  assert.equal(value.calls.filter(([operation]) => operation === "command").length, 0);
  resolveTick({
    sequence: 1,
    revision: 8,
    duplicate: false,
    checkpoint: { generation: 4, rootHash: HASH_A, revision: 8 },
    summary: summary(8),
  });
  await tick;
  const committed = await command;
  assert.equal(committed.revision, 9);
  assert.deepEqual(value.calls.slice(-2).map(([operation]) => operation), ["tick", "command"]);
});

test("lost command response stays uncertain and retries the exact same command without JS fallback", async () => {
  let attempts = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthorityCommand(ownerId, request) {
        value.calls.push(["command", ownerId, request]);
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
        return {
          sequence: 1,
          commandId: request.commandId,
          baseRevision: request.baseRevision,
          revision: 8,
          settledDeadlineMs: 10_000,
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
  await assert.rejects(value.runtime.commitCommand(playerCommand(7, "uncertain-command", 1)), (error) => {
    assert.equal(error.code, "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN");
    return true;
  });
  assert.equal(value.runtime.snapshot().phase, "uncertain");
  assert.equal(value.runtime.snapshot().revision, 7);
  assert.equal(value.runtime.snapshot().nextSequence, 1);
  const recovered = await value.runtime.retryUncertain();
  assert.equal(recovered.phase, "active");
  assert.equal(recovered.revision, 8);
  assert.deepEqual(
    value.calls.filter(([operation]) => operation === "command").map((call) => call[2].commandId),
    ["uncertain-command", "uncertain-command"],
  );
});

test("an uncertain first command rejects every non-durable queued command", async () => {
  const value = fixture({
    registry: {
      async commitPlayerAuthorityCommand(ownerId, request) {
        value.calls.push(["command", ownerId, request]);
        throw new Error("unknown durable boundary");
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const first = value.runtime.commitCommand(playerCommand(7, "first-uncertain", 1));
  const second = value.runtime.commitCommand(playerCommand(8, "never-started", 2));
  const secondResult = second.catch((error) => error);
  await assert.rejects(first, { code: "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN" });
  const queuedError = await secondResult;
  assert.equal(queuedError.code, "NATIVE_PLAYER_AUTHORITY_COMMAND_QUEUE_ABORTED");
  assert.equal(value.runtime.snapshot().queuedCommands, 0);
  assert.deepEqual(
    value.calls.filter(([operation]) => operation === "command").map((call) => call[2].commandId),
    ["first-uncertain"],
  );
});

test("process-start recovery needs no renderer command payload and resumes the next event", async () => {
  const value = fixture({
    registry: {
      async recoverPlayerAuthorityCommand(ownerId, request) {
        value.calls.push(["recover-command", ownerId, request]);
        return {
          runId: "player-run-1",
          sequence: 4,
          commandId: "durable-command-4",
          baseRevision: 10,
          revision: 11,
          settledDeadlineMs: 15_000,
          duplicate: true,
          checkpoint: { generation: 8, rootHash: HASH_A, revision: 11 },
          summary: summary(11),
        };
      },
    },
  });
  const recovered = await value.runtime.recoverPendingCommand({ sessionId: "core-main-1" });
  assert.equal(recovered.phase, "active");
  assert.equal(recovered.runId, "player-run-1");
  assert.equal(recovered.revision, 11);
  assert.equal(recovered.nextSequence, 5);
  assert.equal(recovered.nextDeadlineMs, 16_000);
  assert.deepEqual(value.calls[0], [
    "recover-command", "main-player-authority", { sessionId: "core-main-1" },
  ]);
  assert.equal(value.runtime.snapshot().queuedCommands, 0);
});

test("durable startup receipt adopts the main-owned Rust session and continues its exact clock", async () => {
  const value = fixture();
  const recoveredSummary = {
    ...summary(11),
    registryFingerprint: "builtin:test",
  };
  const resumed = value.runtime.resumeFromStartupRecovery({
    schemaVersion: 1,
    kind: "native-core-player-authority-startup-recovery-v1",
    ownerId: "main-player-authority",
    sessionId: "core-restarted-1",
    runId: "player-run-1",
    registryFingerprint: "builtin:test",
    revision: 11,
    checkpoint: { generation: 8, rootHash: HASH_A, revision: 11 },
    acknowledgedSequence: 4,
    nextSequence: 5,
    settledDeadlineMs: 10_000,
    nextDeadlineMs: 11_000,
    summary: recoveredSummary,
  });
  assert.equal(resumed.phase, "active");
  assert.equal(resumed.sessionId, "core-restarted-1");
  assert.equal(resumed.revision, 11);
  assert.equal(resumed.nextSequence, 5);
  assert.equal(value.timers.length, 1);
  assert.equal(value.timers[0].delay, 1_000);

  value.setNow(11_000);
  const ticked = await value.runtime.settleDue();
  assert.equal(ticked.revision, 12);
  assert.equal(ticked.acknowledgedSequence, 5);
  assert.equal(ticked.nextSequence, 6);
  assert.equal(ticked.nextDeadlineMs, 12_000);
  assert.deepEqual(value.calls.filter(([operation]) => operation === "tick")[0], [
    "tick", "main-player-authority", {
      sessionId: "core-restarted-1",
      runId: "player-run-1",
      sequence: 5,
    },
  ]);
});

test("clean startup immediately after activation resumes revision and sequence zero", () => {
  const value = fixture();
  const resumed = value.runtime.resumeFromStartupRecovery({
    schemaVersion: 1,
    kind: "native-core-player-authority-startup-recovery-v1",
    ownerId: "main-player-authority",
    sessionId: "core-restarted-initial",
    runId: "player-run-initial",
    registryFingerprint: "builtin:test",
    revision: 0,
    checkpoint: { generation: 1, rootHash: HASH_A, revision: 0 },
    acknowledgedSequence: 0,
    nextSequence: 1,
    settledDeadlineMs: 10_000,
    nextDeadlineMs: 11_000,
    summary: { ...summary(0), registryFingerprint: "builtin:test" },
  });
  assert.equal(resumed.phase, "active");
  assert.equal(resumed.revision, 0);
  assert.equal(resumed.acknowledgedSequence, 0);
  assert.equal(resumed.nextSequence, 1);
  assert.equal(value.timers.length, 1);
});

test("startup receipt owner and session ownership mismatches fault closed", () => {
  const value = fixture({
    registry: {
      inspectSession() {
        return {
          ownerId: "old-renderer",
          slot: "normal-main",
          state: "owned",
          inFlight: 0,
        };
      },
    },
  });
  assert.throws(() => value.runtime.resumeFromStartupRecovery({
    schemaVersion: 1,
    kind: "native-core-player-authority-startup-recovery-v1",
    ownerId: "main-player-authority",
    sessionId: "core-restarted-1",
    runId: "player-run-1",
    registryFingerprint: "builtin:test",
    revision: 11,
    checkpoint: { generation: 8, rootHash: HASH_A, revision: 11 },
    acknowledgedSequence: 4,
    nextSequence: 5,
    settledDeadlineMs: 10_000,
    nextDeadlineMs: 11_000,
    summary: { ...summary(11), registryFingerprint: "builtin:test" },
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");
  assert.equal(value.runtime.snapshot().phase, "faulted");
  assert.equal(value.timers.length, 0);
});

test("queued command captures immutable JSON bytes before an uncertain retry", async () => {
  let attempts = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthorityCommand(ownerId, request) {
        value.calls.push(["command", ownerId, request]);
        attempts += 1;
        if (attempts === 1) throw new Error("lost response");
        return {
          sequence: 1,
          commandId: request.commandId,
          baseRevision: request.baseRevision,
          revision: 8,
          settledDeadlineMs: 10_000,
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
  const command = playerCommand(7, "immutable-command", 1);
  const first = value.runtime.commitCommand(command);
  command.command.topLevelChanges[0].value = 999;
  await assert.rejects(first, { code: "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN" });
  await value.runtime.retryUncertain();
  assert.deepEqual(
    value.calls.filter(([operation]) => operation === "command")
      .map((call) => call[2].command.topLevelChanges[0].value),
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

test("activation rejects a lease that already contains a pending player command", async () => {
  const value = fixture({
    registry: {
      async preparePlayerAuthority(ownerId, request) {
        value.calls.push(["prepare", ownerId, request]);
        const receipt = leaseReceipt("prepared", value.checkpoint, request.settledDeadlineMs);
        receipt.lease.pendingCommand = { commandId: "not-empty" };
        return receipt;
      },
    },
  });
  await assert.rejects(value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  }), /lease identity is invalid/);
  assert.equal(value.runtime.snapshot().phase, "faulted");
  assert.equal(value.calls.filter(([operation]) => operation === "activate").length, 0);
});

test("safe-integer exhaustion cannot partially advance command or tick context", async () => {
  const commandValue = fixture({
    registry: {
      async commitPlayerAuthorityCommand(ownerId, request) {
        commandValue.calls.push(["command", ownerId, request]);
        return {
          sequence: Number.MAX_SAFE_INTEGER,
          commandId: request.commandId,
          baseRevision: request.baseRevision,
          revision: 8,
          settledDeadlineMs: 10_000,
          duplicate: false,
          checkpoint: { generation: 4, rootHash: HASH_A, revision: 8 },
          summary: summary(8),
        };
      },
    },
  });
  await commandValue.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: commandValue.checkpoint, settledDeadlineMs: 10_000,
  });
  commandValue.runtime.context.nextSequence = Number.MAX_SAFE_INTEGER;
  await assert.rejects(
    commandValue.runtime.commitCommand(playerCommand(7, "sequence-overflow", 1)),
    /safe integer range/,
  );
  assert.equal(commandValue.runtime.snapshot().revision, 7);
  assert.equal(commandValue.runtime.snapshot().nextSequence, Number.MAX_SAFE_INTEGER);

  const tickValue = fixture({
    registry: {
      async commitPlayerAuthorityTick(ownerId, request) {
        tickValue.calls.push(["tick", ownerId, request]);
        return {
          sequence: Number.MAX_SAFE_INTEGER,
          revision: 8,
          duplicate: false,
          checkpoint: { generation: 4, rootHash: HASH_A, revision: 8 },
          summary: summary(8),
        };
      },
    },
  });
  await tickValue.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: tickValue.checkpoint, settledDeadlineMs: 10_000,
  });
  tickValue.runtime.context.nextSequence = Number.MAX_SAFE_INTEGER;
  tickValue.setNow(11_000);
  await assert.rejects(tickValue.runtime.settleDue(), /safe integer range/);
  assert.equal(tickValue.runtime.snapshot().revision, 7);
  assert.equal(tickValue.runtime.snapshot().nextDeadlineMs, 11_000);
});

test("shutdown cancels only the process timer and leaves durable recovery to Rust", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const snapshot = value.runtime.shutdownForProcessExit();
  assert.equal(snapshot.phase, "shutdown");
  assert.equal(snapshot.lastErrorCode, "NATIVE_PLAYER_AUTHORITY_RUNTIME_SHUTDOWN");
  assert.equal(value.timers[0].cancelled, true);
  await assert.rejects(value.runtime.retryUncertain(), /no uncertain tick/);
});

test("shutdown rejects active and queued command promises without starting another operation", async () => {
  const value = fixture({
    registry: {
      commitPlayerAuthorityCommand(ownerId, request) {
        value.calls.push(["command", ownerId, request]);
        return new Promise(() => undefined);
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const first = value.runtime.commitCommand(playerCommand(7, "shutdown-active", 1));
  const second = value.runtime.commitCommand(playerCommand(8, "shutdown-queued", 2));
  const firstResult = first.catch((error) => error);
  const secondResult = second.catch((error) => error);
  value.runtime.shutdownForProcessExit();
  assert.equal((await firstResult).code, "NATIVE_PLAYER_AUTHORITY_RUNTIME_SHUTDOWN");
  assert.equal((await secondResult).code, "NATIVE_PLAYER_AUTHORITY_COMMAND_QUEUE_ABORTED");
  assert.equal(value.runtime.snapshot().queuedCommands, 0);
  assert.equal(value.calls.filter(([operation]) => operation === "command").length, 1);
});

test("the authority clock is instantiated in main and is absent from renderer IPC", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  const preload = readFileSync("desktop/preload.cjs", "utf8");

  assert.match(main, /new NativePlayerAuthorityRuntime\(\{[\s\S]*?registry:\s*nativeCoreSessions/);
  assert.match(main, /takePlayerAuthorityStartupRecovery\(playerAuthorityOwnerId\)/);
  assert.match(main, /resumeFromStartupRecovery\(playerAuthorityStartupRecovery\)/);
  assert.match(main, /nativePlayerAuthorityRuntime\?\.shutdownForProcessExit\(\)/);
  assert.doesNotMatch(main, /\.commitCommand\(|\.recoverPendingCommand\(/);
  assert.match(preload, /getNativePlayerAuthorityState/);
  assert.match(preload, /onNativePlayerAuthorityState/);
  assert.doesNotMatch(
    preload,
    /core(?:Prepare|Activate|Commit|Recover)PlayerAuthority|retryNativePlayerAuthority|activateNativePlayerAuthority/,
  );
  assert.doesNotMatch(
    preload,
    /desktop:native-player-authority-(?:prepare|activate|commit|recover|retry)/,
  );
});
