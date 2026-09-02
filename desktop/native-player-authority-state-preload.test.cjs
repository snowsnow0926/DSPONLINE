"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

test("preload exposes bounded clock reads plus intent-only pause control", () => {
  const preload = readFileSync("desktop/preload.cjs", "utf8");
  const desktopTypes = readFileSync("src/desktop.ts", "utf8");
  const subscribeStart = preload.indexOf("function subscribeNativePlayerAuthorityState");
  const subscribeEnd = preload.indexOf("function requestNativeCoreProjectionTransfer", subscribeStart);
  const subscription = preload.slice(subscribeStart, subscribeEnd);

  assert.ok(subscribeStart >= 0 && subscribeEnd > subscribeStart);
  assert.match(preload, /getNativePlayerAuthorityState:\s*\(\) => invokeNative\("desktop:native-player-authority-state"/);
  assert.match(preload, /onNativePlayerAuthorityState:\s*subscribeNativePlayerAuthorityState/);
  const pauseStart = preload.indexOf("setNativePlayerAuthorityPaused:");
  const pauseEnd = preload.indexOf("onNativePlayerAuthorityHandoffRequest:", pauseStart);
  const pauseSurface = preload.slice(pauseStart, pauseEnd);
  assert.ok(pauseStart >= 0 && pauseEnd > pauseStart);
  assert.match(pauseSurface, /desktop:native-player-authority-set-paused/);
  assert.match(pauseSurface, /request/);
  assert.doesNotMatch(pauseSurface, /sessionId|runId|revision|deadline|command|checkpoint|ownerId/);
  assert.match(subscription, /ipcRenderer\.on\("desktop:native-player-authority-state-changed", handler\)/);
  assert.match(subscription, /ipcRenderer\.removeListener\("desktop:native-player-authority-state-changed", handler\)/);
  assert.doesNotMatch(subscription, /removeAllListeners|\.send\(|\.postMessage\(|\.invoke\(/);
  assert.doesNotMatch(preload, /activateNativePlayerAuthority\b|commitNativePlayerAuthority\b|retryNativePlayerAuthority\b|shutdownNativePlayerAuthority\b/);
  assert.match(preload, /reconcileNativeCoreCommand:\s*\(request\) => invokeNative\("desktop:native-core-reconcile-command"/);

  assert.match(desktopTypes, /getNativePlayerAuthorityState\?:\s*\(\) => Promise<DesktopNativePlayerAuthorityState>/);
  assert.match(desktopTypes, /reconcileNativeCoreCommand\?:[\s\S]*?Promise<DesktopNativeCoreCommandReconciliationResult>/);
  assert.match(desktopTypes, /onNativePlayerAuthorityState\?:[\s\S]*?\) => \(\) => void/);
  assert.match(desktopTypes, /setNativePlayerAuthorityPaused\?:[\s\S]*?request:\s*\{ readonly paused: boolean \}[\s\S]*?Promise<DesktopNativePlayerAuthorityClockState>/);
  assert.match(desktopTypes, /interface DesktopNativePlayerAuthorityClockState[\s\S]*?schemaVersion:\s*1[\s\S]*?lastErrorCode:\s*string \| null/);
  assert.match(desktopTypes, /interface DesktopNativePlayerAuthorityMacroState[\s\S]*?schemaVersion:\s*2[\s\S]*?statusKind:\s*"macro"[\s\S]*?pausedReason:\s*DesktopNativePlayerAuthorityMacroPausedReason/);
  assert.match(desktopTypes, /type DesktopNativePlayerAuthorityState\s*=\s*\| DesktopNativePlayerAuthorityClockState\s*\| DesktopNativePlayerAuthorityMacroState/);
});
