"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

test("preload exposes only pull/subscribe access to the bounded authority clock", () => {
  const preload = readFileSync("desktop/preload.cjs", "utf8");
  const desktopTypes = readFileSync("src/desktop.ts", "utf8");
  const subscribeStart = preload.indexOf("function subscribeNativePlayerAuthorityState");
  const subscribeEnd = preload.indexOf("function requestNativeCoreProjectionTransfer", subscribeStart);
  const subscription = preload.slice(subscribeStart, subscribeEnd);

  assert.ok(subscribeStart >= 0 && subscribeEnd > subscribeStart);
  assert.match(preload, /getNativePlayerAuthorityState:\s*\(\) => invokeNative\("desktop:native-player-authority-state"/);
  assert.match(preload, /onNativePlayerAuthorityState:\s*subscribeNativePlayerAuthorityState/);
  assert.match(subscription, /ipcRenderer\.on\("desktop:native-player-authority-state-changed", handler\)/);
  assert.match(subscription, /ipcRenderer\.removeListener\("desktop:native-player-authority-state-changed", handler\)/);
  assert.doesNotMatch(subscription, /removeAllListeners|\.send\(|\.postMessage\(|\.invoke\(/);
  assert.doesNotMatch(preload, /activateNativePlayerAuthority|commitNativePlayerAuthority|retryNativePlayerAuthority|shutdownNativePlayerAuthority/);

  assert.match(desktopTypes, /getNativePlayerAuthorityState\?:\s*\(\) => Promise<DesktopNativePlayerAuthorityState>/);
  assert.match(desktopTypes, /onNativePlayerAuthorityState\?:[\s\S]*?\) => \(\) => void/);
  assert.match(desktopTypes, /interface DesktopNativePlayerAuthorityState[\s\S]*?schemaVersion:\s*1[\s\S]*?lastErrorCode:\s*string \| null/);
});
