"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { installBackgroundSmokePolicy } = require("./background-smoke-policy.cjs");

function fixture() {
  const calls = [];
  const app = new EventEmitter();
  app.focus = () => calls.push("app.focus");
  const dialog = Object.fromEntries(["showErrorBox", "showMessageBox", "showMessageBoxSync", "showOpenDialog", "showSaveDialog", "showOpenDialogSync", "showSaveDialogSync"].map(name => [name, () => calls.push(name)]));
  const identity = { editionId: "windows-performance-development-v1", smokeIsolated: true };
  return { app, dialog, identity, calls, environment: { DSP_PERFORMANCE_SMOKE_BACKGROUND: "1" } };
}
function windowFixture(calls, visible = false) {
  const window = new EventEmitter();
  window.isVisible = () => visible;
  for (const name of ["hide", "blur", "setFocusable", "setSkipTaskbar", "show", "showInactive", "focus", "restore", "maximize", "moveTop", "setFullScreen", "flashFrame"]) {
    window[name] = (...args) => calls.push([name, ...args]);
  }
  window.webContents = { setBackgroundThrottling: (value) => calls.push(["throttle", value]), setAudioMuted: (value) => calls.push(["mute", value]) };
  return window;
}
test("normal launches do not mutate app, dialog or window behavior", () => {
  for (const environment of [{}, { DSP_PERFORMANCE_SMOKE_BACKGROUND: "0" }]) {
    const f = fixture(); const focus = f.app.focus; const dialogs = { ...f.dialog };
    assert.equal(installBackgroundSmokePolicy({ ...f, environment }), null);
    assert.equal(f.app.focus, focus); assert.deepEqual(f.dialog, dialogs);
    assert.equal(f.app.listenerCount("browser-window-created"), 0);
  }
});
test("background cannot activate outside the verified performance profile", () => {
  for (const identity of [null, { editionId: "windows-performance-development-v1" }, { editionId: "stable", smokeIsolated: true }]) {
    const f = fixture(); assert.throws(() => installBackgroundSmokePolicy({ ...f, identity }), /verified isolated/);
    assert.equal(f.app.listenerCount("browser-window-created"), 0);
  }
  assert.throws(() => installBackgroundSmokePolicy({ ...fixture(), environment: { DSP_PERFORMANCE_SMOKE_BACKGROUND: "true" } }), /verified isolated/);
});
test("all reveal/focus methods are suppressed while hidden rendering stays scheduled", () => {
  const f = fixture(); const audit = installBackgroundSmokePolicy(f); const window = windowFixture(f.calls);
  f.app.emit("browser-window-created", {}, window);
  assert.deepEqual(f.calls, [["setFocusable", false], ["setSkipTaskbar", true], ["mute", true], ["throttle", false]]);
  f.calls.length = 0;
  for (const name of ["show", "showInactive", "focus", "restore", "maximize", "moveTop", "setFullScreen", "flashFrame"]) window[name](true);
  f.app.focus();
  assert.deepEqual(f.calls, []); assert.equal(Object.keys(audit.blocked).length, 9);
  assert.equal(audit.windowsCreated, 1); assert.equal(audit.initiallyVisible, 0);
  assert.equal(audit.showEvents, 0); assert.equal(audit.focusEvents, 0);
});
test("unexpected visibility and focus are evidence of failure, never erased by emergency hiding", () => {
  const f = fixture(); const audit = installBackgroundSmokePolicy(f); const window = windowFixture(f.calls, true);
  f.app.emit("browser-window-created", {}, window); window.emit("show"); window.emit("focus");
  assert.equal(audit.initiallyVisible, 1); assert.equal(audit.showEvents, 1); assert.equal(audit.focusEvents, 1);
  assert.equal(f.calls.filter(row => row[0] === "hide").length, 2);
  assert.ok(f.calls.some(row => row[0] === "blur"));
});
test("native dialogs cancel or report silently without storing private text", async () => {
  const f = fixture(); const audit = installBackgroundSmokePolicy(f);
  assert.equal(f.dialog.showErrorBox("private", "payload"), undefined);
  assert.equal(f.dialog.showMessageBoxSync({ message: "private", defaultId: 0 }), -1);
  assert.deepEqual(await f.dialog.showMessageBox({ message: "private", defaultId: 0 }), { response: -1, checkboxChecked: false });
  assert.deepEqual(await f.dialog.showOpenDialog({}), { canceled: true, filePaths: [] });
  assert.deepEqual(await f.dialog.showSaveDialog({}), { canceled: true, filePath: undefined });
  assert.equal(f.dialog.showOpenDialogSync({}), undefined); assert.equal(f.dialog.showSaveDialogSync({}), undefined);
  assert.deepEqual(f.calls, []); assert.equal(Object.keys(audit.dialogs).length, 7);
  assert.ok(!JSON.stringify(audit).includes("private"));
});
test("actual main initializes background policy after verified identity and starts every window hidden", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const identityStart = main.indexOf("const desktopRuntimeIdentity = initializeDesktopEditionIdentity(");
  const policyStart = main.indexOf('require("./background-smoke-policy.cjs").installBackgroundSmokePolicy(');
  assert.ok(policyStart > identityStart);
  const policyEnd = main.indexOf(";", policyStart) + 1;
  let received;
  vm.runInNewContext(main.slice(policyStart, policyEnd), {
    require: () => ({ installBackgroundSmokePolicy: input => { received = input; } }),
    app: "app", dialog: "dialog", desktopRuntimeIdentity: "verified",
  });
  assert.equal(received.identity, "verified"); assert.equal(received.app, "app");
  const options = main.slice(main.indexOf("const window = new BrowserWindow({"), main.indexOf("mainWindow = window;"));
  assert.match(options, /show: false/);
});
