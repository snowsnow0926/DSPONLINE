"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const {
  deriveSystemSpaceStationCommandIdentity,
  normalizeSystemSpaceStationIntent,
} = require("./native-system-space-station-intent.cjs");
const {
  NativePlayerAuthoritySystemSpaceStationBroker,
} = require("./native-player-authority-system-space-station-broker.cjs");

const intents = [
  { type: "start", systemId: "helios" },
  { type: "deliver-from-tray", systemId: "helios", planetId: "home", itemId: "titanium_alloy", requestedAmount: 123 },
  { type: "module-target", systemId: "helios", module: "backbone", target: 2 },
  { type: "upgrade-one", entityId: "station-1" },
  { type: "upgrade-all", systemId: null },
  { type: "mode-target", entityId: "station-1", mode: "elevator" },
  { type: "output-target", entityId: "station-1", portIndex: 4, itemId: null, confirmations: 2 },
];

test("all seven system-space-station intents are exact, bounded and deterministic", () => {
  for (const intent of intents) assert.deepEqual(normalizeSystemSpaceStationIntent(intent), intent);
  assert.throws(() => normalizeSystemSpaceStationIntent({ ...intents[0], command: {} }), /invalid/);
  assert.throws(() => normalizeSystemSpaceStationIntent({ ...intents[1], requestedAmount: 0 }), /invalid/);
  assert.throws(() => normalizeSystemSpaceStationIntent({ ...intents[2], target: 1_000_001 }), /invalid/);
  assert.throws(() => normalizeSystemSpaceStationIntent({ ...intents[6], confirmations: 1 }), /invalid/);
  const identity = deriveSystemSpaceStationCommandIdentity({
    sessionId: "core-1",
    runId: "run-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "7df8cf3a",
    expectedSystemId: "helios",
    intent: intents[0],
  });
  assert.equal(identity.semanticSha256, "9eeffa5a13ff025ee8b0e2a2531ccc3aae761e9ecb3c83c36ad5a233c10b2601");
  assert.equal(identity.commandId, `system-space-station-v1-${identity.semanticSha256}`);
  const collision = deriveSystemSpaceStationCommandIdentity({
    ...identity.semantic,
    intent: { type: "start", systemId: "borealis" },
  });
  assert.notEqual(collision.commandId, identity.commandId);
});

test("renderer broker submits only bounded intent and returns one contiguous durable receipt", async () => {
  const calls = [];
  const runtime = {
    snapshot() {
      return { phase: "active", sessionId: "core-1", runId: "run-1", revision: 7 };
    },
    async commitSystemSpaceStationIntent(request) {
      calls.push(request);
      return {
        phase: "active",
        sessionId: "core-1",
        previousRevision: 7,
        revision: 8,
        changedEntityIds: [],
        changedBeltIds: [],
        topologyDirty: false,
      };
    },
  };
  const broker = new NativePlayerAuthoritySystemSpaceStationBroker({
    runtime,
    isTrustedRendererOwner: (ownerId) => ownerId === 17,
  });
  const receipt = await broker.commit(17, {
    expectedSessionId: "core-1",
    expectedRunId: "run-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "7df8cf3a",
    expectedSystemId: "helios",
    intent: intents[0],
  });
  assert.deepEqual(receipt, {
    previousRevision: 7,
    revision: 8,
    changedEntityIds: [],
    changedBeltIds: [],
    topologyDirty: false,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), [
    "baseRevision", "commandId", "expectedRegistryFingerprint", "expectedSystemId", "intent",
  ]);
  assert.equal(Object.hasOwn(calls[0], "command"), false);
  assert.equal(Object.hasOwn(calls[0], "sessionId"), false);
  assert.equal(Object.hasOwn(calls[0], "runId"), false);
  await assert.rejects(
    broker.commit(18, {
      expectedSessionId: "core-1", expectedRunId: "run-1", expectedRevision: 7,
      expectedRegistryFingerprint: "7df8cf3a", expectedSystemId: "helios", intent: intents[0],
    }),
    /not trusted/,
  );
  for (const stale of [
    { expectedSessionId: "core-other", expectedRunId: "run-1", expectedRevision: 7 },
    { expectedSessionId: "core-1", expectedRunId: "run-other", expectedRevision: 7 },
    { expectedSessionId: "core-1", expectedRunId: "run-1", expectedRevision: 6 },
  ]) {
    await assert.rejects(
      broker.commit(17, {
        ...stale,
        expectedRegistryFingerprint: "7df8cf3a",
        expectedSystemId: "helios",
        intent: intents[0],
      }),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_STALE",
    );
  }
  assert.equal(calls.length, 1);
});

test("main and preload expose one intent-only channel and no renderer patch surface", () => {
  const main = fs.readFileSync("desktop/main.cjs", "utf8");
  const preload = fs.readFileSync("desktop/preload.cjs", "utf8");
  const rust = fs.readFileSync("native/dsp-native-host/src/main.rs", "utf8");
  const coreRuntime = fs.readFileSync("native/dsp-native-host/src/core_runtime.rs", "utf8");
  assert.match(main, /desktop:native-player-authority-system-space-station-intent/);
  assert.match(main, /nativePlayerAuthoritySystemSpaceStationBroker\.commit\(ownerId, request\)/);
  assert.match(preload, /commitNativeSystemSpaceStationIntent/);
  assert.doesNotMatch(preload, /commitPlayerAuthoritySystemSpaceStationCommand/);
  assert.match(rust, /PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_COMMAND_CAPABILITY/);
  assert.match(coreRuntime, /native-core-player-authority-system-space-station-command-v1/);
});
