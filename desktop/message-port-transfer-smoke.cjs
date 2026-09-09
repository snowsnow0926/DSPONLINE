const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);

// This transport fixture never opens the game or a player's Electron profile.
const profile = process.env.DSP_ELECTRON_TRANSFER_SMOKE_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), "dsp-transfer-smoke-"));
if (fs.realpathSync(path.dirname(profile)) !== fs.realpathSync(os.tmpdir()) || !/^dsp-transfer-smoke-[A-Za-z0-9]+$/.test(path.basename(profile)) || fs.lstatSync(profile).isSymbolicLink() || !fs.statSync(profile).isDirectory() || fs.readdirSync(profile).length !== 0) throw new Error("Transport fixture requires its own empty temporary profile");
app.setPath("userData", profile);
app.setPath("sessionData", profile);
const backgroundAudit = { policy: "hidden-no-focus-offscreen-v2", windowsCreated: 0, initiallyVisible: 0, showEvents: 0, focusEvents: 0 };
app.focus = () => {};
app.on("browser-window-created", (_event, created) => {
  backgroundAudit.windowsCreated += 1;
  if (created.isVisible()) { backgroundAudit.initiallyVisible += 1; created.hide(); }
  created.setFocusable(false);
  created.setSkipTaskbar(true);
  created.webContents.setAudioMuted(true);
  created.webContents.setBackgroundThrottling(false);
  if (!created.webContents.isOffscreen()) return fail(new Error("Transport fixture requires offscreen rendering"));
  created.webContents.setFrameRate(60);
  created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const name of ["show", "showInactive", "focus", "restore", "maximize", "moveTop", "setFullScreen", "flashFrame"]) created[name] = () => {};
  created.on("show", () => { backgroundAudit.showEvents += 1; created.hide(); });
  created.on("focus", () => { backgroundAudit.focusEvents += 1; created.blur(); });
});

const expectedBytes = Number(process.env.DSP_ELECTRON_TRANSFER_SMOKE_BYTES || 1024 * 1024);
let window = null;

function fail(error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  app.exit(1);
}

ipcMain.on("smoke:port", (event) => {
  const port = event.ports?.[0];
  if (!port) return fail(new Error("MessagePortMain missing"));
  let receivedBytes = 0;
  port.on("message", ({ data }) => {
    if (data?.responseAck !== undefined) return;
    const received = data?.requestChunk;
    if (received instanceof Uint8Array) {
      receivedBytes += received.byteLength;
      if (data.offset !== receivedBytes || receivedBytes > expectedBytes) {
        return fail(new Error(`Renderer to main chunk mismatch: ${receivedBytes}/${data.offset}`));
      }
      port.postMessage({ requestAck: receivedBytes });
      return;
    }
    if (data?.requestEnd !== true || data.totalBytes !== expectedBytes || receivedBytes !== expectedBytes) {
      return fail(new Error(`Renderer to main transfer mismatch: ${receivedBytes}; data=${Object.prototype.toString.call(data)} keys=${Object.keys(data ?? {}).join(",")}`));
    }
    let offset = 0;
    const sendNext = ({ data: ackData } = { data: {} }) => {
      if (ackData.responseAck !== undefined && ackData.responseAck !== offset) {
        return fail(new Error(`Renderer response ACK mismatch: ${ackData.responseAck}/${offset}`));
      }
      if (offset >= expectedBytes) {
        port.removeListener("message", sendNext);
        port.postMessage({ responseEnd: true, totalBytes: offset });
        return;
      }
      const end = Math.min(expectedBytes, offset + 1024 * 1024);
      const response = new Uint8Array(end - offset);
      if (offset === 0) response[0] = 17;
      if (end === expectedBytes) response[response.length - 1] = 29;
      offset = end;
      port.postMessage({ responseChunk: response, receivedBytes: offset });
    };
    port.on("message", sendNext);
    port.postMessage({ responseStart: { status: 200 } });
    sendNext();
  });
  port.start();
});

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, preload: path.join(__dirname, "message-port-transfer-smoke-preload.cjs") } });
  ipcMain.once("smoke:done", (_event, result) => {
    if (result?.ok !== true || result.bytes !== expectedBytes) return fail(new Error(`Main to renderer transfer mismatch: ${JSON.stringify(result)}`));
    if (backgroundAudit.windowsCreated !== 1 || backgroundAudit.initiallyVisible !== 0 || backgroundAudit.showEvents !== 0 || backgroundAudit.focusEvents !== 0 || window.isVisible() || window.isFocusable() || !window.webContents.isAudioMuted() || !window.webContents.isOffscreen() || window.webContents.getFrameRate() !== 60) return fail(new Error("Transport background audit failed"));
    console.log(`DSP_TRANSFER_BACKGROUND ${JSON.stringify({ ...backgroundAudit, bytes: expectedBytes, muted: true, focusable: false, frameRate: 60, isolatedProfile: app.getPath("userData") === profile })}`);
    app.exit(0);
  });
  await window.loadURL("data:text/html,<title>DSP transfer smoke</title>");
}).catch(fail);

setTimeout(() => fail(new Error("Electron MessagePort transfer smoke timed out")), 30_000).unref();
