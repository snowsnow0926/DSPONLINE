const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } = require("electron");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const nodeOs = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const nodeV8 = require("node:v8");
const { createReleaseChannels, optionalHttpsUrl, resolveReleaseChannel } = require("./release-channels.cjs");
const {
  finishCommittedNativeV47Import,
  registerWindowClosedCleanup,
} = require("./window-lifecycle.cjs");
const {
  contract: cloudTransferContract,
  exactUint8Array,
  normalizeRequestHeaders,
  requestBodyLimit,
  requestTimeoutMs,
  validRequestId,
} = require("./cloud-transport.cjs");
const {
  AccountArchiveDownloadRegistry,
  downloadAccountArchiveToFile,
  normalizeBearerAuthorization,
  normalizeRequestId: normalizeAccountArchiveRequestId,
  sanitizeArchiveFileName,
  serializeAccountArchiveDownloadError,
} = require("./account-archive-download.cjs");
const {
  encodeNativeProjectionTransfer,
  NativeHostClient,
  NativeCoreSessionRegistry,
  NativeExactRealtimeLeaseRegistry,
  NativeSaveSessionRegistry,
  nativeHostBinaryPath,
} = require("./native-host.cjs");
const {
  NativeCoreExactRealtimeRustLeaseStore,
} = require("./native-core-exact-realtime-experiment.cjs");
const {
  inspectNativeExactRealtimeStartup,
  inspectNativeExactRealtimeStartupWithoutHost,
  resolveFixedNativeSaveRootPath,
  unavailableStartupStatus,
} = require("./native-exact-realtime-startup-guard.cjs");
const {
  NativePerformancePolicyStore,
  detectLogicalCpuCount,
} = require("./native-performance-policy.cjs");
const {
  PERFORMANCE_EDITION_IDENTITY,
  initializePerformanceEditionIdentity,
  validatePerformanceEditionPackageIdentity,
} = require("./performance-edition-identity.cjs");
const {
  createRendererNativeError,
  normalizeRendererNativeResult,
  rendererNativeErrorCode,
  serializeRendererNativeError,
} = require("./native-renderer-boundary.cjs");
const { RuntimeDiagnosticsSampler } = require("./runtime-diagnostics.cjs");
const { initializeShellRuntimePolicy } = require("./shell-runtime-policy.cjs");
const packageMetadata = require("../package.json");

validatePerformanceEditionPackageIdentity(packageMetadata);
const performanceEditionRuntimeIdentity = initializePerformanceEditionIdentity({
  app,
  fileSystem: fs,
  pathModule: path,
  smokeIsolation: process.env.DSP_PERFORMANCE_SMOKE_ISOLATION === "1"
    ? {
        enabled: true,
        releaseChannel: packageMetadata.releaseChannel,
        appDataRoot: process.env.DSP_PERFORMANCE_SMOKE_APP_DATA_ROOT,
        temporaryRootPath: nodeOs.tmpdir(),
      }
    : null,
});
// This is deliberately initialized before app readiness. The default path does
// not mutate Electron; only the exact experimental fallback can disable GPU use.
const shellRuntimePolicy = initializeShellRuntimePolicy({ app, environment: process.env });

const isDevelopment = Boolean(process.env.DSP_DESKTOP_DEV_URL);
const channels = createReleaseChannels({
  updateBaseUrl: process.env.DSP_UPDATE_BASE_URL || packageMetadata.updateBaseUrl,
  stableUrl: process.env.DSP_UPDATE_STABLE_URL,
  betaUrl: process.env.DSP_UPDATE_BETA_URL,
  nightlyUrl: process.env.DSP_UPDATE_NIGHTLY_URL,
});
const channelId = resolveReleaseChannel(process.env.DSP_RELEASE_CHANNEL || packageMetadata.releaseChannel);
const channel = channels[channelId];
const configuredApiBaseUrl = optionalHttpsUrl(
  process.env.DSP_DESKTOP_API_BASE_URL || packageMetadata.cloudApiBaseUrl,
  "Desktop cloud API base URL",
);
const apiBaseUrl = configuredApiBaseUrl ? new URL(`${configuredApiBaseUrl}/`) : null;
const allowedApiMethods = new Set(["GET", "POST", "PUT", "DELETE"]);
const MAXIMUM_CONCURRENT_TRANSFER_REQUESTS = 4;
const maximumLegacyRequestBytes = cloudTransferContract.legacyJsonRequestLimitBytes;
const maximumSmallRequestBytes = 8 * 1024 * 1024;
const maximumResponseBytes = cloudTransferContract.singleSaveResponseLimitBytes;
const DESKTOP_BASE_SCALE = 0.8;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const MAX_NATIVE_V47_IMPORT_BYTES = 256 * 1024 * 1024;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

let mainWindow = null;
let updater = null;
let zoomTimer = null;
let windowStateTimer = null;
let updateTimer = null;
let updateShutdownPromise = null;
let updateShutdownResolve = null;
let updateShutdownRequested = false;
let fontScale = 1;
const activeApiRequests = new Map();
const activeAccountArchiveDownloads = new AccountArchiveDownloadRegistry(1);
const activeAccountArchiveDownloadCompletions = new Set();
let accountArchiveQuitDrainPromise = null;
let accountArchiveQuitDrainComplete = false;
let nativeHostClient = null;
let nativeSaveSessions = null;
let nativeCoreSessions = null;
let nativeHostQuitDrainPromise = null;
let nativeHostQuitDrainComplete = false;
let nativeExactRealtimeStartupStatus = unavailableStartupStatus(process.env);
let nativePerformancePolicyStore = null;
let nativePerformancePolicyStatus = {
  schemaVersion: 1,
  requestedPolicy: { mode: "balanced" },
  effectivePolicy: { mode: "balanced", threadSetting: "auto" },
  logicalCpuCount: detectLogicalCpuCount(),
  restartRequired: false,
  configurationState: "default",
};
let nativeHostState = {
  available: false,
  state: process.platform === "win32" ? "starting" : "unsupported",
  message: process.platform === "win32" ? "Windows 原生性能服务尚未启动" : "当前平台不启用 Windows 原生性能服务",
  errorCode: null,
  capabilities: [],
  performancePolicy: nativePerformancePolicyStatus,
};
const runtimeDiagnosticsSampler = new RuntimeDiagnosticsSampler({
  app,
  runtimeProcess: process,
  nodeProcess: process,
  nodeOs,
  nodeV8,
  getContext: () => ({
    runtimePolicy: shellRuntimePolicy,
    nativeHost: nativeHostClient && !nativeHostClient.exited
      ? { pid: nativeHostClient.child?.pid }
      : null,
  }),
});
let updateState = {
  state: isDevelopment ? "development" : "idle",
  message: isDevelopment ? "开发环境不检查更新" : channel.url ? "尚未检查" : "此构建未配置更新源",
  channel: channelId,
};

function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function readWindowState() {
  try {
    const value = JSON.parse(fs.readFileSync(windowStateFile(), "utf8"));
    const bounds = value?.bounds;
    if (![bounds?.x, bounds?.y, bounds?.width, bounds?.height].every(Number.isFinite)) return null;
    if (bounds.width < 1024 || bounds.height < 680) return null;
    return { bounds, maximized: value.maximized === true };
  } catch {
    return null;
  }
}

function visibleWindowState() {
  const saved = readWindowState();
  if (!saved) return null;
  const display = screen.getDisplayMatching(saved.bounds);
  const area = display.workArea;
  const horizontalOverlap = Math.max(0, Math.min(saved.bounds.x + saved.bounds.width, area.x + area.width) - Math.max(saved.bounds.x, area.x));
  const verticalOverlap = Math.max(0, Math.min(saved.bounds.y + saved.bounds.height, area.y + area.height) - Math.max(saved.bounds.y, area.y));
  return horizontalOverlap >= 160 && verticalOverlap >= 120 ? saved : null;
}

function persistWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const file = windowStateFile();
    const temporary = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({
      bounds: mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds(),
      maximized: mainWindow.isMaximized(),
    }));
    fs.renameSync(temporary, file);
  } catch {
    // Window state is optional and must never block shutdown.
  }
}

function scheduleWindowStateSave() {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = null;
    persistWindowState();
  }, 250);
}

function applyReadableDesktopZoom() {
  if (!mainWindow || mainWindow.isDestroyed()) return 1;
  const contentWidth = mainWindow.getContentBounds().width;
  const adaptiveScale = isDevelopment ? 1 : Math.max(1, Math.min(2, contentWidth / 1120));
  const zoomFactor = Math.max(0.64, Math.min(2.4, adaptiveScale * DESKTOP_BASE_SCALE * fontScale));
  mainWindow.webContents.setZoomFactor(Number(zoomFactor.toFixed(2)));
  return zoomFactor;
}

function scheduleReadableDesktopZoom() {
  if (zoomTimer) clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    zoomTimer = null;
    applyReadableDesktopZoom();
  }, 120);
}

function publishUpdateState(next) {
  updateState = { ...updateState, ...next, channel: channelId };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:update-status", updateState);
}

function trustedSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

function requireTrustedNativeSender(event) {
  if (!trustedSender(event)) throw new Error("原生性能服务调用来源无效");
  if (!nativeHostClient || !nativeSaveSessions || !nativeCoreSessions || !nativeHostState.available) throw new Error("Windows 原生性能服务不可用");
  return event.sender.id;
}

function validNativeLogicalId(value, maximumLength = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function initializeNativePerformancePolicy() {
  nativePerformancePolicyStore = new NativePerformancePolicyStore({
    userDataPath: app.getPath("userData"),
  });
  nativePerformancePolicyStatus = nativePerformancePolicyStore.initialize();
  nativeHostState = { ...nativeHostState, performancePolicy: nativePerformancePolicyStatus };
  return nativePerformancePolicyStatus;
}

async function initializeNativeHost() {
  const rootPath = resolveFixedNativeSaveRootPath(performanceEditionRuntimeIdentity.userDataPath);
  const inspectWithoutHost = () => inspectNativeExactRealtimeStartupWithoutHost({
    performanceEditionUserDataPath: performanceEditionRuntimeIdentity.userDataPath,
    environment: process.env,
  });
  if (process.platform !== "win32") {
    nativeExactRealtimeStartupStatus = inspectWithoutHost();
    nativeHostState = {
      ...nativeHostState,
      exactRealtime: nativeExactRealtimeStartupStatus,
    };
    return nativeHostState;
  }
  if (!nativePerformancePolicyStore) initializeNativePerformancePolicy();
  const binaryPath = nativeHostBinaryPath({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  });
  try {
    nativeHostClient = new NativeHostClient({
      binaryPath,
      rootPath,
      spawnEnvironment: nativePerformancePolicyStore.spawnEnvironment(),
    });
    const hello = normalizeRendererNativeResult("hostHello", await nativeHostClient.start(app.getVersion()));
    nativeSaveSessions = new NativeSaveSessionRegistry(nativeHostClient);
    nativeCoreSessions = new NativeCoreSessionRegistry(nativeHostClient);
    nativeExactRealtimeStartupStatus = await inspectNativeExactRealtimeStartup({
      leaseStore: new NativeCoreExactRealtimeRustLeaseStore({
        leaseRegistry: new NativeExactRealtimeLeaseRegistry(nativeHostClient),
      }),
      environment: process.env,
    });
    nativeHostState = {
      available: true,
      state: "ready",
      message: "Windows 原生存档服务已就绪",
      errorCode: null,
      protocolVersion: hello.protocolVersion,
      nativeFormatVersion: hello.nativeFormatVersion,
      hostVersion: hello.hostVersion,
      capabilities: Array.isArray(hello.capabilities) ? hello.capabilities : [],
      exactRealtime: nativeExactRealtimeStartupStatus,
      performancePolicy: nativePerformancePolicyStatus,
    };
  } catch (error) {
    const failedNativeHostClient = nativeHostClient;
    if (failedNativeHostClient && !failedNativeHostClient.exited) {
      try {
        await failedNativeHostClient.stop();
      } catch {
        // Startup remains fail-closed below; a failed graceful stop must not
        // skip the fixed-root lease inspection or retain a usable client.
      }
    }
    nativeExactRealtimeStartupStatus = inspectWithoutHost();
    nativeHostState = {
      available: false,
      state: "unavailable",
      message: "Windows 原生性能服务启动失败；已完成本地权威租约安全检查",
      errorCode: rendererNativeErrorCode(error, "NATIVE_HOST_START_FAILED"),
      capabilities: [],
      exactRealtime: nativeExactRealtimeStartupStatus,
      performancePolicy: nativePerformancePolicyStatus,
    };
    nativeHostClient = null;
    nativeSaveSessions = null;
    nativeCoreSessions = null;
  }
  return nativeHostState;
}

function resolveApiRequestUrl(requestPath) {
  if (!apiBaseUrl) throw new Error("此构建未配置云服务地址");
  if (typeof requestPath !== "string" || !requestPath.startsWith("/") || requestPath.includes("\\")) throw new Error("API 路径无效");
  const basePath = apiBaseUrl.pathname.endsWith("/") ? apiBaseUrl.pathname : `${apiBaseUrl.pathname}/`;
  const target = new URL(requestPath.replace(/^\/+/, ""), new URL(basePath, apiBaseUrl.origin));
  if (target.protocol !== "https:" || target.origin !== apiBaseUrl.origin || !target.pathname.startsWith(basePath)) throw new Error("API 地址未获授权");
  return target;
}

async function requestCloudApi(event, request) {
  if (!trustedSender(event)) throw new Error("API 调用来源无效");
  const method = typeof request?.method === "string" ? request.method.toUpperCase() : "GET";
  if (!allowedApiMethods.has(method)) throw new Error("API 请求方法无效");
  const target = resolveApiRequestUrl(request?.path);
  const body = request?.body == null ? undefined : request.body;
  if (body != null && typeof body !== "string") throw new Error("API 请求正文无效");
  const bodyBytes = body ? Buffer.byteLength(body, "utf8") : 0;
  const requestLimit = method === "PUT" && target.pathname.endsWith("/cloud-save")
    ? maximumLegacyRequestBytes
    : maximumSmallRequestBytes;
  if (bodyBytes > requestLimit) throw new Error("API 请求正文过大");
  const headers = new Headers(normalizeRequestHeaders(request?.headers));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    requestTimeoutMs(bodyBytes, request?.expectedResponseBytes, request?.timeoutMs),
  );
  try {
    const response = await fetch(target, { method, headers, body, redirect: "error", signal: controller.signal });
    const responseLength = Number(response.headers.get("content-length") || 0);
    const responseLimit = Number.isFinite(request?.expectedResponseBytes)
      ? Math.min(maximumResponseBytes, Math.max(0, Math.floor(request.expectedResponseBytes)))
      : maximumResponseBytes;
    if (responseLength > responseLimit) throw new Error("云服务响应过大");
    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody, "utf8") > responseLimit) throw new Error("云服务响应过大");
    return {
      ok: response.ok,
      status: response.status,
      body: responseBody,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    };
  } finally {
    clearTimeout(timer);
  }
}

function serializedApiError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "桌面云请求失败",
    ...(error && typeof error === "object" && typeof error.code === "string" ? { code: error.code } : {}),
  };
}

function closeTransferPort(port) {
  try { port.close(); } catch { /* the renderer may already have closed it */ }
}

function postTransferError(port, error) {
  try { port.postMessage({ error: serializedApiError(error) }); } catch { /* renderer is gone */ }
  closeTransferPort(port);
}

function postNativeProjectionTransferError(port, error) {
  const safe = serializeRendererNativeError(error, {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生投影请求失败，请重试",
  });
  try { port.postMessage({ error: safe }); } catch { /* renderer is gone */ }
  closeTransferPort(port);
}

async function runRendererNativeOperation(kind, options, operation) {
  try {
    const raw = await operation();
    try {
      return normalizeRendererNativeResult(kind, raw, options.resultContext);
    } catch (error) {
      if (typeof options.onInvalidResult === "function") {
        await options.onInvalidResult(raw).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    throw createRendererNativeError(error, options);
  }
}

function nativeCoreProjectionResultContext(request) {
  return {
    baseFields: request?.baseFields,
    entityIds: request?.entityIds,
    beltIds: request?.beltIds,
  };
}

function nativeViewportProjectionResultContext(request) {
  return {
    baseFields: request?.baseFields ?? [],
    planetId: request?.planetId,
    bounds: request?.bounds,
    entityCursor: request?.entityCursor ?? 0,
    entityLimit: request?.entityLimit,
    beltLimit: request?.beltLimit,
  };
}

function nativeStatisticsProjectionResultContext(request) {
  return {
    minElapsedSeconds: request?.minElapsedSeconds,
    maxElapsedSeconds: request?.maxElapsedSeconds,
    cursor: request?.cursor ?? 0,
    limit: request?.limit,
    planetId: request?.planetId ?? null,
    itemId: request?.itemId ?? null,
  };
}

async function waitForResponseAck(record, expectedBytes) {
  if (record.cancelled) throw Object.assign(new Error("云存档上传已取消"), { name: "AbortError", code: "ABORTED" });
  await new Promise((resolve, reject) => {
    const finishResolve = () => {
      if (record.responseAckTimer) clearTimeout(record.responseAckTimer);
      resolve();
    };
    const finishReject = (error) => {
      if (record.responseAckTimer) clearTimeout(record.responseAckTimer);
      reject(error);
    };
    record.responseAck = { expectedBytes, resolve: finishResolve, reject: finishReject };
    record.responseAckTimer = setTimeout(() => {
      if (record.responseAck?.expectedBytes !== expectedBytes) return;
      const { reject: rejectAck } = record.responseAck;
      record.responseAck = null;
      rejectAck(Object.assign(new Error("桌面云响应分片确认超时"), { name: "AbortError", code: "CLOUD_REQUEST_TIMEOUT" }));
    }, cloudTransferContract.baseTimeoutMs);
  });
}

async function streamTransferResponse(response, request, port, record) {
  const responseLimit = Number.isFinite(request.expectedResponseBytes)
    ? Math.min(maximumResponseBytes, Math.max(0, Math.floor(request.expectedResponseBytes)))
    : maximumResponseBytes;
  const responseLength = Number(response.headers.get("content-length") || 0);
  if (responseLength > responseLimit) throw new Error("云服务响应过大");
  port.postMessage({
    responseStart: {
      ok: response.ok,
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    },
  });
  let receivedBytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = exactUint8Array(result.value);
        receivedBytes += chunk.byteLength;
        if (receivedBytes > responseLimit) throw new Error("云服务响应过大");
        port.postMessage({ responseChunk: chunk, receivedBytes });
        await waitForResponseAck(record, receivedBytes);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* response stream already closed */ }
    }
  }
  if (responseLength > 0 && receivedBytes !== responseLength) throw new Error("云服务响应长度不一致");
  port.postMessage({ responseEnd: true, totalBytes: receivedBytes });
  closeTransferPort(port);
}

async function requestCloudApiTransfer(event, request, port, record) {
  const headers = normalizeRequestHeaders(request.headers);
  if (request.bodyByteLength > requestBodyLimit(headers)) throw new Error("API 请求正文过大");
  const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
  if (!allowedApiMethods.has(method)) throw new Error("API 请求方法无效");
  const target = resolveApiRequestUrl(request.path);
  const timeoutMs = requestTimeoutMs(request.bodyByteLength, request.expectedResponseBytes, request.timeoutMs);
  const timer = setTimeout(() => record.controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      method,
      headers: new Headers(headers),
      body: request.bodyByteLength > 0 ? record.requestStream : undefined,
      ...(request.bodyByteLength > 0 ? { duplex: "half" } : {}),
      redirect: "error",
      signal: record.controller.signal,
    });
    if (record.cancelled || record.controller.signal.aborted || !activeApiRequests.has(request.requestId)) return;
    await streamTransferResponse(response, request, port, record);
  } finally {
    clearTimeout(timer);
  }
}

function cancelAllApiRequests() {
  for (const record of activeApiRequests.values()) {
    record.cancelled = true;
    if (record.intakeTimer) clearTimeout(record.intakeTimer);
    if (record.responseAckTimer) clearTimeout(record.responseAckTimer);
    record.controller.abort();
    record.requestStream.destroy();
    record.responseAck?.reject(Object.assign(new Error("云存档上传已取消"), { name: "AbortError", code: "ABORTED" }));
    closeTransferPort(record.port);
  }
  activeApiRequests.clear();
}

function cancelAllAccountArchiveDownloads() {
  activeAccountArchiveDownloads.cancelAll();
}

function allowLoadedNavigation(url) {
  if (isDevelopment) {
    try { return new URL(url).origin === new URL(process.env.DSP_DESKTOP_DEV_URL).origin; } catch { return false; }
  }
  return url.startsWith("file://");
}

function openExternalUrl(url) {
  try {
    const target = new URL(url);
    if (target.protocol === "https:") void shell.openExternal(target.toString());
  } catch {
    // Invalid external links are ignored.
  }
}

function createWindow() {
  const saved = visibleWindowState();
  const window = new BrowserWindow({
    width: saved?.bounds.width ?? 1500,
    height: saved?.bounds.height ?? 960,
    x: saved?.bounds.x,
    y: saved?.bounds.y,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#0b100e",
    title: PERFORMANCE_EDITION_IDENTITY.productName,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (allowLoadedNavigation(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    dialog.showMessageBox({
      type: "error",
      title: "渲染进程异常",
      message: "游戏界面发生异常，重新打开应用后会从最近一次本地存档恢复。",
      detail: `原因：${details.reason}`,
    }).catch(() => undefined);
  });
  window.on("page-title-updated", (event) => {
    event.preventDefault();
    if (!window.isDestroyed()) window.setTitle(PERFORMANCE_EDITION_IDENTITY.productName);
  });
  window.on("resize", () => {
    scheduleReadableDesktopZoom();
    scheduleWindowStateSave();
  });
  window.on("move", scheduleWindowStateSave);
  window.on("close", persistWindowState);
  registerWindowClosedCleanup(window, {
    abortNativeSaveOwner: (ownerId) => {
      if (nativeSaveSessions) void nativeSaveSessions.abortOwner(ownerId);
    },
    closeNativeCoreOwner: (ownerId) => {
      if (nativeCoreSessions) void nativeCoreSessions.closeOwner(ownerId);
    },
    cancelApiRequests: cancelAllApiRequests,
    cancelAccountArchiveDownloads: cancelAllAccountArchiveDownloads,
    clearWindow: (closedWindow) => {
      if (mainWindow === closedWindow) mainWindow = null;
    },
  });

  if (isDevelopment) {
    void window.loadURL(process.env.DSP_DESKTOP_DEV_URL);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
  window.once("ready-to-show", () => {
    if (window.isDestroyed() || mainWindow !== window) return;
    if (saved?.maximized || !saved) window.maximize();
    scheduleReadableDesktopZoom();
    window.show();
  });
}

function configureAutoUpdater() {
  if (isDevelopment || !app.isPackaged || process.env.DSP_DISABLE_UPDATES === "1") return;
  try {
    const updateUrl = process.env.DSP_UPDATE_URL || channel.url;
    if (!updateUrl) return;
    const parsedUpdateUrl = new URL(updateUrl);
    if (parsedUpdateUrl.protocol !== "https:") {
      publishUpdateState({ state: "error", message: "更新源必须使用 HTTPS" });
      return;
    }
    ({ autoUpdater: updater } = require("electron-updater"));
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = channel.allowPrerelease;
    updater.setFeedURL({ provider: "generic", url: parsedUpdateUrl.toString().replace(/\/$/, "") });
    updater.on("checking-for-update", () => publishUpdateState({ state: "checking", message: "正在检查更新", progress: undefined }));
    updater.on("update-available", (info) => publishUpdateState({ state: "available", message: `发现版本 ${info.version}`, version: info.version, progress: undefined }));
    updater.on("update-not-available", () => publishUpdateState({ state: "up-to-date", message: "已是最新版本", progress: undefined }));
    updater.on("download-progress", (progress) => publishUpdateState({ state: "downloading", message: "正在下载更新", progress: Math.round(progress.percent) }));
    updater.on("update-downloaded", (info) => publishUpdateState({ state: "downloaded", message: "更新已下载，重启后安装", version: info.version, progress: 100 }));
    updater.on("error", (error) => publishUpdateState({ state: "error", message: error.message || "更新检查失败", progress: undefined }));
  } catch (error) {
    updater = null;
    publishUpdateState({ state: "error", message: `自动更新不可用：${error instanceof Error ? error.message : "初始化失败"}` });
  }
}

ipcMain.handle("desktop:release-info", () => ({
  isDesktop: true,
  editionId: performanceEditionRuntimeIdentity.editionId,
  productName: performanceEditionRuntimeIdentity.productName,
  platform: process.platform,
  channel: channelId,
  channelLabel: channel.label,
  version: app.getVersion(),
  update: updateState,
}));

ipcMain.handle("desktop:set-font-scale", (_event, requestedScale) => {
  fontScale = [0.8, 1, 1.25, 1.5, 2].includes(requestedScale) ? requestedScale : 1;
  return { scale: fontScale, zoomFactor: applyReadableDesktopZoom() };
});

ipcMain.handle("desktop:native-status", async (event) => runRendererNativeOperation("nativeStatus", {
  fallbackCode: "NATIVE_STATUS_FAILED",
  message: "无法读取 Windows 原生性能服务状态",
}, async () => {
  if (!trustedSender(event)) throw new Error("invalid native status sender");
  return nativeHostState;
}));

ipcMain.handle("desktop:runtime-diagnostics", async (event) => {
  if (!trustedSender(event)) throw new Error("桌面运行诊断调用来源无效");
  return runtimeDiagnosticsSampler.sample();
});

ipcMain.handle("desktop:native-performance-policy", async (event) => runRendererNativeOperation("performancePolicy", {
  fallbackCode: "NATIVE_PERFORMANCE_POLICY_READ_FAILED",
  message: "无法读取 Windows 原生性能策略",
}, async () => {
  if (!trustedSender(event)) throw new Error("invalid native performance policy sender");
  return nativePerformancePolicyStatus;
}));

ipcMain.handle("desktop:set-native-performance-policy", async (event, request) => runRendererNativeOperation("performancePolicy", {
  fallbackCode: "NATIVE_PERFORMANCE_POLICY_WRITE_FAILED",
  message: "无法保存 Windows 原生性能策略",
}, async () => {
  if (!trustedSender(event)) throw new Error("invalid native performance policy sender");
  if (!nativePerformancePolicyStore) throw new Error("native performance policy is not initialized");
  nativePerformancePolicyStatus = nativePerformancePolicyStore.save(request);
  nativeHostState = { ...nativeHostState, performancePolicy: nativePerformancePolicyStatus };
  return nativePerformancePolicyStatus;
}));

ipcMain.handle("desktop:native-save-begin", async (event, request) => {
  let ownerId = null;
  return runRendererNativeOperation("saveBegin", {
    fallbackCode: "NATIVE_SAVE_BEGIN_FAILED",
    message: "原生存档事务启动失败，请重试",
    onInvalidResult: async (raw) => {
      if (ownerId !== null && typeof raw?.transactionId === "string") {
        await nativeSaveSessions?.abort(ownerId, raw.transactionId);
      }
    },
  }, async () => {
    ownerId = requireTrustedNativeSender(event);
    return nativeSaveSessions.begin(ownerId, request);
  });
});

ipcMain.handle("desktop:native-save-write", async (event, request) => {
  return runRendererNativeOperation("saveWrite", {
    fallbackCode: "NATIVE_SAVE_WRITE_FAILED",
    message: "原生存档分块写入失败，请重试",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return nativeSaveSessions.write(ownerId, request?.transactionId, request?.records);
  });
});

ipcMain.handle("desktop:native-save-commit", async (event, request) => {
  return runRendererNativeOperation("saveCommit", {
    fallbackCode: "NATIVE_SAVE_COMMIT_FAILED",
    message: "原生存档提交失败，请重新检查存档状态",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return nativeSaveSessions.commit(ownerId, request?.transactionId);
  });
});

ipcMain.handle("desktop:native-save-abort", async (event, request) => {
  return runRendererNativeOperation("saveAbort", {
    fallbackCode: "NATIVE_SAVE_ABORT_FAILED",
    message: "原生存档事务取消失败，请重新检查存档状态",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return nativeSaveSessions.abort(ownerId, request?.transactionId);
  });
});

ipcMain.handle("desktop:native-save-recover", async (event, request) => {
  return runRendererNativeOperation("saveRecovery", {
    fallbackCode: "NATIVE_SAVE_RECOVER_FAILED",
    message: "原生存档恢复检查失败，请重试",
  }, async () => {
    requireTrustedNativeSender(event);
    if (!validNativeLogicalId(request?.slot, 64)) throw new Error("invalid native save slot");
    return nativeHostClient.request({ operation: "saveRecover", slot: request.slot });
  });
});

ipcMain.handle("desktop:native-save-read", async (event, request) => {
  return runRendererNativeOperation("saveRead", {
    fallbackCode: "NATIVE_SAVE_READ_FAILED",
    message: "原生存档区块读取失败，请重试",
  }, async () => {
    requireTrustedNativeSender(event);
    if (!validNativeLogicalId(request?.slot, 64) || !Number.isSafeInteger(request?.generation) || request.generation < 1 ||
      typeof request?.rootHash !== "string" || !/^[a-f0-9]{64}$/.test(request.rootHash) ||
      typeof request?.key !== "string" || request.key.length < 1 || request.key.length > 512 ||
      request.key.includes("..") || /[\\/\0]/.test(request.key)) throw new Error("invalid native save read request");
    return nativeHostClient.request({ operation: "saveRead", slot: request.slot, key: request.key, generation: request.generation, rootHash: request.rootHash });
  });
});

ipcMain.handle("desktop:native-wal-append", async (event, request) => {
  return runRendererNativeOperation("walAppend", {
    fallbackCode: "NATIVE_WAL_APPEND_FAILED",
    message: "原生存档日志写入失败，请重新检查存档状态",
  }, async () => {
    requireTrustedNativeSender(event);
    if (!validNativeLogicalId(request?.slot, 64) || !validNativeLogicalId(request?.commandId, 128) ||
      !Number.isSafeInteger(request?.baseRevision) || request.baseRevision < 0 ||
      !Number.isSafeInteger(request?.revision) || request.revision <= request.baseRevision ||
      !request.payload || typeof request.payload !== "object") throw new Error("invalid native WAL request");
    return nativeHostClient.request({ operation: "walAppend", slot: request.slot, baseRevision: request.baseRevision, revision: request.revision, commandId: request.commandId, payload: request.payload });
  });
});

ipcMain.handle("desktop:native-save-compact", async (event, request) => {
  return runRendererNativeOperation("saveCompact", {
    fallbackCode: "NATIVE_SAVE_COMPACT_FAILED",
    message: "原生存档空闲合并失败，请稍后重试",
  }, async () => {
    requireTrustedNativeSender(event);
    if (!validNativeLogicalId(request?.slot, 64)) throw new Error("invalid native save slot");
    const retainGenerations = Number.isSafeInteger(request?.retainGenerations) ? Math.max(2, Math.min(8, request.retainGenerations)) : 2;
    return nativeHostClient.request({ operation: "compact", slot: request.slot, retainGenerations });
  });
});

ipcMain.handle("desktop:native-core-open", async (event, request) => {
  let ownerId = null;
  return runRendererNativeOperation("coreOpen", {
    fallbackCode: "NATIVE_CORE_OPEN_FAILED",
    message: "原生影子核心打开失败，请重试",
    onInvalidResult: async (raw) => {
      if (ownerId !== null && typeof raw?.sessionId === "string") await nativeCoreSessions?.close(ownerId, raw.sessionId);
    },
  }, async () => {
    ownerId = requireTrustedNativeSender(event);
    return nativeCoreSessions.open(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-import-v47", async (event, request) => {
  try {
    const ownerId = requireTrustedNativeSender(event);
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "导入 DSP极简网络 v47 存档到 Windows 原生核心",
      buttonLabel: "验证并导入",
      filters: [{ name: "DSP极简网络存档", extensions: ["json", "gz"] }],
      properties: ["openFile", "dontAddToRecent"],
    });
    if (selection.canceled || selection.filePaths.length !== 1) {
      return { cancelled: true };
    }
    if (!trustedSender(event) || event.sender.id !== ownerId) {
      throw Object.assign(new Error("renderer owner closed"), {
        name: "AbortError",
        code: "NATIVE_CORE_V47_IMPORT_CANCELLED",
      });
    }
    const sourcePath = path.resolve(selection.filePaths[0]);
    const sourceFileName = path.basename(sourcePath).toLowerCase();
    const supportedSourceName = sourceFileName.endsWith(".json") ||
      sourceFileName.endsWith(".json.gz");
    const sourceStat = await fs.promises.lstat(sourcePath);
    if (!supportedSourceName || !sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size < 1 ||
      sourceStat.size > MAX_NATIVE_V47_IMPORT_BYTES) {
      throw Object.assign(new Error("unsupported native v47 import selection"), {
        code: "NATIVE_CORE_V47_IMPORT_FILE_INVALID",
      });
    }
    const imported = await runRendererNativeOperation("coreImport", {
      fallbackCode: "NATIVE_CORE_V47_IMPORT_FAILED",
      message: "原生 v47 存档导入失败；未验证的内容不会进入游戏会话",
      onInvalidResult: async (raw) => {
        if (typeof raw?.sessionId === "string") await nativeCoreSessions?.close(ownerId, raw.sessionId);
      },
    }, () => nativeCoreSessions.importV47(ownerId, request, sourcePath));
    return finishCommittedNativeV47Import({
      imported,
      fileName: path.basename(sourcePath),
      ownerStillTrusted: trustedSender(event) && event.sender.id === ownerId,
      closeSession: () => nativeCoreSessions.close(ownerId, imported.sessionId),
    });
  } catch (error) {
    throw createRendererNativeError(error, {
      fallbackCode: "NATIVE_CORE_V47_IMPORT_FAILED",
      message: "原生 v47 存档导入失败；未验证的内容不会进入游戏会话",
    });
  }
});

ipcMain.handle("desktop:native-core-status", async (event, request) => {
  return runRendererNativeOperation("coreSummary", {
    fallbackCode: "NATIVE_CORE_STATUS_FAILED",
    message: "原生影子核心状态读取失败，请重试",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return nativeCoreSessions.status(ownerId, request?.sessionId);
  });
});

ipcMain.handle("desktop:native-core-projection", async (event, request) => {
  return runRendererNativeOperation("coreProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生投影请求失败，请重试",
    resultContext: nativeCoreProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await nativeCoreSessions.projection(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-viewport-projection", async (event, request) => {
  return runRendererNativeOperation("coreViewportProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生视口投影请求失败，请重试",
    resultContext: nativeViewportProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await nativeCoreSessions.viewportProjection(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-statistics-projection", async (event, request) => {
  return runRendererNativeOperation("coreStatisticsProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生统计投影请求失败，请重试",
    resultContext: nativeStatisticsProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await nativeCoreSessions.statisticsProjection(ownerId, request);
  });
});

ipcMain.on("desktop:native-core-projection-transfer", (event, request) => {
  const port = event.ports?.[0];
  if (!port) return;
  const run = async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (!request || typeof request !== "object" ||
      !validNativeLogicalId(request.sessionId, 128) ||
      !Number.isSafeInteger(request.sequence) || request.sequence < 1 ||
      !["viewport-v1", "statistics-v1"].includes(request.projectionType) ||
      !request.payload || typeof request.payload !== "object" ||
      Object.prototype.hasOwnProperty.call(request.payload, "sessionId")) {
      throw new Error("原生投影二进制请求无效");
    }
    const normalizedRequest = { ...request.payload, sessionId: request.sessionId };
    const rawResult = request.projectionType === "viewport-v1"
      ? await nativeCoreSessions.viewportProjection(ownerId, normalizedRequest)
      : await nativeCoreSessions.statisticsProjection(ownerId, normalizedRequest);
    const result = normalizeRendererNativeResult(
      request.projectionType === "viewport-v1" ? "coreViewportProjection" : "coreStatisticsProjection",
      rawResult,
      request.projectionType === "viewport-v1"
        ? nativeViewportProjectionResultContext(request.payload)
        : nativeStatisticsProjectionResultContext(request.payload),
    );
    const transfer = encodeNativeProjectionTransfer({
      sessionId: request.sessionId,
      sequence: request.sequence,
      projectionType: request.projectionType,
      result,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("原生投影二进制确认超时")), 15_000);
      const onMessage = ({ data }) => {
        if (data?.projectionAck?.sequence !== transfer.header.sequence ||
          data.projectionAck.sha256 !== transfer.header.sha256) return;
        clearTimeout(timer);
        port.removeListener("message", onMessage);
        resolve();
      };
      port.on("message", onMessage);
      const payload = new Uint8Array(transfer.payload);
      // Electron's MessagePortMain transfer list only accepts MessagePortMain
      // objects. Uint8Array still keeps the data plane binary and bounded; the
      // renderer-side port owns the received clone and ACKs its exact digest.
      port.postMessage({ header: transfer.header, payload });
    });
  };
  port.start();
  void run()
    .catch((error) => postNativeProjectionTransferError(port, error))
    .finally(() => closeTransferPort(port));
});

ipcMain.handle("desktop:native-core-apply-command", async (event, request) => {
  return runRendererNativeOperation("coreCommand", {
    fallbackCode: "NATIVE_CORE_COMMAND_FAILED",
    message: "原生影子命令执行失败，请重试",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return nativeCoreSessions.applyCommand(ownerId, request?.sessionId, request?.command);
  });
});

ipcMain.handle("desktop:native-core-advance", async (event, request) => {
  return runRendererNativeOperation("coreAdvance", {
    fallbackCode: "NATIVE_CORE_ADVANCE_FAILED",
    message: "原生影子模拟推进失败，请重试",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return nativeCoreSessions.advance(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-commit-operation", async (event, request) => {
  return runRendererNativeOperation("coreCommit", {
    fallbackCode: "NATIVE_CORE_COMMIT_FAILED",
    message: "原生影子事务提交失败，请重新检查影子状态",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return nativeCoreSessions.commitOperation(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-checkpoint", async (event, request) => {
  return runRendererNativeOperation("coreCheckpoint", {
    fallbackCode: "NATIVE_CORE_CHECKPOINT_FAILED",
    message: "原生影子检查点生成失败，请重试",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return nativeCoreSessions.checkpoint(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-export-v47", async (event, request) => {
  try {
    const ownerId = requireTrustedNativeSender(event);
    const suggestedName = typeof request?.suggestedName === "string" && /^[A-Za-z0-9._\-\u4e00-\u9fff]{1,160}\.json$/.test(request.suggestedName)
      ? request.suggestedName
      : `dsp-idle-native-${Date.now()}.json`;
    const prepared = normalizeRendererNativeResult("coreExport", await nativeCoreSessions.exportV47(ownerId, request));
    const sourcePath = path.join(nativeHostClient.rootPath, "exports", `${prepared.exportId}.json`);
    const sourceStat = await fs.promises.stat(sourcePath);
    const sourceSha256 = sourceStat.isFile() ? await sha256File(sourcePath) : "";
    if (!sourceStat.isFile() || sourceStat.size !== prepared.result.byteLength ||
      sourceSha256 !== prepared.result.envelopeSha256) {
      throw Object.assign(new Error("native export source identity mismatch"), {
        code: "NATIVE_CORE_V47_EXPORT_IDENTITY_INVALID",
      });
    }
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: "导出 DSP极简网络 v47 存档",
      defaultPath: path.join(app.getPath("downloads"), suggestedName),
      buttonLabel: "保存存档",
      filters: [{ name: "DSP极简网络存档", extensions: ["json"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (selection.canceled || !selection.filePath) {
      return {
        exportId: prepared.exportId,
        mode: prepared.mode,
        result: prepared.result,
        cancelled: true,
      };
    }
    const targetPath = path.resolve(selection.filePath);
    const targetDirectory = path.dirname(targetPath);
    const replacementToken = `${process.pid}-${Date.now()}-${prepared.exportId}`;
    const temporaryPath = path.join(targetDirectory, `.${path.basename(targetPath)}.${replacementToken}.part`);
    const backupPath = path.join(targetDirectory, `.${path.basename(targetPath)}.${replacementToken}.previous`);
    let existingTargetMoved = false;
    try {
      await fs.promises.copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
      const temporaryStat = await fs.promises.stat(temporaryPath);
      const temporarySha256 = temporaryStat.isFile() ? await sha256File(temporaryPath) : "";
      if (!temporaryStat.isFile() || temporaryStat.size !== prepared.result.byteLength ||
        temporarySha256 !== prepared.result.envelopeSha256) {
        throw Object.assign(new Error("native export copy identity mismatch"), {
          code: "NATIVE_CORE_V47_EXPORT_IDENTITY_INVALID",
        });
      }
      const targetStat = await fs.promises.lstat(targetPath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (targetStat && !targetStat.isFile()) {
        throw Object.assign(new Error("native export target is not a direct file"), {
          code: "NATIVE_CORE_V47_EXPORT_TARGET_INVALID",
        });
      }
      if (targetStat) {
        await fs.promises.rename(targetPath, backupPath);
        existingTargetMoved = true;
      }
      await fs.promises.rename(temporaryPath, targetPath);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
      if (existingTargetMoved) {
        const targetExists = await fs.promises.lstat(targetPath)
          .then(() => true)
          .catch((targetError) => targetError?.code === "ENOENT" ? false : true);
        if (!targetExists) await fs.promises.rename(backupPath, targetPath).catch(() => undefined);
      }
      throw error;
    }
    if (existingTargetMoved) await fs.promises.rm(backupPath, { force: true }).catch(() => undefined);
    return {
      exportId: prepared.exportId,
      mode: prepared.mode,
      result: prepared.result,
      cancelled: false,
      fileName: path.basename(targetPath),
    };
  } catch (error) {
    throw createRendererNativeError(error, {
      fallbackCode: "NATIVE_CORE_V47_EXPORT_FAILED",
      message: "原生 v47 存档导出失败；目标文件不会接收未经校验的内容",
    });
  }
});

ipcMain.handle("desktop:native-core-compare", async (event, request) => {
  return runRendererNativeOperation("coreCompare", {
    fallbackCode: "NATIVE_CORE_COMPARE_FAILED",
    message: "原生影子一致性比较失败，请重试",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return nativeCoreSessions.compare(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-close", async (event, request) => {
  return runRendererNativeOperation("coreClose", {
    fallbackCode: "NATIVE_CORE_CLOSE_FAILED",
    message: "原生影子会话关闭失败，请重新检查影子状态",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return nativeCoreSessions.close(ownerId, request?.sessionId);
  });
});

ipcMain.handle("desktop:api-request", requestCloudApi);

ipcMain.handle("desktop:download-account-archive", async (event, request) => {
  let requestId = null;
  let record = null;
  let completion = null;
  let resolveCompletion = null;
  try {
    if (!trustedSender(event)) throw new Error("账号归档下载来源无效");
    requestId = normalizeAccountArchiveRequestId(request?.requestId);
    const headers = normalizeRequestHeaders({ authorization: request?.authorization });
    const authorization = normalizeBearerAuthorization(headers.authorization);
    record = activeAccountArchiveDownloads.begin(requestId);

    const suggestedName = sanitizeArchiveFileName(request?.suggestedName);
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: "导出 DSP极简网络账号归档",
      defaultPath: path.join(app.getPath("downloads"), suggestedName),
      buttonLabel: "保存账号归档",
      filters: [{ name: "DSP极简网络账号归档", extensions: ["dspaccount.zip"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (selection.canceled || !selection.filePath) {
      return { ok: true, value: { cancelled: true, requestId } };
    }
    completion = new Promise((resolve) => { resolveCompletion = resolve; });
    activeAccountArchiveDownloadCompletions.add(completion);
    const target = resolveApiRequestUrl("/account/export/archive");
    const result = await downloadAccountArchiveToFile({
      url: target,
      targetPath: selection.filePath,
      authorization,
      signal: record.controller.signal,
    });
    return {
      ok: true,
      value: {
        cancelled: false,
        requestId,
        byteLength: result.byteLength,
        fileName: result.fileName,
      },
    };
  } catch (error) {
    return { ok: false, error: serializeAccountArchiveDownloadError(error) };
  } finally {
    if (requestId && record) activeAccountArchiveDownloads.finish(requestId, record);
    resolveCompletion?.();
    if (completion) activeAccountArchiveDownloadCompletions.delete(completion);
  }
});

ipcMain.on("desktop:cancel-account-archive-download", (event, requestId) => {
  if (!trustedSender(event) || !validRequestId(requestId)) return;
  activeAccountArchiveDownloads.cancel(requestId);
});

ipcMain.on("desktop:api-request-transfer", (event, request) => {
  const port = event.ports?.[0];
  if (!trustedSender(event) || !port) {
    if (port) postTransferError(port, new Error("API 调用来源无效"));
    return;
  }
  const requestId = request?.requestId;
  if (!validRequestId(requestId) || !Number.isSafeInteger(request?.bodyByteLength) || request.bodyByteLength < 0) {
    postTransferError(port, new Error("API 请求标识或正文长度无效"));
    return;
  }
  if (activeApiRequests.has(requestId)) {
    postTransferError(port, new Error("API 请求标识重复"));
    return;
  }
  if (activeApiRequests.size >= MAXIMUM_CONCURRENT_TRANSFER_REQUESTS) {
    postTransferError(port, Object.assign(new Error("桌面云请求过多，请稍后重试"), { code: "CLOUD_REQUEST_BUSY" }));
    return;
  }
  const normalizedTransferHeaders = normalizeRequestHeaders(request?.headers);
  const declaredBodyLimit = requestBodyLimit(normalizedTransferHeaders);
  if (request.bodyByteLength > declaredBodyLimit) {
    postTransferError(port, new Error("API 请求正文过大"));
    return;
  }
  normalizedTransferHeaders[cloudTransferContract.requestIdHeader] = requestId;
  request = { ...request, headers: normalizedTransferHeaders };
  const record = {
    controller: new AbortController(),
    port,
    cancelled: false,
    receivedBody: request.bodyByteLength === 0,
    receivedBytes: 0,
    intakeTimer: null,
    requestStream: new PassThrough({ highWaterMark: cloudTransferContract.ipcChunkBytes }),
    responseAck: null,
    responseAckTimer: null,
  };
  activeApiRequests.set(requestId, record);
  const armIntakeTimeout = () => {
    if (record.intakeTimer) clearTimeout(record.intakeTimer);
    record.intakeTimer = setTimeout(() => {
      if (!activeApiRequests.has(requestId) || record.receivedBody) return;
      record.cancelled = true;
      record.controller.abort();
      record.requestStream.destroy();
      activeApiRequests.delete(requestId);
      postTransferError(port, Object.assign(new Error("桌面云请求正文接收超时"), { name: "AbortError", code: "CLOUD_REQUEST_TIMEOUT" }));
    }, cloudTransferContract.baseTimeoutMs);
  };
  armIntakeTimeout();
  port.on("message", (messageEvent) => {
    const message = messageEvent.data;
    if (message?.responseAck !== undefined) {
      if (!record.responseAck || message.responseAck !== record.responseAck.expectedBytes) return;
      const { resolve } = record.responseAck;
      record.responseAck = null;
      resolve();
      return;
    }
    if (message?.requestChunk !== undefined) {
      if (record.receivedBody) {
        record.controller.abort();
        record.requestStream.destroy(new Error("API 请求正文已结束"));
        return;
      }
      let chunk;
      try { chunk = exactUint8Array(message.requestChunk); } catch (error) {
        record.controller.abort();
        record.requestStream.destroy(error);
        return;
      }
      record.receivedBytes += chunk.byteLength;
      if (chunk.byteLength === 0 || chunk.byteLength > cloudTransferContract.ipcChunkBytes || record.receivedBytes > request.bodyByteLength || message.offset !== record.receivedBytes) {
        record.controller.abort();
        record.requestStream.destroy(new Error("API 请求正文长度不一致"));
        return;
      }
      armIntakeTimeout();
      const acknowledgedBytes = record.receivedBytes;
      if (record.requestStream.write(Buffer.from(chunk))) port.postMessage({ requestAck: acknowledgedBytes });
      else record.requestStream.once("drain", () => {
        if (!record.cancelled) port.postMessage({ requestAck: acknowledgedBytes });
      });
      return;
    }
    if (message?.requestEnd) {
      if (message.totalBytes !== request.bodyByteLength || record.receivedBytes !== request.bodyByteLength) {
        record.controller.abort();
        record.requestStream.destroy(new Error("API 请求正文长度不一致"));
        return;
      }
      record.receivedBody = true;
      if (record.intakeTimer) clearTimeout(record.intakeTimer);
      record.requestStream.end();
    }
  });
  port.once("close", () => {
    if (!activeApiRequests.has(requestId)) return;
    record.cancelled = true;
    if (record.intakeTimer) clearTimeout(record.intakeTimer);
    if (record.responseAckTimer) clearTimeout(record.responseAckTimer);
    record.controller.abort();
    record.requestStream.destroy();
    record.responseAck?.reject(Object.assign(new Error("云存档上传已取消"), { name: "AbortError", code: "ABORTED" }));
    activeApiRequests.delete(requestId);
  });
  port.start();
  void requestCloudApiTransfer(event, request, port, record)
    .catch((error) => {
      if (!record.cancelled) postTransferError(port, error);
    })
    .finally(() => {
      activeApiRequests.delete(requestId);
    });
  if (request.bodyByteLength === 0) record.requestStream.end();
});

ipcMain.on("desktop:api-request-cancel", (event, requestId) => {
  if (!trustedSender(event) || !validRequestId(requestId)) return;
  const record = activeApiRequests.get(requestId);
  if (!record) return;
  record.cancelled = true;
  if (record.intakeTimer) clearTimeout(record.intakeTimer);
  if (record.responseAckTimer) clearTimeout(record.responseAckTimer);
  record.controller.abort();
  record.requestStream.destroy();
  record.responseAck?.reject(Object.assign(new Error("云存档上传已取消"), { name: "AbortError", code: "ABORTED" }));
  activeApiRequests.delete(requestId);
  postTransferError(record.port, Object.assign(new Error("云存档上传已取消"), { name: "AbortError", code: "ABORTED" }));
});

ipcMain.handle("desktop:check-for-updates", async () => {
  if (!updater || updateState.state === "checking" || updateState.state === "downloading") return updateState;
  try {
    await updater.checkForUpdates();
  } catch (error) {
    publishUpdateState({ state: "error", message: error instanceof Error ? error.message : "更新检查失败" });
  }
  return updateState;
});

ipcMain.handle("desktop:download-update", async () => {
  if (!updater || updateState.state !== "available") return updateState;
  try {
    publishUpdateState({ state: "downloading", message: "正在下载更新", progress: 0 });
    await updater.downloadUpdate();
  } catch (error) {
    publishUpdateState({ state: "error", message: error instanceof Error ? error.message : "更新下载失败", progress: undefined });
  }
  return updateState;
});

ipcMain.handle("desktop:update-ready", (event) => {
  if (!trustedSender(event) || !updateShutdownRequested) return;
  updateShutdownResolve?.();
  updateShutdownResolve = null;
});

async function requestRendererSaveBeforeUpdate() {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  const contents = window.webContents;
  if (contents.isDestroyed()) return;
  if (updateShutdownPromise) return updateShutdownPromise;
  updateShutdownRequested = true;
  updateShutdownPromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      updateShutdownResolve = null;
      resolve();
    };
    updateShutdownResolve = finish;
    if (!contents.isDestroyed()) contents.send("desktop:prepare-for-update");
    setTimeout(finish, 15_000);
  }).finally(() => {
    updateShutdownPromise = null;
  });
  await updateShutdownPromise;
}

ipcMain.handle("desktop:install-update", async () => {
  if (updateState.state !== "downloaded" || !updater) return { accepted: false };
  try {
    await requestRendererSaveBeforeUpdate();
    // quitAndInstall waits for the Electron process and its renderer to exit;
    // the renderer acknowledgement above ensures the last local save is on disk.
    setImmediate(() => updater.quitAndInstall(false, true));
    return { accepted: true };
  } catch (error) {
    publishUpdateState({ state: "error", message: `升级前保存失败：${error instanceof Error ? error.message : "未知错误"}` });
    return { accepted: false };
  }
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId(PERFORMANCE_EDITION_IDENTITY.appUserModelId);
    Menu.setApplicationMenu(null);
    configureAutoUpdater();
    initializeNativePerformancePolicy();
    await initializeNativeHost();
    if (!nativeExactRealtimeStartupStatus.normalWindowAllowed) {
      dialog.showErrorBox("原生权威恢复需要处理", nativeExactRealtimeStartupStatus.message);
      app.quit();
      return;
    }
    createWindow();
    if (updater) {
      setTimeout(() => void updater.checkForUpdates().catch((error) => {
        publishUpdateState({ state: "error", message: error instanceof Error ? error.message : "更新检查失败" });
      }), 15_000);
      updateTimer = setInterval(() => void updater.checkForUpdates().catch(() => undefined), UPDATE_CHECK_INTERVAL_MS);
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error) => {
    console.error("Desktop startup failed", error);
    dialog.showErrorBox("启动失败", `${PERFORMANCE_EDITION_IDENTITY.productName} 无法启动：${error instanceof Error ? error.message : "未知错误"}`);
    app.quit();
  });
}

app.on("before-quit", (event) => {
  persistWindowState();
  cancelAllAccountArchiveDownloads();
  if (updateTimer) clearInterval(updateTimer);
  const accountArchiveReady = accountArchiveQuitDrainComplete || activeAccountArchiveDownloadCompletions.size === 0;
  const nativeHostReady = nativeHostQuitDrainComplete || !nativeHostClient || nativeHostClient.exited;
  if (accountArchiveReady && nativeHostReady) return;
  event.preventDefault();
  if (accountArchiveQuitDrainPromise || nativeHostQuitDrainPromise) return;
  const pending = [...activeAccountArchiveDownloadCompletions];
  accountArchiveQuitDrainPromise = Promise.allSettled(pending).finally(() => {
    accountArchiveQuitDrainComplete = true;
  });
  nativeHostQuitDrainPromise = (nativeHostClient ? nativeHostClient.stop() : Promise.resolve()).finally(() => {
    nativeHostQuitDrainComplete = true;
  });
  void Promise.allSettled([accountArchiveQuitDrainPromise, nativeHostQuitDrainPromise]).finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
