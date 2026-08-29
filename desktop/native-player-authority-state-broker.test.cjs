"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_MACRO_BUDGET_MILLISECONDS,
  NativePlayerAuthorityStateBroker,
  normalizeNativePlayerAuthorityState,
} = require("./native-player-authority-state-broker.cjs");

function active(overrides = {}) {
  return {
    phase: "active",
    sessionId: "core-1",
    runId: "run-1",
    revision: 41,
    acknowledgedSequence: 9,
    nextSequence: 10,
    nextDeadlineMs: 50_000,
    inFlight: false,
    currentOperation: null,
    queuedCommands: 0,
    lastErrorCode: null,
    ...overrides,
  };
}

function empty(phase = "idle", overrides = {}) {
  return {
    phase,
    sessionId: null,
    runId: null,
    revision: null,
    acknowledgedSequence: null,
    nextSequence: null,
    nextDeadlineMs: null,
    inFlight: phase !== "idle",
    currentOperation: phase === "activating" ? "activation" : phase === "recovering" ? "recovery" : null,
    queuedCommands: 0,
    lastErrorCode: null,
    ...overrides,
  };
}

function macroSnapshot(phase = "macro-active", overrides = {}) {
  const currentOperation = phase === "macro-committing"
    ? "macro-advance"
    : phase === "macro-finishing" ? "macro-finish" : null;
  return {
    ...active({
      phase,
      revision: 43,
      acknowledgedSequence: 11,
      nextSequence: 12,
      nextDeadlineMs: 75_000,
      inFlight: ["macro-committing", "macro-finishing"].includes(phase),
      currentOperation,
    }),
    macroSessionId: "macro-session-secret",
    macroAlgorithmVersion: "native-pure-idle-macro-v10",
    ...overrides,
  };
}

function internalMacroSession(overrides = {}) {
  return {
    macroSessionId: "macro-session-secret",
    algorithmVersion: "native-pure-idle-macro-v10",
    lastOperation: {
      operationId: "macro-operation-secret",
      revision: 43,
      simulationMilliseconds: 60_000,
      wallMilliseconds: 4_000,
    },
    ...overrides,
  };
}

function macroFixture(options = {}) {
  let rendererTrusted = true;
  let snapshot = macroSnapshot(options.phase, options.snapshot);
  const runtime = {
    context: {
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      revision: snapshot.revision,
      nextSequence: snapshot.nextSequence,
      nextDeadlineMs: snapshot.nextDeadlineMs,
      macroSession: options.macroSession === undefined
        ? internalMacroSession()
        : options.macroSession,
    },
    pendingMacroAction: options.pendingMacroAction ?? null,
    snapshot: () => ({ ...snapshot }),
  };
  const broker = new NativePlayerAuthorityStateBroker({
    runtime,
    isTrustedRendererOwner: (ownerId) => rendererTrusted && ownerId === 7,
  });
  return {
    broker,
    runtime,
    setRendererTrusted(value) { rendererTrusted = value; },
    setSnapshot(value) {
      snapshot = { ...snapshot, ...value };
      runtime.context.sessionId = snapshot.sessionId;
      runtime.context.runId = snapshot.runId;
      runtime.context.revision = snapshot.revision;
      runtime.context.nextSequence = snapshot.nextSequence;
      runtime.context.nextDeadlineMs = snapshot.nextDeadlineMs;
    },
  };
}

test("normalizer exposes one immutable bounded thin-UI authority clock", () => {
  const result = normalizeNativePlayerAuthorityState({
    ...active(),
    ownerId: "main-player-authority",
    checkpoint: { generation: 7, rootHash: "a".repeat(64), revision: 41 },
  });
  assert.deepEqual(result, { schemaVersion: 1, ...active() });
  assert.equal(Object.isFrozen(result), true);
  assert.equal("ownerId" in result, false);
  assert.equal("checkpoint" in result, false);
});

test("idle, activating and recovering states carry no player identity", () => {
  for (const phase of ["idle", "activating", "recovering"]) {
    assert.deepEqual(normalizeNativePlayerAuthorityState(empty(phase)), {
      schemaVersion: 1,
      ...empty(phase),
    });
  }
});

test("uncertain state remains revision-addressable but read-only", () => {
  const result = normalizeNativePlayerAuthorityState(active({
    phase: "uncertain",
    lastErrorCode: "NATIVE_PLAYER_AUTHORITY_TICK_UNCERTAIN",
  }));
  assert.equal(result.phase, "uncertain");
  assert.equal(result.revision, 41);
  assert.equal(result.lastErrorCode, "NATIVE_PLAYER_AUTHORITY_TICK_UNCERTAIN");
});

test("partial identities, discontinuous sequences and malformed active states fail closed", () => {
  for (const value of [
    active({ runId: null }),
    active({ nextSequence: 11 }),
    active({ lastErrorCode: "NATIVE_ERROR" }),
    empty("idle", { revision: 1 }),
    active({ queuedCommands: 65 }),
    active({ currentOperation: "save" }),
    active({ lastErrorCode: "not-public" }),
  ]) {
    assert.throws(() => normalizeNativePlayerAuthorityState(value), /native player-authority/i);
  }
});

test("broker serves only the trusted renderer and re-normalizes every read", () => {
  let value = active();
  const broker = new NativePlayerAuthorityStateBroker({
    runtime: { snapshot: () => value },
    isTrustedRendererOwner: (ownerId) => ownerId === 7,
  });
  assert.equal(broker.read(7).revision, 41);
  value = active({ revision: 42, acknowledgedSequence: 10, nextSequence: 11 });
  assert.equal(broker.read(7).revision, 42);
  assert.throws(
    () => broker.read(8),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_STATE_RENDERER_UNTRUSTED",
  );
});

test("broker exposes only a bounded same-revision recovered-finish hint", () => {
  let hint = { kind: "finished-pending-disable", revision: 40 };
  const broker = new NativePlayerAuthorityStateBroker({
    runtime: { snapshot: () => active() },
    getMacroRecoveryHint: () => hint,
    isTrustedRendererOwner: (ownerId) => ownerId === 7,
  });
  assert.deepEqual(broker.read(7).macroRecoveryHint, hint);
  hint = { kind: "finished-pending-disable", revision: 42 };
  assert.throws(
    () => broker.read(7),
    (error) => error.name === "NativePlayerAuthorityStateBrokerError",
  );
});

test("macro-active normalizer returns only a frozen scalar status and redacts every authority ID", () => {
  const result = normalizeNativePlayerAuthorityState(macroSnapshot());
  assert.deepEqual(result, {
    schemaVersion: 2,
    statusKind: "macro",
    phase: "macro-active",
    revision: 43,
    acknowledgedSequence: 11,
    nextSequence: 12,
    nextDeadlineMs: 75_000,
    inFlight: false,
    currentOperation: null,
    simulationBudgetMilliseconds: null,
    wallBudgetMilliseconds: null,
    simulationProgressMilliseconds: null,
    wallProgressMilliseconds: null,
    pausedReason: "macro-window-active",
  });
  assert.equal(Object.isFrozen(result), true);
  for (const forbidden of [
    "sessionId", "runId", "macroSessionId", "operationId", "macroAlgorithmVersion",
    "algorithmVersion", "lastErrorCode",
  ]) {
    assert.equal(Object.hasOwn(result, forbidden), false, forbidden);
  }
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /core-1|run-1|macro-session-secret|macro-operation-secret|macro-v10/);
});

test("broker publishes completed macro budget and progress without exposing internal identities", () => {
  const value = macroFixture();
  const result = value.broker.read(7);
  assert.deepEqual(result, {
    schemaVersion: 2,
    statusKind: "macro",
    phase: "macro-active",
    revision: 43,
    acknowledgedSequence: 11,
    nextSequence: 12,
    nextDeadlineMs: 75_000,
    inFlight: false,
    currentOperation: null,
    simulationBudgetMilliseconds: 60_000,
    wallBudgetMilliseconds: 4_000,
    simulationProgressMilliseconds: 60_000,
    wallProgressMilliseconds: 4_000,
    pausedReason: "macro-window-active",
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|native-pure-idle/);
});

test("first-window commit and uncertain recovery expose bounded progress without pending IDs", () => {
  const request = {
    macroSessionId: "macro-first-secret",
    operationId: "operation-first-secret",
    baseRevision: 43,
    simulationMilliseconds: 90_000,
    wallMilliseconds: 6_000,
  };
  const committing = macroFixture({
    phase: "macro-committing",
    snapshot: { macroSessionId: null, macroAlgorithmVersion: null },
    macroSession: null,
    pendingMacroAction: { kind: "advance", request },
  }).broker.read(7);
  assert.equal(committing.currentOperation, "advance");
  assert.equal(committing.simulationBudgetMilliseconds, 90_000);
  assert.equal(committing.simulationProgressMilliseconds, 0);
  assert.equal(committing.pausedReason, "macro-advance-committing");

  const uncertain = macroFixture({
    phase: "macro-uncertain",
    snapshot: {
      macroSessionId: null,
      macroAlgorithmVersion: null,
      inFlight: false,
      currentOperation: null,
      lastErrorCode: "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
    },
    macroSession: null,
    pendingMacroAction: { kind: "advance", request },
  }).broker.read(7);
  assert.equal(uncertain.currentOperation, null);
  assert.equal(uncertain.simulationBudgetMilliseconds, 90_000);
  assert.equal(uncertain.simulationProgressMilliseconds, null);
  assert.equal(uncertain.wallProgressMilliseconds, null);
  assert.equal(uncertain.pausedReason, "macro-advance-uncertain");
  assert.doesNotMatch(JSON.stringify({ committing, uncertain }), /macro-first-secret|operation-first-secret/);
});

test("finish, uncertain finish, and shutdown preserve completed progress with generic pause reasons", () => {
  for (const [phase, snapshot, reason] of [
    ["macro-finishing", {}, "macro-finish-committing"],
    ["macro-uncertain", {
      inFlight: false,
      currentOperation: null,
      lastErrorCode: "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
    }, "macro-finish-uncertain"],
  ]) {
    const result = macroFixture({
      phase,
      snapshot,
      pendingMacroAction: { kind: "finish", macroSessionId: "macro-session-secret" },
    }).broker.read(7);
    assert.equal(result.simulationProgressMilliseconds, 60_000);
    assert.equal(result.wallProgressMilliseconds, 4_000);
    assert.equal(result.pausedReason, reason);
  }

  const shutdown = macroFixture({
    phase: "shutdown",
    snapshot: {
      inFlight: false,
      currentOperation: null,
      lastErrorCode: "NATIVE_PLAYER_AUTHORITY_RUNTIME_SHUTDOWN",
    },
  }).broker.read(7);
  assert.equal(shutdown.schemaVersion, 2);
  assert.equal(shutdown.phase, "shutdown");
  assert.equal(shutdown.pausedReason, "macro-runtime-shutdown");
  assert.equal(Object.hasOwn(shutdown, "sessionId"), false);
});

test("macro phase, identity, operation, and error groups fail closed when partial or unknown", () => {
  for (const value of [
    macroSnapshot("macro-active", { macroAlgorithmVersion: null }),
    macroSnapshot("macro-active", { macroSessionId: null, macroAlgorithmVersion: null }),
    macroSnapshot("macro-active", { queuedCommands: 1 }),
    macroSnapshot("macro-active", { currentOperation: "macro-advance" }),
    macroSnapshot("macro-committing", { currentOperation: null }),
    macroSnapshot("macro-finishing", { currentOperation: "macro-advance" }),
    macroSnapshot("macro-uncertain", { lastErrorCode: null }),
    macroSnapshot("macro-uncertain", {
      inFlight: true,
      currentOperation: null,
      lastErrorCode: "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
    }),
    macroSnapshot("macro-unknown"),
    active({ macroSessionId: "macro-secret", macroAlgorithmVersion: "algorithm-secret" }),
  ]) {
    assert.throws(() => normalizeNativePlayerAuthorityState(value), /native player-authority/i);
  }
});

test("impossible, partial, stale, or mismatched internal macro budgets fail closed", () => {
  const cases = [
    () => macroFixture({
      macroSession: internalMacroSession({
        lastOperation: {
          ...internalMacroSession().lastOperation,
          simulationMilliseconds: 0,
        },
      }),
    }),
    () => macroFixture({
      macroSession: internalMacroSession({
        lastOperation: {
          ...internalMacroSession().lastOperation,
          wallMilliseconds: MAX_MACRO_BUDGET_MILLISECONDS + 1,
        },
      }),
    }),
    () => macroFixture({
      macroSession: internalMacroSession({
        lastOperation: { ...internalMacroSession().lastOperation, revision: 42 },
      }),
    }),
    () => macroFixture({
      phase: "macro-committing",
      snapshot: { macroSessionId: null, macroAlgorithmVersion: null },
      macroSession: null,
      pendingMacroAction: {
        kind: "advance",
        request: {
          macroSessionId: "macro-pending",
          operationId: "operation-pending",
          baseRevision: 42,
          simulationMilliseconds: 1_000,
          wallMilliseconds: 1_000,
        },
      },
    }),
    () => macroFixture({
      phase: "macro-finishing",
      pendingMacroAction: { kind: "finish", macroSessionId: "macro-other" },
    }),
  ];
  for (const create of cases) {
    assert.throws(
      () => create().broker.read(7),
      (error) => error.name === "NativePlayerAuthorityStateBrokerError",
    );
  }
});

test("standalone macro details reject stale revisions, partial fields, and progress beyond budget", () => {
  const details = {
    revision: 43,
    simulationBudgetMilliseconds: 60_000,
    wallBudgetMilliseconds: 4_000,
    simulationProgressMilliseconds: 60_000,
    wallProgressMilliseconds: 4_000,
    operationKind: "active",
    pausedReason: "macro-window-active",
  };
  for (const invalid of [
    { ...details, revision: 42 },
    { ...details, simulationBudgetMilliseconds: 0 },
    { ...details, wallBudgetMilliseconds: MAX_MACRO_BUDGET_MILLISECONDS + 1 },
    { ...details, simulationProgressMilliseconds: 60_001 },
    { ...details, wallProgressMilliseconds: null },
    { ...details, operationKind: "macro-operation-secret" },
    { ...details, pausedReason: "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN" },
    Object.fromEntries(Object.entries(details).filter(([key]) => key !== "wallBudgetMilliseconds")),
  ]) {
    assert.throws(
      () => normalizeNativePlayerAuthorityState(macroSnapshot(), invalid),
      (error) => error.name === "NativePlayerAuthorityStateBrokerError",
    );
  }
});

test("same-session macro revisions may repeat or advance but cannot regress", () => {
  let snapshot = active({ revision: 44, acknowledgedSequence: 12, nextSequence: 13 });
  const runtime = {
    context: null,
    pendingMacroAction: null,
    snapshot: () => ({ ...snapshot }),
  };
  const broker = new NativePlayerAuthorityStateBroker({
    runtime,
    isTrustedRendererOwner: () => true,
  });
  assert.equal(broker.read(7).revision, 44);

  snapshot = macroSnapshot("macro-active", {
    revision: 43,
    acknowledgedSequence: 11,
    nextSequence: 12,
  });
  runtime.context = {
    sessionId: snapshot.sessionId,
    runId: snapshot.runId,
    revision: snapshot.revision,
    nextSequence: snapshot.nextSequence,
    nextDeadlineMs: snapshot.nextDeadlineMs,
    macroSession: internalMacroSession(),
  };
  assert.throws(
    () => broker.read(7),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_STATE_STALE",
  );
});

test("startup macro status converges to the same real v1 session without exposing an identity early", () => {
  let snapshot = macroSnapshot();
  const runtime = {
    context: {
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      revision: snapshot.revision,
      nextSequence: snapshot.nextSequence,
      nextDeadlineMs: snapshot.nextDeadlineMs,
      macroSession: internalMacroSession(),
    },
    pendingMacroAction: null,
    snapshot: () => ({ ...snapshot }),
  };
  const broker = new NativePlayerAuthorityStateBroker({
    runtime,
    isTrustedRendererOwner: () => true,
  });

  const macro = broker.read(7);
  assert.equal(macro.schemaVersion, 2);
  assert.equal(Object.hasOwn(macro, "sessionId"), false);
  assert.doesNotMatch(JSON.stringify(macro), /core-1|run-1|secret|algorithm/i);

  snapshot = active({
    revision: 43,
    acknowledgedSequence: 11,
    nextSequence: 12,
    nextDeadlineMs: 75_000,
  });
  runtime.context = null;
  const settled = broker.read(7);
  assert.deepEqual(settled, { schemaVersion: 1, ...snapshot });

  snapshot = active({
    sessionId: "core-other",
    runId: "run-other",
    revision: 44,
    acknowledgedSequence: 12,
    nextSequence: 13,
    nextDeadlineMs: 76_000,
  });
  assert.throws(
    () => broker.read(7),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_STATE_STALE",
  );
});

test("maximum legal macro budgets are accepted and an untrusted renderer sees nothing", () => {
  const value = macroFixture({
    macroSession: internalMacroSession({
      lastOperation: {
        ...internalMacroSession().lastOperation,
        simulationMilliseconds: MAX_MACRO_BUDGET_MILLISECONDS,
        wallMilliseconds: MAX_MACRO_BUDGET_MILLISECONDS,
      },
    }),
  });
  const status = value.broker.read(7);
  assert.equal(status.simulationBudgetMilliseconds, MAX_MACRO_BUDGET_MILLISECONDS);
  assert.equal(status.simulationProgressMilliseconds, MAX_MACRO_BUDGET_MILLISECONDS);
  value.setRendererTrusted(false);
  assert.throws(
    () => value.broker.read(7),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_STATE_RENDERER_UNTRUSTED",
  );
});
