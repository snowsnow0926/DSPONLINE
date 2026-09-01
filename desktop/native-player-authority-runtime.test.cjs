"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const {
  NativePlayerAuthorityRuntime,
  OPERATIONS_SETTING_PRE_STAGE_REJECTED_CODE,
  ORBITAL_CONTRACT_PRE_STAGE_REJECTED_CODE,
  SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE,
} = require("./native-player-authority-runtime.cjs");
const {
  NativePlayerAuthorityMacroBroker,
} = require("./native-player-authority-macro-broker.cjs");
const {
  deriveSystemSpaceStationCommandIdentity,
} = require("./native-system-space-station-intent.cjs");
const {
  deriveOrbitalContractCommandIdentity,
} = require("./native-orbital-contract-intent.cjs");
const {
  deriveOperationsSettingCommandIdentity,
} = require("./native-operations-setting-intent.cjs");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function changeReceipt(overrides = {}) {
  return {
    changedEntityIds: [],
    changedBeltIds: [],
    topologyDirty: true,
    ...overrides,
  };
}

function summary(revision, authorityEligible = true, paused = false) {
  return {
    revision,
    stateVersion: 47,
    mode: "normal",
    paused,
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

function systemSpaceStationRequest(baseRevision, intent) {
  const identity = deriveSystemSpaceStationCommandIdentity({
    sessionId: "core-main-1",
    runId: "player-run-1",
    expectedRevision: baseRevision,
    expectedRegistryFingerprint: "7df8cf3a",
    expectedSystemId: "helios",
    intent,
  });
  return {
    commandId: identity.commandId,
    baseRevision,
    expectedRegistryFingerprint: "7df8cf3a",
    expectedSystemId: "helios",
    intent,
  };
}

function orbitalContractRequest(baseRevision, intent) {
  const identity = deriveOrbitalContractCommandIdentity({
    sessionId: "core-main-1",
    runId: "player-run-1",
    expectedRevision: baseRevision,
    expectedRegistryFingerprint: "7df8cf3a",
    confirmedWallClockMs: 8_611_200_000,
    intent,
  });
  return {
    commandId: identity.commandId,
    baseRevision,
    expectedRegistryFingerprint: "7df8cf3a",
    confirmedWallClockMs: 8_611_200_000,
    intent,
  };
}

function operationsSettingRequest(baseRevision, intent) {
  const identity = deriveOperationsSettingCommandIdentity({
    sessionId: "core-main-1",
    runId: "player-run-1",
    expectedRevision: baseRevision,
    expectedRegistryFingerprint: "7df8cf3a",
    intent,
  });
  return {
    commandId: identity.commandId,
    baseRevision,
    expectedRegistryFingerprint: "7df8cf3a",
    intent,
  };
}

function pauseLifecycleReceipt(request, sequence, generation, duplicate = false) {
  const revision = request.baseRevision + 1;
  return {
    sequence,
    baseRevision: request.baseRevision,
    revision,
    targetPaused: request.targetPaused,
    settledDeadlineMs: request.settledDeadlineMs,
    checkpoint: { generation, rootHash: HASH_A, revision },
    summary: summary(revision, true, request.targetPaused),
    duplicate,
  };
}

function fixture(overrides = {}) {
  let now = 10_000;
  const timers = [];
  const calls = [];
  const checkpoint = { generation: 3, rootHash: HASH_A, revision: 7 };
  let macroCheckpoint = checkpoint;
  let macroSequence = 0;
  let macroSettledDeadlineMs = 10_000;
  let macroSessionId = null;
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
      macroSequence = request.sequence;
      macroSettledDeadlineMs = 10_000 + request.sequence * 1_000;
      macroCheckpoint = {
        generation: 3 + request.sequence,
        rootHash: HASH_A,
        revision,
      };
      return {
        sequence: request.sequence,
        revision,
        duplicate: false,
        checkpoint: macroCheckpoint,
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
        ...changeReceipt(),
        checkpoint: { generation: 3 + revision - checkpoint.revision, rootHash: HASH_A, revision },
        summary: summary(revision),
      };
    },
    async commitPlayerAuthoritySystemSpaceStationCommand(ownerId, request) {
      calls.push(["station-command", ownerId, request]);
      const revision = request.baseRevision + 1;
      return {
        sequence: revision - checkpoint.revision,
        commandId: request.commandId,
        baseRevision: request.baseRevision,
        revision,
        settledDeadlineMs: 10_000,
        duplicate: false,
        ...changeReceipt(),
        checkpoint: { generation: 3 + revision - checkpoint.revision, rootHash: HASH_A, revision },
        summary: summary(revision),
      };
    },
    async commitPlayerAuthorityOrbitalContractCommand(ownerId, request) {
      calls.push(["orbital-command", ownerId, request]);
      const revision = request.baseRevision + 1;
      return {
        sequence: revision - checkpoint.revision,
        commandId: request.commandId,
        baseRevision: request.baseRevision,
        revision,
        settledDeadlineMs: 10_000,
        duplicate: false,
        ...changeReceipt(),
        checkpoint: { generation: 3 + revision - checkpoint.revision, rootHash: HASH_A, revision },
        summary: summary(revision),
      };
    },
    async commitPlayerAuthorityOperationsSettingCommand(ownerId, request) {
      calls.push(["operations-command", ownerId, request]);
      const revision = request.baseRevision + 1;
      return {
        sequence: revision - checkpoint.revision,
        commandId: request.commandId,
        baseRevision: request.baseRevision,
        revision,
        settledDeadlineMs: 10_000,
        duplicate: false,
        ...changeReceipt({ topologyDirty: false }),
        checkpoint: { generation: 3 + revision - checkpoint.revision, rootHash: HASH_A, revision },
        summary: summary(revision),
      };
    },
    async commitPlayerAuthorityPause(ownerId, request) {
      calls.push(["pause", ownerId, request]);
      const revision = request.baseRevision + 1;
      const sequence = revision - checkpoint.revision;
      return {
        sequence,
        baseRevision: request.baseRevision,
        revision,
        targetPaused: request.targetPaused,
        settledDeadlineMs: request.settledDeadlineMs,
        checkpoint: { generation: 3 + sequence, rootHash: HASH_A, revision },
        summary: summary(revision, true, request.targetPaused),
        duplicate: false,
      };
    },
    async commitPlayerAuthorityMacroAdvance(ownerId, request) {
      calls.push(["macro-advance", ownerId, request]);
      const revision = request.baseRevision + 2;
      macroSequence += 2;
      macroSettledDeadlineMs += request.wallMilliseconds;
      macroSessionId = request.macroSessionId;
      macroCheckpoint = {
        generation: macroCheckpoint.generation + 1,
        rootHash: HASH_A,
        revision,
      };
      return {
        acknowledgedSequence: macroSequence,
        macroSessionId: request.macroSessionId,
        operationId: request.operationId,
        baseRevision: request.baseRevision,
        revision,
        simulationMilliseconds: request.simulationMilliseconds,
        wallMilliseconds: request.wallMilliseconds,
        algorithmVersion: "native-pure-idle-macro-v10",
        settledDeadlineMs: macroSettledDeadlineMs,
        checkpoint: macroCheckpoint,
        summary: summary(revision),
        duplicate: false,
      };
    },
    async finishPlayerAuthorityMacroSession(ownerId, request) {
      calls.push(["macro-finish", ownerId, request]);
      return {
        lease: {
          kind: "native-core-exact-realtime-player-authority-lease-v1",
          phase: "active",
          runId: request.runId,
          mode: "normal",
          slot: "normal-main",
          checkpoint: macroCheckpoint,
          acknowledged: {
            sequence: macroSequence,
            revision: macroCheckpoint.revision,
            checkpoint: macroCheckpoint,
            settledDeadlineMs: macroSettledDeadlineMs,
          },
          pendingTick: null,
          pendingCommand: null,
          pendingAdvance: null,
          macroSession: null,
          lastFinishedMacroSessionId: macroSessionId,
        },
        summary: summary(macroCheckpoint.revision),
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
    schedule: overrides.schedule ?? ((callback, delay) => {
      const token = { callback, delay, cancelled: false };
      timers.push(token);
      return token;
    }),
    cancel: overrides.cancel ?? ((token) => { token.cancelled = true; }),
    onTransition: overrides.onTransition,
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

test("pause drains every tick due at the request anchor and leaves no live timer", async () => {
  const transitions = [];
  const value = fixture({
    onTransition: (state) => transitions.push(state),
    registry: {
      async commitPlayerAuthorityTick(ownerId, request) {
        value.calls.push(["tick", ownerId, request]);
        return {
          sequence: request.sequence,
          revision: 8,
          duplicate: false,
          checkpoint: { generation: 4, rootHash: HASH_A, revision: 8 },
          summary: summary(8),
        };
      },
      async commitPlayerAuthorityPause(ownerId, request) {
        value.calls.push(["pause", ownerId, request]);
        return pauseLifecycleReceipt(request, 3, 5);
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  value.setNow(12_500);

  const paused = await value.runtime.setPaused(true);

  assert.equal(paused.phase, "paused");
  assert.equal(paused.revision, 9);
  assert.equal(paused.acknowledgedSequence, 3);
  assert.equal(paused.nextSequence, 4);
  assert.equal(paused.nextDeadlineMs, 13_000);
  assert.deepEqual(value.calls.filter(([operation]) => ["tick", "pause"].includes(operation)), [
    ["tick", "main-player-authority", {
      sessionId: "core-main-1", runId: "player-run-1", sequence: 2,
    }],
    ["pause", "main-player-authority", {
      sessionId: "core-main-1",
      runId: "player-run-1",
      baseRevision: 8,
      targetPaused: true,
      settledDeadlineMs: 12_000,
    }],
  ]);
  assert.equal(value.timers.filter((timer) => !timer.cancelled).length, 0);
  assert.ok(transitions.some((state) => state.phase === "pausing"));
  assert.ok(
    transitions.filter((state) => state.phase === "pausing")
      .every((state) => state.currentOperation === "pause"),
  );
  assert.deepEqual(transitions.at(-1), paused);
  assert.equal(transitions.at(-1).inFlight, false);
  assert.equal(transitions.at(-1).currentOperation, null);

  value.setNow(90_000);
  const stillPaused = await value.runtime.settleDue();
  assert.equal(stillPaused.phase, "paused");
  assert.equal(stillPaused.revision, 9);
  assert.equal(value.calls.filter(([operation]) => operation === "tick").length, 1);
});

test("an uncertain pause drain retries its original batch and never expands to later wall time", async () => {
  let tickAttempts = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthorityTick(ownerId, request) {
        value.calls.push(["tick", ownerId, request]);
        tickAttempts += 1;
        if (tickAttempts === 1) throw Object.assign(new Error("lost tick ACK"), { code: "EPIPE" });
        const revision = 8;
        return {
          sequence: request.sequence,
          revision,
          duplicate: true,
          checkpoint: { generation: revision - 4, rootHash: HASH_A, revision },
          summary: summary(revision),
        };
      },
      async commitPlayerAuthorityPause(ownerId, request) {
        value.calls.push(["pause", ownerId, request]);
        return pauseLifecycleReceipt(request, 3, 5);
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  value.setNow(12_500);
  await assert.rejects(
    value.runtime.setPaused(true),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_TICK_UNCERTAIN",
  );
  assert.equal(value.runtime.snapshot().phase, "uncertain");
  value.setNow(100_000);

  const paused = await value.runtime.retryUncertain();

  assert.equal(paused.phase, "paused");
  assert.equal(paused.revision, 9);
  assert.equal(paused.acknowledgedSequence, 3);
  assert.equal(paused.nextDeadlineMs, 13_000);
  assert.deepEqual(
    value.calls.filter(([operation]) => operation === "tick").map((call) => call[2].sequence),
    [2, 2],
  );
  assert.deepEqual(value.calls.filter(([operation]) => operation === "pause")[0][2], {
    sessionId: "core-main-1",
    runId: "player-run-1",
    baseRevision: 8,
    targetPaused: true,
    settledDeadlineMs: 12_000,
  });
});

test("pause drains 31 overdue seconds as 30 plus 1 without crossing its request anchor", async () => {
  let revision = 7;
  let acknowledgedSequence = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthorityTick(ownerId, request) {
        value.calls.push(["tick", ownerId, request]);
        assert.ok(request.sequence - acknowledgedSequence <= 30);
        acknowledgedSequence = request.sequence;
        revision += 1;
        return {
          sequence: request.sequence,
          revision,
          duplicate: false,
          checkpoint: { generation: revision - 4, rootHash: HASH_A, revision },
          summary: summary(revision),
        };
      },
      async commitPlayerAuthorityPause(ownerId, request) {
        value.calls.push(["pause", ownerId, request]);
        return pauseLifecycleReceipt(request, 32, 6);
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  value.setNow(41_000);

  const paused = await value.runtime.setPaused(true);

  assert.equal(paused.phase, "paused");
  assert.equal(paused.revision, 10);
  assert.equal(paused.acknowledgedSequence, 32);
  assert.equal(paused.nextDeadlineMs, 42_000);
  assert.deepEqual(
    value.calls.filter(([operation]) => operation === "tick").map((call) => call[2].sequence),
    [30, 31],
  );
  assert.equal(value.calls.filter(([operation]) => operation === "pause")[0][2].settledDeadlineMs, 41_000);
});

test("resume uses a fresh main-owned anchor and never backlogs paused wall time", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  value.setNow(10_500);
  await value.runtime.setPaused(true);
  value.setNow(1_000_000);

  const resumed = await value.runtime.setPaused(false);

  assert.equal(resumed.phase, "active");
  assert.equal(resumed.revision, 9);
  assert.equal(resumed.acknowledgedSequence, 2);
  assert.equal(resumed.nextDeadlineMs, 1_001_000);
  assert.deepEqual(value.calls.filter(([operation]) => operation === "pause").map((call) => call[2]), [
    {
      sessionId: "core-main-1", runId: "player-run-1", baseRevision: 7,
      targetPaused: true, settledDeadlineMs: 10_000,
    },
    {
      sessionId: "core-main-1", runId: "player-run-1", baseRevision: 8,
      targetPaused: false, settledDeadlineMs: 1_000_000,
    },
  ]);
  assert.equal(value.calls.filter(([operation]) => operation === "tick").length, 0);
  assert.equal(value.timers.filter((timer) => !timer.cancelled).length, 1);
  assert.equal(value.timers.find((timer) => !timer.cancelled).delay, 1_000);

  value.setNow(1_000_999);
  await value.runtime.settleDue();
  assert.equal(value.calls.filter(([operation]) => operation === "tick").length, 0);
  value.setNow(1_001_000);
  const ticked = await value.runtime.settleDue();
  assert.equal(ticked.revision, 10);
  assert.equal(value.calls.filter(([operation]) => operation === "tick").length, 1);
});

test("paused checkpoints remain saveable while gameplay commands stay closed", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  await value.runtime.setPaused(true);
  let boundary = null;
  const persisted = await value.runtime.withSettledPersistenceBoundary((valueAtBoundary) => {
    boundary = valueAtBoundary;
    return "saved-while-paused";
  });

  assert.equal(persisted, "saved-while-paused");
  assert.deepEqual(boundary, {
    sessionId: "core-main-1",
    runId: "player-run-1",
    revision: 8,
    checkpoint: { generation: 4, rootHash: HASH_A, revision: 8 },
    acknowledgedSequence: 1,
    settledDeadlineMs: 10_000,
    paused: true,
  });
  assert.equal(value.runtime.snapshot().phase, "paused");
  await assert.rejects(
    value.runtime.commitCommand(playerCommand(8, "command-while-paused", true)),
    /not accepting commands/,
  );
  assert.equal(value.calls.filter(([operation]) => operation === "command").length, 0);
  assert.equal(value.timers.filter((timer) => !timer.cancelled).length, 0);
});

test("lost pause response retries byte-identical lifecycle input without a new clock sample", async () => {
  let attempts = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthorityPause(ownerId, request) {
        value.calls.push(["pause", ownerId, request]);
        attempts += 1;
        if (attempts === 1) throw new Error("lost pause response");
        return pauseLifecycleReceipt(request, 1, 4, true);
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  value.setNow(10_500);

  await assert.rejects(
    value.runtime.setPaused(true),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PAUSE_UNCERTAIN",
  );
  assert.equal(value.runtime.snapshot().phase, "pause-uncertain");
  assert.equal(value.timers.filter((timer) => !timer.cancelled).length, 0);
  value.setNow(99_000);
  const recovered = await value.runtime.setPaused(true);

  assert.equal(recovered.phase, "paused");
  assert.equal(recovered.revision, 8);
  const requests = value.calls.filter(([operation]) => operation === "pause").map((call) => call[2]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[1].settledDeadlineMs, 10_000);
});

test("lost resume response remains on the exact original resume anchor", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  await value.runtime.setPaused(true);
  const successfulPauseCalls = value.calls.filter(([operation]) => operation === "pause").length;
  let attempts = 0;
  value.runtime.registry.commitPlayerAuthorityPause = async (ownerId, request) => {
    value.calls.push(["pause", ownerId, request]);
    attempts += 1;
    if (attempts === 1) throw new Error("lost resume response");
    return pauseLifecycleReceipt(request, 2, 5, true);
  };
  value.setNow(20_000);

  await assert.rejects(
    value.runtime.setPaused(false),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_RESUME_UNCERTAIN",
  );
  assert.equal(value.runtime.snapshot().phase, "resume-uncertain");
  value.setNow(20_500);
  const resumed = await value.runtime.retryUncertain();

  assert.equal(resumed.phase, "active");
  assert.equal(resumed.nextDeadlineMs, 21_000);
  const requests = value.calls.filter(([operation]) => operation === "pause")
    .slice(successfulPauseCalls).map((call) => call[2]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[1].settledDeadlineMs, 20_000);
});

test("startup recovery preserves a durable paused phase until an explicit fresh resume", async () => {
  const value = fixture();
  const resumedPaused = value.runtime.resumeFromStartupRecovery({
    schemaVersion: 1,
    kind: "native-core-player-authority-startup-recovery-v1",
    ownerId: "main-player-authority",
    sessionId: "core-restarted-paused",
    runId: "player-run-1",
    registryFingerprint: "builtin:test",
    revision: 11,
    checkpoint: { generation: 8, rootHash: HASH_A, revision: 11 },
    acknowledgedSequence: 4,
    nextSequence: 5,
    settledDeadlineMs: 10_000,
    nextDeadlineMs: 11_000,
    commandId: "pause-lifecycle-command",
    commandBaseRevision: 10,
    paused: true,
    ...changeReceipt({ topologyDirty: false }),
    summary: { ...summary(11, true, true), registryFingerprint: "builtin:test" },
  });

  assert.equal(resumedPaused.phase, "paused");
  assert.equal(value.timers.length, 0);
  value.setNow(80_000);
  const resumed = await value.runtime.setPaused(false);
  assert.equal(resumed.phase, "active");
  assert.equal(resumed.nextDeadlineMs, 81_000);
  assert.equal(value.calls.filter(([operation]) => operation === "tick").length, 0);
  assert.deepEqual(value.calls.filter(([operation]) => operation === "pause")[0][2], {
    sessionId: "core-restarted-paused",
    runId: "player-run-1",
    baseRevision: 11,
    targetPaused: false,
    settledDeadlineMs: 80_000,
  });
});

test("main-owned persistence freezes an ACKed boundary and resumes queued gameplay only after it settles", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const gate = deferred();
  let observedBoundary = null;
  const persistence = value.runtime.withSettledPersistenceBoundary(async (boundary) => {
    observedBoundary = boundary;
    await gate.promise;
    return "persisted";
  });

  assert.equal(value.timers[0].cancelled, true);
  value.setNow(11_000);
  const dueWhileFrozen = await value.runtime.settleDue();
  assert.equal(dueWhileFrozen.revision, 7);
  assert.equal(value.calls.filter(([operation]) => operation === "tick").length, 0);

  const queuedCommand = value.runtime.commitCommand(playerCommand(7, "after-save", 1));
  await Promise.resolve();
  assert.equal(value.calls.filter(([operation]) => operation === "command").length, 0);
  assert.deepEqual(observedBoundary, {
    sessionId: "core-main-1",
    runId: "player-run-1",
    revision: 7,
    checkpoint: value.checkpoint,
    acknowledgedSequence: 0,
    settledDeadlineMs: 10_000,
    paused: false,
  });

  gate.resolve();
  assert.equal(await persistence, "persisted");
  const committed = await queuedCommand;
  assert.equal(committed.revision, 8);
  assert.equal(value.calls.filter(([operation]) => operation === "command").length, 1);
});

test("persistence refuses in-flight gameplay and overlapping persistence reads", async () => {
  const tickGate = deferred();
  const ticking = fixture({
    registry: {
      commitPlayerAuthorityTick(ownerId, request) {
        ticking.calls.push(["tick", ownerId, request]);
        return tickGate.promise;
      },
    },
  });
  await ticking.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: ticking.checkpoint, settledDeadlineMs: 10_000,
  });
  ticking.setNow(11_000);
  const pendingTick = ticking.runtime.settleDue();
  await assert.rejects(
    ticking.runtime.withSettledPersistenceBoundary(async () => undefined),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
  );
  tickGate.resolve({
    sequence: 1,
    revision: 8,
    duplicate: false,
    checkpoint: { generation: 4, rootHash: HASH_A, revision: 8 },
    summary: summary(8),
  });
  await pendingTick;

  const persistenceGate = deferred();
  const first = ticking.runtime.withSettledPersistenceBoundary(() => persistenceGate.promise);
  await assert.rejects(
    ticking.runtime.withSettledPersistenceBoundary(async () => undefined),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
  );
  persistenceGate.resolve("done");
  assert.equal(await first, "done");
});

test("startup reconciliation freezes the current macro checkpoint without finishing or replaying it", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  await value.runtime.commitMacroAdvance({
    macroSessionId: "macro-reload",
    operationId: "macro-reload-first",
    baseRevision: 7,
    simulationMilliseconds: 30_000,
    wallMilliseconds: 5_000,
  });
  assert.deepEqual(value.runtime.snapshot(), {
    phase: "macro-active",
    sessionId: "core-main-1",
    runId: "player-run-1",
    revision: 9,
    acknowledgedSequence: 2,
    nextSequence: 3,
    nextDeadlineMs: 16_000,
    inFlight: false,
    currentOperation: null,
    queuedCommands: 0,
    macroSessionId: "macro-reload",
    macroAlgorithmVersion: "native-pure-idle-macro-v10",
    lastErrorCode: null,
  });

  const gate = deferred();
  let observedBoundary = null;
  const reconciliation = value.runtime.withStartupReconciliationBoundary(async (boundary) => {
    observedBoundary = boundary;
    await gate.promise;
    return "renderer-rebound";
  });
  await assert.rejects(
    value.runtime.withSettledPersistenceBoundary(async () => undefined),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
  );
  await assert.rejects(value.runtime.commitMacroAdvance({
    macroSessionId: "macro-reload",
    operationId: "macro-reload-second",
    baseRevision: 9,
    simulationMilliseconds: 30_000,
    wallMilliseconds: 5_000,
  }));
  await assert.rejects(
    value.runtime.finishMacroSession({ macroSessionId: "macro-reload" }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
  );
  assert.deepEqual(observedBoundary, {
    sessionId: "core-main-1",
    runId: "player-run-1",
    revision: 9,
    checkpoint: { generation: 4, rootHash: HASH_A, revision: 9 },
    acknowledgedSequence: 2,
    settledDeadlineMs: 15_000,
    paused: false,
  });
  assert.equal(value.calls.filter(([operation]) => operation === "macro-advance").length, 1);
  assert.equal(value.calls.filter(([operation]) => operation === "macro-finish").length, 0);

  gate.resolve();
  assert.equal(await reconciliation, "renderer-rebound");
  assert.equal(value.runtime.snapshot().phase, "macro-active");
  assert.equal(value.runtime.snapshot().revision, 9);
});

test("macro broker treats persistence BUSY as a definite no-op and remains retryable", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const issued = [
    "session-a", "operation-a", "session-b", "operation-b", "operation-c", "operation-d",
  ];
  const broker = new NativePlayerAuthorityMacroBroker({
    runtime: value.runtime,
    createId: () => issued.shift(),
  });

  const activeGate = deferred();
  const activeBoundary = value.runtime.withSettledPersistenceBoundary(() => activeGate.promise);
  await assert.rejects(
    broker.start({ expectedRevision: 7, simulationMilliseconds: 30_000, wallMilliseconds: 5_000 }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
  );
  assert.equal(value.calls.filter(([operation]) => operation === "macro-advance").length, 0);
  await assert.rejects(
    broker.recover(),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_RECOVERY_UNAVAILABLE",
  );
  value.setNow(11_000);
  activeGate.resolve("active-released");
  assert.equal(await activeBoundary, "active-released");
  await value.runtime.settleDue();
  assert.equal(value.runtime.snapshot().revision, 8);

  await assert.rejects(
    broker.start({ expectedRevision: 7, simulationMilliseconds: 30_000, wallMilliseconds: 5_000 }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_START_REBASE_REQUIRED",
  );
  assert.equal(value.calls.filter(([operation]) => operation === "macro-advance").length, 0);

  const started = await broker.start({
    expectedRevision: 8, simulationMilliseconds: 30_000, wallMilliseconds: 5_000,
  });
  assert.equal(started.state, "macro-active");
  assert.equal(started.revision, 10);

  const macroGate = deferred();
  const macroBoundary = value.runtime.withStartupReconciliationBoundary(() => macroGate.promise);
  await assert.rejects(
    broker.advance({ simulationMilliseconds: 30_000, wallMilliseconds: 5_000 }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
  );
  await assert.rejects(
    broker.finish(),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
  );
  assert.equal(value.calls.filter(([operation]) => operation === "macro-advance").length, 1);
  assert.equal(value.calls.filter(([operation]) => operation === "macro-finish").length, 0);
  assert.equal((await broker.recover()).state, "macro-active");
  macroGate.resolve("macro-released");
  assert.equal(await macroBoundary, "macro-released");

  const advanced = await broker.advance({ simulationMilliseconds: 30_000, wallMilliseconds: 5_000 });
  assert.equal(advanced.revision, 12);
  assert.deepEqual(await broker.finish(), { schemaVersion: 1, state: "finished", revision: 12 });
  assert.equal(value.calls.filter(([operation]) => operation === "macro-advance").length, 2);
  assert.equal(value.calls.filter(([operation]) => operation === "macro-finish").length, 1);
});

test("macro start observes an exact tick gate as BUSY and starts once the newer frame settles", async () => {
  const tickGate = deferred();
  let value;
  value = fixture({
    registry: {
      async commitPlayerAuthorityTick(ownerId, request) {
        value.calls.push(["tick", ownerId, request]);
        return tickGate.promise;
      },
      async commitPlayerAuthorityMacroAdvance(ownerId, request) {
        value.calls.push(["macro-advance", ownerId, request]);
        const checkpoint = { generation: 5, rootHash: HASH_A, revision: 10 };
        return {
          acknowledgedSequence: 3,
          macroSessionId: request.macroSessionId,
          operationId: request.operationId,
          baseRevision: request.baseRevision,
          revision: 10,
          simulationMilliseconds: request.simulationMilliseconds,
          wallMilliseconds: request.wallMilliseconds,
          algorithmVersion: "native-pure-idle-macro-v10",
          settledDeadlineMs: 12_000,
          checkpoint,
          summary: summary(10),
          duplicate: false,
        };
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  let issued = 0;
  const broker = new NativePlayerAuthorityMacroBroker({
    runtime: value.runtime,
    createId: () => {
      issued += 1;
      return "epoch-after-tick";
    },
  });

  value.setNow(11_000);
  const ticking = value.runtime.settleDue();
  await Promise.resolve();
  assert.equal(value.runtime.snapshot().inFlight, true);
  assert.equal(value.runtime.snapshot().currentOperation, "tick");
  await assert.rejects(
    broker.start({ expectedRevision: 7, simulationMilliseconds: 15_000, wallMilliseconds: 1_000 }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_BUSY",
  );
  assert.equal(issued, 0);
  assert.equal(value.calls.filter(([operation]) => operation === "macro-advance").length, 0);

  const checkpoint = { generation: 4, rootHash: HASH_A, revision: 8 };
  tickGate.resolve({
    sequence: 1,
    revision: 8,
    duplicate: false,
    checkpoint,
    summary: summary(8),
  });
  await ticking;
  assert.equal(value.runtime.snapshot().revision, 8);
  const started = await broker.start({
    expectedRevision: 8,
    simulationMilliseconds: 15_000,
    wallMilliseconds: 1_000,
  });
  assert.equal(started.state, "macro-active");
  assert.equal(started.previousRevision, 8);
  assert.equal(issued, 1);
  assert.equal(value.calls.filter(([operation]) => operation === "macro-advance").length, 1);
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

test("overdue wall time is one bounded 1, 2, 5, or 30 second exact batch", async (t) => {
  for (const seconds of [1, 2, 5, 30]) {
    await t.test(`${seconds}s`, async () => {
      const value = fixture({
        registry: {
          async commitPlayerAuthorityTick(ownerId, request) {
            value.calls.push(["tick", ownerId, request]);
            const revision = 8;
            return {
              sequence: request.sequence,
              revision,
              duplicate: false,
              checkpoint: { generation: 4, rootHash: HASH_A, revision },
              summary: summary(revision),
            };
          },
        },
      });
      await value.runtime.activate({
        sessionId: "core-main-1", runId: "player-run-1",
        expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
      });
      value.setNow(10_000 + seconds * 1_000);

      const settled = await value.runtime.settleDue();

      assert.deepEqual(value.calls.filter(([operation]) => operation === "tick")[0][2], {
        sessionId: "core-main-1", runId: "player-run-1", sequence: seconds,
      });
      assert.equal(settled.revision, 8);
      assert.equal(settled.acknowledgedSequence, seconds);
      assert.equal(settled.nextSequence, seconds + 1);
      assert.equal(settled.nextDeadlineMs, 11_000 + seconds * 1_000);
    });
  }
});

test("more than 30 overdue seconds are split into yielded durable batches", async () => {
  let revision = 7;
  let acknowledgedSequence = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthorityTick(ownerId, request) {
        value.calls.push(["tick", ownerId, request]);
        assert.ok(request.sequence > acknowledgedSequence);
        assert.ok(request.sequence - acknowledgedSequence <= 30);
        acknowledgedSequence = request.sequence;
        revision += 1;
        return {
          sequence: request.sequence,
          revision,
          duplicate: false,
          checkpoint: { generation: revision - 4, rootHash: HASH_A, revision },
          summary: summary(revision),
        };
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  value.setNow(41_000);

  value.timers[0].callback();
  const first = await value.runtime.inFlight;
  assert.equal(first.acknowledgedSequence, 30);
  assert.equal(first.revision, 8);
  assert.equal(value.timers.at(-1).delay, 1);
  assert.deepEqual(
    value.calls.filter(([operation]) => operation === "tick").map((call) => call[2].sequence),
    [30],
  );

  const second = await value.runtime.settleDue();
  assert.equal(second.acknowledgedSequence, 31);
  assert.equal(second.revision, 9);
  assert.equal(second.nextDeadlineMs, 42_000);
  assert.deepEqual(
    value.calls.filter(([operation]) => operation === "tick").map((call) => call[2].sequence),
    [30, 31],
  );
});

test("lost batched tick response retries the immutable final sequence after wall time advances", async () => {
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
  value.setNow(15_000);
  await assert.rejects(
    value.runtime.settleDue(),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_TICK_UNCERTAIN",
  );
  value.setNow(100_000);

  const recovered = await value.runtime.retryUncertain();

  assert.equal(recovered.revision, 8);
  assert.equal(recovered.acknowledgedSequence, 5);
  assert.equal(recovered.nextDeadlineMs, 16_000);
  const requests = value.calls.filter(([operation]) => operation === "tick").map((call) => call[2]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].sequence, 5);
});

test("malformed batched tick ACK cannot partially advance the public clock", async () => {
  const value = fixture({
    registry: {
      async commitPlayerAuthorityTick(ownerId, request) {
        value.calls.push(["tick", ownerId, request]);
        return {
          sequence: request.sequence,
          revision: 12,
          duplicate: false,
          checkpoint: { generation: 4, rootHash: HASH_A, revision: 12 },
          summary: summary(12),
        };
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  value.setNow(15_000);

  await assert.rejects(
    value.runtime.settleDue(),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_TICK_RECEIPT_INVALID",
  );
  const after = value.runtime.snapshot();
  assert.equal(after.phase, "uncertain");
  assert.equal(after.revision, 7);
  assert.equal(after.acknowledgedSequence, 0);
  assert.equal(after.nextDeadlineMs, 11_000);
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

test("an already queued command wins over an overdue multi-second batch", async () => {
  let resolveCommand;
  const value = fixture({
    registry: {
      commitPlayerAuthorityCommand(ownerId, request) {
        value.calls.push(["command", ownerId, request]);
        return new Promise((resolve) => { resolveCommand = resolve; });
      },
      async commitPlayerAuthorityTick(ownerId, request) {
        value.calls.push(["tick", ownerId, request]);
        return {
          sequence: request.sequence,
          revision: 9,
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
  value.setNow(15_000);

  const command = value.runtime.commitCommand(playerCommand(7, "before-backlog", true));
  const dueWhileQueued = value.runtime.settleDue();
  await Promise.resolve();
  assert.deepEqual(value.calls.map(([operation]) => operation), ["prepare", "activate", "command"]);
  resolveCommand({
    sequence: 1,
    commandId: "before-backlog",
    baseRevision: 7,
    revision: 8,
    settledDeadlineMs: 10_000,
    duplicate: false,
    ...changeReceipt(),
    checkpoint: { generation: 4, rootHash: HASH_A, revision: 8 },
    summary: summary(8),
  });
  await dueWhileQueued;
  await command;
  assert.equal(value.calls.filter(([operation]) => operation === "tick").length, 0);

  const settled = await value.runtime.settleDue();

  assert.deepEqual(value.calls.slice(-2).map(([operation]) => operation), ["command", "tick"]);
  assert.equal(value.calls.at(-1)[2].sequence, 6);
  assert.equal(settled.revision, 9);
  assert.equal(settled.acknowledgedSequence, 6);
  assert.equal(settled.nextDeadlineMs, 16_000);
});

test("system-space-station intents share the exact command FIFO without exposing a patch", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const stationRequest = (baseRevision, intent) => {
    const identity = deriveSystemSpaceStationCommandIdentity({
      sessionId: "core-main-1",
      runId: "player-run-1",
      expectedRevision: baseRevision,
      expectedRegistryFingerprint: "7df8cf3a",
      expectedSystemId: "helios",
      intent,
    });
    return {
      commandId: identity.commandId,
      baseRevision,
      expectedRegistryFingerprint: "7df8cf3a",
      expectedSystemId: "helios",
      intent,
    };
  };
  const results = await Promise.all([
    value.runtime.commitSystemSpaceStationIntent(stationRequest(7, {
      type: "start", systemId: "helios",
    })),
    value.runtime.commitCommand(playerCommand(8, "ordinary-command", 1)),
    value.runtime.commitSystemSpaceStationIntent(stationRequest(9, {
      type: "module-target", systemId: "helios", module: "backbone", target: 1,
    })),
  ]);
  assert.deepEqual(results.map((result) => result.revision), [8, 9, 10]);
  assert.deepEqual(
    value.calls
      .filter(([operation]) => operation === "station-command" || operation === "command")
      .map(([operation]) => operation),
    ["station-command", "command", "station-command"],
  );
  for (const [, , request] of value.calls.filter(([operation]) => operation === "station-command")) {
    assert.equal(Object.hasOwn(request, "command"), false);
    assert.deepEqual(Object.keys(request).sort(), [
      "baseRevision", "commandId", "expectedRegistryFingerprint", "expectedSystemId", "intent", "runId", "sessionId",
    ]);
  }
});

test("orbital-contract intents share the main-owned FIFO and never expose a patch", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const results = await Promise.all([
    value.runtime.commitOrbitalContractIntent(orbitalContractRequest(7, {
      type: "deliver-quantum",
      contractId: "station-contract-v1-7-100-0-single",
      itemId: "processor",
      requestedAmount: "75",
    })),
    value.runtime.commitCommand(playerCommand(8, "ordinary-after-orbital", 1)),
    value.runtime.commitOrbitalContractIntent(orbitalContractRequest(9, {
      type: "claim",
      contractId: "station-contract-v1-7-100-0-single",
    })),
  ]);
  assert.deepEqual(results.map((result) => result.revision), [8, 9, 10]);
  assert.deepEqual(
    value.calls
      .filter(([operation]) => operation === "orbital-command" || operation === "command")
      .map(([operation]) => operation),
    ["orbital-command", "command", "orbital-command"],
  );
  for (const [, , request] of value.calls.filter(([operation]) => operation === "orbital-command")) {
    assert.equal(Object.hasOwn(request, "command"), false);
    assert.deepEqual(Object.keys(request).sort(), [
      "baseRevision", "commandId", "confirmedWallClockMs", "expectedRegistryFingerprint", "intent", "runId", "sessionId",
    ]);
  }
});

test("operations leaf intents share the main-owned FIFO and never expose a patch", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const results = await Promise.all([
    value.runtime.commitOperationsSettingIntent(operationsSettingRequest(7, {
      type: "set-simulation-speed", value: 2,
    })),
    value.runtime.commitCommand(playerCommand(8, "ordinary-after-operations", 1)),
    value.runtime.commitOperationsSettingIntent(operationsSettingRequest(9, {
      type: "set-production-buffer-limit", value: 4000,
    })),
  ]);
  assert.deepEqual(results.map((result) => result.revision), [8, 9, 10]);
  assert.deepEqual(
    value.calls
      .filter(([operation]) => operation === "operations-command" || operation === "command")
      .map(([operation]) => operation),
    ["operations-command", "command", "operations-command"],
  );
  for (const [, , request] of value.calls.filter(([operation]) => operation === "operations-command")) {
    assert.equal(Object.hasOwn(request, "command"), false);
    assert.deepEqual(Object.keys(request).sort(), [
      "baseRevision", "commandId", "expectedRegistryFingerprint", "intent", "runId", "sessionId",
    ]);
  }
});

test("operations typed pre-stage rejection is definite after an uncertain retry", async () => {
  let attempts = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthorityOperationsSettingCommand(ownerId, request) {
        value.calls.push(["operations-command", ownerId, request]);
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
        throw Object.assign(new Error("buffer leaf proof failed"), {
          code: OPERATIONS_SETTING_PRE_STAGE_REJECTED_CODE,
        });
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  await assert.rejects(
    value.runtime.commitOperationsSettingIntent(operationsSettingRequest(7, {
      type: "set-belt-buffer-limit", value: 4000,
    })),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN",
  );
  assert.equal(value.runtime.snapshot().phase, "uncertain");
  await assert.rejects(
    value.runtime.retryUncertain(),
    (error) => error.code === OPERATIONS_SETTING_PRE_STAGE_REJECTED_CODE,
  );
  assert.equal(value.runtime.snapshot().phase, "active");
  assert.equal(value.runtime.snapshot().revision, 7);
  const calls = value.calls.filter(([operation]) => operation === "operations-command");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][2], calls[1][2]);
});

test("orbital-contract pre-stage rejection is definite but transport loss stays retryable", async () => {
  let attempts = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthorityOrbitalContractCommand(ownerId, request) {
        value.calls.push(["orbital-command", ownerId, request]);
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
        throw Object.assign(new Error("quantum inventory is insufficient"), {
          code: ORBITAL_CONTRACT_PRE_STAGE_REJECTED_CODE,
        });
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const request = orbitalContractRequest(7, {
    type: "deliver-quantum",
    contractId: "station-contract-v1-7-100-0-single",
    itemId: "processor",
    requestedAmount: "1",
  });
  await assert.rejects(
    value.runtime.commitOrbitalContractIntent(request),
    { code: "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN" },
  );
  assert.equal(value.runtime.snapshot().phase, "uncertain");
  await assert.rejects(value.runtime.retryUncertain(), (error) => {
    assert.equal(error.code, ORBITAL_CONTRACT_PRE_STAGE_REJECTED_CODE);
    return true;
  });
  assert.equal(value.runtime.snapshot().phase, "active");
  assert.equal(value.runtime.snapshot().revision, 7);
  const calls = value.calls.filter(([operation]) => operation === "orbital-command");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][2], calls[1][2]);
});

test("typed station pre-stage rejections stay definite, cancel dependent commands, and resume", async () => {
  const cases = [
    {
      id: "insufficient-inventory",
      label: "insufficient module inventory",
      intent: { type: "module-target", systemId: "helios", module: "backbone", target: 1 },
    },
    {
      id: "missing-tech",
      label: "missing construction technology",
      intent: { type: "start", systemId: "helios" },
    },
    {
      id: "unchanged-target",
      label: "unchanged module target",
      intent: { type: "module-target", systemId: "helios", module: "backbone", target: 0 },
    },
  ];

  for (const scenario of cases) {
    const value = fixture({
      registry: {
        async commitPlayerAuthoritySystemSpaceStationCommand(ownerId, request) {
          value.calls.push(["station-command", ownerId, request]);
          throw Object.assign(new Error(scenario.label), {
            code: SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE,
          });
        },
      },
    });
    await value.runtime.activate({
      sessionId: "core-main-1", runId: "player-run-1",
      expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
    });

    const rejected = value.runtime.commitSystemSpaceStationIntent(
      systemSpaceStationRequest(7, scenario.intent),
    );
    const dependent = value.runtime
      .commitCommand(playerCommand(8, `dependent-${scenario.id}`, 1))
      .catch((error) => error);
    await assert.rejects(rejected, (error) => {
      assert.equal(error.code, SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE, scenario.label);
      assert.equal(error.message, scenario.label);
      return true;
    });
    assert.equal(
      (await dependent).code,
      "NATIVE_PLAYER_AUTHORITY_COMMAND_QUEUE_ABORTED",
      scenario.label,
    );
    assert.deepEqual(
      value.runtime.snapshot(),
      {
        phase: "active",
        sessionId: "core-main-1",
        runId: "player-run-1",
        revision: 7,
        acknowledgedSequence: 0,
        nextSequence: 1,
        nextDeadlineMs: 11_000,
        inFlight: false,
        currentOperation: null,
        queuedCommands: 0,
        macroSessionId: null,
        macroAlgorithmVersion: null,
        lastErrorCode: null,
      },
      scenario.label,
    );
    assert.equal(value.timers.length, 1, scenario.label);
    assert.equal(value.timers[0].cancelled, false, scenario.label);

    const resumed = await value.runtime.commitCommand(
      playerCommand(7, `replacement-${scenario.id}`, 2),
    );
    assert.equal(resumed.revision, 8, scenario.label);
    assert.equal(value.runtime.snapshot().phase, "active", scenario.label);
  }
});

test("lost station response stays uncertain until its byte-identical retry receives typed rejection", async () => {
  let attempts = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthoritySystemSpaceStationCommand(ownerId, request) {
        value.calls.push(["station-command", ownerId, request]);
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("pipe closed before response"), { code: "EPIPE" });
        }
        throw Object.assign(new Error("module inventory is insufficient"), {
          code: SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE,
        });
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const request = systemSpaceStationRequest(7, {
    type: "module-target", systemId: "helios", module: "backbone", target: 1,
  });

  await assert.rejects(
    value.runtime.commitSystemSpaceStationIntent(request),
    { code: "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN" },
  );
  assert.equal(value.runtime.snapshot().phase, "uncertain");
  assert.equal(value.runtime.snapshot().revision, 7);

  await assert.rejects(value.runtime.retryUncertain(), (error) => {
    assert.equal(error.code, SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE);
    return true;
  });
  assert.equal(value.runtime.snapshot().phase, "active");
  assert.equal(value.runtime.snapshot().revision, 7);
  assert.equal(value.runtime.snapshot().nextSequence, 1);
  const calls = value.calls.filter(([operation]) => operation === "station-command");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][2], calls[1][2]);
});

test("ordinary generic commands never trust the station-only pre-stage rejection code", async () => {
  const value = fixture({
    registry: {
      async commitPlayerAuthorityCommand(ownerId, request) {
        value.calls.push(["command", ownerId, request]);
        throw Object.assign(new Error("forged station-only code"), {
          code: SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE,
        });
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });

  await assert.rejects(
    value.runtime.commitCommand(playerCommand(7, "ordinary-command-with-station-code", 1)),
    { code: "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN" },
  );
  assert.equal(value.runtime.snapshot().phase, "uncertain");
  assert.equal(value.runtime.snapshot().revision, 7);
  assert.equal(value.runtime.snapshot().nextSequence, 1);
});

test("lost system-space-station response retries the byte-identical intent command", async () => {
  let attempts = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthoritySystemSpaceStationCommand(ownerId, request) {
        value.calls.push(["station-command", ownerId, request]);
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
        return {
          sequence: 1,
          commandId: request.commandId,
          baseRevision: request.baseRevision,
          revision: 8,
          settledDeadlineMs: 10_000,
          duplicate: true,
          ...changeReceipt({ changedEntityIds: ["station-1"], topologyDirty: false }),
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
  const intent = { type: "upgrade-one", entityId: "station-1" };
  const identity = deriveSystemSpaceStationCommandIdentity({
    sessionId: "core-main-1",
    runId: "player-run-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "7df8cf3a",
    expectedSystemId: "helios",
    intent,
  });
  const request = {
    commandId: identity.commandId,
    baseRevision: 7,
    expectedRegistryFingerprint: "7df8cf3a",
    expectedSystemId: "helios",
    intent,
  };
  await assert.rejects(
    value.runtime.commitSystemSpaceStationIntent(request),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN",
  );
  assert.equal(value.runtime.snapshot().phase, "uncertain");
  assert.equal(value.runtime.snapshot().revision, 7);
  const recovered = await value.runtime.retryUncertain();
  assert.equal(recovered.revision, 8);
  assert.deepEqual(recovered.changedEntityIds, ["station-1"]);
  const replay = await value.runtime.commitSystemSpaceStationIntent(request);
  assert.equal(replay.revision, 8);
  const calls = value.calls.filter(([operation]) => operation === "station-command");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0][2], calls[1][2]);
  assert.deepEqual(calls[1][2], calls[2][2]);
  assert.equal(
    value.calls.filter(([operation]) => operation === "command").length,
    0,
  );
});

test("generic Host failure after station durable stage remains uncertain and retryable", async () => {
  let attempts = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthoritySystemSpaceStationCommand(ownerId, request) {
        value.calls.push(["station-command", ownerId, request]);
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(
            new Error("lost response after durable stage: module inventory is insufficient"),
            { code: "NATIVE_OPERATION_FAILED" },
          );
        }
        return {
          sequence: 1,
          commandId: request.commandId,
          baseRevision: request.baseRevision,
          revision: 8,
          settledDeadlineMs: 10_000,
          duplicate: true,
          ...changeReceipt(),
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
  const request = systemSpaceStationRequest(7, {
    type: "module-target", systemId: "helios", module: "backbone", target: 1,
  });

  await assert.rejects(
    value.runtime.commitSystemSpaceStationIntent(request),
    { code: "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN" },
  );
  assert.equal(value.runtime.snapshot().phase, "uncertain");
  assert.equal(value.runtime.snapshot().revision, 7);
  const recovered = await value.runtime.retryUncertain();
  assert.equal(recovered.phase, "active");
  assert.equal(recovered.revision, 8);
  const calls = value.calls.filter(([operation]) => operation === "station-command");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][2], calls[1][2]);
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
          ...changeReceipt({
            changedEntityIds: ["entity-a", "entity-z"],
            changedBeltIds: ["belt-a"],
            topologyDirty: false,
          }),
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

test("a command arriving during a five-second batch projects only its one Core revision", async () => {
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
          sequence: 6,
          commandId: request.commandId,
          baseRevision: request.baseRevision,
          revision: 9,
          settledDeadlineMs: 15_000,
          duplicate: false,
          ...changeReceipt({ topologyDirty: false }),
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
  value.setNow(15_000);
  const tick = value.runtime.settleDue();
  const command = value.runtime.commitCommand(playerCommand(8, "after-five-second-batch", true));
  await Promise.resolve();
  assert.equal(value.calls.filter(([operation]) => operation === "tick")[0][2].sequence, 5);
  assert.equal(value.calls.filter(([operation]) => operation === "command").length, 0);

  resolveTick({
    sequence: 5,
    revision: 8,
    duplicate: false,
    checkpoint: { generation: 4, rootHash: HASH_A, revision: 8 },
    summary: summary(8),
  });
  await tick;
  const committed = await command;

  assert.equal(committed.previousRevision, 8);
  assert.equal(committed.revision, 9);
  assert.equal(committed.acknowledgedSequence, 6);
  assert.equal(committed.nextDeadlineMs, 16_000);
  assert.deepEqual(value.calls.slice(-2).map(([operation]) => operation), ["tick", "command"]);
  assert.equal(value.calls.at(-1)[2].baseRevision, 8);
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
          ...changeReceipt({
            changedEntityIds: ["entity-a", "entity-z"],
            changedBeltIds: ["belt-a"],
            topologyDirty: false,
          }),
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
  assert.equal(recovered.previousRevision, 7);
  assert.deepEqual(recovered.changedEntityIds, ["entity-a", "entity-z"]);
  assert.deepEqual(recovered.changedBeltIds, ["belt-a"]);
  assert.equal(recovered.topologyDirty, false);
  const replay = await value.runtime.commitCommand(playerCommand(7, "uncertain-command", 1));
  assert.deepEqual(replay.changedEntityIds, recovered.changedEntityIds);
  assert.deepEqual(replay.changedBeltIds, recovered.changedBeltIds);
  assert.equal(replay.topologyDirty, recovered.topologyDirty);
  assert.equal(value.runtime.snapshot().nextSequence, 2);
  assert.deepEqual(
    value.calls.filter(([operation]) => operation === "command").map((call) => call[2].commandId),
    ["uncertain-command", "uncertain-command", "uncertain-command"],
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

test("macro advances suspend exact ticks, preserve one session, and resume only after finish", async () => {
  const value = fixture();
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const firstTimer = value.timers[0];
  const first = await value.runtime.commitMacroAdvance({
    macroSessionId: "macro-session-1",
    operationId: "macro-operation-1",
    baseRevision: 7,
    simulationMilliseconds: 60_000,
    wallMilliseconds: 4_000,
  });
  assert.equal(first.phase, "macro-active");
  assert.equal(first.revision, 9);
  assert.equal(first.acknowledgedSequence, 2);
  assert.equal(first.nextSequence, 3);
  assert.equal(first.nextDeadlineMs, 15_000);
  assert.equal(first.macroSessionId, "macro-session-1");
  assert.equal(first.macroAlgorithmVersion, "native-pure-idle-macro-v10");
  assert.equal(firstTimer.cancelled, true);
  assert.equal(value.calls.filter(([operation]) => operation === "tick").length, 0);
  value.setNow(30_000);
  const suspended = await value.runtime.settleDue();
  assert.equal(suspended.phase, "macro-active");
  assert.equal(value.calls.filter(([operation]) => operation === "tick").length, 0);
  await assert.rejects(
    value.runtime.commitCommand(playerCommand(9, "command-during-macro", 1)),
    /not accepting commands/,
  );

  const second = await value.runtime.commitMacroAdvance({
    macroSessionId: "macro-session-1",
    operationId: "macro-operation-2",
    baseRevision: 9,
    simulationMilliseconds: 30_000,
    wallMilliseconds: 2_000,
  });
  assert.equal(second.revision, 11);
  assert.equal(second.acknowledgedSequence, 4);
  assert.equal(second.nextDeadlineMs, 17_000);
  await assert.rejects(value.runtime.commitMacroAdvance({
    macroSessionId: "macro-session-other",
    operationId: "macro-operation-forged",
    baseRevision: 11,
    simulationMilliseconds: 1_000,
    wallMilliseconds: 1_000,
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_SESSION_CONFLICT");

  const finished = await value.runtime.finishMacroSession({ macroSessionId: "macro-session-1" });
  assert.equal(finished.phase, "active");
  assert.equal(finished.macroSessionId, null);
  assert.equal(finished.revision, 11);
  assert.equal(value.calls.filter(([operation]) => operation === "macro-advance").length, 2);
  assert.equal(value.calls.filter(([operation]) => operation === "macro-finish").length, 1);
  assert.equal(value.timers.at(-1).delay, 1);
});

test("real runtime finish recovery survives an overdue exact tick starting before broker delivery", async (t) => {
  const run = async (loseFirstFinish) => {
    const tickGate = deferred();
    let finishAttempts = 0;
    const value = fixture({
      schedule(callback, delay) {
        const token = { callback, delay, cancelled: false };
        if (delay <= 1) queueMicrotask(() => {
          if (!token.cancelled) callback();
        });
        return token;
      },
      registry: {
        async commitPlayerAuthorityTick(ownerId, request) {
          value.calls.push(["tick", ownerId, request]);
          await tickGate.promise;
          const revision = 10;
          return {
            sequence: request.sequence,
            revision,
            duplicate: false,
            checkpoint: { generation: 5, rootHash: HASH_A, revision },
            summary: summary(revision),
          };
        },
        async finishPlayerAuthorityMacroSession(ownerId, request) {
          value.calls.push(["macro-finish", ownerId, request]);
          finishAttempts += 1;
          if (loseFirstFinish && finishAttempts === 1) throw new Error("lost finish ACK");
          const checkpoint = { generation: 4, rootHash: HASH_A, revision: 9 };
          return {
            lease: {
              kind: "native-core-exact-realtime-player-authority-lease-v1",
              phase: "active",
              runId: request.runId,
              mode: "normal",
              slot: "normal-main",
              checkpoint,
              acknowledged: {
                sequence: 2,
                revision: 9,
                checkpoint,
                settledDeadlineMs: 14_000,
              },
              pendingTick: null,
              pendingCommand: null,
              pendingAdvance: null,
              macroSession: null,
              lastFinishedMacroSessionId: request.macroSessionId,
            },
            summary: summary(9),
          };
        },
      },
    });
    await value.runtime.activate({
      sessionId: "core-main-1", runId: "player-run-1",
      expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
    });
    const ids = ["session-race", "operation-race"];
    const broker = new NativePlayerAuthorityMacroBroker({
      runtime: value.runtime,
      createId: () => ids.shift(),
    });
    await broker.start({
      expectedRevision: 7,
      simulationMilliseconds: 60_000,
      wallMilliseconds: 4_000,
    });
    value.setNow(30_000);

    let receipt;
    if (loseFirstFinish) {
      await assert.rejects(
        broker.finish(),
        (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
      );
      receipt = await broker.recover();
      assert.equal(receipt.recovered, true);
    } else {
      receipt = await broker.finish();
      assert.equal(Object.hasOwn(receipt, "recovered"), false);
    }
    assert.equal(receipt.state, "finished");
    assert.equal(receipt.revision, 9);
    assert.equal(value.runtime.snapshot().phase, "active");
    assert.equal(value.runtime.snapshot().inFlight, true);
    assert.equal(value.runtime.snapshot().currentOperation, "tick");
    assert.deepEqual(await broker.recover(), {
      schemaVersion: 1,
      state: "finished",
      revision: 9,
      recovered: true,
    });
    assert.equal(
      value.calls.filter(([operation]) => operation === "macro-finish").length,
      loseFirstFinish ? 2 : 1,
    );

    value.setNow(10_000);
    tickGate.resolve();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    return value.runtime.snapshot();
  };

  await t.test("normal finish", async () => {
    assert.equal((await run(false)).phase, "active");
  });
  await t.test("uncertain finish recovery", async () => {
    assert.equal((await run(true)).phase, "active");
  });
});

test("lost macro responses retry the exact durable operation without advancing twice", async () => {
  let attempts = 0;
  const value = fixture({
    registry: {
      async commitPlayerAuthorityMacroAdvance(ownerId, request) {
        value.calls.push(["macro-advance", ownerId, request]);
        attempts += 1;
        if (attempts === 1) throw new Error("lost macro ACK response");
        return {
          acknowledgedSequence: 2,
          macroSessionId: request.macroSessionId,
          operationId: request.operationId,
          baseRevision: request.baseRevision,
          revision: 9,
          simulationMilliseconds: request.simulationMilliseconds,
          wallMilliseconds: request.wallMilliseconds,
          algorithmVersion: "native-pure-idle-macro-v10",
          settledDeadlineMs: 14_000,
          checkpoint: { generation: 4, rootHash: HASH_A, revision: 9 },
          summary: summary(9),
          duplicate: true,
        };
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  const request = {
    macroSessionId: "macro-session-retry",
    operationId: "macro-operation-retry",
    baseRevision: 7,
    simulationMilliseconds: 60_000,
    wallMilliseconds: 4_000,
  };
  await assert.rejects(value.runtime.commitMacroAdvance(request), (error) => {
    assert.equal(error.code, "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN");
    return true;
  });
  assert.equal(value.runtime.snapshot().phase, "macro-uncertain");
  assert.equal(value.runtime.snapshot().revision, 7);
  await assert.rejects(value.runtime.commitMacroAdvance({ ...request, operationId: "different" }), (error) => {
    assert.equal(error.code, "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN");
    return true;
  });
  const recovered = await value.runtime.retryUncertain();
  assert.equal(recovered.phase, "macro-active");
  assert.equal(recovered.revision, 9);
  assert.deepEqual(
    value.calls.filter(([operation]) => operation === "macro-advance")
      .map((call) => call[2].operationId),
    ["macro-operation-retry", "macro-operation-retry"],
  );
});

test("lost macro finish response remains suspended and retries the same session", async () => {
  let finishAttempts = 0;
  const value = fixture({
    registry: {
      async finishPlayerAuthorityMacroSession(ownerId, request) {
        value.calls.push(["macro-finish", ownerId, request]);
        finishAttempts += 1;
        if (finishAttempts === 1) throw new Error("lost macro finish response");
        const checkpoint = { generation: 4, rootHash: HASH_A, revision: 9 };
        return {
          lease: {
            kind: "native-core-exact-realtime-player-authority-lease-v1",
            phase: "active",
            runId: request.runId,
            mode: "normal",
            slot: "normal-main",
            checkpoint,
            acknowledged: {
              sequence: 2,
              revision: 9,
              checkpoint,
              settledDeadlineMs: 14_000,
            },
            pendingTick: null,
            pendingCommand: null,
            pendingAdvance: null,
            macroSession: null,
            lastFinishedMacroSessionId: request.macroSessionId,
          },
          summary: summary(9),
        };
      },
    },
  });
  await value.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: value.checkpoint, settledDeadlineMs: 10_000,
  });
  await value.runtime.commitMacroAdvance({
    macroSessionId: "macro-session-finish-retry",
    operationId: "macro-operation-before-finish",
    baseRevision: 7,
    simulationMilliseconds: 60_000,
    wallMilliseconds: 4_000,
  });
  await assert.rejects(
    value.runtime.finishMacroSession({ macroSessionId: "macro-session-finish-retry" }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
  );
  assert.equal(value.runtime.snapshot().phase, "macro-uncertain");
  assert.equal(value.runtime.snapshot().macroSessionId, "macro-session-finish-retry");
  const recovered = await value.runtime.retryUncertain();
  assert.equal(recovered.phase, "active");
  assert.equal(recovered.macroSessionId, null);
  assert.deepEqual(
    value.calls.filter(([operation]) => operation === "macro-finish")
      .map((call) => call[2].macroSessionId),
    ["macro-session-finish-retry", "macro-session-finish-retry"],
  );
});

test("startup macro recovery remains suspended and rejects partial macro identity", () => {
  const value = fixture();
  const receipt = {
    schemaVersion: 1,
    kind: "native-core-player-authority-startup-recovery-v1",
    ownerId: "main-player-authority",
    sessionId: "core-restarted-macro",
    runId: "player-run-1",
    registryFingerprint: "builtin:test",
    revision: 9,
    checkpoint: { generation: 4, rootHash: HASH_A, revision: 9 },
    acknowledgedSequence: 2,
    nextSequence: 3,
    settledDeadlineMs: 14_000,
    nextDeadlineMs: 15_000,
    commandId: null,
    commandBaseRevision: null,
    paused: false,
    ...changeReceipt({ topologyDirty: false }),
    macroSessionId: "macro-session-recovered",
    recoveredMacroOperationId: "macro-operation-recovered",
    macroAlgorithmVersion: "native-pure-idle-macro-v10",
    macroSimulationMilliseconds: 60_000,
    macroWallMilliseconds: 4_000,
    summary: { ...summary(9), registryFingerprint: "builtin:test" },
  };
  const resumed = value.runtime.resumeFromStartupRecovery(receipt);
  assert.equal(resumed.phase, "macro-active");
  assert.equal(resumed.macroSessionId, "macro-session-recovered");
  assert.equal(resumed.nextSequence, 3);
  assert.equal(value.timers.length, 0);
  assert.throws(() => fixture().runtime.resumeFromStartupRecovery({
    ...receipt,
    macroWallMilliseconds: undefined,
  }), /macroWallMilliseconds is invalid/);
});

test("malformed Host change IDs fault the command without advancing runtime context", async () => {
  const value = fixture({
    registry: {
      async commitPlayerAuthorityCommand(ownerId, request) {
        value.calls.push(["command", ownerId, request]);
        return {
          sequence: 1,
          commandId: request.commandId,
          baseRevision: request.baseRevision,
          revision: 8,
          settledDeadlineMs: 10_000,
          duplicate: false,
          ...changeReceipt({ changedEntityIds: ["entity-z", "entity-a"] }),
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
  await assert.rejects(
    value.runtime.commitCommand(playerCommand(7, "malformed-change-receipt", 1)),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
  );
  assert.equal(value.runtime.snapshot().phase, "uncertain");
  assert.equal(value.runtime.snapshot().revision, 7);
  assert.equal(value.runtime.snapshot().nextSequence, 1);
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
          ...changeReceipt({ changedEntityIds: ["entity-a"], topologyDirty: false }),
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
  const value = fixture({
    registry: {
      async commitPlayerAuthorityCommand(ownerId, request) {
        value.calls.push(["command", ownerId, request]);
        return {
          sequence: 4,
          commandId: request.commandId,
          baseRevision: request.baseRevision,
          revision: 11,
          settledDeadlineMs: 10_000,
          duplicate: true,
          ...changeReceipt({ changedEntityIds: ["entity-a"], topologyDirty: false }),
          checkpoint: { generation: 8, rootHash: HASH_A, revision: 11 },
          summary: summary(11),
        };
      },
    },
  });
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
    commandId: "durable-command-4",
    commandBaseRevision: 10,
    paused: false,
    pendingMacroCleanupSessionId: "macro-session-finished-before-restart",
    pendingMacroCleanupRevision: 9,
    ...changeReceipt({ changedEntityIds: ["entity-a"], topologyDirty: false }),
    summary: recoveredSummary,
  });
  assert.equal(resumed.phase, "active");
  assert.equal(resumed.sessionId, "core-restarted-1");
  assert.equal(resumed.revision, 11);
  assert.equal(resumed.nextSequence, 5);
  assert.equal(value.timers.length, 1);
  assert.equal(value.timers[0].delay, 1_000);

  const replay = await value.runtime.commitCommand(
    playerCommand(10, "durable-command-4", { recovered: true }),
  );
  assert.equal(replay.previousRevision, 10);
  assert.deepEqual(replay.changedEntityIds, ["entity-a"]);
  assert.deepEqual(replay.changedBeltIds, []);
  assert.equal(replay.topologyDirty, false);
  assert.equal(value.runtime.snapshot().nextSequence, 5);

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
    commandId: null,
    commandBaseRevision: null,
    paused: false,
    ...changeReceipt({ topologyDirty: false }),
    summary: { ...summary(0), registryFingerprint: "builtin:test" },
  });
  assert.equal(resumed.phase, "active");
  assert.equal(resumed.revision, 0);
  assert.equal(resumed.acknowledgedSequence, 0);
  assert.equal(resumed.nextSequence, 1);
  assert.equal(value.timers.length, 1);
});

test("startup recovery accepts a 30-second ACK with one Core revision and continues at sequence 31", async () => {
  const value = fixture({
    registry: {
      async commitPlayerAuthorityTick(ownerId, request) {
        value.calls.push(["tick", ownerId, request]);
        return {
          sequence: request.sequence,
          revision: 9,
          duplicate: false,
          checkpoint: { generation: 5, rootHash: HASH_A, revision: 9 },
          summary: summary(9),
        };
      },
    },
  });
  const resumed = value.runtime.resumeFromStartupRecovery({
    schemaVersion: 1,
    kind: "native-core-player-authority-startup-recovery-v1",
    ownerId: "main-player-authority",
    sessionId: "core-restarted-batch",
    runId: "player-run-batch",
    registryFingerprint: "builtin:test",
    revision: 8,
    checkpoint: { generation: 4, rootHash: HASH_A, revision: 8 },
    acknowledgedSequence: 30,
    nextSequence: 31,
    settledDeadlineMs: 40_000,
    nextDeadlineMs: 41_000,
    commandId: null,
    commandBaseRevision: null,
    paused: false,
    ...changeReceipt({ topologyDirty: false }),
    summary: { ...summary(8), registryFingerprint: "builtin:test" },
  });
  assert.equal(resumed.revision, 8);
  assert.equal(resumed.acknowledgedSequence, 30);
  assert.equal(resumed.nextSequence, 31);
  assert.equal(resumed.nextDeadlineMs, 41_000);
  value.setNow(41_000);

  const ticked = await value.runtime.settleDue();

  assert.equal(ticked.revision, 9);
  assert.equal(ticked.acknowledgedSequence, 31);
  assert.deepEqual(value.calls.filter(([operation]) => operation === "tick")[0][2], {
    sessionId: "core-restarted-batch",
    runId: "player-run-batch",
    sequence: 31,
  });
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
    commandId: null,
    commandBaseRevision: null,
    paused: false,
    ...changeReceipt({ topologyDirty: false }),
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
          ...changeReceipt(),
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
          ...changeReceipt(),
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
  assert.equal(tickValue.runtime.snapshot().phase, "faulted");
  assert.equal(tickValue.calls.filter(([operation]) => operation === "tick").length, 0);

  const deadlineValue = fixture();
  await deadlineValue.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: deadlineValue.checkpoint, settledDeadlineMs: 10_000,
  });
  deadlineValue.runtime.context.nextDeadlineMs = Number.MAX_SAFE_INTEGER - 500;
  deadlineValue.setNow(Number.MAX_SAFE_INTEGER - 500);
  await assert.rejects(deadlineValue.runtime.settleDue(), /safe integer range/);
  assert.equal(deadlineValue.runtime.snapshot().phase, "faulted");
  assert.equal(deadlineValue.calls.filter(([operation]) => operation === "tick").length, 0);

  const timerValue = fixture();
  await timerValue.runtime.activate({
    sessionId: "core-main-1", runId: "player-run-1",
    expectedCheckpoint: timerValue.checkpoint, settledDeadlineMs: 10_000,
  });
  timerValue.runtime.context.nextSequence = Number.MAX_SAFE_INTEGER;
  timerValue.setNow(11_000);
  timerValue.timers[0].callback();
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  assert.equal(timerValue.runtime.snapshot().phase, "faulted");
  assert.equal(timerValue.runtime.timer, null);
  assert.equal(timerValue.calls.filter(([operation]) => operation === "tick").length, 0);
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
