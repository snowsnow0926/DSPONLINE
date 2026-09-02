const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function loadPreload() {
  const invocations = [];
  let exposed = null;
  const filename = path.join(__dirname, "preload.cjs");
  const source = fs.readFileSync(filename, "utf8");
  const sandbox = {
    Buffer,
    MessageChannel: class {},
    clearTimeout() {},
    console,
    globalThis: null,
    require(specifier) {
      if (specifier === "electron") {
        return {
          contextBridge: { exposeInMainWorld(_name, value) { exposed = value; } },
          ipcRenderer: {
            invoke(channel, ...args) {
              invocations.push({ channel, args });
              return Promise.resolve({ ok: true });
            },
            on() {}, removeListener() {}, send() {}, postMessage() {},
          },
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
  return { api: exposed, invocations, toRealm };
}

const projectionRequest = {
  sessionId: "session-1",
  runId: "run-1",
  expectedRevision: 7,
  expectedRegistryFingerprint: "registry-a",
};

const settingRequest = {
  expectedSessionId: "session-1",
  expectedRunId: "run-1",
  expectedRevision: 7,
  expectedRegistryFingerprint: "registry-a",
  intent: { type: "set-production-buffer-limit", value: 4000 },
};

test("operations projection preload accepts only the exact authority binding", async () => {
  const valid = loadPreload();
  await valid.api.getNativeCoreOperationsWorkspaceProjection(valid.toRealm(projectionRequest));
  assert.equal(valid.invocations.length, 1);
  assert.equal(valid.invocations[0].channel, "desktop:native-core-operations-workspace-projection");
  assert.deepEqual(valid.invocations[0].args[0], valid.toRealm(projectionRequest));

  for (const request of [
    { ...projectionRequest, extra: true },
    { ...projectionRequest, expectedRevision: Number.MAX_SAFE_INTEGER },
    { ...projectionRequest, runId: "run 非法" },
  ]) {
    const invalid = loadPreload();
    assert.throws(
      () => invalid.api.getNativeCoreOperationsWorkspaceProjection(invalid.toRealm(request)),
      (error) => error?.name === "TypeError",
    );
    assert.equal(invalid.invocations.length, 0);
  }
});

test("operations intent preload rejects outer and nested extra keys before IPC", async () => {
  const valid = loadPreload();
  await valid.api.commitNativeOperationsSettingIntent(valid.toRealm(settingRequest));
  assert.equal(valid.invocations.length, 1);
  assert.equal(valid.invocations[0].channel, "desktop:native-player-authority-operations-setting-intent");
  assert.deepEqual(valid.invocations[0].args[0], valid.toRealm(settingRequest));

  for (const request of [
    { ...settingRequest, command: { topLevelChanges: [] } },
    { ...settingRequest, intent: { ...settingRequest.intent, extra: true } },
    { ...settingRequest, intent: { type: "set-resource-mode", value: "finite" } },
    { ...settingRequest, intent: { type: "set-simulation-speed", value: 3 } },
    { ...settingRequest, intent: { type: "set-production-buffer-limit", value: 999 } },
  ]) {
    const invalid = loadPreload();
    assert.throws(
      () => invalid.api.commitNativeOperationsSettingIntent(invalid.toRealm(request)),
      (error) => error?.name === "TypeError",
    );
    assert.equal(invalid.invocations.length, 0);
  }
});
