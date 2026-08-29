"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const {
  NATIVE_PLAYER_AUTHORITY_GATE_CAPABILITY,
  NativeCoreSessionRegistry,
} = require("./native-host.cjs");
const { NativePlayerAuthorityRuntime } = require("./native-player-authority-runtime.cjs");
const {
  NativePlayerAuthorityHandoffCoordinator,
  QUIESCENCE_ACK_KIND,
} = require("./native-player-authority-handoff.cjs");

const CHECKPOINT = Object.freeze({ generation: 4, rootHash: "a".repeat(64), revision: 17 });
const WRITER_FENCE = Object.freeze({ ownerId: "desktop-primary-1", fencingToken: 9 });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function handoffRequest(overrides = {}) {
  return {
    handoffId: "handoff-1",
    sessionId: "core-1",
    runId: "player-run-1",
    rendererOwnerId: 7,
    expectedRevision: CHECKPOINT.revision,
    expectedCheckpoint: CHECKPOINT,
    publicWriterFence: WRITER_FENCE,
    settledDeadlineMs: 20_000,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function quiescenceAck(request = handoffRequest(), overrides = {}) {
  return {
    kind: QUIESCENCE_ACK_KIND,
    handoffId: request.handoffId,
    sessionId: request.sessionId,
    runId: request.runId,
    ownerId: request.rendererOwnerId,
    revision: request.expectedRevision,
    checkpoint: request.expectedCheckpoint,
    publicWriterFence: request.publicWriterFence,
    settledDeadlineMs: request.settledDeadlineMs,
    rendererInFlightCoreOperations: 0,
    workerInFlightCoreOperations: 0,
    ...overrides,
  };
}

function completeStatus(overrides = {}) {
  return {
    revision: CHECKPOINT.revision,
    stateVersion: 47,
    mode: "normal",
    paused: false,
    coverage: { authorityEligible: true },
    ...overrides,
  };
}

function registryWithStatus(statusFactory = () => completeStatus()) {
  const calls = [];
  const client = {
    request(request) {
      calls.push(request);
      return statusFactory(request);
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  registry.sessions.set("core-1", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  return { registry, calls };
}

test("handoff binds exact quiescence state, transfers once, and rejects the old renderer owner", async () => {
  const { registry } = registryWithStatus();
  const activationCalls = [];
  const runtime = {
    async activate(request) {
      activationCalls.push(request);
      assert.equal(registry.inspectSession("main-player-authority", request.sessionId).ownerEpoch, 2);
      return {
        phase: "active",
        sessionId: request.sessionId,
        runId: request.runId,
        revision: request.expectedCheckpoint.revision,
        inFlight: false,
      };
    },
  };
  const requested = [];
  const coordinator = new NativePlayerAuthorityHandoffCoordinator({
    registry,
    runtime,
    requestQuiescence(request) {
      requested.push(request);
      return quiescenceAck();
    },
  });

  const result = await coordinator.handoff(handoffRequest());
  assert.deepEqual(result, {
    phase: "active",
    sessionId: "core-1",
    runId: "player-run-1",
    revision: 17,
    ownerEpoch: 2,
    inFlight: false,
    lastErrorCode: null,
  });
  assert.deepEqual(requested, [{
    kind: "native-player-authority-quiescence-request-v1",
    handoffId: "handoff-1",
    sessionId: "core-1",
    runId: "player-run-1",
    ownerId: 7,
    revision: 17,
    checkpoint: CHECKPOINT,
    publicWriterFence: WRITER_FENCE,
    settledDeadlineMs: 20_000,
  }]);
  assert.deepEqual(activationCalls, [{
    sessionId: "core-1",
    runId: "player-run-1",
    expectedCheckpoint: CHECKPOINT,
    settledDeadlineMs: 20_000,
  }]);
  assert.throws(
    () => registry.status(7, "core-1"),
    (error) => error.code === "NATIVE_CORE_SESSION_INVALID",
  );
  assert.equal((await registry.status("main-player-authority", "core-1")).revision, 17);
});

test("stale or incomplete quiescence ACKs fault closed before status, transfer, or activation", async () => {
  const invalidAcks = [
    quiescenceAck(handoffRequest(), { runId: "old-run" }),
    quiescenceAck(handoffRequest(), { revision: 16 }),
    quiescenceAck(handoffRequest(), { checkpoint: { ...CHECKPOINT, generation: 3 } }),
    quiescenceAck(handoffRequest(), { publicWriterFence: { ...WRITER_FENCE, fencingToken: 8 } }),
    quiescenceAck(handoffRequest(), { settledDeadlineMs: 19_000 }),
    quiescenceAck(handoffRequest(), { rendererInFlightCoreOperations: 1 }),
    quiescenceAck(handoffRequest(), { workerInFlightCoreOperations: 1 }),
    { ...quiescenceAck(), unexpected: true },
  ];
  for (const ack of invalidAcks) {
    const { registry, calls } = registryWithStatus();
    let activated = false;
    const coordinator = new NativePlayerAuthorityHandoffCoordinator({
      registry,
      runtime: { activate: async () => { activated = true; } },
      requestQuiescence: async () => ack,
    });
    await assert.rejects(
      coordinator.handoff(handoffRequest()),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_HANDOFF_FAULTED",
    );
    assert.equal(coordinator.snapshot().phase, "faulted");
    assert.equal(registry.inspectSession(7, "core-1").ownerEpoch, 1);
    assert.equal(calls.length, 0);
    assert.equal(activated, false);
  }
});

test("revision drift and owner closure block without transferring the renderer session", async (t) => {
  await t.test("revision drift", async () => {
    const { registry } = registryWithStatus(() => completeStatus({ revision: 18 }));
    const releases = [];
    const coordinator = new NativePlayerAuthorityHandoffCoordinator({
      registry,
      runtime: { activate: async () => assert.fail("must not activate") },
      requestQuiescence: async () => quiescenceAck(),
      releaseQuiescence: async (request) => { releases.push(request); },
    });
    await assert.rejects(coordinator.handoff(handoffRequest()), (error) => {
      assert.equal(error.code, "NATIVE_PLAYER_AUTHORITY_HANDOFF_BLOCKED");
      assert.equal(error.cause.code, "NATIVE_PLAYER_AUTHORITY_HANDOFF_REVISION_DRIFT");
      return true;
    });
    assert.equal(registry.inspectSession(7, "core-1").ownerEpoch, 1);
    assert.deepEqual(releases, [{
      kind: "native-player-authority-browser-fence-release-v1",
      handoffId: "handoff-1",
      sessionId: "core-1",
      runId: "player-run-1",
      checkpoint: CHECKPOINT,
      releaseAuthorized: true,
    }]);
  });

  await t.test("owner closes while quiescing", async () => {
    const gate = deferred();
    const { registry } = registryWithStatus((request) =>
      request.operation === "coreClose" ? { closed: true } : completeStatus());
    const coordinator = new NativePlayerAuthorityHandoffCoordinator({
      registry,
      runtime: { activate: async () => assert.fail("must not activate") },
      requestQuiescence: () => gate.promise,
      releaseQuiescence: async () => undefined,
    });
    const operation = coordinator.handoff(handoffRequest());
    await registry.closeOwner(7);
    gate.resolve(quiescenceAck());
    await assert.rejects(operation, (error) => error.code === "NATIVE_PLAYER_AUTHORITY_HANDOFF_BLOCKED");
    assert.throws(() => registry.inspectSession(7, "core-1"), /not owned/);
  });
});

test("quiescence timeout is an unknown outcome that faults closed and ignores a late ACK", async () => {
  const gate = deferred();
  let timeoutCallback;
  let cancelled = false;
  const { registry, calls } = registryWithStatus();
  let activated = false;
  const coordinator = new NativePlayerAuthorityHandoffCoordinator({
    registry,
    runtime: { activate: async () => { activated = true; } },
    requestQuiescence: () => gate.promise,
    schedule(callback) {
      timeoutCallback = callback;
      return 41;
    },
    cancel(token) {
      assert.equal(token, 41);
      cancelled = true;
    },
  });
  const operation = coordinator.handoff(handoffRequest());
  await assert.rejects(
    coordinator.handoff(handoffRequest({ handoffId: "handoff-2" })),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_HANDOFF_ALREADY_STARTED",
  );
  timeoutCallback();
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, "NATIVE_PLAYER_AUTHORITY_HANDOFF_FAULTED");
    assert.equal(error.cause.code, "NATIVE_PLAYER_AUTHORITY_HANDOFF_QUIESCENCE_TIMEOUT");
    return true;
  });
  gate.resolve(quiescenceAck());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(coordinator.snapshot().phase, "faulted");
  assert.equal(calls.length, 0);
  assert.equal(activated, false);
  assert.equal(cancelled, false);
  assert.equal(registry.inspectSession(7, "core-1").ownerEpoch, 1);
});

test("an already in-flight renderer operation prevents handoff until it settles", async () => {
  const rendererOperation = deferred();
  const { registry } = registryWithStatus((request) =>
    request.operation === "coreAdvance" ? rendererOperation.promise : completeStatus());
  const pending = registry.advance(7, {
    sessionId: "core-1",
    baseRevision: 17,
    simulationSeconds: 1,
    wallSeconds: 1,
  });
  assert.equal(registry.inspectSession(7, "core-1").inFlight, 1);
  const coordinator = new NativePlayerAuthorityHandoffCoordinator({
    registry,
    runtime: { activate: async () => assert.fail("must not activate") },
    requestQuiescence: async () => quiescenceAck(),
    releaseQuiescence: async () => undefined,
  });
  await assert.rejects(coordinator.handoff(handoffRequest()), (error) => {
    assert.equal(error.code, "NATIVE_PLAYER_AUTHORITY_HANDOFF_BLOCKED");
    assert.equal(error.cause.code, "NATIVE_PLAYER_AUTHORITY_HANDOFF_OWNER_NOT_QUIESCENT");
    return true;
  });
  assert.equal(registry.inspectSession(7, "core-1").ownerEpoch, 1);
  rendererOperation.resolve({ revision: 18 });
  await pending;
  assert.equal(registry.inspectSession(7, "core-1").inFlight, 0);
});

test("post-transfer activation failure is faulted and never returns ownership to the renderer", async () => {
  const { registry } = registryWithStatus();
  let released = false;
  const coordinator = new NativePlayerAuthorityHandoffCoordinator({
    registry,
    runtime: { activate: async () => { throw new Error("prepare receipt lost"); } },
    requestQuiescence: async () => quiescenceAck(),
    releaseQuiescence: async () => { released = true; },
  });
  await assert.rejects(coordinator.handoff(handoffRequest()), (error) => {
    assert.equal(error.code, "NATIVE_PLAYER_AUTHORITY_HANDOFF_FAULTED");
    return true;
  });
  assert.equal(coordinator.snapshot().phase, "faulted");
  assert.throws(() => registry.inspectSession(7, "core-1"), /not owned/);
  assert.equal(registry.inspectSession("main-player-authority", "core-1").ownerEpoch, 2);
  assert.equal(released, false);
});

test("handoff rejects incomplete authority coverage before transferring ownership", async () => {
  const client = {
    hello: { capabilities: [NATIVE_PLAYER_AUTHORITY_GATE_CAPABILITY] },
    request(request) {
      if (request.operation === "coreStatus") {
        return completeStatus({ coverage: { authorityEligible: false } });
      }
      if (request.operation === "corePreparePlayerAuthority") {
        return {
          lease: {
            kind: "native-core-exact-realtime-player-authority-lease-v1",
            phase: "prepared",
            runId: "player-run-1",
            mode: "normal",
            slot: "normal-main",
            pendingTick: null,
            checkpoint: CHECKPOINT,
            acknowledged: {
              checkpoint: CHECKPOINT,
              revision: 17,
              settledDeadlineMs: 20_000,
              sequence: 0,
            },
          },
          summary: {
            revision: 17,
            stateVersion: 47,
            mode: "normal",
            paused: false,
            canonicalSha256: "b".repeat(64),
            domainSha256: "c".repeat(64),
            coverage: { authorityEligible: false },
          },
        };
      }
      assert.fail(`unexpected host operation ${request.operation}`);
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  registry.sessions.set("core-1", {
    ownerId: 7, slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });
  const runtime = new NativePlayerAuthorityRuntime({ registry, minimumYieldMs: 0 });
  const coordinator = new NativePlayerAuthorityHandoffCoordinator({
    registry,
    runtime,
    requestQuiescence: async () => quiescenceAck(),
    releaseQuiescence: async () => undefined,
  });
  await assert.rejects(
    coordinator.handoff(handoffRequest()),
    (error) => {
      assert.equal(error.code, "NATIVE_PLAYER_AUTHORITY_HANDOFF_BLOCKED");
      assert.equal(error.cause.code, "NATIVE_PLAYER_AUTHORITY_HANDOFF_COVERAGE_INCOMPLETE");
      return true;
    },
  );
  assert.equal(runtime.snapshot().phase, "idle");
  assert.equal(runtime.snapshot().lastErrorCode, null);
  assert.equal(registry.inspectSession(7, "core-1").ownerEpoch, 1);
  assert.throws(() => registry.inspectSession("main-player-authority", "core-1"), /not owned/);
});

test("a validated browser fence faults closed when explicit hand-back is missing or uncertain", async (t) => {
  for (const scenario of ["missing-release", "lost-release-ack"]) {
    await t.test(scenario, async () => {
      const { registry } = registryWithStatus(() => completeStatus({ revision: 18 }));
      const coordinator = new NativePlayerAuthorityHandoffCoordinator({
        registry,
        runtime: { activate: async () => assert.fail("must not activate") },
        requestQuiescence: async () => quiescenceAck(),
        ...(scenario === "lost-release-ack"
          ? { releaseQuiescence: async () => { throw new Error("release response lost"); } }
          : {}),
      });
      await assert.rejects(
        coordinator.handoff(handoffRequest()),
        (error) => error.code === "NATIVE_PLAYER_AUTHORITY_HANDOFF_FAULTED",
      );
      assert.equal(coordinator.snapshot().phase, "faulted");
      assert.equal(registry.inspectSession(7, "core-1").ownerEpoch, 1);
      assert.throws(() => registry.inspectSession("main-player-authority", "core-1"), /not owned/);
    });
  }
});

test("missing, paused, speedrun, and wrong-version summaries fail closed before transfer", async () => {
  const invalidStatuses = [
    { revision: CHECKPOINT.revision },
    completeStatus({ stateVersion: 46 }),
    completeStatus({ mode: "speedrun" }),
    completeStatus({ paused: true }),
    completeStatus({ coverage: null }),
  ];
  for (const status of invalidStatuses) {
    const { registry } = registryWithStatus(() => status);
    let activated = false;
    const coordinator = new NativePlayerAuthorityHandoffCoordinator({
      registry,
      runtime: { activate: async () => { activated = true; } },
      requestQuiescence: async () => quiescenceAck(),
      releaseQuiescence: async () => undefined,
    });
    await assert.rejects(coordinator.handoff(handoffRequest()), (error) => {
      assert.equal(error.code, "NATIVE_PLAYER_AUTHORITY_HANDOFF_BLOCKED");
      assert.equal(error.cause.code, "NATIVE_PLAYER_AUTHORITY_HANDOFF_COVERAGE_INCOMPLETE");
      return true;
    });
    assert.equal(activated, false);
    assert.equal(registry.inspectSession(7, "core-1").ownerEpoch, 1);
  }
});

test("unknown transfer outcome and malformed post-transfer receipt both fault closed under main ownership", async (t) => {
  for (const scenario of ["throw-after-transfer", "malformed-receipt"]) {
    await t.test(scenario, async () => {
      const { registry: actualRegistry } = registryWithStatus();
      const registry = {
        status: (...args) => actualRegistry.status(...args),
        inspectSession: (...args) => actualRegistry.inspectSession(...args),
        transferOwner(...args) {
          const receipt = actualRegistry.transferOwner(...args);
          if (scenario === "throw-after-transfer") throw new Error("transfer response lost");
          return { ...receipt, ownerEpoch: 99 };
        },
      };
      const coordinator = new NativePlayerAuthorityHandoffCoordinator({
        registry,
        runtime: { activate: async () => assert.fail("must not activate") },
        requestQuiescence: async () => quiescenceAck(),
        releaseQuiescence: async () => assert.fail("post/unknown transfer must not release browser fence"),
      });
      await assert.rejects(
        coordinator.handoff(handoffRequest()),
        (error) => error.code === "NATIVE_PLAYER_AUTHORITY_HANDOFF_FAULTED",
      );
      assert.equal(actualRegistry.inspectSession("main-player-authority", "core-1").ownerEpoch, 2);
      assert.throws(() => actualRegistry.inspectSession(7, "core-1"), /not owned/);
    });
  }
});

test("handoff wiring is main-initiated, coverage-gated, and exposes no renderer start/transfer invoke", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  const preload = readFileSync("desktop/preload.cjs", "utf8");
  assert.match(main, /DSP_NATIVE_PLAYER_AUTHORITY_HANDOFF === "1"/);
  assert.match(main, /summary\?\.coverage\?\.authorityEligible === true/);
  assert.match(main, /ipcMain\.on\(NATIVE_PLAYER_AUTHORITY_HANDOFF_RESPONSE_CHANNEL/);
  assert.match(main, /ipcMain\.on\(NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_READY_CHANNEL/);
  assert.doesNotMatch(main, /ipcMain\.handle\([^\n]*native-player-authority-handoff/);
  assert.doesNotMatch(main, /nativePlayerAuthorityDurableOwner/);
  assert.match(main, /desktop:native-player-authority-checkpoint/);
  assert.match(main, /nativePlayerAuthorityPersistenceBroker\.checkpoint\(rendererOwnerId\)/);
  assert.match(main, /desktop:native-player-authority-export-v47/);
  assert.match(main, /nativePlayerAuthorityPersistenceBroker\.exportV47\(rendererOwnerId/);
  assert.match(preload, /onNativePlayerAuthorityHandoffRequest:/);
  assert.match(preload, /subscribeRendererToNativePlayerAuthorityHandoff/);
  assert.match(preload, /checkpointNativePlayerAuthority:\s*\(\) =>/);
  assert.match(preload, /exportNativePlayerAuthorityV47:\s*\(request\) =>/);
  assert.doesNotMatch(preload, /invokeNative\([^\n]*native-player-authority-handoff/);
  assert.doesNotMatch(preload, /checkpointNativePlayerAuthority:\s*\([^)]*(?:session|run|owner|lease|fence)/i);
});
