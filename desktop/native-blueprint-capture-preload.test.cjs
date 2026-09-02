const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function loadPreload() {
  const invocations = [];
  const transfers = [];
  let exposed = null;
  class FakeMessageChannel {
    constructor() {
      this.port1 = {
        close() {},
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
        onmessage: null,
        onmessageerror: null,
      };
      this.port2 = { kind: "fake-transfer-port" };
    }
  }
  const ipcRenderer = {
    invoke(channel, ...args) {
      invocations.push({ channel, args });
      return Promise.resolve({ ok: true });
    },
    postMessage(channel, request, ports) {
      transfers.push({ channel, request, ports });
    },
    on() {},
    removeListener() {},
    send() {},
  };
  const filename = path.join(__dirname, "preload.cjs");
  const source = fs.readFileSync(filename, "utf8");
  const sandbox = {
    Buffer,
    MessageChannel: FakeMessageChannel,
    clearTimeout() {},
    console,
    globalThis: null,
    require(specifier) {
      if (specifier === "electron") {
        return {
          contextBridge: {
            exposeInMainWorld(_name, value) { exposed = value; },
          },
          ipcRenderer,
        };
      }
      if (specifier === "node:crypto") return require("node:crypto");
      if (specifier === "./native-renderer-boundary.cjs") {
        return require(path.join(__dirname, "native-renderer-boundary.cjs"));
      }
      if (specifier === "./native-player-authority-handoff-ipc.cjs") {
        return { subscribeRendererToNativePlayerAuthorityHandoff: () => () => undefined };
      }
      throw new Error(`unexpected preload dependency: ${specifier}`);
    },
    setTimeout() { return 1; },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename });
  const toRealm = (value) => {
    sandbox.__testJson = JSON.stringify(value);
    return vm.runInContext("JSON.parse(__testJson)", context);
  };
  return { api: exposed, invocations, transfers, toRealm };
}

function request(entityIds) {
  return {
    sessionId: "session-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "registry-a",
    entityIds,
  };
}

test("capture preload rejects malformed direct requests before invoke", async () => {
  const invalid = [
    { ...request(["entity-a"]), extra: true },
    { ...request(["entity-a"]), sessionId: "session 非法" },
    { ...request(["entity-a"]), expectedRegistryFingerprint: "registry 非法" },
    request(["entity-a", "entity-a"]),
    request(["entity-\ud800"]),
    request(["x".repeat(1024 * 1024 + 1)]),
  ];
  for (const [index, value] of invalid.entries()) {
    const { api, invocations, toRealm } = loadPreload();
    assert.throws(
      () => api.getNativeCoreBlueprintCaptureContext(toRealm(value)),
      (error) => error?.name === "TypeError",
      `invalid direct request ${index} reached IPC`,
    );
    assert.equal(invocations.length, 0);
  }
});

test("capture preload rejects malformed transfer requests before MessagePort dispatch", async () => {
  const invalidRequests = [
    {
      sessionId: "session-1",
      projectionType: "blueprint-capture-context-v1",
      payload: { expectedRevision: 7, expectedRegistryFingerprint: "registry-a", entityIds: ["entity-a"], extra: 1 },
    },
    {
      sessionId: "session-1",
      projectionType: "blueprint-capture-context-v1",
      payload: { sessionId: "session-1", expectedRevision: 7, expectedRegistryFingerprint: "registry-a", entityIds: ["entity-a"] },
    },
    {
      sessionId: "session-1",
      projectionType: "blueprint-capture-context-v1",
      payload: { expectedRevision: 7, expectedRegistryFingerprint: "registry-a", entityIds: ["entity-a", "entity-a"] },
    },
    {
      sessionId: "session-1",
      projectionType: "blueprint-capture-context-v1",
      payload: { expectedRevision: 7, expectedRegistryFingerprint: "registry-a", entityIds: ["entity-\udc00"] },
    },
    {
      sessionId: "session-1",
      projectionType: "blueprint-capture-context-v1",
      payload: { expectedRevision: 7, expectedRegistryFingerprint: "registry-a", entityIds: ["x".repeat(1024 * 1024 + 1)] },
    },
    {
      sessionId: "session-1",
      projectionType: "blueprint-capture-context-v1",
      payload: { expectedRevision: 7, expectedRegistryFingerprint: "registry-a", entityIds: ["entity-a"] },
      extra: true,
    },
  ];
  for (const value of invalidRequests) {
    const { api, transfers, toRealm } = loadPreload();
    await assert.rejects(api.requestNativeCoreProjectionTransfer(toRealm(value)));
    assert.equal(transfers.length, 0);
  }
});

test("capture preload preserves the exact order of a legal 512-ID request", async () => {
  const entityIds = Array.from({ length: 512 }, (_, index) =>
    `entity_${String(index).padStart(3, "0")}_${"界".repeat(160)}`);
  const direct = loadPreload();
  await direct.api.getNativeCoreBlueprintCaptureContext(direct.toRealm(request(entityIds)));
  assert.equal(direct.invocations.length, 1);
  assert.equal(direct.invocations[0].channel, "desktop:native-core-blueprint-capture-context");
  assert.deepEqual(Array.from(direct.invocations[0].args[0].entityIds), entityIds);

  const transfer = loadPreload();
  void transfer.api.requestNativeCoreProjectionTransfer(transfer.toRealm({
    sessionId: "session-1",
    projectionType: "blueprint-capture-context-v1",
    payload: {
      expectedRevision: 7,
      expectedRegistryFingerprint: "registry-a",
      entityIds,
    },
  }));
  assert.equal(transfer.transfers.length, 1);
  assert.equal(transfer.transfers[0].channel, "desktop:native-core-projection-transfer");
  assert.deepEqual(Array.from(transfer.transfers[0].request.payload.entityIds), entityIds);
  assert.deepEqual(Reflect.ownKeys(transfer.transfers[0].request).sort(), [
    "payload",
    "projectionType",
    "sequence",
    "sessionId",
  ]);
});

test("export preload rejects malformed row bindings before direct or transfer IPC", async () => {
  const base = {
    sessionId: "session-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "registry-a",
    blueprintId: "blueprint_17",
    blueprintRevision: 1,
  };
  for (const value of [
    { ...base, extra: true },
    { ...base, sessionId: "session 非法" },
    { ...base, expectedRegistryFingerprint: "registry 非法" },
    { ...base, blueprintId: "blueprint-\ud800" },
    { ...base, blueprintRevision: 0 },
  ]) {
    const direct = loadPreload();
    assert.throws(() => direct.api.getNativeCoreBlueprintExportContext(direct.toRealm(value)));
    assert.equal(direct.invocations.length, 0);
  }
  const transfer = loadPreload();
  await assert.rejects(transfer.api.requestNativeCoreProjectionTransfer(transfer.toRealm({
    sessionId: "session-1",
    projectionType: "blueprint-export-context-v1",
    payload: { ...base, sessionId: undefined, extra: true },
  })));
  assert.equal(transfer.transfers.length, 0);
});

test("export preload admits an exact max-safe read binding and preserves it in both paths", async () => {
  const payload = {
    expectedRevision: Number.MAX_SAFE_INTEGER,
    expectedRegistryFingerprint: "registry-a",
    blueprintId: "blueprint_17",
    blueprintRevision: Number.MAX_SAFE_INTEGER,
  };
  const direct = loadPreload();
  await direct.api.getNativeCoreBlueprintExportContext(direct.toRealm({
    sessionId: "session-1",
    ...payload,
  }));
  assert.equal(direct.invocations.length, 1);
  assert.deepEqual(direct.invocations[0].args[0], direct.toRealm({ sessionId: "session-1", ...payload }));

  const transfer = loadPreload();
  void transfer.api.requestNativeCoreProjectionTransfer(transfer.toRealm({
    sessionId: "session-1",
    projectionType: "blueprint-export-context-v1",
    payload,
  }));
  assert.equal(transfer.transfers.length, 1);
  assert.equal(transfer.transfers[0].request.payload.expectedRevision, Number.MAX_SAFE_INTEGER);
  assert.equal(transfer.transfers[0].request.payload.blueprintRevision, Number.MAX_SAFE_INTEGER);
});
