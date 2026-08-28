"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

test("main validates the raw authority owner before delivering either state schema", () => {
  const source = readFileSync("desktop/main.cjs", "utf8");
  const validateStart = source.indexOf("function validatedNativePlayerAuthorityState");
  const publishStart = source.indexOf("function publishNativePlayerAuthorityState", validateStart);
  const helperEnd = source.indexOf("function validNativeLogicalId", publishStart);

  assert.ok(validateStart >= 0 && publishStart > validateStart && helperEnd > publishStart);
  const validateSource = source.slice(validateStart, publishStart);
  const publishSource = source.slice(publishStart, helperEnd);

  assert.match(validateSource, /nativePlayerAuthorityRuntime\.snapshot\(\)/);
  assert.match(validateSource, /authoritySnapshot\?\.sessionId/);
  assert.match(validateSource, /inspectSession\("main-player-authority", authoritySessionId\)/);
  assert.match(validateSource, /nativePlayerAuthorityStateBroker\.read\(rendererOwnerId\)/);
  assert.match(validateSource, /normalizeRendererNativeResult\("playerAuthorityState", state\)/);
  assert.doesNotMatch(validateSource, /state\.sessionId/);

  assert.match(publishSource, /validatedNativePlayerAuthorityState\(mainWindow\.webContents\.id\)/);
  assert.match(publishSource, /webContents\.send\("desktop:native-player-authority-state-changed", state\)/);
  assert.doesNotMatch(publishSource, /normalizeNativePlayerAuthorityState|snapshot\.sessionId|state\.sessionId/);
});

test("main never imports the raw state normalizer into the renderer delivery path", () => {
  const source = readFileSync("desktop/main.cjs", "utf8");
  assert.doesNotMatch(source, /\bnormalizeNativePlayerAuthorityState\b/);
});
