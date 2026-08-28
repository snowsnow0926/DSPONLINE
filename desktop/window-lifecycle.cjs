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

async function finishCommittedNativeV47Import({
  imported,
  fileName,
  ownerStillTrusted,
  closeSession,
}) {
  const committedResult = {
    sessionId: imported.sessionId,
    authority: imported.authority,
    checkpoint: imported.checkpoint,
    import: imported.import,
    summary: imported.summary,
    cancelled: false,
    committed: true,
    fileName,
  };
  if (ownerStillTrusted) {
    return {
      ...committedResult,
      ownerClosed: false,
      sessionClosed: false,
    };
  }

  // The durable checkpoint is already public at this point, so renderer
  // teardown is no longer cancellation. The session is best-effort closed;
  // NativeCoreSessionRegistry removes local ownership before awaiting the host
  // close response, which also makes a lost host ACK leak-safe.
  let sessionClosed = false;
  try {
    await closeSession();
    sessionClosed = true;
  } catch {
    // Window-level closeOwner may have won the race, or the Host may have gone
    // away after committing. Neither outcome can roll back the checkpoint.
  }
  return {
    ...committedResult,
    sessionId: null,
    ownerClosed: true,
    sessionClosed,
  };
}

module.exports = { finishCommittedNativeV47Import, registerWindowClosedCleanup };
