const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  finishCommittedNativeV47Import,
  registerWindowClosedCleanup,
} = require("./window-lifecycle.cjs");

test("captures renderer ownership before BrowserWindow destruction", () => {
  const window = new EventEmitter();
  let destroyed = false;
  let webContentsReads = 0;
  Object.defineProperty(window, "webContents", {
    get() {
      webContentsReads += 1;
      if (destroyed) throw new TypeError("Object has been destroyed");
      return { id: 4318 };
    },
  });
  const calls = [];
  registerWindowClosedCleanup(window, {
    abortNativeSaveOwner: (ownerId) => calls.push(["save", ownerId]),
    closeNativeCoreOwner: (ownerId) => calls.push(["core", ownerId]),
    cancelApiRequests: () => calls.push(["api"]),
    cancelAccountArchiveDownloads: () => calls.push(["archive"]),
    clearWindow: (closedWindow) => calls.push(["clear", closedWindow === window]),
  });

  destroyed = true;
  assert.doesNotThrow(() => window.emit("closed"));
  assert.equal(webContentsReads, 1);
  assert.deepEqual(calls, [
    ["save", 4318],
    ["core", 4318],
    ["api"],
    ["archive"],
    ["clear", true],
  ]);
});

test("a published native v47 checkpoint is never reported as cancelled", async (t) => {
  const imported = {
    sessionId: "core-7",
    authority: "shadow",
    checkpoint: { generation: 3, rootHash: "a".repeat(64), revision: 2 },
    import: { sourceSha256: "b".repeat(64) },
    summary: { revision: 2 },
    sourcePath: "C:\\Users\\Player\\private-save.json",
    stderr: "private Host stderr",
  };

  await t.test("keeps the live owner's session", async () => {
    let closeCalls = 0;
    const result = await finishCommittedNativeV47Import({
      imported,
      fileName: "save.json",
      ownerStillTrusted: true,
      closeSession: async () => { closeCalls += 1; },
    });
    assert.equal(result.cancelled, false);
    assert.equal(result.committed, true);
    assert.equal(result.sessionId, "core-7");
    assert.equal(result.ownerClosed, false);
    assert.equal(result.sessionClosed, false);
    assert.equal(closeCalls, 0);
    assert.equal(Object.hasOwn(result, "sourcePath"), false);
    assert.equal(Object.hasOwn(result, "stderr"), false);
  });

  await t.test("closes a session whose renderer disappeared after publication", async () => {
    let closeCalls = 0;
    const result = await finishCommittedNativeV47Import({
      imported,
      fileName: "save.json",
      ownerStillTrusted: false,
      closeSession: async () => { closeCalls += 1; },
    });
    assert.equal(result.cancelled, false);
    assert.equal(result.committed, true);
    assert.equal(result.sessionId, null);
    assert.equal(result.ownerClosed, true);
    assert.equal(result.sessionClosed, true);
    assert.equal(closeCalls, 1);
  });

  await t.test("keeps committed semantics when the Host close ACK is lost", async () => {
    const result = await finishCommittedNativeV47Import({
      imported,
      fileName: "save.json",
      ownerStillTrusted: false,
      closeSession: async () => { throw new Error("host exited after commit"); },
    });
    assert.equal(result.cancelled, false);
    assert.equal(result.committed, true);
    assert.equal(result.sessionId, null);
    assert.equal(result.ownerClosed, true);
    assert.equal(result.sessionClosed, false);
  });
});
