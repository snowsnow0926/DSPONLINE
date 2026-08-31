"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const {
  MAX_MACRO_BUDGET_MILLISECONDS,
  NativePlayerAuthorityMacroBroker,
} = require("./native-player-authority-macro-broker.cjs");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");
const {
  NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY,
  NativeCoreSessionRegistry,
} = require("./native-host.cjs");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function ownedSession(ownerId = "main-player-authority", slot = "normal-main") {
  return { ownerId, slot, ownerEpoch: 1, state: "owned", inFlight: 0 };
}

function registryFixture(capabilities = [NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY]) {
  const calls = [];
  const client = {
    hello: { capabilities },
    async request(request, timeoutMs) {
      calls.push([request, timeoutMs]);
      return { ok: true };
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  registry.sessions.set("core-main-1", ownedSession());
  return { registry, calls, client };
}

function hostAdvanceRequest(overrides = {}) {
  return {
    sessionId: "core-main-1",
    runId: "player-run-1",
    macroSessionId: "macro-session-1",
    operationId: "macro-operation-1",
    baseRevision: 7,
    simulationMilliseconds: 60_000,
    wallMilliseconds: 4_000,
    ...overrides,
  };
}

function macroStartRequest(overrides = {}) {
  return {
    expectedRevision: 7,
    simulationMilliseconds: 60_000,
    wallMilliseconds: 4_000,
    ...overrides,
  };
}

function authoritySnapshot(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function runtimeFixture(options = {}) {
  let current = options.snapshot ?? authoritySnapshot();
  let pending = null;
  let advanceAttempts = 0;
  let finishAttempts = 0;
  const calls = [];
  const completeAdvance = (request) => {
    current = authoritySnapshot({
      phase: "macro-active",
      revision: request.baseRevision + (options.revisionDelta ?? 2),
      macroSessionId: request.macroSessionId,
      macroAlgorithmVersion: "native-pure-idle-macro-v10",
      ...(options.advanceReceiptOverrides ?? {}),
    });
    pending = null;
    return current;
  };
  const completeFinish = (request) => {
    current = authoritySnapshot({
      revision: current.revision,
      ...(options.finishReceiptOverrides ?? {}),
    });
    pending = null;
    return current;
  };
  const runtime = {
    snapshot: () => current,
    async commitMacroAdvance(request) {
      calls.push(["advance", request]);
      advanceAttempts += 1;
      pending = { kind: "advance", request };
      if (options.loseFirstAdvance && advanceAttempts === 1) {
        current = { ...current, phase: "macro-uncertain" };
        throw new Error("lost macro advance response");
      }
      if (options.beforeAdvanceComplete) await options.beforeAdvanceComplete(request);
      return completeAdvance(request);
    },
    async finishMacroSession(request) {
      calls.push(["finish", request]);
      finishAttempts += 1;
      pending = { kind: "finish", request };
      if (options.loseFirstFinish && finishAttempts === 1) {
        current = { ...current, phase: "macro-uncertain" };
        throw new Error("lost macro finish response");
      }
      return completeFinish(request);
    },
    async retryUncertain() {
      calls.push(["recover", pending]);
      if (!pending) throw new Error("nothing pending");
      return pending.kind === "advance"
        ? completeAdvance(pending.request)
        : completeFinish(pending.request);
    },
  };
  const ids = [...(options.ids ?? ["session-a", "operation-a", "operation-b", "operation-c"])];
  const broker = new NativePlayerAuthorityMacroBroker({
    runtime,
    createId: options.createId ?? (() => ids.shift()),
    ...(options.recoveredOperationId
      ? { recoveredOperationId: options.recoveredOperationId }
      : {}),
    ...(options.pendingMacroCleanupSessionId
      ? {
          pendingMacroCleanupSessionId: options.pendingMacroCleanupSessionId,
          pendingMacroCleanupRevision: options.pendingMacroCleanupRevision,
        }
      : {}),
  });
  return {
    broker,
    calls,
    runtime,
    setSnapshot(value) { current = value; },
  };
}

test("macro Host registry forwards only exact main-owned commit, finish and recovery operations", async () => {
  const { registry, calls } = registryFixture();
  await registry.commitPlayerAuthorityMacroAdvance("main-player-authority", hostAdvanceRequest());
  await registry.finishPlayerAuthorityMacroSession("main-player-authority", {
    sessionId: "core-main-1",
    runId: "player-run-1",
    macroSessionId: "macro-session-1",
  });
  await registry.recoverPlayerAuthorityMacroAdvance("main-player-authority", {
    sessionId: "core-main-1",
  });
  assert.deepEqual(calls, [
    [{
      operation: "coreCommitPlayerAuthorityMacroAdvance",
      sessionId: "core-main-1",
      request: {
        runId: "player-run-1",
        macroSessionId: "macro-session-1",
        operationId: "macro-operation-1",
        baseRevision: 7,
        simulationMilliseconds: 60_000,
        wallMilliseconds: 4_000,
      },
    }, 300_000],
    [{
      operation: "coreFinishPlayerAuthorityMacroSession",
      sessionId: "core-main-1",
      request: {
        runId: "player-run-1",
        macroSessionId: "macro-session-1",
      },
    }, 300_000],
    [{ operation: "coreRecoverPlayerAuthorityMacroAdvance", sessionId: "core-main-1" }, 300_000],
  ]);
  assert.equal(registry.inspectSession("main-player-authority", "core-main-1").inFlight, 0);
});

test("macro Host registry rejects old capabilities, renderer ownership and every malformed budget", async (t) => {
  await t.test("old Host capability", async () => {
    const { registry, calls } = registryFixture([]);
    assert.throws(
      () => registry.commitPlayerAuthorityMacroAdvance("main-player-authority", hostAdvanceRequest()),
      (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_MACRO_ADVANCE_UNAVAILABLE",
    );
    assert.throws(
      () => registry.finishPlayerAuthorityMacroSession("main-player-authority", {
        sessionId: "core-main-1",
        runId: "player-run-1",
        macroSessionId: "macro-session-1",
      }),
      (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_MACRO_ADVANCE_UNAVAILABLE",
    );
    assert.throws(
      () => registry.recoverPlayerAuthorityMacroAdvance("main-player-authority", {
        sessionId: "core-main-1",
      }),
      (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_MACRO_ADVANCE_UNAVAILABLE",
    );
    assert.equal(calls.length, 0);
  });
  await t.test("renderer owner", async () => {
    const { registry, calls } = registryFixture();
    registry.sessions.set("core-renderer", ownedSession(7));
    assert.throws(
      () => registry.commitPlayerAuthorityMacroAdvance(7, {
        ...hostAdvanceRequest(),
        sessionId: "core-renderer",
      }),
      (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_OWNER_REQUIRED",
    );
    assert.equal(calls.length, 0);
  });
  for (const [label, overrides] of [
    ["zero simulation", { simulationMilliseconds: 0 }],
    ["fractional simulation", { simulationMilliseconds: 1.5 }],
    ["overlong wall", { wallMilliseconds: MAX_MACRO_BUDGET_MILLISECONDS + 1 }],
    ["negative revision", { baseRevision: -1 }],
    ["invalid operation ID", { operationId: "has whitespace" }],
    ["unknown field", { forgedCheckpoint: HASH_A }],
  ]) {
    await t.test(label, async () => {
      const { registry, calls } = registryFixture();
      assert.throws(
        () => registry.commitPlayerAuthorityMacroAdvance(
          "main-player-authority",
          hostAdvanceRequest(overrides),
        ),
      );
      assert.equal(calls.length, 0);
    });
  }
  await t.test("recovery identity injection", async () => {
    const { registry, calls } = registryFixture();
    assert.throws(() => registry.recoverPlayerAuthorityMacroAdvance("main-player-authority", {
      sessionId: "core-main-1",
      operationId: "renderer-forged",
    }));
    assert.equal(calls.length, 0);
  });
});

test("startup recovery accepts one complete macro identity and rejects a partial one", () => {
  const summary = {
    revision: 9,
    stateVersion: 47,
    mode: "normal",
    paused: false,
    registryFingerprint: "builtin:test",
    canonicalSha256: HASH_A,
    domainSha256: HASH_B,
    coverage: { authorityEligible: true },
  };
  const recovery = {
    schemaVersion: 1,
    kind: NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY,
    ownerId: "main-player-authority",
    sessionId: "core-restarted-1",
    runId: "player-run-1",
    registryFingerprint: "builtin:test",
    revision: 9,
    checkpoint: { generation: 4, rootHash: HASH_A, revision: 9 },
    acknowledgedSequence: 2,
    nextSequence: 3,
    settledDeadlineMs: 15_000,
    nextDeadlineMs: 16_000,
    commandId: null,
    commandBaseRevision: null,
    changedEntityIds: [],
    changedBeltIds: [],
    topologyDirty: false,
    paused: false,
    macroSessionId: "macro-session-recovered",
    recoveredMacroOperationId: "macro-operation-recovered",
    macroAlgorithmVersion: "native-pure-idle-macro-v10",
    macroSimulationMilliseconds: 60_000,
    macroWallMilliseconds: 4_000,
    summary,
  };
  const registry = new NativeCoreSessionRegistry({
    hello: {
      capabilities: [
        NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY,
        NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY,
      ],
      playerAuthorityStartupRecovery: recovery,
    },
  });
  const adopted = registry.takePlayerAuthorityStartupRecovery("main-player-authority");
  assert.equal(adopted.macroSessionId, "macro-session-recovered");
  assert.equal(adopted.recoveredMacroOperationId, "macro-operation-recovered");
  assert.equal(adopted.macroSimulationMilliseconds, 60_000);
  assert.throws(() => new NativeCoreSessionRegistry({
    hello: {
      capabilities: [NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY],
      playerAuthorityStartupRecovery: recovery,
    },
  }), (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");
  assert.throws(() => new NativeCoreSessionRegistry({
    hello: {
      capabilities: [
        NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY,
        NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY,
      ],
      playerAuthorityStartupRecovery: {
        ...recovery,
        macroAlgorithmVersion: undefined,
      },
    },
  }), (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");
});

test("main-owned broker starts, advances and finishes without exposing authority identities", async () => {
  const { broker, calls } = runtimeFixture();
  const first = await broker.start(macroStartRequest());
  assert.deepEqual(first, {
    schemaVersion: 1,
    state: "macro-active",
    previousRevision: 7,
    revision: 9,
    simulationMilliseconds: 60_000,
    wallMilliseconds: 4_000,
    algorithmVersion: "native-pure-idle-macro-v10",
    recovered: false,
  });
  const second = await broker.advance({ simulationMilliseconds: 30_000, wallMilliseconds: 2_000 });
  assert.equal(second.previousRevision, 9);
  assert.equal(second.revision, 11);
  const finished = await broker.finish();
  assert.deepEqual(finished, { schemaVersion: 1, state: "finished", revision: 11 });
  assert.deepEqual(calls.map(([kind, request]) => [kind, request]), [
    ["advance", {
      macroSessionId: "native-macro-session-session-a-1",
      operationId: "native-macro-operation-session-a-2",
      baseRevision: 7,
      simulationMilliseconds: 60_000,
      wallMilliseconds: 4_000,
    }],
    ["advance", {
      macroSessionId: "native-macro-session-session-a-1",
      operationId: "native-macro-operation-session-a-3",
      baseRevision: 9,
      simulationMilliseconds: 30_000,
      wallMilliseconds: 2_000,
    }],
    ["finish", { macroSessionId: "native-macro-session-session-a-1" }],
  ]);
  for (const receipt of [first, second, finished]) {
    assert.equal(Object.hasOwn(receipt, "sessionId"), false);
    assert.equal(Object.hasOwn(receipt, "runId"), false);
    assert.equal(Object.hasOwn(receipt, "macroSessionId"), false);
    assert.equal(Object.hasOwn(receipt, "operationId"), false);
  }
});

test("start rejects a stale observed revision before issuing identities or mutating the Host", async () => {
  let issued = 0;
  const { broker, calls } = runtimeFixture({
    snapshot: authoritySnapshot({ revision: 8 }),
    createId: () => {
      issued += 1;
      return `unexpected-${issued}`;
    },
  });
  await assert.rejects(
    broker.start(macroStartRequest({ expectedRevision: 7 })),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_START_REBASE_REQUIRED",
  );
  assert.equal(issued, 0);
  assert.equal(calls.length, 0);
});

test("inclusive one-millisecond and thirty-day bounds remain valid and one operation stays single-flight", async () => {
  const { registry, calls } = registryFixture();
  await registry.commitPlayerAuthorityMacroAdvance("main-player-authority", hostAdvanceRequest({
    simulationMilliseconds: 1,
    wallMilliseconds: MAX_MACRO_BUDGET_MILLISECONDS,
  }));
  assert.equal(calls[0][0].request.simulationMilliseconds, 1);
  assert.equal(calls[0][0].request.wallMilliseconds, MAX_MACRO_BUDGET_MILLISECONDS);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const value = runtimeFixture({ beforeAdvanceComplete: () => gate });
  const first = value.broker.start(macroStartRequest({
    simulationMilliseconds: MAX_MACRO_BUDGET_MILLISECONDS,
    wallMilliseconds: 1,
  }));
  await assert.rejects(
    value.broker.start(macroStartRequest({ simulationMilliseconds: 1, wallMilliseconds: 1 })),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_BUSY",
  );
  release();
  const settled = await first;
  assert.equal(settled.simulationMilliseconds, MAX_MACRO_BUDGET_MILLISECONDS);
  assert.equal(settled.wallMilliseconds, 1);
  assert.equal(value.calls.filter(([kind]) => kind === "advance").length, 1);
});

test("broker rejects forged identity fields, invalid epochs and stale receipts before publishing", async (t) => {
  await t.test("forged start identity", async () => {
    const { broker, calls } = runtimeFixture();
    await assert.rejects(broker.start({
      expectedRevision: 7,
      simulationMilliseconds: 1_000,
      wallMilliseconds: 1_000,
      sessionId: "renderer-forged",
    }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_REQUEST_INVALID");
    assert.equal(calls.length, 0);
  });
  await t.test("forged finish identity", async () => {
    const { broker, calls } = runtimeFixture();
    await broker.start(macroStartRequest({ simulationMilliseconds: 1_000, wallMilliseconds: 1_000 }));
    await assert.rejects(
      broker.finish({ macroSessionId: "renderer-forged" }),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_REQUEST_INVALID",
    );
    assert.equal(calls.filter(([kind]) => kind === "finish").length, 0);
  });
  await t.test("one constant epoch still yields distinct operation IDs", async () => {
    let epochCalls = 0;
    const { broker, calls } = runtimeFixture({
      createId: () => {
        epochCalls += 1;
        return "same";
      },
    });
    await broker.start(macroStartRequest({ simulationMilliseconds: 1_000, wallMilliseconds: 1_000 }));
    await broker.advance({ simulationMilliseconds: 1_000, wallMilliseconds: 1_000 });
    assert.equal(epochCalls, 1);
    assert.deepEqual(
      calls.filter(([kind]) => kind === "advance").map(([, request]) => request.operationId),
      ["native-macro-operation-same-2", "native-macro-operation-same-3"],
    );
  });
  await t.test("overlong identity epoch", async () => {
    const { broker, calls } = runtimeFixture({ createId: () => "x".repeat(128) });
    await assert.rejects(
      broker.start(macroStartRequest({ simulationMilliseconds: 1_000, wallMilliseconds: 1_000 })),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_ID_INVALID",
    );
    assert.equal(calls.length, 0);
  });
  await t.test("stale result session", async () => {
    const { broker } = runtimeFixture({
      advanceReceiptOverrides: { sessionId: "core-stale" },
    });
    await assert.rejects(
      broker.start(macroStartRequest({ simulationMilliseconds: 1_000, wallMilliseconds: 1_000 })),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_RECEIPT_INVALID",
    );
  });
  await t.test("out-of-range budget", async () => {
    const { broker, calls } = runtimeFixture();
    await assert.rejects(broker.start(macroStartRequest({
      simulationMilliseconds: MAX_MACRO_BUDGET_MILLISECONDS + 1,
      wallMilliseconds: 1,
    })), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_REQUEST_INVALID");
    assert.equal(calls.length, 0);
  });
});

test("uncertain advance and finish recover the exact main-generated identity", async () => {
  const advance = runtimeFixture({ loseFirstAdvance: true });
  await assert.rejects(
    advance.broker.start(macroStartRequest()),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
  );
  const recoveredAdvance = await advance.broker.recover();
  assert.equal(recoveredAdvance.recovered, true);
  assert.equal(recoveredAdvance.revision, 9);
  assert.deepEqual(await advance.broker.recover(), recoveredAdvance);
  const advanceCalls = advance.calls.filter(([kind]) => kind === "advance");
  assert.equal(advanceCalls.length, 1);
  const pendingRecovery = advance.calls.find(([kind]) => kind === "recover")[1];
  assert.deepEqual(pendingRecovery.request, advanceCalls[0][1]);
  await advance.broker.advance({ simulationMilliseconds: 30_000, wallMilliseconds: 2_000 });
  const laterStartup = await advance.broker.recover();
  assert.equal(laterStartup.revision, 11);
  assert.equal(Object.hasOwn(laterStartup, "previousRevision"), false);

  const finish = runtimeFixture({ loseFirstFinish: true });
  await finish.broker.start(macroStartRequest());
  await assert.rejects(
    finish.broker.finish(),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
  );
  const recoveredFinish = await finish.broker.recover();
  assert.deepEqual(recoveredFinish, {
    schemaVersion: 1,
    state: "finished",
    revision: 9,
    recovered: true,
  });
  finish.setSnapshot(authoritySnapshot({
    revision: 10,
    inFlight: true,
    currentOperation: "tick",
  }));
  assert.equal(finish.broker.recoveryHint(), null);
  finish.setSnapshot(authoritySnapshot({ revision: 10 }));
  assert.deepEqual(finish.broker.recoveryHint(), {
    kind: "finished-pending-disable",
    revision: 9,
  });
  assert.deepEqual(await finish.broker.recover(), recoveredFinish);
  assert.equal(finish.broker.observeCommittedCommand({
    sessionId: "core-main-1",
    baseRevision: 10,
    revision: 11,
    command: {
      topLevelChanges: [{
        path: ["timeWarp", "intent"], operation: "set",
        value: { controllerEntityId: "controller", enabled: false },
      }],
    },
  }), true);
  assert.equal(finish.broker.recoveryHint(), null);
  assert.deepEqual(
    finish.calls.find(([kind]) => kind === "recover")[1].request,
    finish.calls.find(([kind]) => kind === "finish")[1],
  );
});

test("a lost normal finish reply replays one recovered terminal receipt without finishing twice", async () => {
  const value = runtimeFixture();
  await value.broker.start(macroStartRequest());
  const ordinary = await value.broker.finish();
  assert.deepEqual(ordinary, { schemaVersion: 1, state: "finished", revision: 9 });
  assert.deepEqual(value.broker.recoveryHint(), {
    kind: "finished-pending-disable",
    revision: 9,
  });

  // The renderer never observed `ordinary` (for example, it reloaded after
  // main/Rust committed the finish). Its replacement asks main to recover.
  const replay = await value.broker.recover();
  assert.deepEqual(replay, {
    schemaVersion: 1,
    state: "finished",
    revision: 9,
    recovered: true,
  });
  assert.equal(value.calls.filter(([kind]) => kind === "finish").length, 1);
  assert.equal(value.calls.filter(([kind]) => kind === "recover").length, 0);

  value.setSnapshot(authoritySnapshot({
    revision: 10,
    inFlight: true,
    currentOperation: "tick",
  }));
  assert.equal(value.broker.recoveryHint(), null);
  assert.deepEqual(await value.broker.recover(), replay);
  value.setSnapshot(authoritySnapshot({ revision: 10 }));
  assert.deepEqual(await value.broker.recover(), replay);
  value.setSnapshot(authoritySnapshot({
    revision: 11,
    inFlight: true,
    currentOperation: "command",
  }));
  assert.equal(value.broker.observeCommittedCommand({
    sessionId: "core-main-1",
    baseRevision: 10,
    revision: 11,
    command: {
      topLevelChanges: [{
        path: ["timeWarp", "intent"], operation: "set",
        value: { controllerEntityId: "controller", enabled: false },
      }],
    },
  }), true);
  assert.equal(value.broker.recoveryHint(), null);
});

test("cached recovery receipts never cross authority lineage or macro identity", async (t) => {
  for (const [label, overrides] of [
    ["session", { sessionId: "core-other" }],
    ["run", { runId: "run-other" }],
    ["revision regression", { revision: 8 }],
  ]) {
    await t.test(label, async () => {
      const value = runtimeFixture({ loseFirstFinish: true });
      await value.broker.start(macroStartRequest());
      await assert.rejects(
        value.broker.finish(),
        (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
      );
      await value.broker.recover();
      value.setSnapshot(authoritySnapshot({ revision: 9, ...overrides }));
      assert.equal(value.broker.recoveryHint(), null);
      await assert.rejects(
        value.broker.recover(),
        (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_RECOVERY_UNAVAILABLE",
      );
    });
  }

  await t.test("macro session", async () => {
    const value = runtimeFixture({ loseFirstAdvance: true });
    await assert.rejects(
      value.broker.start(macroStartRequest()),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
    );
    await value.broker.recover();
    value.setSnapshot(authoritySnapshot({
      phase: "macro-active",
      revision: 9,
      macroSessionId: "native-macro-session-other",
      macroAlgorithmVersion: "native-pure-idle-macro-v10",
    }));
    await assert.rejects(
      value.broker.recover(),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_RECOVERY_UNAVAILABLE",
    );
  });

  await t.test("algorithm", async () => {
    const value = runtimeFixture({ loseFirstAdvance: true });
    await assert.rejects(
      value.broker.start(macroStartRequest()),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
    );
    await value.broker.recover();
    const macroSessionId = value.runtime.snapshot().macroSessionId;
    value.setSnapshot(authoritySnapshot({
      phase: "macro-active",
      revision: 9,
      macroSessionId,
      macroAlgorithmVersion: "native-pure-idle-macro-v11-other",
    }));
    const startup = await value.broker.recover();
    assert.equal(Object.hasOwn(startup, "previousRevision"), false);
    assert.equal(startup.algorithmVersion, "native-pure-idle-macro-v11-other");
  });
});

test("macro identity allocation stays bounded across three days of one-hertz advances", async () => {
  const advanceCount = 3 * 24 * 60 * 60;
  let current = authoritySnapshot();
  let committedAdvances = 0;
  let epochCalls = 0;
  const runtime = {
    snapshot: () => current,
    async commitMacroAdvance(request) {
      committedAdvances += 1;
      assert.equal(
        request.operationId,
        `native-macro-operation-long-run-epoch-${(committedAdvances + 1).toString(36)}`,
      );
      current = authoritySnapshot({
        phase: "macro-active",
        revision: request.baseRevision + 1,
        macroSessionId: request.macroSessionId,
        macroAlgorithmVersion: "native-pure-idle-macro-v10",
      });
      return current;
    },
    async finishMacroSession() {
      current = authoritySnapshot({ revision: current.revision });
      return current;
    },
    async retryUncertain() {
      throw new Error("long-run test has no uncertain operation");
    },
  };
  const broker = new NativePlayerAuthorityMacroBroker({
    runtime,
    createId: () => {
      epochCalls += 1;
      return "long-run-epoch";
    },
  });

  await broker.start(macroStartRequest({ simulationMilliseconds: 1, wallMilliseconds: 1 }));
  for (let index = 0; index < advanceCount; index += 1) {
    await broker.advance({ simulationMilliseconds: 1, wallMilliseconds: 1 });
  }

  assert.equal(committedAdvances, advanceCount + 1);
  assert.equal(epochCalls, 1);
  assert.equal(Object.hasOwn(broker, "issuedIds"), false);
  assert.equal(broker.startupReservedIds.size, 0);
  assert.equal(broker.nextIdentitySequence, advanceCount + 2);
  await broker.finish();
});

test("startup-recovered macro is adopted without renderer identity or a second Host mutation", async () => {
  const { broker, calls } = runtimeFixture({
    snapshot: authoritySnapshot({
      phase: "macro-active",
      revision: 9,
      macroSessionId: "macro-session-recovered",
      macroAlgorithmVersion: "native-pure-idle-macro-v10",
    }),
    recoveredOperationId: "macro-operation-recovered",
  });
  const result = await broker.recover();
  assert.deepEqual(result, {
    schemaVersion: 1,
    state: "macro-active",
    revision: 9,
    algorithmVersion: "native-pure-idle-macro-v10",
    recovered: true,
  });
  assert.equal(calls.length, 0);
  await assert.rejects(
    broker.recover({ operationId: "renderer-forged" }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_MACRO_REQUEST_INVALID",
  );
});

test("startup-recovered finished cleanup replays only inside the same main-owned lineage", async () => {
  const value = runtimeFixture({
    snapshot: authoritySnapshot({ revision: 12 }),
    pendingMacroCleanupSessionId: "native-macro-session-finished-before-restart",
    pendingMacroCleanupRevision: 9,
  });
  assert.deepEqual(value.broker.recoveryHint(), {
    kind: "finished-pending-disable",
    revision: 9,
  });
  assert.deepEqual(await value.broker.recover(), {
    schemaVersion: 1,
    state: "finished",
    revision: 9,
    recovered: true,
  });
  assert.equal(value.calls.length, 0);
  assert.equal(value.broker.observeCommittedCommand({
    sessionId: "core-main-1",
    baseRevision: 12,
    revision: 13,
    command: {
      topLevelChanges: [{
        path: ["timeWarp", "intent"], operation: "set",
        value: { controllerEntityId: "controller", enabled: false },
      }],
    },
  }), true);
  assert.equal(value.broker.recoveryHint(), null);

  assert.throws(() => runtimeFixture({
    snapshot: authoritySnapshot({ revision: 8 }),
    pendingMacroCleanupSessionId: "native-macro-session-future",
    pendingMacroCleanupRevision: 9,
  }), /cleanup lineage/i);
  assert.throws(() => new NativePlayerAuthorityMacroBroker({
    runtime: value.runtime,
    pendingMacroCleanupSessionId: "native-macro-session-partial",
  }), /pending macro cleanup/i);
});

test("renderer macro receipts expose only bounded progress and never durable identities", () => {
  const active = normalizeRendererNativeResult("playerAuthorityMacroReceipt", {
    schemaVersion: 1,
    state: "macro-active",
    previousRevision: 7,
    revision: 9,
    simulationMilliseconds: 60_000,
    wallMilliseconds: 4_000,
    algorithmVersion: "native-pure-idle-macro-v10",
    recovered: false,
  });
  assert.deepEqual(active, {
    schemaVersion: 1,
    state: "macro-active",
    previousRevision: 7,
    revision: 9,
    simulationMilliseconds: 60_000,
    wallMilliseconds: 4_000,
    recovered: false,
  });
  assert.equal(Object.hasOwn(active, "algorithmVersion"), false);
  const recovered = normalizeRendererNativeResult("playerAuthorityMacroReceipt", {
    schemaVersion: 1,
    state: "macro-active",
    revision: 9,
    algorithmVersion: "native-pure-idle-macro-v10",
    recovered: true,
  });
  assert.equal(recovered.previousRevision, null);
  assert.equal(recovered.simulationMilliseconds, null);
  const finished = normalizeRendererNativeResult("playerAuthorityMacroReceipt", {
    schemaVersion: 1,
    state: "finished",
    revision: 9,
    recovered: true,
  });
  assert.equal(finished.state, "finished");
  for (const invalid of [
    {
      schemaVersion: 1, state: "macro-active", previousRevision: 9, revision: 9,
      simulationMilliseconds: 1, wallMilliseconds: 1,
      algorithmVersion: "native-pure-idle-macro-v10", recovered: false,
    },
    {
      schemaVersion: 1, state: "macro-active", previousRevision: 7, revision: 9,
      simulationMilliseconds: 1, wallMilliseconds: 1,
      algorithmVersion: "native-pure-idle-macro-v10", recovered: false,
      operationId: "forged",
    },
    {
      schemaVersion: 1, state: "finished", revision: 9, recovered: false,
      sessionId: "forged",
    },
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult("playerAuthorityMacroReceipt", invalid),
      { code: "NATIVE_PROTOCOL_INVALID" },
    );
  }
});

test("desktop exposes only a start revision fence and budgets while main owns every identity", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  const preload = readFileSync("desktop/preload.cjs", "utf8");
  assert.match(main, /new NativePlayerAuthorityMacroBroker\(\{[\s\S]*?runtime:\s*nativePlayerAuthorityRuntime/);
  assert.match(main, /recoveredOperationId:\s*playerAuthorityStartupRecovery\.recoveredMacroOperationId/);
  assert.match(main, /pendingMacroCleanupSessionId:[\s\S]*?playerAuthorityStartupRecovery\.pendingMacroCleanupSessionId/);
  assert.match(main, /desktop:native-player-authority-macro-start"[\s\S]*?nativePlayerAuthorityMacroBroker\.start\(request\)/);
  assert.match(main, /desktop:native-player-authority-macro-advance"[\s\S]*?nativePlayerAuthorityMacroBroker\.advance\(request\)/);
  assert.match(main, /desktop:native-player-authority-macro-finish"[\s\S]*?nativePlayerAuthorityMacroBroker\.finish\(request\)/);
  assert.match(main, /desktop:native-player-authority-macro-recover"[\s\S]*?nativePlayerAuthorityMacroBroker\.recover\(request\)/);
  assert.doesNotMatch(main, /nativeCoreSessions\.(?:commitPlayerAuthorityMacroAdvance|finishPlayerAuthorityMacroSession|recoverPlayerAuthorityMacroAdvance)/);
  assert.match(preload, /startNativePlayerAuthorityMacro:[\s\S]*?desktop:native-player-authority-macro-start/);
  assert.match(preload, /finishNativePlayerAuthorityMacro:\s*\(\)[\s\S]*?desktop:native-player-authority-macro-finish[\s\S]*?\{\}/);
  const macroPreloadSurface = preload.match(
    /^\s*(?:start|advance|finish|recover)NativePlayerAuthorityMacro:.*$/gm,
  ) ?? [];
  assert.equal(macroPreloadSurface.length, 4);
  assert.doesNotMatch(
    macroPreloadSurface.join("\n"),
    /macroSessionId|operationId|runId|main-player-authority/,
  );
});
