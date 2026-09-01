"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("durable restart is main-owned, revision fenced and never enables a JavaScript mirror", () => {
  const main = read("desktop/main.cjs");
  const preload = read("desktop/preload.cjs");
  const app = read("src/App.tsx");
  assert.match(main, /desktop:native-player-authority-restart-from-durable/);
  assert.match(main, /nativePlayerAuthorityRuntime\.prepareDurableRestart\(\)/);
  assert.match(main, /summary\.revision < proof\.minimumRevision/);
  assert.match(main, /app\.relaunch\(\);\s*app\.quit\(\)/);
  assert.match(preload, /restartNativePlayerAuthorityFromDurable/);
  assert.match(app, /不会读取旧 JavaScript 镜像/);
  assert.doesNotMatch(main, /restart-from-durable[\s\S]{0,1000}transferOwner/);
  assert.doesNotMatch(preload, /restartNativePlayerAuthorityFromDurable:[\s\S]{0,300}(?:sessionId|runId|checkpoint)/);
});

test("the recovery action is visible only for terminal or uncertain authority phases", () => {
  const app = read("src/App.tsx");
  assert.match(app, /\["uncertain", "pause-uncertain", "resume-uncertain", "faulted"\]/);
  assert.match(app, /\["macro-uncertain", "faulted"\]/);
  assert.match(app, /data-native-authority-durable-restart/);
  assert.match(app, /restartNativeAuthorityFromDurable/);
});
