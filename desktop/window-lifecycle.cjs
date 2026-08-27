function registerWindowClosedCleanup(window, cleanup) {
  // Capture renderer ownership while Electron still guarantees webContents is
  // alive. Reading it from a `closed` callback races BrowserWindow teardown
  // and can throw "Object has been destroyed" during an ordinary app exit.
  const ownerId = window.webContents.id;
  window.on("closed", () => {
    cleanup.abortNativeSaveOwner(ownerId);
    cleanup.closeNativeCoreOwner(ownerId);
    cleanup.cancelApiRequests();
    cleanup.cancelAccountArchiveDownloads();
    cleanup.clearWindow(window);
  });
  return ownerId;
}

module.exports = { registerWindowClosedCleanup };
