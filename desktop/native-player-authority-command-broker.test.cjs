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

test("black-hole intent crosses the host as a minimal durable command with a settled receipt", async () => {
  const blackHoleCommand = command(17, {
    changedEntities: [{
      id: "black-hole-a",
      changes: [{
        path: ["blackHolePaused", "intent"],
        operation: "set",
        value: { paused: false, confirmActivation: true },
      }],
    }],
  });
  const observed = [];
  const { broker, calls } = brokerFixture({
    onCommittedCommand(value) { observed.push(value); },
    commit: async (request) => commandResult(request, {
      changedEntityIds: ["black-hole-a"],
      changedBeltIds: [],
      topologyDirty: false,
    }),
  });

  const receipt = await broker.commit(7, { sessionId: "core-1", command: blackHoleCommand });
  assert.deepEqual(receipt, {
    previousRevision: 17,
    revision: 18,
    changedEntityIds: ["black-hole-a"],
    changedBeltIds: [],
    topologyDirty: false,
  });
  assert.deepEqual(calls[0].command, blackHoleCommand);
  assert.equal(JSON.stringify(calls[0].command).includes("blackHolePorts"), false);
  assert.equal(JSON.stringify(calls[0].command).includes("totalDestroyed"), false);
  assert.deepEqual(observed[0], {
    sessionId: "core-1",
    baseRevision: 17,
    revision: 18,
    command: blackHoleCommand,
  });
});

test("blueprint rename crosses as one opaque semantic marker and returns topology invalidation", async () => {
  const renameCommand = command(17, {
    topLevelChanges: [{
      path: ["blueprints", "intent"],
      operation: "set",
      value: { kind: "rename", id: "mod:opaque/rocket", name: "新模组蓝图🚀" },
    }],
  });
  const observed = [];
  const { broker, calls } = brokerFixture({
    onCommittedCommand(value) { observed.push(value); },
    commit: async (request) => commandResult(request, {
      changedEntityIds: [],
      changedBeltIds: [],
      topologyDirty: true,
    }),
  });

  const receipt = await broker.commit(7, { sessionId: "core-1", command: renameCommand });
  assert.deepEqual(receipt, {
    previousRevision: 17,
    revision: 18,
    changedEntityIds: [],
    changedBeltIds: [],
    topologyDirty: true,
  });
  assert.deepEqual(calls[0].command, renameCommand);
  assert.deepEqual(observed[0].command, renameCommand);
  const encoded = JSON.stringify(calls[0].command);
  assert.equal(encoded.includes('"entities":'), false);
  assert.equal(encoded.includes('"belts":'), false);
  assert.equal(encoded.includes("blueprintVersions"), false);
  assert.equal(encoded.includes("constructionQueue"), false);
  assert.equal(encoded.includes("nextId"), false);
});

test("Dyson shell planning crosses as one compact opaque intent and invalidates projections", async () => {
  const dysonCommand = command(17, {
    topLevelChanges: [{
      path: ["dysonPlans", "intent"],
      operation: "set",
      value: {
        kind: "plan-shell",
        systemId: "mod:system/Ω🚀",
        layerId: "mod:layer/alpha🚀",
      },
    }],
  });
  const observed = [];
  const { broker, calls } = brokerFixture({
    onCommittedCommand(value) { observed.push(value); },
    commit: async (request) => commandResult(request, {
      changedEntityIds: [],
      changedBeltIds: [],
      topologyDirty: true,
    }),
  });

  const receipt = await broker.commit(7, { sessionId: "core-1", command: dysonCommand });
  assert.equal(receipt.revision, 18);
  assert.equal(receipt.topologyDirty, true);
  assert.deepEqual(calls[0].command, dysonCommand);
  assert.deepEqual(observed[0].command, dysonCommand);
  const encoded = JSON.stringify(calls[0].command);
  assert.equal(encoded.includes("requiredStructurePoints"), false);
  assert.equal(encoded.includes("completedStructurePoints"), false);
  assert.equal(encoded.includes("sailCapacity"), false);
  assert.equal(encoded.includes("absorbedSails"), false);
  assert.equal(encoded.includes("nextId"), false);
  assert.ok(Buffer.byteLength(encoded, "utf8") < 512);
});

test("Dyson layer and orbit lifecycle cross only as compact Rust-owned intents", async () => {
  const commands = [
    command(17, {
      topLevelChanges: [{
        path: ["dysonPlans", "intent"],
        operation: "set",
        value: { kind: "add-standard-layer", systemId: "helios" },
      }],
    }),
    command(17, {
      topLevelChanges: [{
        path: ["dysonEngineering", "intent"],
        operation: "set",
        value: { kind: "remove-orbit", systemId: "helios", orbitId: "orbit-a" },
      }],
    }),
    command(17, {
      topLevelChanges: [{
        path: ["dysonPlans", "intent"],
        operation: "set",
        value: {
          kind: "connect-nodes",
          systemId: "helios",
          layerId: "layer-a",
          sourceNodeId: "node-a",
          targetNodeId: "node-b",
        },
      }],
    }),
  ];
  for (const expected of commands) {
    const { broker, calls } = brokerFixture({
      commit: async (request) => commandResult(request, {
        changedEntityIds: [],
        changedBeltIds: [],
        topologyDirty: true,
      }),
    });
    const receipt = await broker.commit(7, { sessionId: "core-1", command: expected });
    assert.equal(receipt.topologyDirty, true);
    assert.deepEqual(calls[0].command, expected);
    const encoded = JSON.stringify(calls[0].command);
    assert.equal(encoded.includes("sailsInOrbit"), false);
    assert.equal(encoded.includes("totalLaunched"), false);
    assert.equal(encoded.includes("requiredStructurePoints"), false);
    assert.equal(encoded.includes("nextId"), false);
    assert.ok(Buffer.byteLength(encoded, "utf8") < 512);
  }
});

test("time-warp intent and ejector target cross the host without renderer-derived state", async () => {
  const timeWarpCommand = command(17, {
    topLevelChanges: [{
      path: ["timeWarp", "intent"],
      operation: "set",
      value: { controllerEntityId: "controller-a", requestedMultiplier: 16 },
    }],
  });
  const ejectorCommand = command(17, {
    changedEntities: [{
      id: "ejector-a",
      changes: [{
        path: ["targetDysonOrbitId"],
        operation: "set",
        value: "orbit-new",
      }],
    }],
  });
  for (const expected of [timeWarpCommand, ejectorCommand]) {
    const { broker, calls } = brokerFixture({
      commit: async (request) => commandResult(request, {
        changedEntityIds: expected === ejectorCommand ? ["ejector-a"] : [],
        changedBeltIds: [],
        topologyDirty: expected === timeWarpCommand,
      }),
    });
    const receipt = await broker.commit(7, { sessionId: "core-1", command: expected });
    assert.equal(receipt.revision, 18);
    assert.deepEqual(calls[0].command, expected);
    const encoded = JSON.stringify(calls[0].command);
    assert.equal(encoded.includes("requiredPowerKw"), false);
    assert.equal(encoded.includes("effectiveMultiplier"), false);
    assert.equal(encoded.includes("orbitsBySystem"), false);
  }
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

test("lost renderer response is reconciled from the main receipt without executing again", async () => {
  let trusted = true;
  let trustChecks = 0;
  const { broker, calls, setSnapshot } = brokerFixture({
    isTrustedRendererOwner: () => {
      trustChecks += 1;
      return trusted && trustChecks !== 2;
    },
  });
  const request = { sessionId: "core-1", command: command() };
  await assert.rejects(
    broker.commit(7, request),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_RENDERER_UNTRUSTED",
  );
  trusted = true;
  setSnapshot(snapshot(18, { phase: "uncertain", lastErrorCode: "TRANSPORT_UNCERTAIN" }));
  const reconciled = broker.reconcile(7, request);
  assert.deepEqual(reconciled, {
    status: "committed",
    receipt: {
      previousRevision: 17,
      revision: 18,
      changedEntityIds: ["entity-a", "entity-z"],
      changedBeltIds: ["belt-a"],
      topologyDirty: false,
    },
  });
  assert.equal(calls.length, 1, "receipt reconciliation must not call commitCommand again");
});

test("read-only reconciliation distinguishes pending, definitely absent and conflicting clocks", async () => {
  let release;
  const pendingResult = new Promise((resolve) => { release = resolve; });
  const pendingFixture = brokerFixture({ commit: () => pendingResult });
  const request = { sessionId: "core-1", command: command() };
  const commit = pendingFixture.broker.commit(7, request);
  await Promise.resolve();
  assert.deepEqual(pendingFixture.broker.reconcile(7, request), {
    status: "pending",
    baseRevision: 17,
    currentRevision: 17,
  });
  assert.equal(pendingFixture.calls.length, 1);
  release(commandResult({ baseRevision: 17 }));
  await commit;

  const absent = brokerFixture();
  assert.deepEqual(absent.broker.reconcile(7, request), {
    status: "not-committed",
    baseRevision: 17,
    currentRevision: 17,
  });
  assert.equal(absent.calls.length, 0);

  const conflict = brokerFixture({ snapshot: snapshot(19) });
  assert.deepEqual(conflict.broker.reconcile(7, request), {
    status: "conflict",
    baseRevision: 17,
    currentRevision: 19,
  });
  assert.equal(conflict.calls.length, 0);

  const unsettled = brokerFixture({
    snapshot: snapshot(17, { phase: "uncertain", lastErrorCode: "TRANSPORT_UNCERTAIN" }),
  });
  assert.deepEqual(unsettled.broker.reconcile(7, request), {
    status: "pending",
    baseRevision: 17,
    currentRevision: 17,
  });
  assert.equal(unsettled.calls.length, 0);
});

test("read-only reconciliation retains only the latest 64 bounded receipts", async () => {
  const { broker, calls } = brokerFixture();
  const requests = [];
  for (let baseRevision = 17; baseRevision < 82; baseRevision += 1) {
    const request = { sessionId: "core-1", command: command(baseRevision) };
    requests.push(request);
    await broker.commit(7, request);
  }
  assert.equal(calls.length, 65);
  assert.deepEqual(broker.reconcile(7, requests[0]), {
    status: "conflict",
    baseRevision: 17,
    currentRevision: 82,
  });
  assert.deepEqual(broker.reconcile(7, requests.at(-1)), {
    status: "committed",
    receipt: {
      previousRevision: 81,
      revision: 82,
      changedEntityIds: ["entity-a", "entity-z"],
      changedBeltIds: ["belt-a"],
      topologyDirty: false,
    },
  });
});

test("untrusted or malformed reconciliation never reaches the runtime command path", () => {
  const { broker, calls } = brokerFixture();
  assert.throws(
    () => broker.reconcile(8, { sessionId: "core-1", command: command() }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_RENDERER_UNTRUSTED",
  );
  assert.throws(
    () => broker.reconcile(7, { sessionId: "core-1", command: { ...command(), extra: true } }),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_COMMAND_REQUEST_INVALID",
  );
  assert.equal(calls.length, 0);
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
  await t.test("pause lifecycle uses only the dedicated main-owned path", async () => {
    await assert.rejects(
      broker.commit(7, {
        sessionId: "core-1",
        command: command(17, {
          topLevelChanges: [{ path: ["paused"], operation: "set", value: true }],
        }),
      }),
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
  const preload = readFileSync("desktop/preload.cjs", "utf8");
  assert.match(main, /new NativePlayerAuthorityCommandBroker\(\{[\s\S]*?runtime:\s*nativePlayerAuthorityRuntime/);
  assert.match(main, /nativePlayerAuthorityCommandBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityCommandBroker\.commit\(ownerId, request\)/);
  assert.match(main, /const ownerId = requireTrustedNativeSender\(event\);[\s\S]*?nativePlayerAuthorityCommandBroker/);
  assert.match(main, /desktop:native-core-reconcile-command[\s\S]*?nativePlayerAuthorityCommandBroker\.reconcile\(ownerId, request\)/);
  assert.match(preload, /reconcileNativeCoreCommand:[\s\S]*?desktop:native-core-reconcile-command/);
  assert.doesNotMatch(preload, /playerAuthorityCommandBroker|main-player-authority/);
});
