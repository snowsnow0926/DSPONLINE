"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  NativePlayerAuthorityPersistenceBroker,
} = require("./native-player-authority-persistence-broker.cjs");

const CHECKPOINT = Object.freeze({
  generation: 9,
  rootHash: "a".repeat(64),
  revision: 41,
});

function summary(overrides = {}) {
  return {
    revision: 41,
    stateVersion: 47,
    mode: "normal",
    paused: false,
    canonicalSha256: "b".repeat(64),
    domainSha256: "c".repeat(64),
    coverage: { authorityEligible: true },
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const boundary = {
    sessionId: "core-main-1",
    runId: "player-run-1",
    revision: 41,
    checkpoint: CHECKPOINT,
    acknowledgedSequence: 7,
    settledDeadlineMs: 18_000,
  };
  const runtime = {
    async withSettledPersistenceBoundary(operation) {
      calls.push(["boundary"]);
      return operation(boundary);
    },
    async withStartupReconciliationBoundary(operation) {
      calls.push(["startup-boundary"]);
      return operation(boundary);
    },
    ...overrides.runtime,
  };
  const registry = {
    inspectSession(ownerId, sessionId) {
      calls.push(["inspect", ownerId, sessionId]);
      return {
        kind: "native-core-session-owner-state-v1",
        sessionId,
        ownerId,
        slot: "normal-main",
        ownerEpoch: 2,
        state: "owned",
        inFlight: 0,
      };
    },
    async status(ownerId, sessionId) {
      calls.push(["status", ownerId, sessionId]);
      return summary();
    },
    async exportV47(ownerId, request) {
      calls.push(["export", ownerId, request]);
      return {
        exportId: request.exportId,
        mode: "normal",
        result: {
          revision: 41,
          savedAtMs: request.savedAtMs,
          byteLength: 123,
          envelopeSha256: "d".repeat(64),
          stateChecksum: "12345678",
        },
      };
    },
    ...overrides.registry,
  };
  return {
    calls,
    broker: new NativePlayerAuthorityPersistenceBroker({
      runtime,
      registry,
      ownerId: "main-player-authority",
      isTrustedRendererOwner: (ownerId) => ownerId === 7,
    }),
  };
}

test("checkpoint reuses the Rust-ACKed lease checkpoint and never enters generic checkpoint mutation", async () => {
  let genericCheckpointCalled = false;
  const value = fixture({
    registry: {
      checkpoint() {
        genericCheckpointCalled = true;
        throw new Error("generic checkpoint must remain fenced");
      },
    },
  });

  assert.deepEqual(await value.broker.checkpoint(7), {
    authority: {
      sessionId: "core-main-1",
      runId: "player-run-1",
      revision: 41,
    },
    checkpoint: CHECKPOINT,
    summary: summary(),
    reusedAcknowledgedCheckpoint: true,
  });
  assert.equal(genericCheckpointCalled, false);
  assert.deepEqual(value.calls, [
    ["boundary"],
    ["inspect", "main-player-authority", "core-main-1"],
    ["status", "main-player-authority", "core-main-1"],
  ]);
});

test("export selects the active main-owned session and renderer cannot supply authority identity", async () => {
  const value = fixture();
  value.broker.bindRendererAuthority(7, {
    sessionId: "core-main-1",
    runId: "player-run-1",
    revision: 41,
  });
  const exported = await value.broker.exportV47(7, {
    exportId: "export-1",
    savedAtMs: 20_000,
  });
  assert.equal(exported.result.revision, 41);
  assert.deepEqual(exported.authority, {
    sessionId: "core-main-1",
    runId: "player-run-1",
    revision: 41,
  });
  assert.deepEqual(value.calls.at(-1), ["export", "main-player-authority", {
    sessionId: "core-main-1",
    exportId: "export-1",
    savedAtMs: 20_000,
  }]);

  assert.throws(
    () => value.broker.exportV47(7, {
      exportId: "export-2",
      savedAtMs: 20_000,
      sessionId: "forged-session",
    }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_INVALID",
  );
});

test("startup reconciliation holds the settled runtime boundary through the renderer challenge", async () => {
  const gate = (() => {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  })();
  let boundaryReleased = false;
  const value = fixture({
    runtime: {
      async withStartupReconciliationBoundary(operation) {
        try {
          return await operation({
            sessionId: "core-main-1",
            runId: "player-run-1",
            revision: 41,
            checkpoint: CHECKPOINT,
            acknowledgedSequence: 7,
            settledDeadlineMs: 18_000,
          });
        } finally {
          boundaryReleased = true;
        }
      },
    },
  });
  let observed;
  const pending = value.broker.withStartupReconciliation(7, async (receipt) => {
    observed = receipt;
    await gate.promise;
    return "renderer-ack";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(boundaryReleased, false);
  assert.deepEqual(observed.authority, {
    sessionId: "core-main-1",
    runId: "player-run-1",
    revision: 41,
  });
  gate.resolve();
  assert.equal(await pending, "renderer-ack");
  assert.equal(boundaryReleased, true);
});

test("live completion keeps the clock frozen through its durable receipt and renderer ACK", async () => {
  const gate = (() => {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  })();
  let boundaryReleased = false;
  const value = fixture({
    runtime: {
      async withSettledPersistenceBoundary(operation) {
        try {
          return await operation({
            sessionId: "core-main-1",
            runId: "player-run-1",
            revision: 41,
            checkpoint: CHECKPOINT,
            acknowledgedSequence: 7,
            settledDeadlineMs: 18_000,
          });
        } finally {
          boundaryReleased = true;
        }
      },
    },
  });
  const pending = value.broker.withHandoffCompletion(7, async (receipt) => {
    assert.equal(receipt.checkpoint.revision, 41);
    assert.deepEqual(receipt.authority, {
      sessionId: "core-main-1",
      runId: "player-run-1",
      revision: 41,
    });
    await gate.promise;
    return "completion-ack";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(boundaryReleased, false);
  gate.resolve();
  assert.equal(await pending, "completion-ack");
  assert.equal(boundaryReleased, true);
});

test("untrusted callers, stale revisions, and non-exclusive owners fail closed", async () => {
  const value = fixture();
  await assert.rejects(
    value.broker.checkpoint(8),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_RENDERER_UNTRUSTED",
  );

  const stale = fixture({ registry: { status: async () => summary({ revision: 42 }) } });
  await assert.rejects(
    stale.broker.checkpoint(7),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BOUNDARY_INVALID",
  );

  const busy = fixture({
    registry: {
      inspectSession: () => ({
        ownerId: "main-player-authority",
        slot: "normal-main",
        state: "owned",
        inFlight: 1,
      }),
    },
  });
  await assert.rejects(
    busy.broker.checkpoint(7),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_OWNER_INVALID",
  );
});

test("export rejects a result that drifted from the frozen scheduler boundary", async () => {
  const value = fixture({
    registry: {
      exportV47: async (_ownerId, request) => ({
        exportId: request.exportId,
        mode: "normal",
        result: { revision: 42, savedAtMs: request.savedAtMs },
      }),
    },
  });
  value.broker.bindRendererAuthority(7, {
    sessionId: "core-main-1",
    runId: "player-run-1",
    revision: 41,
  });
  await assert.rejects(
    value.broker.exportV47(7, { exportId: "export-stale", savedAtMs: 20_000 }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_EXPORT_STALE",
  );
});

test("export fails before Rust export when the renderer document is unbound or has another lineage", async () => {
  const value = fixture();
  await assert.rejects(
    value.broker.exportV47(7, { exportId: "export-unbound", savedAtMs: 20_000 }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BINDING_STALE",
  );
  assert.equal(value.calls.some(([operation]) => operation === "export"), false);

  value.broker.bindRendererAuthority(7, {
    sessionId: "replacement-session",
    runId: "replacement-run",
    revision: 41,
  });
  await assert.rejects(
    value.broker.exportV47(7, { exportId: "export-replaced", savedAtMs: 20_001 }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BINDING_STALE",
  );
  assert.equal(value.calls.some(([operation]) => operation === "export"), false);

  assert.equal(value.broker.clearRendererBinding(7), true);
  assert.equal(value.broker.clearRendererBinding(7), false);
  assert.throws(
    () => value.broker.bindRendererAuthority(8, {
      sessionId: "core-main-1",
      runId: "player-run-1",
      revision: 41,
    }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_RENDERER_UNTRUSTED",
  );
});

test("the post-export guard rejects a renderer replacement before artifact delivery", async () => {
  const value = fixture();
  value.broker.bindRendererAuthority(7, {
    sessionId: "core-main-1",
    runId: "player-run-1",
    revision: 41,
  });
  const prepared = await value.broker.exportV47(7, {
    exportId: "export-before-reload",
    savedAtMs: 20_000,
  });
  assert.equal(value.broker.clearRendererBinding(7), true);
  assert.throws(
    () => value.broker.assertBoundRendererArtifact(7, prepared.authority, prepared.result.revision),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BINDING_STALE",
  );
});
