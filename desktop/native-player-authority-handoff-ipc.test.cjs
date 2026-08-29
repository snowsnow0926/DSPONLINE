"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  COMMIT_REQUEST_KIND,
  COMPLETE_REQUEST_KIND,
  NativePlayerAuthorityHandoffIpcBridge,
  PREPARE_REQUEST_KIND,
  RELEASE_REQUEST_KIND,
  RENDERER_READY_CHANNEL,
  RENDERER_READY_KIND,
  REQUEST_CHANNEL,
  RESPONSE_CHANNEL,
  STARTUP_RECONCILE_REQUEST_KIND,
  startupReconciliationIsTerminalResolved,
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
