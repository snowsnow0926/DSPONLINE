"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  deriveOperationsSettingCommandIdentity,
  normalizeOperationsSettingIntent,
} = require("./native-operations-setting-intent.cjs");
const {
  NativePlayerAuthorityOperationsSettingBroker,
} = require("./native-player-authority-operations-setting-broker.cjs");

const semantic = (intent) => ({
  sessionId: "core-main-1", runId: "run-1", expectedRevision: 17,
  expectedRegistryFingerprint: "7df8cf3a", intent,
});

test("seven operations setting intents are bounded and extra keys fail closed", () => {
  const intents = [
    { type: "set-simulation-speed", value: 2 },
    { type: "set-technology-layout", value: "compact" },
    { type: "set-default-belt-route-mode", value: "upper" },
    { type: "set-production-buffer-limit", value: 1000 },
    { type: "set-logistics-buffer-limit", value: 100000000 },
    { type: "set-belt-buffer-limit", value: 5000 },
    { type: "set-proliferator-buffer-limit", value: 1 },
  ];
  for (const intent of intents) {
    const value = deriveOperationsSettingCommandIdentity(semantic(intent));
    assert.match(value.commandId, /^operations-setting-v1-[a-f0-9]{64}$/);
    assert.deepEqual(value.semantic.intent, intent);
  }
  assert.equal(
    deriveOperationsSettingCommandIdentity(semantic(intents[3])).commandId,
    "operations-setting-v1-b6eaf052d3c25f0ba8447935a74127eb9ab108fed18b5ade3303330554c6b13c",
  );
  assert.throws(() => normalizeOperationsSettingIntent({ type: "set-production-buffer-limit", value: 999 }));
  assert.throws(() => normalizeOperationsSettingIntent({ type: "set-production-buffer-limit", value: 1000, patch: {} }));
  assert.throws(() => deriveOperationsSettingCommandIdentity({ ...semantic(intents[0]), ownerId: "renderer" }));
});

test("broker fences active lineage and accepts only empty leaf-only durable receipt", async () => {
  const calls = [];
  const runtime = {
    snapshot: () => ({ phase: "active", sessionId: "core-main-1", runId: "run-1", revision: 17 }),
    async commitOperationsSettingIntent(request) {
      calls.push(request);
      return {
        phase: "active", sessionId: "core-main-1", previousRevision: 17, revision: 18,
        changedEntityIds: [], changedBeltIds: [], topologyDirty: false,
      };
    },
  };
  const broker = new NativePlayerAuthorityOperationsSettingBroker({
    runtime, isTrustedRendererOwner: (ownerId) => ownerId === 23,
  });
  const receipt = await broker.commit(23, {
    expectedSessionId: "core-main-1", expectedRunId: "run-1", expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a", intent: { type: "set-simulation-speed", value: 2 },
  });
  assert.deepEqual(receipt, {
    previousRevision: 17, revision: 18, changedEntityIds: [], changedBeltIds: [], topologyDirty: false,
  });
  assert.equal(calls.length, 1);
  await assert.rejects(broker.commit(23, {
    expectedSessionId: "core-main-1", expectedRunId: "old-run", expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a", intent: { type: "set-simulation-speed", value: 2 },
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_OPERATIONS_STALE");
  await assert.rejects(broker.commit(23, {
    expectedSessionId: "core-main-1", expectedRunId: "run-1", expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a", intent: { type: "set-simulation-speed", value: 2 }, extra: true,
  }), TypeError);

  runtime.commitOperationsSettingIntent = async () => ({
    phase: "active", sessionId: "core-main-1", previousRevision: 17, revision: 18,
    changedEntityIds: ["entity-1"], changedBeltIds: [], topologyDirty: false,
  });
  await assert.rejects(broker.commit(23, {
    expectedSessionId: "core-main-1", expectedRunId: "run-1", expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a", intent: { type: "set-simulation-speed", value: 2 },
  }), /leaf-only durable receipt/);
});
