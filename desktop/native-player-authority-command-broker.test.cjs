"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const {
  NativePlayerAuthorityCommandBroker,
} = require("./native-player-authority-command-broker.cjs");

function command(baseRevision = 17, overrides = {}) {
  return {
    protocolVersion: 1,
    baseRevision,
    topLevelChanges: [],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
    ...overrides,
  };
}

function snapshot(revision = 17, overrides = {}) {
  return {
    phase: "active",
    sessionId: "core-1",
    runId: "run-1",
    revision,
    inFlight: false,
    ...overrides,
  };
}

function commandResult(request, overrides = {}) {
  return {
    ...snapshot(request.baseRevision + 1),
    previousRevision: request.baseRevision,
    changedEntityIds: ["entity-a", "entity-z"],
    changedBeltIds: ["belt-a"],
    topologyDirty: false,
    ...overrides,
  };
}

function brokerFixture(options = {}) {
  let current = options.snapshot ?? snapshot();
  const calls = [];
  const runtime = {
    snapshot: () => current,
    async commitCommand(request) {
      calls.push(request);
      if (options.commit) return options.commit(request, current);
      current = commandResult(request);
      return current;
    },
  };
  const broker = new NativePlayerAuthorityCommandBroker({
    runtime,
    ...(options.onCommittedCommand ? { onCommittedCommand: options.onCommittedCommand } : {}),
    isTrustedRendererOwner: options.isTrustedRendererOwner ?? ((ownerId) => ownerId === 7),
  });
  return { broker, calls, setSnapshot: (value) => { current = value; } };
}

test("trusted renderer command crosses only the main-owned durable runtime", async () => {
  const { broker, calls } = brokerFixture();
  const result = await broker.commit(7, { sessionId: "core-1", command: command() });
  assert.deepEqual(result, {
    previousRevision: 17,
    revision: 18,
    changedEntityIds: ["entity-a", "entity-z"],
    changedBeltIds: ["belt-a"],
    topologyDirty: false,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].commandId, /^renderer-17-[a-f0-9]{40}$/);
  assert.equal(calls[0].baseRevision, 17);
  assert.deepEqual(calls[0].command, command());
});

test("a main-only observer sees only validated durable commands and cannot poison their receipt", async () => {
  const observed = [];
  const { broker } = brokerFixture({
    onCommittedCommand(value) {
      observed.push(value);
      throw new Error("observer diagnostic failed");
    },
  });
  const result = await broker.commit(7, { sessionId: "core-1", command: command() });
  assert.equal(result.revision, 18);
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0], {
    sessionId: "core-1",
    baseRevision: 17,
    revision: 18,
    command: command(),
  });
});

test("a durable command retires main-only cleanup even when its renderer disappears before delivery", async () => {
  let trustChecks = 0;
  const observed = [];
  const { broker } = brokerFixture({
    isTrustedRendererOwner: () => {
      trustChecks += 1;
      return trustChecks === 1;
    },
    onCommittedCommand(value) { observed.push(value); },
  });
  await assert.rejects(
    broker.commit(7, { sessionId: "core-1", command: command() }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_RENDERER_UNTRUSTED",
  );
  assert.equal(trustChecks, 2);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].revision, 18);
});

test("identical lost-response retry derives the same durable command ID", async () => {
  const ids = [];
  const { broker, setSnapshot } = brokerFixture({
    commit: async (request) => {
      ids.push(request.commandId);
      return commandResult(request);
    },
  });
  const request = { sessionId: "core-1", command: command() };
  const first = await broker.commit(7, request);
  setSnapshot(snapshot(18));
  const replay = await broker.commit(7, request);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.deepEqual(replay, first);
});

test("queued future revision remains owned by the runtime FIFO", async () => {
  const { broker, calls } = brokerFixture({
    commit: async (request) => commandResult(request),
  });
  await assert.doesNotReject(broker.commit(7, {
    sessionId: "core-1",
    command: command(18),
  }));
  assert.equal(calls[0].baseRevision, 18);
});

test("untrusted, stale, malformed and oversized requests fail before runtime mutation", async (t) => {
  const { broker, calls } = brokerFixture();
  await t.test("untrusted renderer", async () => {
    await assert.rejects(
      broker.commit(8, { sessionId: "core-1", command: command() }),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_RENDERER_UNTRUSTED",
    );
  });
  await t.test("stale base revision", async () => {
    await assert.rejects(
      broker.commit(7, { sessionId: "core-1", command: command(15) }),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_REVISION_MISMATCH",
    );
  });
  await t.test("unknown key", async () => {
    await assert.rejects(
      broker.commit(7, { sessionId: "core-1", command: { ...command(), unknown: [] } }),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_REQUEST_INVALID",
    );
  });
  await t.test("oversized payload", async () => {
    const oversized = command(17, {
      topLevelChanges: [{ key: "tray", value: "x".repeat(1_750_000) }],
    });
    await assert.rejects(
      broker.commit(7, { sessionId: "core-1", command: oversized }),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_REQUEST_TOO_LARGE",
    );
  });
  assert.equal(calls.length, 0);
});

test("session drift and a non-contiguous or unsettled receipt fail closed", async (t) => {
  await t.test("session mismatch", async () => {
    const { broker, calls } = brokerFixture({ snapshot: snapshot(17, { sessionId: "core-other" }) });
    await assert.rejects(
      broker.commit(7, { sessionId: "core-1", command: command() }),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_UNAVAILABLE",
    );
    assert.equal(calls.length, 0);
  });
  for (const receipt of [
    commandResult({ baseRevision: 17 }, { revision: 19 }),
    commandResult({ baseRevision: 17 }, { inFlight: true }),
  ]) {
    await t.test(`bad receipt ${receipt.revision}/${receipt.inFlight}`, async () => {
      const { broker } = brokerFixture({ commit: async () => receipt });
      await assert.rejects(
        broker.commit(7, { sessionId: "core-1", command: command() }),
        (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
      );
    });
  }
  for (const [label, receipt] of [
    ["unordered entity IDs", commandResult({ baseRevision: 17 }, {
      changedEntityIds: ["entity-z", "entity-a"],
    })],
    ["duplicate belt IDs", commandResult({ baseRevision: 17 }, {
      changedBeltIds: ["belt-a", "belt-a"],
    })],
    ["invalid topology flag", commandResult({ baseRevision: 17 }, {
      topologyDirty: "renderer-says-dirty",
    })],
  ]) {
    await t.test(label, async () => {
      const { broker } = brokerFixture({ commit: async () => receipt });
      await assert.rejects(
        broker.commit(7, { sessionId: "core-1", command: command() }),
        (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
      );
    });
  }
});

test("routing remains captured after the authority runtime becomes uncertain", () => {
  const { broker } = brokerFixture({ snapshot: snapshot(18, { phase: "uncertain" }) });
  assert.equal(broker.ownsSession("core-1"), true);
  assert.equal(broker.ownsSession("core-other"), false);
});

test("desktop command IPC routes a captured authority session through the main-only broker", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  assert.match(main, /new NativePlayerAuthorityCommandBroker\(\{[\s\S]*?runtime:\s*nativePlayerAuthorityRuntime/);
  assert.match(main, /nativePlayerAuthorityCommandBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityCommandBroker\.commit\(ownerId, request\)/);
  assert.match(main, /const ownerId = requireTrustedNativeSender\(event\);[\s\S]*?nativePlayerAuthorityCommandBroker/);
  assert.doesNotMatch(readFileSync("desktop/preload.cjs", "utf8"), /playerAuthorityCommandBroker|main-player-authority/);
});
