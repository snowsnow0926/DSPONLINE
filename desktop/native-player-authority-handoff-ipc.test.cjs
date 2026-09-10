"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  COMMIT_REQUEST_KIND,
  COMPLETE_REQUEST_KIND,
  NativePlayerAuthorityBoundedRetryCoordinator,
  NativePlayerAuthorityHandoffIpcBridge,
  PREPARE_REQUEST_KIND,
  RELEASE_REQUEST_KIND,
  RENDERER_READY_CHANNEL,
  RENDERER_READY_KIND,
  REQUEST_CHANNEL,
  RESPONSE_CHANNEL,
  STARTUP_RECONCILE_REQUEST_KIND,
  startupReconciliationIsTerminalResolved,
  requestNativePlayerAuthorityQuiescence,
  subscribeRendererToNativePlayerAuthorityHandoff,
} = require("./native-player-authority-handoff-ipc.cjs");

const CHECKPOINT = Object.freeze({ generation: 4, rootHash: "a".repeat(64), revision: 17 });
const PUBLIC_FENCE = Object.freeze({ ownerId: "desktop-primary-1", fencingToken: 9 });
const NATIVE_FENCE = Object.freeze({ ownerId: "native_authority:player-run-1", fencingToken: 10 });

function prepareRequest(overrides = {}) {
  return {
    kind: PREPARE_REQUEST_KIND,
    handoffId: "handoff-1",
    sessionId: "core-1",
    runId: "player-run-1",
    initialRevision: 17,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function commitRequest(overrides = {}) {
  return {
    kind: COMMIT_REQUEST_KIND,
    handoffId: "handoff-1",
    sessionId: "core-1",
    runId: "player-run-1",
    revision: 17,
    checkpoint: CHECKPOINT,
    publicWriterFence: PUBLIC_FENCE,
    settledDeadlineMs: 20_000,
    ...overrides,
  };
}

function browserFencedResult(overrides = {}) {
  return {
    kind: "native-player-authority-browser-fenced-v1",
    leaseReceipt: {
      kind: "local-save-native-authority-lease-v1",
      leaseId: "player-run-1",
      previousWriterFence: PUBLIC_FENCE,
      nativeWriterFence: NATIVE_FENCE,
    },
    journal: {
      schemaVersion: 1,
      kind: "local-save-native-authority-handoff-journal-v1",
      runId: "player-run-1",
      sessionId: "core-1",
      stateVersion: 47,
      mode: "normal",
      checkpoint: CHECKPOINT,
      previousWriterFence: PUBLIC_FENCE,
      nativeWriterFence: NATIVE_FENCE,
      phase: "browser-fenced",
      createdAt: 19_000,
    },
    rendererInFlightCoreOperations: 0,
    workerInFlightCoreOperations: 0,
    ...overrides,
  };
}

function completeRequest(overrides = {}) {
  return {
    kind: COMPLETE_REQUEST_KIND,
    handoffId: "handoff-1",
    sessionId: "core-1",
    runId: "player-run-1",
    revision: 17,
    checkpoint: CHECKPOINT,
    nativeWriterFence: NATIVE_FENCE,
    summary: {
      revision: 17,
      stateVersion: 47,
      mode: "normal",
      paused: false,
      canonicalSha256: "b".repeat(64),
      domainSha256: "c".repeat(64),
      coverage: { authorityEligible: true },
    },
    ...overrides,
  };
}

function startupRequest(state, overrides = {}) {
  const rustLease = state === "active"
    ? {
      state: "active",
      runId: "player-run-1",
      sessionId: "core-1",
      stateVersion: 47,
      mode: "normal",
      entryCheckpoint: CHECKPOINT,
      checkpoint: CHECKPOINT,
      summary: completeRequest().summary,
    }
    : { state };
  return {
    kind: STARTUP_RECONCILE_REQUEST_KIND,
    handoffId: "startup-1",
    rustLease,
    releaseAuthorized: state === "absent",
    timeoutMs: 5_000,
    ...overrides,
  };
}

function response(request, value) {
  return {
    kind: "native-player-authority-handoff-renderer-response-v1",
    handoffId: request.handoffId,
    requestKind: request.kind,
    ok: true,
    value,
  };
}

function bridgeFixture() {
  const sent = [];
  const renderer = {
    id: 7,
    isDestroyed: () => false,
    send(channel, value) { sent.push({ channel, value }); },
  };
  return {
    sent,
    bridge: new NativePlayerAuthorityHandoffIpcBridge({
      getRenderer: (ownerId) => ownerId === 7 ? renderer : null,
    }),
  };
}

test("main quiescence adapter preserves the coordinator boundary and validates the browser reply", async () => {
  const { bridge, sent } = bridgeFixture();
  const request = { ...commitRequest(), ownerId: 7 };
  const pending = requestNativePlayerAuthorityQuiescence(bridge, request, 5_000);
  assert.deepEqual(sent, [{ channel: REQUEST_CHANNEL, value: commitRequest() }]);
  assert.equal(bridge.accept({ sender: { id: 8 } }, response(commitRequest(), browserFencedResult())), false);
  assert.equal(bridge.accept({ sender: { id: 7 } }, response(commitRequest(), browserFencedResult())), true);
  assert.deepEqual(await pending, { browserFence: browserFencedResult(), acknowledgement: {
    ...request, kind: "native-player-authority-quiescence-ack-v1",
    rendererInFlightCoreOperations: 0, workerInFlightCoreOperations: 0,
  } });
});

test("main quiescence adapter never returns an ACK for a stale journal or non-drained Worker", async () => {
  for (const value of [browserFencedResult({ workerInFlightCoreOperations: 1 }), browserFencedResult({
    journal: { ...browserFencedResult().journal, checkpoint: { ...CHECKPOINT, revision: 18 } },
  })]) {
    const { bridge } = bridgeFixture();
    const pending = requestNativePlayerAuthorityQuiescence(bridge, { ...commitRequest(), ownerId: 7 }, 5_000);
    bridge.accept({ sender: { id: 7 } }, response(commitRequest(), value));
    await assert.rejects(pending, { code: "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_INVALID" });
  }
});

test("main quiescence adapter uses the main deadline and leaves lost replies uncertain", async () => {
  let expired;
  const bridge = new NativePlayerAuthorityHandoffIpcBridge({
    getRenderer: () => ({ id: 7, send() {}, isDestroyed: () => false }),
    schedule: (callback, milliseconds) => { assert.equal(milliseconds, 15_000); expired = callback; return 1; },
    cancel() {},
  });
  const pending = requestNativePlayerAuthorityQuiescence(bridge, { ...commitRequest(), ownerId: 7 }, 15_000);
  expired();
  await assert.rejects(pending, { code: "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_TIMEOUT" });
  assert.equal(bridge.accept({ sender: { id: 7 } }, response(commitRequest(), browserFencedResult())), false);
});

test("main challenge accepts only the exact WebContents, handoff ID, and request kind", async () => {
  const { bridge, sent } = bridgeFixture();
  const request = prepareRequest();
  const pending = bridge.request(7, request, 5_000);
  assert.deepEqual(sent, [{ channel: REQUEST_CHANNEL, value: request }]);
  assert.equal(bridge.accept({ sender: { id: 8 } }, response(request, {})), false);
  assert.equal(bridge.accept({ sender: { id: 7 } }, {
    ...response(request, {}),
    handoffId: "handoff-stale",
  }), false);
  assert.equal(bridge.accept({ sender: { id: 7 } }, response(request, {
    kind: "native-player-authority-quiescence-prepared-v1",
    publicWriterFence: PUBLIC_FENCE,
    rendererInFlightCoreOperations: 0,
    workerInFlightCoreOperations: 0,
    settledDeadlineMs: 20_000,
  })), true);
  assert.deepEqual(await pending, {
    kind: "native-player-authority-quiescence-prepared-v1",
    handoffId: "handoff-1",
    publicWriterFence: PUBLIC_FENCE,
    rendererInFlightCoreOperations: 0,
    workerInFlightCoreOperations: 0,
    settledDeadlineMs: 20_000,
  });
});

test("browser-fenced ACK is bound to zero in-flight work, N+1 lease, journal, and checkpoint", async () => {
  const invalidResults = [
    browserFencedResult({ workerInFlightCoreOperations: 1 }),
    browserFencedResult({
      leaseReceipt: { ...browserFencedResult().leaseReceipt, leaseId: "other-run" },
    }),
    browserFencedResult({
      leaseReceipt: {
        ...browserFencedResult().leaseReceipt,
        nativeWriterFence: { ...NATIVE_FENCE, fencingToken: 11 },
      },
    }),
    browserFencedResult({
      journal: { ...browserFencedResult().journal, checkpoint: { ...CHECKPOINT, revision: 18 } },
    }),
    browserFencedResult({
      journal: { ...browserFencedResult().journal, phase: "handed-back" },
    }),
  ];
  for (const value of invalidResults) {
    const { bridge } = bridgeFixture();
    const request = commitRequest();
    const pending = bridge.request(7, request, 5_000);
    assert.equal(bridge.accept({ sender: { id: 7 } }, response(request, value)), true);
    await assert.rejects(pending, (error) =>
      error.code === "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_INVALID");
  }

  const { bridge } = bridgeFixture();
  const request = commitRequest();
  const pending = bridge.request(7, request, 5_000);
  bridge.accept({ sender: { id: 7 } }, response(request, browserFencedResult()));
  assert.deepEqual(await pending, browserFencedResult());
});

test("release ACK requires the original browser writer and exact N+2 fence", async () => {
  const release = {
    kind: RELEASE_REQUEST_KIND,
    handoffId: "handoff-1",
    sessionId: "core-1",
    runId: "player-run-1",
    checkpoint: CHECKPOINT,
    receipt: browserFencedResult().leaseReceipt,
    releaseAuthorized: true,
    decision: {
      action: "release-browser-fence",
      reason: "rust-lease-absent-release-authorized",
      runId: "player-run-1",
      sessionId: "core-1",
      checkpoint: CHECKPOINT,
    },
  };
  for (const returnedWriterFence of [
    { ownerId: "other-browser", fencingToken: 11 },
    { ownerId: PUBLIC_FENCE.ownerId, fencingToken: 10 },
  ]) {
    const { bridge } = bridgeFixture();
    const pending = bridge.request(7, release, 5_000);
    bridge.accept({ sender: { id: 7 } }, response(release, {
      kind: "native-player-authority-browser-fence-released-v1",
      released: true,
      returnedWriterFence,
    }));
    await assert.rejects(pending, (error) =>
      error.code === "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_INVALID");
  }

  const { bridge } = bridgeFixture();
  const pending = bridge.request(7, release, 5_000);
  bridge.accept({ sender: { id: 7 } }, response(release, {
    kind: "native-player-authority-browser-fence-released-v1",
    released: true,
    returnedWriterFence: { ownerId: PUBLIC_FENCE.ownerId, fencingToken: 11 },
  }));
  assert.deepEqual(await pending, {
    kind: "native-player-authority-browser-fence-released-v1",
    released: true,
    returnedWriterFence: { ownerId: PUBLIC_FENCE.ownerId, fencingToken: 11 },
  });
});

test("completion ACK is exactly bound to the active session, checkpoint, writer fence, and zero work", async () => {
  const valid = {
    kind: "native-player-authority-handoff-completed-v1",
    sessionId: "core-1",
    runId: "player-run-1",
    revision: 17,
    checkpoint: CHECKPOINT,
    nativeWriterFence: NATIVE_FENCE,
    rendererInFlightCoreOperations: 0,
    workerInFlightCoreOperations: 0,
    controllerPhase: "native-authoritative",
  };
  for (const invalid of [
    { ...valid, revision: 18 },
    { ...valid, checkpoint: { ...CHECKPOINT, generation: 5 } },
    { ...valid, nativeWriterFence: { ...NATIVE_FENCE, fencingToken: 11 } },
    { ...valid, workerInFlightCoreOperations: 1 },
    { ...valid, controllerPhase: "native-ready" },
  ]) {
    const { bridge } = bridgeFixture();
    const request = completeRequest();
    const pending = bridge.request(7, request, 5_000);
    bridge.accept({ sender: { id: 7 } }, response(request, invalid));
    await assert.rejects(
      pending,
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_INVALID",
    );
  }

  const { bridge } = bridgeFixture();
  const request = completeRequest();
  const pending = bridge.request(7, request, 5_000);
  bridge.accept({ sender: { id: 7 } }, response(request, valid));
  assert.deepEqual(await pending, valid);
});

test("startup reconciliation actions are constrained by main's active/absent/unknown observation", async () => {
  const permitted = [
    ["active", "resumed-native"],
    ["active", "fail-closed"],
    ["absent", "released-browser-fence"],
    ["absent", "no-browser-fence"],
    ["unknown", "fail-closed"],
  ];
  for (const [state, action] of permitted) {
    const { bridge } = bridgeFixture();
    const request = startupRequest(state);
    const pending = bridge.request(7, request, 5_000);
    bridge.accept({ sender: { id: 7 } }, response(request, {
      kind: "native-player-authority-startup-reconciled-v1",
      action,
      rendererInFlightCoreOperations: 0,
      workerInFlightCoreOperations: 0,
    }));
    assert.equal((await pending).action, action);
  }
  assert.equal(startupReconciliationIsTerminalResolved({
    kind: "native-player-authority-startup-reconciled-v1",
    action: "resumed-native",
  }), true);
  assert.equal(startupReconciliationIsTerminalResolved({
    kind: "native-player-authority-startup-reconciled-v1",
    action: "released-browser-fence",
  }), true);
  assert.equal(startupReconciliationIsTerminalResolved({
    kind: "native-player-authority-startup-reconciled-v1",
    action: "no-browser-fence",
  }), true);
  assert.equal(startupReconciliationIsTerminalResolved({
    kind: "native-player-authority-startup-reconciled-v1",
    action: "fail-closed",
  }), false);

  for (const [state, action] of [
    ["active", "released-browser-fence"],
    ["absent", "resumed-native"],
    ["unknown", "no-browser-fence"],
  ]) {
    const { bridge } = bridgeFixture();
    const request = startupRequest(state);
    const pending = bridge.request(7, request, 5_000);
    bridge.accept({ sender: { id: 7 } }, response(request, {
      kind: "native-player-authority-startup-reconciled-v1",
      action,
      rendererInFlightCoreOperations: 0,
      workerInFlightCoreOperations: 0,
    }));
    await assert.rejects(
      pending,
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_INVALID",
    );
  }
});

test("cancelling a reused WebContents rejects its old envelope and accepts only the fresh handoff ID", async () => {
  const { bridge, sent } = bridgeFixture();
  const oldRequest = startupRequest("active", { handoffId: "startup-old" });
  const oldPending = bridge.request(7, oldRequest, 5_000);
  assert.equal(bridge.cancelOwner(7), true);
  await assert.rejects(
    oldPending,
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_UNAVAILABLE",
  );

  const freshRequest = startupRequest("active", { handoffId: "startup-fresh" });
  const freshPending = bridge.request(7, freshRequest, 5_000);
  const resumed = {
    kind: "native-player-authority-startup-reconciled-v1",
    action: "resumed-native",
    rendererInFlightCoreOperations: 0,
    workerInFlightCoreOperations: 0,
  };
  assert.equal(bridge.accept({ sender: { id: 7 } }, response(oldRequest, resumed)), false);
  assert.equal(bridge.accept({ sender: { id: 7 } }, response(freshRequest, resumed)), true);
  assert.equal((await freshPending).action, "resumed-native");
  assert.deepEqual(sent.map(({ value }) => value.handoffId), ["startup-old", "startup-fresh"]);
});

test("startup retry is single-instance, bounded, and reaches terminal without another renderer-ready signal", async () => {
  const scheduled = [];
  const cancelled = [];
  const calls = [];
  let elapsedMs = 0;
  let maximumDelayMs = 0;
  const outcomes = [
    ...Array.from({ length: 8 }, () => Object.assign(new Error("tick busy"), {
      code: "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
    })),
    Object.assign(new Error("renderer timeout"), {
      code: "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_TIMEOUT",
    }),
    { kind: "native-player-authority-startup-reconciled-v1", action: "fail-closed" },
    { kind: "native-player-authority-startup-reconciled-v1", action: "resumed-native" },
  ];
  const retry = new NativePlayerAuthorityBoundedRetryCoordinator({
    operation: async (ownerId) => {
      calls.push(ownerId);
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    isTerminalResult: startupReconciliationIsTerminalResolved,
    isOwnerAvailable: (ownerId) => ownerId === 7,
    shouldRetryError: (error) => [
      "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
      "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_TIMEOUT",
    ].includes(error?.code),
    schedule: (callback, delayMs) => {
      maximumDelayMs = Math.max(maximumDelayMs, delayMs);
      const token = { callback, delayMs, cancelled: false };
      scheduled.push(token);
      return token;
    },
    cancel: (token) => {
      token.cancelled = true;
      cancelled.push(token);
    },
  });
  const completion = retry.start(7);
  assert.equal(retry.start(7), completion);
  while (scheduled.length > 0) {
    const timer = scheduled.shift();
    if (!timer.cancelled) {
      elapsedMs += timer.delayMs;
      timer.callback();
    }
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal((await completion).action, "resumed-native");
  assert.deepEqual(calls, Array.from({ length: 11 }, () => 7));
  assert.ok(elapsedMs > 2_000);
  assert.equal(maximumDelayMs, 2_000);
  assert.deepEqual(retry.snapshot(), {
    phase: "terminal",
    rendererOwnerId: 7,
    attempt: 11,
    retryDelayMs: null,
    lastErrorCode: null,
  });
  assert.ok(cancelled.every((timer) => timer.cancelled));
});

test("a fresh renderer-ready after terminal starts a new challenge even when WebContents ID is reused", async () => {
  let calls = 0;
  const retry = new NativePlayerAuthorityBoundedRetryCoordinator({
    operation: async () => {
      calls += 1;
      return {
        kind: "native-player-authority-startup-reconciled-v1",
        action: "resumed-native",
      };
    },
    isTerminalResult: startupReconciliationIsTerminalResolved,
    isOwnerAvailable: (ownerId) => ownerId === 7,
    retryDelaysMs: [0],
  });

  const first = retry.start(7);
  await first;
  const second = retry.start(7);
  assert.notEqual(second, first);
  await second;
  assert.equal(calls, 2);
  assert.deepEqual(retry.snapshot(), {
    phase: "terminal",
    rendererOwnerId: 7,
    attempt: 1,
    retryDelayMs: null,
    lastErrorCode: null,
  });
});

test("a fresh renderer-ready cancels an in-flight challenge before reusing the WebContents ID", async () => {
  const firstGate = {};
  firstGate.promise = new Promise((resolve) => { firstGate.resolve = resolve; });
  const scheduled = [];
  let calls = 0;
  const retry = new NativePlayerAuthorityBoundedRetryCoordinator({
    operation: async () => {
      calls += 1;
      if (calls === 1) return firstGate.promise;
      return {
        kind: "native-player-authority-startup-reconciled-v1",
        action: "resumed-native",
      };
    },
    isTerminalResult: startupReconciliationIsTerminalResolved,
    isOwnerAvailable: (ownerId) => ownerId === 7,
    retryDelaysMs: [0],
    schedule: (callback, delayMs) => {
      const token = { callback, delayMs, cancelled: false };
      scheduled.push(token);
      return token;
    },
    cancel: (token) => { token.cancelled = true; },
  });

  const previousDocument = retry.start(7);
  scheduled.shift().callback();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(retry.cancelOwner(7), true);
  await assert.rejects(
    previousDocument,
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_UNAVAILABLE",
  );

  const currentDocument = retry.start(7);
  scheduled.shift().callback();
  firstGate.resolve({
    kind: "native-player-authority-startup-reconciled-v1",
    action: "resumed-native",
  });
  assert.equal((await currentDocument).action, "resumed-native");
  assert.equal(calls, 2);
  assert.deepEqual(retry.snapshot(), {
    phase: "terminal",
    rendererOwnerId: 7,
    attempt: 1,
    retryDelayMs: null,
    lastErrorCode: null,
  });
});

test("retry-pending becomes recovery-blocked and cancels its timer when the renderer is destroyed", async () => {
  const scheduled = [];
  let ownerAvailable = true;
  const retry = new NativePlayerAuthorityBoundedRetryCoordinator({
    operation: async () => ({
      kind: "native-player-authority-startup-reconciled-v1",
      action: "fail-closed",
    }),
    isTerminalResult: startupReconciliationIsTerminalResolved,
    isOwnerAvailable: () => ownerAvailable,
    retryDelaysMs: [0, 25],
    schedule: (callback, delayMs) => {
      const token = { callback, delayMs, cancelled: false };
      scheduled.push(token);
      return token;
    },
    cancel: (token) => { token.cancelled = true; },
  });
  const completion = retry.start(7);
  scheduled.shift().callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(retry.snapshot().phase, "retry-pending");
  assert.equal(scheduled.at(-1).delayMs, 25);
  ownerAvailable = false;
  assert.equal(retry.cancelOwner(7), true);
  await assert.rejects(completion, (error) =>
    error.code === "NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_UNAVAILABLE");
  assert.equal(retry.snapshot().phase, "recovery-blocked");
  assert.equal(scheduled.at(-1).cancelled, true);
});

test("preload subscription is response-only and removes its listener cleanly", async () => {
  const emitter = new EventEmitter();
  const sent = [];
  const ipcRenderer = {
    on: (...args) => emitter.on(...args),
    removeListener: (...args) => emitter.removeListener(...args),
    send: (channel, value) => sent.push({ channel, value }),
  };
  const request = prepareRequest();
  const unsubscribe = subscribeRendererToNativePlayerAuthorityHandoff(
    ipcRenderer,
    async (received) => ({
      kind: "native-player-authority-quiescence-prepared-v1",
      publicWriterFence: PUBLIC_FENCE,
      rendererInFlightCoreOperations: 0,
      workerInFlightCoreOperations: 0,
      settledDeadlineMs: received.timeoutMs,
    }),
  );
  emitter.emit(REQUEST_CHANNEL, {}, request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [{
    channel: RENDERER_READY_CHANNEL,
    value: { kind: RENDERER_READY_KIND },
  }, {
    channel: RESPONSE_CHANNEL,
    value: {
      kind: "native-player-authority-handoff-renderer-response-v1",
      handoffId: "handoff-1",
      requestKind: PREPARE_REQUEST_KIND,
      ok: true,
      value: {
        kind: "native-player-authority-quiescence-prepared-v1",
        publicWriterFence: PUBLIC_FENCE,
        rendererInFlightCoreOperations: 0,
        workerInFlightCoreOperations: 0,
        settledDeadlineMs: 5_000,
      },
    },
  }]);
  unsubscribe();
  emitter.emit(REQUEST_CHANNEL, {}, prepareRequest({ handoffId: "handoff-2" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
});
