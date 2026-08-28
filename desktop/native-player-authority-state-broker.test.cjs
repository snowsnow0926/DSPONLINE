"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
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
