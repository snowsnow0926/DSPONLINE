"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("main binds persistent projection subscriptions to the authority broker", () => {
  const main = read("main.cjs");
  assert.match(main, /ipcMain\.on\("desktop:native-core-projection-subscribe"/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\.sessionId\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\.read\(\s*rendererOwnerId,/);
  assert.match(main, /normalizeRendererNativeResult\(normalizer\[0\], raw, normalizer\[1\]\(normalizedRequest\)\)/);
  assert.doesNotMatch(main, /nativeCoreSessions\.(?:readViewport|readStatistics).*projection-subscribe/);
});

test("preload owns subscription identity, validates frames and exposes no raw port", () => {
  const preload = read("preload.cjs");
  assert.match(preload, /subscriptionId = `projection-\$\{randomUUID\(\)\}`/);
  assert.match(preload, /createHash\("sha256"\)[\s\S]*?checksum !== header\.sha256/);
  assert.match(preload, /payload\.byteLength !== header\.payloadLength/);
  assert.match(preload, /desktop:native-core-projection-subscribe"[\s\S]*?subscriptionId,[\s\S]*?sessionId:\s*request\.sessionId/);
  assert.match(preload, /subscribeNativeCoreProjection,/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^]*MessageChannelMain/);
});

test("host transfer allowlist includes the operations workspace without broad wildcards", () => {
  const host = read("native-host.cjs");
  assert.match(host, /"operations-workspace-v1"/);
  assert.doesNotMatch(host, /projectionType\.startsWith/);
});
