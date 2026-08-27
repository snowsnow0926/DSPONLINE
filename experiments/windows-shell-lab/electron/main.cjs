const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { app, BrowserWindow, ipcMain, session } = require("electron");

const { NativeHostClient } = require("../../../desktop/native-host.cjs");
const { buildMetricsEnvelope, resolveLabOptions, validateRendererMetrics } = require("./lab-contract.cjs");

const processStartedAt = performance.now();
const repositoryRoot = path.resolve(__dirname, "../../..");
const options = resolveLabOptions(process.argv.slice(1));
fs.mkdirSync(options.userDataDirectory, { recursive: true });

app.setName("DSPidle Windows Shell Lab");
app.setPath("userData", options.userDataDirectory);
app.commandLine.appendSwitch("disable-http-cache");

let mainWindow = null;
let nativeHostClient = null;
let nativeStopStarted = false;
let nativeStopPromise = null;
let metricsSubmitted = false;
let rendererLoadedMs = 0;
let windowShownMs = 0;
let windowCreatedMs = 0;
let appReadyMs = 0;
let nativeHostReadyMs = 0;
let nativeHostState = {
  available: false,
  state: options.nativeHostEnabled ? "starting" : "disabled",
  capabilities: [],
};

function elapsedMilliseconds() {
  return performance.now() - processStartedAt;
}

function writeJsonAtomically(targetPath, value) {
  const temporaryPath = `${targetPath}.part`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, targetPath);
}

function sanitizedError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message.slice(0, 2_000) : "Unknown shell lab error",
  };
}

function writeFailureMetrics(phase, error) {
  if (metricsSubmitted) return;
  metricsSubmitted = true;
  writeJsonAtomically(options.metricsPath, {
    schemaVersion: 1,
    kind: "dsp-windows-shell-lab",
    shell: "electron",
    status: "failed",
    capturedAtUtc: new Date().toISOString(),
    phase,
    error: sanitizedError(error),
    configuration: {
      durationMs: options.durationMs,
      instanceCount: options.instanceCount,
      fixtureId: options.fixtureId,
      nativeHostEnabled: options.nativeHostEnabled,
      cloudEnabled: false,
      updatesEnabled: false,
    },
  });
}

function trustedSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  try {
    const senderUrl = new URL(event.senderFrame.url);
    return senderUrl.protocol === "file:" && path.resolve(decodeURIComponent(senderUrl.pathname.replace(/^\/(.:)/, "$1"))) === path.join(__dirname, "index.html");
  } catch {
    return false;
  }
}

function blockNetworkAndPrivileges() {
  const labSession = session.defaultSession;
  labSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  labSession.setPermissionCheckHandler(() => false);
  labSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "ftp://*/*"] },
    (_details, callback) => callback({ cancel: true }),
  );
}

function stopNativeHostOnce() {
  if (nativeStopPromise) return nativeStopPromise;
  nativeStopStarted = true;
  nativeStopPromise = nativeHostClient && !nativeHostClient.exited
    ? nativeHostClient.stop().catch(() => {})
    : Promise.resolve();
  return nativeStopPromise;
}

async function startNativeHost() {
  if (!options.nativeHostEnabled) return;
  const binaryPath = path.join(repositoryRoot, "native", "target", "release", "dsp-native-host.exe");
  if (!fs.existsSync(binaryPath)) {
    nativeHostState = { available: false, state: "missing", capabilities: [] };
    nativeHostReadyMs = elapsedMilliseconds();
    return;
  }
  try {
    nativeHostClient = new NativeHostClient({
      binaryPath,
      rootPath: path.join(options.userDataDirectory, "native-saves-v1"),
      requestTimeoutMs: 30_000,
    });
    const hello = await nativeHostClient.start("windows-shell-lab");
    nativeHostState = {
      available: true,
      state: "ready",
      protocolVersion: hello.protocolVersion,
      nativeFormatVersion: hello.nativeFormatVersion,
      hostVersion: hello.hostVersion,
      capabilities: Array.isArray(hello.capabilities) ? hello.capabilities : [],
    };
  } catch (error) {
    nativeHostState = {
      available: false,
      state: "unavailable",
      message: error instanceof Error ? error.message.slice(0, 500) : "native host unavailable",
      capabilities: [],
    };
  } finally {
    nativeHostReadyMs = elapsedMilliseconds();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#09110f",
    title: "DSPidle Windows Shell Lab — Electron",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  windowCreatedMs = elapsedMilliseconds();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (targetUrl !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.once("did-finish-load", () => {
    rendererLoadedMs = elapsedMilliseconds();
  });
  mainWindow.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
    writeFailureMetrics("renderer-load", new Error(`${errorCode}: ${errorDescription}`));
  });
  mainWindow.once("ready-to-show", () => {
    windowShownMs = elapsedMilliseconds();
    mainWindow.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(path.join(__dirname, "index.html"));
}

ipcMain.handle("shell-lab:get-configuration", (event) => {
  if (!trustedSender(event)) throw new Error("untrusted shell lab renderer");
  return {
    schemaVersion: options.schemaVersion,
    durationMs: options.durationMs,
    instanceCount: options.instanceCount,
    fixtureId: options.fixtureId,
    fixtureSeed: options.fixtureSeed,
    nativeHost: nativeHostState,
    cloudEnabled: false,
    updatesEnabled: false,
  };
});

ipcMain.handle("shell-lab:submit-renderer-metrics", (event, rendererMetrics) => {
  if (!trustedSender(event)) throw new Error("untrusted shell lab renderer");
  if (metricsSubmitted) throw new Error("shell lab metrics were already submitted");
  validateRendererMetrics(rendererMetrics, options);
  const envelope = buildMetricsEnvelope({
    rendererMetrics,
    options,
    nativeHost: nativeHostState,
    timings: { appReadyMs, nativeHostReadyMs, windowCreatedMs, rendererLoadedMs, windowShownMs },
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
    },
  });
  writeJsonAtomically(options.metricsPath, envelope);
  metricsSubmitted = true;
  if (options.autoExit) setTimeout(() => app.quit(), 100);
  return { accepted: true };
});

app.whenReady().then(async () => {
  appReadyMs = elapsedMilliseconds();
  app.setAppUserModelId("com.dspidle.network.shelllab");
  blockNetworkAndPrivileges();
  await startNativeHost();
  createWindow();
}).catch((error) => {
  writeFailureMetrics("startup", error);
  void stopNativeHostOnce().finally(() => app.exit(1));
});

app.on("before-quit", (event) => {
  if (!nativeHostClient || nativeHostClient.exited || nativeStopStarted) return;
  event.preventDefault();
  void stopNativeHostOnce().finally(() => app.quit());
});

app.on("window-all-closed", () => app.quit());

process.on("uncaughtException", (error) => {
  writeFailureMetrics("uncaught-exception", error);
  void stopNativeHostOnce().finally(() => app.exit(1));
});

process.on("unhandledRejection", (error) => {
  writeFailureMetrics("unhandled-rejection", error instanceof Error ? error : new Error(String(error)));
  void stopNativeHostOnce().finally(() => app.exit(1));
});
