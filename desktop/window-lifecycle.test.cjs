const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { registerWindowClosedCleanup } = require("./window-lifecycle.cjs");

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
