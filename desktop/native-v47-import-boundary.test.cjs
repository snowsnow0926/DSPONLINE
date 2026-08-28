const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("renderer-facing v47 import exposes no path or byte payload", () => {
  const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const host = fs.readFileSync(path.join(__dirname, "native-host.cjs"), "utf8");
  const lifecycle = fs.readFileSync(path.join(__dirname, "window-lifecycle.cjs"), "utf8");
  assert.match(preload, /importNativeCoreV47:\s*\(request\)\s*=>\s*invokeNative\("desktop:native-core-import-v47"[\s\S]*?request\)/);
  assert.match(preload, /function invokeNative[\s\S]*?createRendererNativeRejection\(error, options\)/);
  assert.match(main, /dialog\.showOpenDialog\(mainWindow,[\s\S]*?"openFile"[\s\S]*?nativeCoreSessions\.importV47\(ownerId, request, sourcePath\)/);
  assert.match(main, /finishCommittedNativeV47Import\([\s\S]*?closeSession:\s*\(\)\s*=>\s*nativeCoreSessions\.close\(ownerId, imported\.sessionId\)/);
  assert.match(main, /runRendererNativeOperation\("coreImport"/);
  assert.match(lifecycle, /cancelled:\s*false,[\s\S]*?committed:\s*true/);
  assert.match(lifecycle, /await closeSession\(\)[\s\S]*?sessionId:\s*null/);
  assert.doesNotMatch(main, /request\??\.sourcePath/);
  assert.match(main, /MAX_NATIVE_V47_IMPORT_BYTES\s*=\s*256 \* 1024 \* 1024/);
  assert.match(host, /exactObjectKeys\(value, \["registryFingerprint", "catalog"\]/);
  assert.match(host, /operation:\s*"coreImportV47",\s*sourcePath,/);
});

test("Rust host advertises import only beside the bounded parser and direct-file guard", () => {
  const main = fs.readFileSync(path.join(root, "native", "dsp-native-host", "src", "main.rs"), "utf8");
  const parser = fs.readFileSync(path.join(root, "native", "dsp-native-core", "src", "v47_import.rs"), "utf8");
  const fileGuard = fs.readFileSync(path.join(root, "native", "dsp-native-host", "src", "v47_import.rs"), "utf8");
  assert.match(main, /"native-core-v47-stream-import-v1"/);
  assert.match(main, /open_v47_import_source/);
  assert.match(parser, /MAX_V47_IMPORT_BYTES:\s*u64\s*=\s*256 \* 1024 \* 1024/);
  assert.match(parser, /parse_v47_envelope/);
  assert.match(fileGuard, /symlink_metadata/);
  assert.match(fileGuard, /FILE_FLAG_OPEN_REPARSE_POINT/);
  assert.match(fileGuard, /share_mode\(FILE_SHARE_READ\)/);
  assert.match(fileGuard, /GetFileInformationByHandle/);
  assert.match(fileGuard, /last_write_time/);
  assert.match(parser, /V47ImportJavascriptCompatibilityRequired/);
});
