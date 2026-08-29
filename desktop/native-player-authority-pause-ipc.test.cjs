"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

test("renderer pause surface carries only intent and main owns the durable clock", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  const preload = readFileSync("desktop/preload.cjs", "utf8");
  const app = readFileSync("src/App.tsx", "utf8");
  const handlerStart = main.indexOf('ipcMain.handle("desktop:native-player-authority-set-paused"');
  const handlerEnd = main.indexOf('ipcMain.handle("desktop:native-player-authority-macro-start"', handlerStart);
  const handler = main.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.match(handler, /Reflect\.ownKeys\(request\)\.length !== 1/);
  assert.match(handler, /Object\.hasOwn\(request, "paused"\)/);
  assert.match(handler, /typeof request\.paused !== "boolean"/);
  assert.match(handler, /nativePlayerAuthorityRuntime\.setPaused\(request\.paused\)/);
  assert.match(handler, /validatedNativePlayerAuthorityState\(rendererOwnerId\)/);
  assert.doesNotMatch(handler, /request\.(?:sessionId|runId|revision|settledDeadlineMs|checkpoint|command)/);

  const preloadStart = preload.indexOf("setNativePlayerAuthorityPaused:");
  const preloadEnd = preload.indexOf("onNativePlayerAuthorityHandoffRequest:", preloadStart);
  const surface = preload.slice(preloadStart, preloadEnd);
  assert.match(surface, /desktop:native-player-authority-set-paused/);
  assert.doesNotMatch(surface, /sessionId|runId|revision|settledDeadlineMs|checkpoint|command/);

  const toggleStart = app.indexOf("const togglePause = useCallback");
  const toggleEnd = app.indexOf("const handleTimeWarpEnabledChange", toggleStart);
  const toggle = app.slice(toggleStart, toggleEnd);
  const nativeToggle = toggle.slice(0, toggle.indexOf("if (gameRef.current.paused"));
  assert.match(toggle, /frame\.phase === "active" \|\| frame\.phase === "pause-uncertain"/);
  assert.match(toggle, /frame\.phase === "paused" \|\| frame\.phase === "resume-uncertain"/);
  assert.match(toggle, /nativePlayerAuthorityPauseInFlightRef\.current = true/);
  assert.match(toggle, /setNativePlayerAuthorityPaused\(\{ paused: targetPaused \}\)/);
  assert.match(toggle, /再次点击，程序会按同一个持久事务核对/);
  assert.match(toggle, /\.finally\(\(\) => \{[\s\S]*?nativePlayerAuthorityPauseInFlightRef\.current = false/);
  assert.doesNotMatch(nativeToggle, /setPaused\(gameRef\.current/);
});
