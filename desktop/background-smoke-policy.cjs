"use strict";

/** Installed only after the existing identity code verified an isolated profile. */
function installBackgroundSmokePolicy({ app, dialog, identity, environment = process.env }) {
  const requested = environment.DSP_PERFORMANCE_SMOKE_BACKGROUND;
  if (requested === undefined || requested === "0") return null;
  if (requested !== "1" || identity?.smokeIsolated !== true ||
      identity.editionId !== "windows-performance-development-v1") {
    throw new Error("Background smoke requires a verified isolated performance profile");
  }
  const audit = {
    policy: "hidden-no-focus-v1", windowsCreated: 0, initiallyVisible: 0,
    showEvents: 0, focusEvents: 0, blocked: {}, dialogs: {},
  };
  const count = (collection, name) => { collection[name] = (collection[name] ?? 0) + 1; };
  app.focus = () => count(audit.blocked, "app.focus");
  app.on("browser-window-created", (_event, window) => {
    audit.windowsCreated += 1;
    // Main creates windows with show:false. An unexpectedly visible new window
    // makes the probe fail even if this emergency hide succeeds afterwards.
    if (window.isVisible()) { audit.initiallyVisible += 1; window.hide(); }
    window.setFocusable(false);
    window.setSkipTaskbar(true);
    window.webContents.setAudioMuted(true);
    // Keep the hidden renderer's scheduling equivalent to a foreground window;
    // a real probe also verifies document.visibilityState and timer progress.
    window.webContents.setBackgroundThrottling(false);
    for (const name of ["show", "showInactive", "focus", "restore", "maximize", "moveTop", "setFullScreen", "flashFrame"]) {
      window[name] = () => count(audit.blocked, `window.${name}`);
    }
    window.on("show", () => { audit.showEvents += 1; window.hide(); });
    window.on("focus", () => { audit.focusEvents += 1; window.blur(); });
  });
  // Test failures are reported in the audit rather than opening native dialogs.
  // File dialogs always cancel; no destructive/default affirmative choice is made.
  for (const name of ["showErrorBox", "showMessageBoxSync"]) {
    dialog[name] = () => { count(audit.dialogs, name); return name === "showMessageBoxSync" ? -1 : undefined; };
  }
  dialog.showMessageBox = async () => { count(audit.dialogs, "showMessageBox"); return { response: -1, checkboxChecked: false }; };
  for (const name of ["showOpenDialog", "showSaveDialog"]) {
    dialog[name] = async () => {
      count(audit.dialogs, name);
      return name === "showOpenDialog" ? { canceled: true, filePaths: [] } : { canceled: true, filePath: undefined };
    };
  }
  for (const name of ["showOpenDialogSync", "showSaveDialogSync"]) {
    dialog[name] = () => { count(audit.dialogs, name); return undefined; };
  }
  globalThis.__dspBackgroundSmokeAudit = audit;
  return audit;
}

module.exports = { installBackgroundSmokePolicy };
