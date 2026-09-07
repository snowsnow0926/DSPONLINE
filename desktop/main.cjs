const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell, session } = require("electron");
require("./isolated-test-network.cjs").installIsolatedTestNetwork({ app, session, shell, metadata: require("../package.json") });
const { createHash, randomUUID } = require("node:crypto");
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
const { NativePlayerAuthorityRuntime } = require("./native-player-authority-runtime.cjs");
const {
  NativePlayerAuthorityHandoffCoordinator,
  QUIESCENCE_ACK_KIND,
} = require("./native-player-authority-handoff.cjs");
const {
  CANCEL_REQUEST_KIND: NATIVE_PLAYER_AUTHORITY_HANDOFF_CANCEL_REQUEST_KIND,
  COMMIT_REQUEST_KIND: NATIVE_PLAYER_AUTHORITY_HANDOFF_COMMIT_REQUEST_KIND,
  COMPLETE_REQUEST_KIND: NATIVE_PLAYER_AUTHORITY_HANDOFF_COMPLETE_REQUEST_KIND,
  NativePlayerAuthorityBoundedRetryCoordinator,
  NativePlayerAuthorityHandoffIpcBridge,
  PREPARE_REQUEST_KIND: NATIVE_PLAYER_AUTHORITY_HANDOFF_PREPARE_REQUEST_KIND,
  RELEASE_REQUEST_KIND: NATIVE_PLAYER_AUTHORITY_HANDOFF_RELEASE_REQUEST_KIND,
  RENDERER_READY_CHANNEL: NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_READY_CHANNEL,
  RENDERER_READY_KIND: NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_READY_KIND,
  RESPONSE_CHANNEL: NATIVE_PLAYER_AUTHORITY_HANDOFF_RESPONSE_CHANNEL,
  STARTUP_RECONCILE_REQUEST_KIND: NATIVE_PLAYER_AUTHORITY_STARTUP_RECONCILE_REQUEST_KIND,
  startupReconciliationIsTerminalResolved,
} = require("./native-player-authority-handoff-ipc.cjs");
const {
  NativePlayerAuthorityCommandBroker,
} = require("./native-player-authority-command-broker.cjs");
const {
  NativePlayerAuthoritySystemSpaceStationBroker,
} = require("./native-player-authority-system-space-station-broker.cjs");
const {
  createMonotonicOrbitalContractClock,
  NativePlayerAuthorityOrbitalContractBroker,
} = require("./native-player-authority-orbital-contract-broker.cjs");
const {
  NativePlayerAuthorityOperationsSettingBroker,
} = require("./native-player-authority-operations-setting-broker.cjs");
const {
  NativePlayerAuthorityMacroBroker,
} = require("./native-player-authority-macro-broker.cjs");
const {
  nativeProjectionHasPlayerAuthorityRun,
  NativePlayerAuthorityProjectionBroker,
  NativePlayerAuthorityProjectionBrokerError,
  routeNativeProjectionRead,
} = require("./native-player-authority-projection-broker.cjs");
const {
  NativePlayerAuthorityPersistenceBroker,
} = require("./native-player-authority-persistence-broker.cjs");
const {
  NativeProjectionSubscription,
  normalizeSubscriptionRequest,
  summarizeNativeProjectionSubscriptions,
} = require("./native-projection-subscription.cjs");
const {
  NativeAuthorityCloudTransfer,
} = require("./native-authority-cloud-transfer.cjs");
const {
  NativePlayerAuthorityStateBroker,
} = require("./native-player-authority-state-broker.cjs");
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
  initializeDesktopEditionIdentity,
} = require("./performance-edition-identity.cjs");
const {
  createRendererNativeError,
  normalizeRendererNativeResult,
  rendererNativeErrorCode,
  serializeRendererNativeError,
} = require("./native-renderer-boundary.cjs");
const {
  streamNativeOfflineStartupCandidate,
} = require("./native-offline-startup-transfer.cjs");
const { RuntimeDiagnosticsSampler } = require("./runtime-diagnostics.cjs");
const { initializeShellRuntimePolicy } = require("./shell-runtime-policy.cjs");
const packageMetadata = require("../package.json");

const isDevelopment = Boolean(process.env.DSP_DESKTOP_DEV_URL);
const desktopRuntimeIdentity = initializeDesktopEditionIdentity({
  metadata: packageMetadata,
  requestedEdition: isDevelopment ? process.env.DSP_DESKTOP_EDITION : undefined,
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

const sampleNativeOfflineStartupWallClock = createMonotonicOrbitalContractClock();
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
// Main-owned development gate. Domain coverage remains an independent hard
// gate inside Rust and the coordinator; setting this flag can never bypass it.
const nativePlayerAuthorityHandoffFeatureEnabled =
  process.env.DSP_NATIVE_PLAYER_AUTHORITY_HANDOFF === "1";
const NATIVE_PLAYER_AUTHORITY_HANDOFF_TIMEOUT_MS = 15_000;

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
let nativePlayerAuthorityRuntime = null;
let nativePlayerAuthorityRestartScheduled = false;
let nativePlayerAuthorityCommandBroker = null;
let nativePlayerAuthoritySystemSpaceStationBroker = null;
let nativePlayerAuthorityOrbitalContractBroker = null;
let nativePlayerAuthorityOperationsSettingBroker = null;
let nativePlayerAuthorityMacroBroker = null;
let nativePlayerAuthorityProjectionBroker = null;
let nativePlayerAuthorityPersistenceBroker = null;
let nativePlayerAuthorityStateBroker = null;
const nativeProjectionSubscriptions = new Map();
const nativeProjectionSubscriptionHistory = [];
let nativePlayerAuthorityHandoffIpcBridge = null;
let nativePlayerAuthorityHandoffCoordinator = null;
let nativePlayerAuthorityHandoffAttempt = null;
let nativePlayerAuthorityDeferredHandoff = null;
let nativePlayerAuthorityStartupReconcileObservation = Object.freeze({ state: "unknown" });
let nativePlayerAuthorityStartupReconcileRetry = null;
let nativePlayerAuthorityHandoffCompletionRetry = null;
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

function validatedNativePlayerAuthorityState(rendererOwnerId) {
  if (!nativePlayerAuthorityRuntime || !nativePlayerAuthorityStateBroker || !nativeCoreSessions) {
    throw new Error("Windows 原生玩家权威时钟不可用");
  }
  const authoritySnapshot = nativePlayerAuthorityRuntime.snapshot();
  const authoritySessionId = authoritySnapshot?.sessionId;
  if (authoritySessionId !== null) {
    if (!validNativeLogicalId(authoritySessionId)) {
      throw new Error("Windows 原生玩家权威会话无效");
    }
    const owned = nativeCoreSessions.inspectSession("main-player-authority", authoritySessionId);
    if (owned.ownerId !== "main-player-authority" || owned.slot !== "normal-main" ||
        owned.state !== "owned") {
      throw new Error("Windows 原生玩家权威会话不一致");
    }
  }
  const state = nativePlayerAuthorityStateBroker.read(rendererOwnerId);
  return normalizeRendererNativeResult("playerAuthorityState", state);
}

function publishNativePlayerAuthorityState(_snapshot) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try {
    // Treat the transition only as a wake-up signal. Reading through the
    // trusted broker is essential for macro states: it validates the internal
    // authority identity and then redacts every session/run/macro/operation ID
    // before the payload reaches the renderer.
    const state = validatedNativePlayerAuthorityState(mainWindow.webContents.id);
    mainWindow.webContents.send("desktop:native-player-authority-state-changed", state);
  } catch {
    // A malformed or stale authority snapshot is never delivered. The pull
    // endpoint remains available for the renderer to recover a later exact state.
  }
}

function validNativeLogicalId(value, maximumLength = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function trustedRendererForNativePlayerAuthority(ownerId) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed() ||
      mainWindow.webContents.id !== ownerId) return null;
  return mainWindow.webContents;
}

function nativePlayerAuthoritySummaryEligible(summary) {
  return summary?.revision >= 0 && summary?.stateVersion === 47 && summary?.mode === "normal" &&
    summary?.paused === false && summary?.coverage?.authorityEligible === true;
}

function recordActiveNativePlayerAuthorityObservation(identity, entryCheckpoint, checkpoint, summary) {
  nativePlayerAuthorityStartupReconcileObservation = Object.freeze({
    state: "active",
    runId: identity.runId,
    sessionId: identity.sessionId,
    stateVersion: 47,
    mode: "normal",
    entryCheckpoint: Object.freeze({ ...entryCheckpoint }),
    checkpoint: Object.freeze({ ...checkpoint }),
    summary,
  });
}

const NATIVE_PLAYER_AUTHORITY_RETRYABLE_CODES = new Set([
  "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
  "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_STALE",
  "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_BUSY",
  "NATIVE_PLAYER_AUTHORITY_HANDOFF_IPC_TIMEOUT",
  "NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_UNAVAILABLE",
  "NATIVE_PLAYER_AUTHORITY_QUIESCENCE_BUSY",
  "NATIVE_PLAYER_AUTHORITY_QUIESCENCE_TIMEOUT",
  "NATIVE_PLAYER_AUTHORITY_COMPLETION_STALE",
  "NATIVE_PLAYER_AUTHORITY_HANDOFF_COMPLETION_STALE",
]);

function retryableNativePlayerAuthorityBoundaryError(error) {
  return NATIVE_PLAYER_AUTHORITY_RETRYABLE_CODES.has(error?.code);
}

function nativePlayerAuthorityStartupReconciliationTerminal(rendererOwnerId) {
  const state = nativePlayerAuthorityStartupReconcileRetry?.snapshot();
  return state?.phase === "terminal" && state.rendererOwnerId === rendererOwnerId &&
    Boolean(trustedRendererForNativePlayerAuthority(rendererOwnerId));
}

function cancelNativePlayerAuthorityRetriesForOwner(rendererOwnerId) {
  nativePlayerAuthorityStartupReconcileRetry?.cancelOwner(rendererOwnerId);
  nativePlayerAuthorityHandoffCompletionRetry?.cancelOwner(rendererOwnerId);
}

function resetNativePlayerAuthorityRetryCoordinators() {
  nativePlayerAuthorityStartupReconcileRetry?.shutdown();
  nativePlayerAuthorityHandoffCompletionRetry?.shutdown();
  nativePlayerAuthorityStartupReconcileRetry = null;
  nativePlayerAuthorityHandoffCompletionRetry = null;
}

async function cancelPreparedNativePlayerAuthorityHandoff(rendererOwnerId, identity) {
  if (!nativePlayerAuthorityHandoffIpcBridge) return;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await nativePlayerAuthorityHandoffIpcBridge.request(rendererOwnerId, {
        kind: NATIVE_PLAYER_AUTHORITY_HANDOFF_CANCEL_REQUEST_KIND,
        handoffId: identity.handoffId,
        sessionId: identity.sessionId,
        runId: identity.runId,
        releaseAuthorized: true,
        browserFenceAcquired: false,
      }, NATIVE_PLAYER_AUTHORITY_HANDOFF_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("native player-authority prepare cancellation is uncertain");
}

async function performNativePlayerAuthorityHandoff(rendererOwnerId, opened) {
  if (!nativePlayerAuthorityHandoffFeatureEnabled || nativePlayerAuthorityHandoffAttempt ||
      !nativePlayerAuthorityHandoffIpcBridge || !nativeCoreSessions || !nativePlayerAuthorityRuntime ||
      !nativePlayerAuthoritySummaryEligible(opened?.summary) ||
      nativePlayerAuthorityRuntime.snapshot().phase !== "idle") return null;
  const identity = Object.freeze({
    handoffId: `handoff-${randomUUID()}`,
    runId: `player-run-${randomUUID()}`,
    sessionId: opened.sessionId,
  });
  let prepareDispatched = false;
  let coordinatorStarted = false;
  const operation = (async () => {
    try {
      prepareDispatched = true;
      const preparedResult = await nativePlayerAuthorityHandoffIpcBridge.request(rendererOwnerId, {
        kind: NATIVE_PLAYER_AUTHORITY_HANDOFF_PREPARE_REQUEST_KIND,
        ...identity,
        initialRevision: opened.summary.revision,
        timeoutMs: NATIVE_PLAYER_AUTHORITY_HANDOFF_TIMEOUT_MS,
      }, NATIVE_PLAYER_AUTHORITY_HANDOFF_TIMEOUT_MS);

      // The renderer has invalidated its legacy async generation and drained
      // all JS/Worker/save/cloud work. Only now is the final Rust checkpoint
      // generated, so it cannot race a queued shadow replay.
      const preCheckpointStatus = normalizeRendererNativeResult(
        "coreSummary",
        await nativeCoreSessions.status(rendererOwnerId, identity.sessionId),
      );
      if (!nativePlayerAuthoritySummaryEligible(preCheckpointStatus)) {
        throw Object.assign(new Error("native player-authority coverage is incomplete"), {
          code: "NATIVE_PLAYER_AUTHORITY_HANDOFF_COVERAGE_INCOMPLETE",
        });
      }
      const savedAtMs = Date.now();
      const checkpointResult = normalizeRendererNativeResult(
        "coreCheckpoint",
        await nativeCoreSessions.checkpoint(rendererOwnerId, {
          sessionId: identity.sessionId,
          savedAtMs,
        }),
      );
      if (!nativePlayerAuthoritySummaryEligible(checkpointResult.summary)) {
        throw Object.assign(new Error("native player-authority checkpoint coverage is incomplete"), {
          code: "NATIVE_PLAYER_AUTHORITY_HANDOFF_COVERAGE_INCOMPLETE",
        });
      }
      const expectedCheckpoint = Object.freeze({
        generation: checkpointResult.checkpoint.generation,
        rootHash: checkpointResult.checkpoint.rootHash,
        revision: checkpointResult.checkpoint.revision,
      });
      let browserFence = null;
      const coordinator = new NativePlayerAuthorityHandoffCoordinator({
        registry: nativeCoreSessions,
        runtime: nativePlayerAuthorityRuntime,
        mainOwnerId: "main-player-authority",
        requestQuiescence: async (request) => {
          const fenced = await nativePlayerAuthorityHandoffIpcBridge.request(rendererOwnerId, {
            kind: NATIVE_PLAYER_AUTHORITY_HANDOFF_COMMIT_REQUEST_KIND,
            handoffId: request.handoffId,
            sessionId: request.sessionId,
            runId: request.runId,
            revision: request.expectedRevision,
            checkpoint: request.expectedCheckpoint,
            publicWriterFence: request.publicWriterFence,
            settledDeadlineMs: request.settledDeadlineMs,
          }, request.timeoutMs);
          browserFence = fenced;
          return Object.freeze({
            kind: QUIESCENCE_ACK_KIND,
            handoffId: request.handoffId,
            sessionId: request.sessionId,
            runId: request.runId,
            ownerId: request.rendererOwnerId,
            revision: request.expectedRevision,
            checkpoint: request.expectedCheckpoint,
            publicWriterFence: request.publicWriterFence,
            settledDeadlineMs: request.settledDeadlineMs,
            rendererInFlightCoreOperations: fenced.rendererInFlightCoreOperations,
            workerInFlightCoreOperations: fenced.workerInFlightCoreOperations,
          });
        },
        releaseQuiescence: async (request) => {
          if (!browserFence || request.releaseAuthorized !== true) {
            throw Object.assign(new Error("browser-fence release identity is unavailable"), {
              code: "NATIVE_PLAYER_AUTHORITY_HANDOFF_RELEASE_UNCERTAIN",
            });
          }
          await nativePlayerAuthorityHandoffIpcBridge.request(rendererOwnerId, {
            kind: NATIVE_PLAYER_AUTHORITY_HANDOFF_RELEASE_REQUEST_KIND,
            handoffId: request.handoffId,
            sessionId: request.sessionId,
            runId: request.runId,
            checkpoint: request.checkpoint,
            receipt: browserFence.leaseReceipt,
            releaseAuthorized: true,
            decision: {
              action: "release-browser-fence",
              reason: "rust-lease-absent-release-authorized",
              runId: request.runId,
              sessionId: request.sessionId,
              checkpoint: request.checkpoint,
            },
          }, NATIVE_PLAYER_AUTHORITY_HANDOFF_TIMEOUT_MS);
        },
      });
      nativePlayerAuthorityHandoffCoordinator = coordinator;
      coordinatorStarted = true;
      const handoff = await coordinator.handoff({
        ...identity,
        rendererOwnerId,
        expectedRevision: expectedCheckpoint.revision,
        expectedCheckpoint,
        publicWriterFence: preparedResult.publicWriterFence,
        settledDeadlineMs: preparedResult.settledDeadlineMs,
        timeoutMs: NATIVE_PLAYER_AUTHORITY_HANDOFF_TIMEOUT_MS,
      });
      if (handoff.phase !== "active" || !browserFence || !nativePlayerAuthorityPersistenceBroker) {
        throw Object.assign(new Error("native player-authority completion boundary is unavailable"), {
          code: "NATIVE_PLAYER_AUTHORITY_HANDOFF_COMPLETION_UNAVAILABLE",
        });
      }
      // Rust owns the session from this point onward even if the renderer ACK
      // is lost or the document reloads. Keep the main-owned startup
      // observation current so the next renderer can rebind instead of seeing
      // the pre-handoff "absent" observation.
      recordActiveNativePlayerAuthorityObservation(
        identity,
        expectedCheckpoint,
        expectedCheckpoint,
        checkpointResult.summary,
      );
      nativePlayerAuthorityPersistenceBroker.clearRendererBinding(rendererOwnerId);
      // Ownership has already moved to main. From this point forward there is
      // no legal browser hand-back. Retry only the idempotent completion bind,
      // and hold one settled persistence boundary across checkpoint capture,
      // renderer refresh/drain, and the exact completion ACK.
      const completionRetry = new NativePlayerAuthorityBoundedRetryCoordinator({
        operation: (ownerId) => nativePlayerAuthorityPersistenceBroker.withHandoffCompletion(
          ownerId,
          async (durable) => {
            if (durable.authority.sessionId !== identity.sessionId ||
                durable.authority.runId !== identity.runId ||
                durable.authority.revision !== durable.checkpoint.revision) {
              throw Object.assign(new Error("native player-authority completion lineage changed"), {
                code: "NATIVE_PLAYER_AUTHORITY_HANDOFF_COMPLETION_STALE",
              });
            }
            const completed = await nativePlayerAuthorityHandoffIpcBridge.request(ownerId, {
              kind: NATIVE_PLAYER_AUTHORITY_HANDOFF_COMPLETE_REQUEST_KIND,
              ...identity,
              revision: durable.checkpoint.revision,
              checkpoint: durable.checkpoint,
              nativeWriterFence: browserFence.leaseReceipt.nativeWriterFence,
              summary: durable.summary,
            }, NATIVE_PLAYER_AUTHORITY_HANDOFF_TIMEOUT_MS);
            recordActiveNativePlayerAuthorityObservation(
              durable.authority,
              expectedCheckpoint,
              durable.checkpoint,
              durable.summary,
            );
            nativePlayerAuthorityPersistenceBroker.bindRendererAuthority(ownerId, durable.authority);
            return completed;
          },
        ),
        isTerminalResult: (result) => result?.kind === "native-player-authority-handoff-completed-v1",
        isOwnerAvailable: (ownerId) => Boolean(trustedRendererForNativePlayerAuthority(ownerId)),
        shouldRetryError: retryableNativePlayerAuthorityBoundaryError,
      });
      nativePlayerAuthorityHandoffCompletionRetry = completionRetry;
      try {
        await completionRetry.start(rendererOwnerId);
      } finally {
        if (nativePlayerAuthorityHandoffCompletionRetry === completionRetry &&
            completionRetry.snapshot().phase === "terminal") {
          nativePlayerAuthorityHandoffCompletionRetry = null;
        }
      }
      return handoff;
    } catch (error) {
      if (prepareDispatched && !coordinatorStarted) {
        await cancelPreparedNativePlayerAuthorityHandoff(rendererOwnerId, identity).catch(() => undefined);
      }
      throw error;
    }
  })();
  nativePlayerAuthorityHandoffAttempt = operation;
  try {
    return await operation;
  } finally {
    if (nativePlayerAuthorityHandoffAttempt === operation) nativePlayerAuthorityHandoffAttempt = null;
    if (nativePlayerAuthorityHandoffCoordinator?.snapshot().phase === "blocked") {
      nativePlayerAuthorityHandoffCoordinator = null;
    }
  }
}

async function reconcileNativePlayerAuthorityStartupWithRenderer(rendererOwnerId) {
  if (!nativePlayerAuthorityHandoffIpcBridge) return null;
  let observation = nativePlayerAuthorityStartupReconcileObservation;
  const recoveredRuntimePhase = nativePlayerAuthorityRuntime?.snapshot().phase ?? null;
  if (observation.state === "active" &&
      !["active", "paused", "macro-active"].includes(recoveredRuntimePhase)) {
    observation = Object.freeze({ state: "unknown" });
  }
  const handoffId = `startup-reconcile-${randomUUID()}`;
  const challenge = (rustLease) => nativePlayerAuthorityHandoffIpcBridge.request(rendererOwnerId, {
    kind: NATIVE_PLAYER_AUTHORITY_STARTUP_RECONCILE_REQUEST_KIND,
    handoffId,
    rustLease,
    releaseAuthorized: rustLease.state === "absent",
    timeoutMs: NATIVE_PLAYER_AUTHORITY_HANDOFF_TIMEOUT_MS,
  }, NATIVE_PLAYER_AUTHORITY_HANDOFF_TIMEOUT_MS);
  if (observation.state === "active" &&
      ["active", "paused", "macro-active"].includes(recoveredRuntimePhase) &&
      nativePlayerAuthorityPersistenceBroker) {
    // Keep the exact clock frozen from checkpoint capture through renderer
    // drain and ACK. The outer retry coordinator starts a fresh atomic attempt
    // after BUSY, timeout, or a non-terminal fail-closed response.
    const entryCheckpoint = observation.entryCheckpoint;
    return nativePlayerAuthorityPersistenceBroker.withStartupReconciliation(
      rendererOwnerId,
      async (durable) => {
        if (durable.authority.sessionId !== observation.sessionId ||
            durable.authority.runId !== observation.runId ||
            durable.authority.revision !== durable.checkpoint.revision) {
          throw Object.assign(new Error("native player-authority startup lineage changed"), {
            code: "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_STALE",
          });
        }
        const result = await challenge(Object.freeze({
          ...observation,
          checkpoint: durable.checkpoint,
          summary: durable.summary,
        }));
        if (result?.action === "resumed-native") {
          recordActiveNativePlayerAuthorityObservation(
            durable.authority,
            entryCheckpoint,
            durable.checkpoint,
            durable.summary,
          );
          nativePlayerAuthorityPersistenceBroker.bindRendererAuthority(rendererOwnerId, durable.authority);
        }
        return result;
      },
    );
  }
  const result = await challenge(observation);
  if (result?.action === "resumed-native" && observation.state === "active" &&
      nativePlayerAuthorityPersistenceBroker) {
    nativePlayerAuthorityPersistenceBroker.bindRendererAuthority(rendererOwnerId, {
      sessionId: observation.sessionId,
      runId: observation.runId,
      revision: observation.checkpoint.revision,
    });
  }
  return result;
}

function beginNativePlayerAuthorityStartupReconciliation(rendererOwnerId) {
  if (!nativePlayerAuthorityStartupReconcileRetry) {
    nativePlayerAuthorityStartupReconcileRetry = new NativePlayerAuthorityBoundedRetryCoordinator({
      operation: reconcileNativePlayerAuthorityStartupWithRenderer,
      isTerminalResult: startupReconciliationIsTerminalResolved,
      isOwnerAvailable: (ownerId) => Boolean(trustedRendererForNativePlayerAuthority(ownerId)),
      shouldRetryError: retryableNativePlayerAuthorityBoundaryError,
    });
  }
  const retry = nativePlayerAuthorityStartupReconcileRetry;
  const completion = retry.start(rendererOwnerId);
  void completion.then(() => {
    if (nativePlayerAuthorityStartupReconcileRetry !== retry || retry.snapshot().phase !== "terminal") return;
    const deferred = nativePlayerAuthorityDeferredHandoff;
    nativePlayerAuthorityDeferredHandoff = null;
    if (deferred) scheduleNativePlayerAuthorityHandoff(deferred.rendererOwnerId, deferred.opened);
  }, () => undefined);
  return completion;
}

function scheduleNativePlayerAuthorityHandoff(rendererOwnerId, opened) {
  if (!nativePlayerAuthorityHandoffFeatureEnabled || !nativePlayerAuthoritySummaryEligible(opened?.summary)) return;
  if (!nativePlayerAuthorityStartupReconciliationTerminal(rendererOwnerId)) {
    nativePlayerAuthorityDeferredHandoff = Object.freeze({ rendererOwnerId, opened });
    return;
  }
  setImmediate(() => {
    void performNativePlayerAuthorityHandoff(rendererOwnerId, opened).catch(() => undefined);
  });
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
  const rootPath = resolveFixedNativeSaveRootPath(
    desktopRuntimeIdentity.userDataPath,
    path,
    desktopRuntimeIdentity.userDataDirectoryName,
  );
  const inspectWithoutHost = () => inspectNativeExactRealtimeStartupWithoutHost({
    desktopUserDataPath: desktopRuntimeIdentity.userDataPath,
    expectedUserDataDirectoryName: desktopRuntimeIdentity.userDataDirectoryName,
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
    nativeSaveSessions = new NativeSaveSessionRegistry(nativeHostClient, {
      // The Rust Host creates this fixed root before hello.  The JavaScript
      // preflight uses a non-existent probe filename only to query the same
      // filesystem; it never creates or removes the probe.
      diskBudgetTargetPath: path.join(rootPath, ".native-save-space-probe"),
    });
    nativeCoreSessions = new NativeCoreSessionRegistry(nativeHostClient);
    nativePlayerAuthorityHandoffIpcBridge = new NativePlayerAuthorityHandoffIpcBridge({
      getRenderer: trustedRendererForNativePlayerAuthority,
    });
    // Main-owned only. There is deliberately no renderer IPC that can call
    // activate/tick. The internal challenge below can cut over only after the
    // Rust coverage gate and the public-primary browser fence both succeed.
    const playerAuthorityOwnerId = "main-player-authority";
    const samplePlayerAuthorityWallClock = createMonotonicOrbitalContractClock();
    nativePlayerAuthorityRuntime = new NativePlayerAuthorityRuntime({
      registry: nativeCoreSessions,
      ownerId: playerAuthorityOwnerId,
      now: samplePlayerAuthorityWallClock,
      onTransition: publishNativePlayerAuthorityState,
    });
    nativePlayerAuthorityStateBroker = new NativePlayerAuthorityStateBroker({
      runtime: nativePlayerAuthorityRuntime,
      getMacroRecoveryHint: () => nativePlayerAuthorityMacroBroker?.recoveryHint() ?? null,
      isTrustedRendererOwner: (ownerId) => Boolean(
        mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === ownerId,
      ),
    });
    const playerAuthorityStartupRecovery =
      nativeCoreSessions.takePlayerAuthorityStartupRecovery(playerAuthorityOwnerId);
    if (playerAuthorityStartupRecovery) {
      nativePlayerAuthorityRuntime.resumeFromStartupRecovery(playerAuthorityStartupRecovery);
    }
    nativePlayerAuthorityCommandBroker = new NativePlayerAuthorityCommandBroker({
      runtime: nativePlayerAuthorityRuntime,
      onCommittedCommand: (receipt) =>
        nativePlayerAuthorityMacroBroker?.observeCommittedCommand(receipt),
      isTrustedRendererOwner: (ownerId) => Boolean(
        mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === ownerId,
      ),
    });
    nativePlayerAuthoritySystemSpaceStationBroker =
      new NativePlayerAuthoritySystemSpaceStationBroker({
        runtime: nativePlayerAuthorityRuntime,
        isTrustedRendererOwner: (ownerId) => Boolean(
          mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === ownerId,
        ),
      });
    nativePlayerAuthorityOrbitalContractBroker =
      new NativePlayerAuthorityOrbitalContractBroker({
        runtime: nativePlayerAuthorityRuntime,
        now: samplePlayerAuthorityWallClock,
        isTrustedRendererOwner: (ownerId) => Boolean(
          mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === ownerId,
        ),
      });
    nativePlayerAuthorityOperationsSettingBroker =
      new NativePlayerAuthorityOperationsSettingBroker({
        runtime: nativePlayerAuthorityRuntime,
        isTrustedRendererOwner: (ownerId) => Boolean(
          mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === ownerId,
        ),
      });
    // Main-process-owned. The renderer supplies only one optimistic start
    // revision plus its same-revision multiplier observation, followed by
    // parameter-free continue/finish intents. This broker derives every wall
    // and simulation budget from the same monotonic main clock used by the
    // durable exact scheduler; identities and retry state stay in main/Rust.
    nativePlayerAuthorityMacroBroker = new NativePlayerAuthorityMacroBroker({
      runtime: nativePlayerAuthorityRuntime,
      now: samplePlayerAuthorityWallClock,
      ...(playerAuthorityStartupRecovery?.recoveredMacroOperationId
        ? { recoveredOperationId: playerAuthorityStartupRecovery.recoveredMacroOperationId }
        : {}),
      ...(playerAuthorityStartupRecovery?.macroSessionId
        ? {
            recoveredSimulationMilliseconds:
              playerAuthorityStartupRecovery.macroSimulationMilliseconds,
            recoveredWallMilliseconds:
              playerAuthorityStartupRecovery.macroWallMilliseconds,
          }
        : {}),
      ...(playerAuthorityStartupRecovery?.pendingMacroCleanupSessionId
        ? {
            pendingMacroCleanupSessionId:
              playerAuthorityStartupRecovery.pendingMacroCleanupSessionId,
            pendingMacroCleanupRevision:
              playerAuthorityStartupRecovery.pendingMacroCleanupRevision,
          }
        : {}),
    });
    nativePlayerAuthorityProjectionBroker = new NativePlayerAuthorityProjectionBroker({
      runtime: nativePlayerAuthorityRuntime,
      registry: nativeCoreSessions,
      ownerId: playerAuthorityOwnerId,
      now: samplePlayerAuthorityWallClock,
      isTrustedRendererOwner: (ownerId) => Boolean(
        mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === ownerId,
      ),
    });
    nativePlayerAuthorityPersistenceBroker = new NativePlayerAuthorityPersistenceBroker({
      runtime: nativePlayerAuthorityRuntime,
      registry: nativeCoreSessions,
      ownerId: playerAuthorityOwnerId,
      isTrustedRendererOwner: (ownerId) => Boolean(
        mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === ownerId,
      ),
    });
    const inspectedExactRealtimeStartup = await inspectNativeExactRealtimeStartup({
      leaseStore: new NativeCoreExactRealtimeRustLeaseStore({
        leaseRegistry: new NativeExactRealtimeLeaseRegistry(nativeHostClient),
      }),
      environment: process.env,
    });
    nativeExactRealtimeStartupStatus = playerAuthorityStartupRecovery
      ? {
        ...inspectedExactRealtimeStartup,
        state: "player-authority-recovered",
        leaseState: "valid",
        leasePhase: playerAuthorityStartupRecovery.paused ? "paused" : "active",
        code: null,
        normalWindowAllowed: true,
        message: playerAuthorityStartupRecovery.macroSessionId
          ? "已恢复 Windows 原生纯挂机结算；普通确定性时钟保持暂停"
          : playerAuthorityStartupRecovery.paused
            ? "已恢复 Windows 原生玩家权威会话；模拟保持玩家暂停状态"
          : "已恢复 Windows 原生玩家权威会话并继续确定性时钟",
      }
      : inspectedExactRealtimeStartup;
    nativePlayerAuthorityStartupReconcileObservation = playerAuthorityStartupRecovery?.entryCheckpoint
      ? Object.freeze({
        state: "active",
        runId: playerAuthorityStartupRecovery.runId,
        sessionId: playerAuthorityStartupRecovery.sessionId,
        stateVersion: 47,
        mode: "normal",
        entryCheckpoint: playerAuthorityStartupRecovery.entryCheckpoint,
        checkpoint: playerAuthorityStartupRecovery.checkpoint,
        summary: playerAuthorityStartupRecovery.summary,
      })
      : Object.freeze({
        state: !playerAuthorityStartupRecovery && inspectedExactRealtimeStartup.leaseState === "missing"
          ? "absent"
          : "unknown",
      });
    resetNativePlayerAuthorityRetryCoordinators();
    nativePlayerAuthorityDeferredHandoff = null;
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
    nativePlayerAuthorityRuntime?.shutdownForProcessExit();
    nativePlayerAuthorityRuntime = null;
    nativePlayerAuthorityCommandBroker = null;
    nativePlayerAuthoritySystemSpaceStationBroker = null;
    nativePlayerAuthorityOrbitalContractBroker = null;
    nativePlayerAuthorityOperationsSettingBroker = null;
    nativePlayerAuthorityMacroBroker = null;
    nativePlayerAuthorityProjectionBroker = null;
    nativePlayerAuthorityPersistenceBroker = null;
    nativePlayerAuthorityStateBroker = null;
    // Startup reconciliation remains available even when the host failed:
    // an explicit fixed-root "absent" result is what authorizes an IndexedDB
    // N+2 hand-back. Unknown/blocked observations still fail closed.
    nativePlayerAuthorityHandoffIpcBridge = new NativePlayerAuthorityHandoffIpcBridge({
      getRenderer: trustedRendererForNativePlayerAuthority,
    });
    nativePlayerAuthorityHandoffCoordinator = null;
    nativePlayerAuthorityHandoffAttempt = null;
    nativePlayerAuthorityDeferredHandoff = null;
    nativePlayerAuthorityStartupReconcileObservation = Object.freeze({
      state: nativeExactRealtimeStartupStatus.leaseState === "missing" ? "absent" : "unknown",
    });
    resetNativePlayerAuthorityRetryCoordinators();
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

function postNativeOfflineStartupTransferError(port, error) {
  const safe = serializeRendererNativeError(error, {
    fallbackCode: "NATIVE_OFFLINE_STARTUP_FAILED",
    message: "Windows 原生离线结算候选失败，正在回退兼容结算",
  });
  try { port.postMessage({ error: safe }); } catch { /* renderer is gone */ }
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

function nativeViewportProjectionV2ResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    baseFields: request?.baseFields ?? [],
    planetId: request?.planetId,
    bounds: request?.bounds,
    entityCursor: request?.entityCursor ?? 0,
    entityLimit: request?.entityLimit,
    beltCursor: request?.beltCursor ?? 0,
    beltLimit: request?.beltLimit,
    pinnedEntityIds: request?.pinnedEntityIds ?? [],
    pinnedBeltIds: request?.pinnedBeltIds ?? [],
    entityPresentationVersion: request?.entityPresentationVersion,
  };
}

function nativeFactoryReadModelResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    selectedEntityIds: request?.selectedEntityIds ?? [],
    selectedBeltIds: request?.selectedBeltIds ?? [],
  };
}

function nativeFactoryInventoryResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    cursor: request?.cursor,
    limit: request?.limit,
  };
}

function nativeConstructionInventoryResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    cursor: request?.cursor,
    limit: request?.limit,
  };
}

function nativeBlueprintWorkspaceResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    section: request?.section,
    blueprintId: request?.blueprintId,
    queueEntryId: request?.queueEntryId,
    cursor: request?.cursor,
    limit: request?.limit,
  };
}

function nativeBlueprintCaptureContextResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    entityIds: request?.entityIds,
  };
}

function nativeBlueprintImportContextResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    raw: request?.raw,
  };
}

function nativeBlueprintExportContextResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    blueprintId: request?.blueprintId,
    blueprintRevision: request?.blueprintRevision,
  };
}

function nativeBlueprintEnqueueContextResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    blueprintId: request?.blueprintId,
    blueprintRevision: request?.blueprintRevision,
  };
}

function nativeBlueprintDirectDeployContextResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    blueprintId: request?.blueprintId,
    blueprintRevision: request?.blueprintRevision,
    position: request?.position,
  };
}

function nativeConstructionPlacementContextResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    buildingId: request?.buildingId,
  };
}

function nativeConstructionBeltPlacementContextResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    sourceId: request?.sourceId,
    targetId: request?.targetId,
    itemId: request?.itemId,
    tier: request?.tier,
    lanes: request?.lanes,
  };
}

function nativeConstructionBeltRemovalContextResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    beltId: request?.beltId,
  };
}

function nativeConstructionBeltLaneContextResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    beltId: request?.beltId,
    targetLanes: request?.targetLanes,
  };
}

function nativeConstructionRemovalContextResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    entityId: request?.entityId,
  };
}

function nativeConstructionStackContextResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    entityId: request?.entityId,
    targetCount: request?.targetCount,
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

function nativeStatisticsProjectionHasPlayerAuthorityLineage(request) {
  return request !== null && typeof request === "object" && !Array.isArray(request) &&
    (Object.hasOwn(request, "runId") || Object.hasOwn(request, "expectedRegistryFingerprint"));
}

function nativeTechnologyProjectionResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
  };
}

function nativeRecipeWorkspaceProjectionResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    itemIds: request?.itemIds ?? [],
    selectedItemId: request?.selectedItemId,
    location: request?.location ?? null,
  };
}

function nativeStarMapOverviewProjectionResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    cursor: request?.cursor,
    limit: request?.limit,
  };
}

function nativeStarMapCatalogProjectionResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    systemCursor: request?.systemCursor,
    systemLimit: request?.systemLimit,
    planetCursor: request?.planetCursor,
    planetLimit: request?.planetLimit,
  };
}

function nativeStellarIndustryProjectionResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    systemId: request?.systemId ?? null,
    planetId: request?.planetId ?? null,
    planetCursor: request?.planetCursor,
    planetLimit: request?.planetLimit,
    stationCursor: request?.stationCursor,
    stationLimit: request?.stationLimit,
  };
}

function nativeStellarIndustryV2ProjectionResultContext(request) {
  return {
    ...nativeStellarIndustryProjectionResultContext(request),
    routeCursor: request?.routeCursor,
    routeLimit: request?.routeLimit,
    routeFilter: request?.routeFilter,
    query: request?.query,
  };
}

function nativeStellarQuantumProjectionResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    itemCursor: request?.itemCursor,
    itemLimit: request?.itemLimit,
    collectorCursor: request?.collectorCursor,
    collectorLimit: request?.collectorLimit,
  };
}

function nativeDysonWorkspaceProjectionResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    selectedSystemId: request?.selectedSystemId,
    systemCursor: request?.systemCursor,
    systemLimit: request?.systemLimit,
    layerCursor: request?.layerCursor,
    layerLimit: request?.layerLimit,
    orbitCursor: request?.orbitCursor,
    orbitLimit: request?.orbitLimit,
    nodeCursor: request?.nodeCursor,
    nodeLimit: request?.nodeLimit,
    frameCursor: request?.frameCursor,
    frameLimit: request?.frameLimit,
    shellCursor: request?.shellCursor,
    shellLimit: request?.shellLimit,
  };
}

function nativeSystemSpaceStationWorkspaceProjectionResultContext(request) {
  return {
    sessionId: request?.sessionId,
    runId: request?.runId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    systemId: request?.systemId,
    requirementCursor: request?.requirementCursor,
    requirementLimit: request?.requirementLimit,
    inventoryCursor: request?.inventoryCursor,
    inventoryLimit: request?.inventoryLimit,
    trayCursor: request?.trayCursor,
    trayLimit: request?.trayLimit,
    stationCursor: request?.stationCursor,
    stationLimit: request?.stationLimit,
  };
}

function nativeOrbitalContractWorkspaceProjectionResultContext(request) {
  return {
    sessionId: request?.sessionId,
    runId: request?.runId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
  };
}

function nativeCampaignWorkspaceProjectionResultContext(request) {
  return {
    sessionId: request?.sessionId,
    runId: request?.runId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
  };
}

function nativeOperationsWorkspaceProjectionResultContext(request) {
  return {
    sessionId: request?.sessionId,
    runId: request?.runId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
  };
}

function nativeGalaxyAccountWorkspaceProjectionResultContext(request) {
  return {
    sessionId: request?.sessionId,
    runId: request?.runId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
  };
}

function nativeCommandPaletteEntitySearchResultContext(request) {
  return {
    sessionId: request?.sessionId,
    expectedRevision: request?.expectedRevision,
    expectedRegistryFingerprint: request?.expectedRegistryFingerprint,
    query: request?.query,
    cursor: request?.cursor,
    limit: request?.limit,
    buildingIds: request?.buildingIds ?? [],
    resourceIds: request?.resourceIds ?? [],
    planetIds: request?.planetIds ?? [],
  };
}

const NATIVE_SUBSCRIPTION_PROJECTION_NORMALIZERS = Object.freeze({
  "viewport-v2": ["coreViewportProjectionV2", nativeViewportProjectionV2ResultContext],
  "factory-read-model-v1": ["coreFactoryReadModelProjection", nativeFactoryReadModelResultContext],
  "factory-inventory-v1": ["coreFactoryInventoryProjection", nativeFactoryInventoryResultContext],
  "construction-inventory-v1": ["coreConstructionInventoryProjection", nativeConstructionInventoryResultContext],
  "statistics-v1": ["coreStatisticsProjection", nativeStatisticsProjectionResultContext],
  "technology-v1": ["coreTechnologyProjection", nativeTechnologyProjectionResultContext],
  "operations-workspace-v1": ["coreOperationsWorkspaceProjection", nativeOperationsWorkspaceProjectionResultContext],
});

async function readNativeProjectionSubscriptionFrame(rendererOwnerId, request) {
  const normalizer = NATIVE_SUBSCRIPTION_PROJECTION_NORMALIZERS[request.projectionType];
  if (!normalizer || !nativePlayerAuthorityProjectionBroker?.ownsSession(request.sessionId)) {
    throw Object.assign(new Error("native projection subscription is not bound to the active authority session"), {
      code: "NATIVE_PLAYER_AUTHORITY_PROJECTION_UNAVAILABLE",
    });
  }
  const normalizedRequest = Object.freeze({ ...request.payload, sessionId: request.sessionId });
  const raw = await nativePlayerAuthorityProjectionBroker.read(
    rendererOwnerId,
    request.projectionType,
    normalizedRequest,
  );
  return normalizeRendererNativeResult(normalizer[0], raw, normalizer[1](normalizedRequest));
}

function nativeProjectionSubscriptionDiagnostics() {
  const active = [...nativeProjectionSubscriptions.values()].map((entry) => entry.snapshot());
  const retained = nativeProjectionSubscriptionHistory.slice(-64);
  return summarizeNativeProjectionSubscriptions(active, retained);
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
    title: desktopRuntimeIdentity.productName,
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
    if (!window.isDestroyed()) window.setTitle(desktopRuntimeIdentity.productName);
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
      cancelNativePlayerAuthorityRetriesForOwner(ownerId);
      nativePlayerAuthorityHandoffIpcBridge?.cancelOwner(ownerId);
      nativePlayerAuthorityPersistenceBroker?.clearRendererBinding(ownerId);
      if (nativePlayerAuthorityDeferredHandoff?.rendererOwnerId === ownerId) {
        nativePlayerAuthorityDeferredHandoff = null;
      }
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

// Response-only channel: a renderer cannot start a handoff through IPC. The
// bridge accepts a reply only while main holds the matching one-shot challenge
// for that exact WebContents ID.
ipcMain.on(NATIVE_PLAYER_AUTHORITY_HANDOFF_RESPONSE_CHANNEL, (event, response) => {
  nativePlayerAuthorityHandoffIpcBridge?.accept(event, response);
});

// Renderer readiness carries no authority identity. Main creates every
// startup challenge and binds it to this exact WebContents before accepting a
// response. A remount can safely retry a timed-out challenge.
ipcMain.on(NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_READY_CHANNEL, (event, message) => {
  if (message?.kind !== NATIVE_PLAYER_AUTHORITY_HANDOFF_RENDERER_READY_KIND ||
      Reflect.ownKeys(message).length !== 1 ||
      !trustedRendererForNativePlayerAuthority(event?.sender?.id)) return;
  // A ready event belongs to the newly installed renderer subscription. Drop
  // any binding left by the previous document even when Electron reuses the
  // same WebContents ID. Invalidate the old one-shot request/retry generation
  // before issuing a fresh challenge, so a late ACK from the previous document
  // cannot bind the new document by owner-ID reuse alone.
  cancelNativePlayerAuthorityRetriesForOwner(event.sender.id);
  nativePlayerAuthorityHandoffIpcBridge?.cancelOwner(event.sender.id);
  nativePlayerAuthorityPersistenceBroker?.clearRendererBinding(event.sender.id);
  void beginNativePlayerAuthorityStartupReconciliation(event.sender.id).catch(() => undefined);
});

ipcMain.handle("desktop:release-info", () => ({
  isDesktop: true,
  editionId: desktopRuntimeIdentity.editionId,
  productName: desktopRuntimeIdentity.productName,
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

ipcMain.handle("desktop:native-player-authority-state", async (event) =>
  runRendererNativeOperation("playerAuthorityState", {
    fallbackCode: "NATIVE_PLAYER_AUTHORITY_STATE_FAILED",
    message: "无法读取 Windows 原生玩家权威时钟",
  }, async () => validatedNativePlayerAuthorityState(requireTrustedNativeSender(event))));

ipcMain.handle("desktop:native-player-authority-set-paused", async (event, request) =>
  runRendererNativeOperation("playerAuthorityState", {
    fallbackCode: "NATIVE_PLAYER_AUTHORITY_PAUSE_FAILED",
    message: "Windows 原生暂停状态切换失败",
  }, async () => {
    const rendererOwnerId = requireTrustedNativeSender(event);
    if (!request || typeof request !== "object" || Array.isArray(request) ||
        Reflect.ownKeys(request).length !== 1 || !Object.hasOwn(request, "paused") ||
        typeof request.paused !== "boolean") {
      throw Object.assign(new TypeError("native player-authority pause intent is invalid"), {
        code: "NATIVE_PLAYER_AUTHORITY_PAUSE_REQUEST_INVALID",
      });
    }
    if (!nativePlayerAuthorityRuntime ||
        typeof nativePlayerAuthorityRuntime.setPaused !== "function") {
      throw Object.assign(new Error("native player-authority pause lifecycle is unavailable"), {
        code: "NATIVE_PLAYER_AUTHORITY_PAUSE_UNAVAILABLE",
      });
    }
    await nativePlayerAuthorityRuntime.setPaused(request.paused);
    return validatedNativePlayerAuthorityState(rendererOwnerId);
  }));

ipcMain.handle("desktop:native-player-authority-macro-start", async (event, request) =>
  runRendererNativeOperation("playerAuthorityMacroReceipt", {
    fallbackCode: "NATIVE_PLAYER_AUTHORITY_MACRO_FAILED",
    message: "Windows 原生纯挂机结算启动失败",
  }, async () => {
    requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityMacroBroker) throw new Error("native player authority macro broker is unavailable");
    return nativePlayerAuthorityMacroBroker.start(request);
  }));

ipcMain.handle("desktop:native-player-authority-macro-advance", async (event, request) =>
  runRendererNativeOperation("playerAuthorityMacroReceipt", {
    fallbackCode: "NATIVE_PLAYER_AUTHORITY_MACRO_FAILED",
    message: "Windows 原生纯挂机结算推进失败",
  }, async () => {
    requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityMacroBroker) throw new Error("native player authority macro broker is unavailable");
    return nativePlayerAuthorityMacroBroker.advance(request);
  }));

ipcMain.handle("desktop:native-player-authority-macro-finish", async (event, request) =>
  runRendererNativeOperation("playerAuthorityMacroReceipt", {
    fallbackCode: "NATIVE_PLAYER_AUTHORITY_MACRO_FAILED",
    message: "Windows 原生纯挂机结算结束失败",
  }, async () => {
    requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityMacroBroker) throw new Error("native player authority macro broker is unavailable");
    return nativePlayerAuthorityMacroBroker.finish(request);
  }));

ipcMain.handle("desktop:native-player-authority-macro-recover", async (event, request) =>
  runRendererNativeOperation("playerAuthorityMacroReceipt", {
    fallbackCode: "NATIVE_PLAYER_AUTHORITY_MACRO_FAILED",
    message: "Windows 原生纯挂机结算恢复失败",
  }, async () => {
    requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityMacroBroker) throw new Error("native player authority macro broker is unavailable");
    return nativePlayerAuthorityMacroBroker.recover(request);
  }));

ipcMain.handle("desktop:runtime-diagnostics", async (event) => {
  if (!trustedSender(event)) throw new Error("桌面运行诊断调用来源无效");
  return runtimeDiagnosticsSampler.sample();
});

ipcMain.handle("desktop:native-projection-subscription-diagnostics", async (event) => {
  if (!trustedSender(event)) throw new Error("原生投影订阅诊断调用来源无效");
  return nativeProjectionSubscriptionDiagnostics();
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
    const opened = await nativeCoreSessions.open(ownerId, request);
    const normalized = normalizeRendererNativeResult("coreOpen", opened);
    scheduleNativePlayerAuthorityHandoff(ownerId, normalized);
    return opened;
  });
});

ipcMain.handle("desktop:native-core-import-v47", async (event, request) => {
  try {
    const ownerId = requireTrustedNativeSender(event);
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "导入 DSP极简网络 v46/v47 存档到 Windows 原生核心",
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
      message: "原生 v46/v47 存档导入失败；未验证的内容不会进入游戏会话",
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
      message: "原生 v46/v47 存档导入失败；未验证的内容不会进入游戏会话",
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

ipcMain.handle("desktop:native-core-viewport-projection-v2", async (event, request) => {
  return runRendererNativeOperation("coreViewportProjectionV2", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生视口 v2 投影请求失败，请重试",
    resultContext: nativeViewportProjectionV2ResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(ownerId, "viewport-v2", request);
    }
    return await nativeCoreSessions.viewportProjectionV2(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-factory-read-model", async (event, request) => {
  return runRendererNativeOperation("coreFactoryReadModelProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生工厂只读模型请求失败，请重试",
    resultContext: nativeFactoryReadModelResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(ownerId, "factory-read-model-v1", request);
    }
    return await nativeCoreSessions.factoryReadModelProjection(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-factory-inventory", async (event, request) => {
  return runRendererNativeOperation("coreFactoryInventoryProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生工厂库存请求失败，请重试",
    resultContext: nativeFactoryInventoryResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await routeNativeProjectionRead({
      broker: nativePlayerAuthorityProjectionBroker,
      ownerId,
      projectionType: "factory-inventory-v1",
      request,
      shadowRead: () => nativeCoreSessions.factoryInventoryProjection(ownerId, request),
    });
  });
});

ipcMain.handle("desktop:native-core-construction-inventory", async (event, request) => {
  return runRendererNativeOperation("coreConstructionInventoryProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生建筑库存请求失败，请重试",
    resultContext: nativeConstructionInventoryResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await routeNativeProjectionRead({
      broker: nativePlayerAuthorityProjectionBroker,
      ownerId,
      projectionType: "construction-inventory-v1",
      request,
      shadowRead: () => nativeCoreSessions.constructionInventoryProjection(ownerId, request),
    });
  });
});

ipcMain.handle("desktop:native-core-blueprint-workspace", async (event, request) => {
  return runRendererNativeOperation("coreBlueprintWorkspaceProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生蓝图只读模型请求失败，请重试",
    resultContext: nativeBlueprintWorkspaceResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await routeNativeProjectionRead({
      broker: nativePlayerAuthorityProjectionBroker,
      ownerId,
      projectionType: "blueprint-workspace-v1",
      request,
      shadowRead: () => nativeCoreSessions.blueprintWorkspaceProjection(ownerId, request),
    });
  });
});

ipcMain.handle("desktop:native-core-blueprint-capture-context", async (event, request) => {
  return runRendererNativeOperation("coreBlueprintCaptureContext", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生蓝图捕获上下文请求失败，请重试",
    resultContext: nativeBlueprintCaptureContextResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(
        ownerId,
        "blueprint-capture-context-v1",
        request,
      );
    }
    return await nativeCoreSessions.blueprintCaptureContext(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-blueprint-import-context", async (event, request) => {
  return runRendererNativeOperation("coreBlueprintImportContext", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生蓝图导入上下文请求失败，请重试",
    resultContext: nativeBlueprintImportContextResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(
        ownerId,
        "blueprint-import-context-v1",
        request,
      );
    }
    return await nativeCoreSessions.blueprintImportContext(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-blueprint-export-context", async (event, request) => {
  return runRendererNativeOperation("coreBlueprintExportContext", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生蓝图导出上下文请求失败，请重试",
    resultContext: nativeBlueprintExportContextResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(
        ownerId,
        "blueprint-export-context-v1",
        request,
      );
    }
    return await nativeCoreSessions.blueprintExportContext(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-blueprint-enqueue-context", async (event, request) => {
  return runRendererNativeOperation("coreBlueprintEnqueueContext", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生蓝图入队上下文请求失败，请重试",
    resultContext: nativeBlueprintEnqueueContextResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(
        ownerId,
        "blueprint-enqueue-context-v1",
        request,
      );
    }
    return await nativeCoreSessions.blueprintEnqueueContext(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-blueprint-direct-deploy-context", async (event, request) => {
  return runRendererNativeOperation("coreBlueprintDirectDeployContext", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生蓝图直接部署上下文请求失败，请重试",
    resultContext: nativeBlueprintDirectDeployContextResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(
        ownerId,
        "blueprint-direct-deploy-context-v1",
        request,
      );
    }
    return await nativeCoreSessions.blueprintDirectDeployContext(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-construction-placement-context", async (event, request) => {
  return runRendererNativeOperation("coreConstructionPlacementContext", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生建筑放置上下文请求失败，请重试",
    resultContext: nativeConstructionPlacementContextResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(
        ownerId,
        "construction-placement-context-v1",
        request,
      );
    }
    return await nativeCoreSessions.constructionPlacementContext(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-construction-belt-placement-context", async (event, request) => {
  return runRendererNativeOperation("coreConstructionBeltPlacementContext", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生传送带放置上下文请求失败，请重试",
    resultContext: nativeConstructionBeltPlacementContextResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(
        ownerId,
        "construction-belt-placement-context-v1",
        request,
      );
    }
    return await nativeCoreSessions.constructionBeltPlacementContext(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-construction-belt-removal-context", async (event, request) => {
  return runRendererNativeOperation("coreConstructionBeltRemovalContext", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生传送带回收上下文请求失败，请重试",
    resultContext: nativeConstructionBeltRemovalContextResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(
        ownerId,
        "construction-belt-removal-context-v1",
        request,
      );
    }
    return await nativeCoreSessions.constructionBeltRemovalContext(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-construction-belt-lane-context", async (event, request) => {
  return runRendererNativeOperation("coreConstructionBeltLaneContext", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生传送带并联调整上下文请求失败，请重试",
    resultContext: nativeConstructionBeltLaneContextResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(
        ownerId,
        "construction-belt-lane-context-v1",
        request,
      );
    }
    return await nativeCoreSessions.constructionBeltLaneContext(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-construction-removal-context", async (event, request) => {
  return runRendererNativeOperation("coreConstructionRemovalContext", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生建筑回收上下文请求失败，请重试",
    resultContext: nativeConstructionRemovalContextResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(
        ownerId,
        "construction-removal-context-v1",
        request,
      );
    }
    return await nativeCoreSessions.constructionRemovalContext(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-construction-stack-context", async (event, request) => {
  return runRendererNativeOperation("coreConstructionStackContext", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生建筑堆叠上下文请求失败，请重试",
    resultContext: nativeConstructionStackContextResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      return await nativePlayerAuthorityProjectionBroker.read(
        ownerId,
        "construction-stack-context-v1",
        request,
      );
    }
    return await nativeCoreSessions.constructionStackContext(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-statistics-projection", async (event, request) => {
  return runRendererNativeOperation("coreStatisticsProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生统计投影请求失败，请重试",
    resultContext: nativeStatisticsProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    const hasPlayerAuthorityLineage = nativeStatisticsProjectionHasPlayerAuthorityLineage(request);
    if (hasPlayerAuthorityLineage || nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      if (!nativePlayerAuthorityProjectionBroker) {
        throw new NativePlayerAuthorityProjectionBrokerError(
          "native player-authority statistics projection broker is unavailable",
          "NATIVE_PLAYER_AUTHORITY_PROJECTION_UNAVAILABLE",
        );
      }
      return await nativePlayerAuthorityProjectionBroker.read(ownerId, "statistics-v1", request);
    }
    return await nativeCoreSessions.statisticsProjection(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-technology-projection", async (event, request) => {
  return runRendererNativeOperation("coreTechnologyProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生科研投影请求失败，请重试",
    resultContext: nativeTechnologyProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativeProjectionHasPlayerAuthorityRun(request) ||
        nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      if (!nativePlayerAuthorityProjectionBroker) {
        throw new NativePlayerAuthorityProjectionBrokerError(
          "native player-authority technology projection broker is unavailable",
          "NATIVE_PLAYER_AUTHORITY_PROJECTION_UNAVAILABLE",
        );
      }
      return await nativePlayerAuthorityProjectionBroker.read(ownerId, "technology-v1", request);
    }
    return await nativeCoreSessions.technologyProjection(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-recipe-workspace-projection", async (event, request) => {
  return runRendererNativeOperation("coreRecipeWorkspaceProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生生产资料库投影请求失败，请重试",
    resultContext: nativeRecipeWorkspaceProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativeProjectionHasPlayerAuthorityRun(request) ||
        nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      if (!nativePlayerAuthorityProjectionBroker) {
        throw new NativePlayerAuthorityProjectionBrokerError(
          "native player-authority recipe projection broker is unavailable",
          "NATIVE_PLAYER_AUTHORITY_PROJECTION_UNAVAILABLE",
        );
      }
      return await nativePlayerAuthorityProjectionBroker.read(ownerId, "recipe-workspace-v1", request);
    }
    return await nativeCoreSessions.recipeWorkspaceProjection(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-star-map-overview-projection", async (event, request) => {
  return runRendererNativeOperation("coreStarMapOverviewProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生星图总览投影请求失败，请重试",
    resultContext: nativeStarMapOverviewProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await routeNativeProjectionRead({
      broker: nativePlayerAuthorityProjectionBroker,
      ownerId,
      projectionType: "star-map-overview-v1",
      request,
      shadowRead: () => nativeCoreSessions.starMapOverviewProjection(ownerId, request),
    });
  });
});

ipcMain.handle("desktop:native-core-star-map-catalog-projection", async (event, request) => {
  return runRendererNativeOperation("coreStarMapCatalogProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生星图目录投影请求失败，请重试",
    resultContext: nativeStarMapCatalogProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await routeNativeProjectionRead({
      broker: nativePlayerAuthorityProjectionBroker,
      ownerId,
      projectionType: "star-map-catalog-v1",
      request,
      shadowRead: () => nativeCoreSessions.starMapCatalogProjection(ownerId, request),
    });
  });
});

ipcMain.handle("desktop:native-core-stellar-industry-projection", async (event, request) => {
  return runRendererNativeOperation("coreStellarIndustryProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生恒星工业投影请求失败，请重试",
    resultContext: nativeStellarIndustryProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await routeNativeProjectionRead({
      broker: nativePlayerAuthorityProjectionBroker,
      ownerId,
      projectionType: "stellar-industry-v1",
      request,
      shadowRead: () => nativeCoreSessions.stellarIndustryProjection(ownerId, request),
    });
  });
});

ipcMain.handle("desktop:native-core-stellar-industry-v2-projection", async (event, request) => {
  return runRendererNativeOperation("coreStellarIndustryProjectionV2", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生恒星工业 v2 投影请求失败，请重试",
    resultContext: nativeStellarIndustryV2ProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await routeNativeProjectionRead({
      broker: nativePlayerAuthorityProjectionBroker,
      ownerId,
      projectionType: "stellar-industry-v2",
      request,
      shadowRead: () => nativeCoreSessions.stellarIndustryProjectionV2(ownerId, request),
    });
  });
});

ipcMain.handle("desktop:native-core-stellar-quantum-projection", async (event, request) => {
  return runRendererNativeOperation("coreStellarQuantumProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生量子库存投影请求失败，请重试",
    resultContext: nativeStellarQuantumProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await routeNativeProjectionRead({
      broker: nativePlayerAuthorityProjectionBroker,
      ownerId,
      projectionType: "stellar-quantum-v1",
      request,
      shadowRead: () => nativeCoreSessions.stellarQuantumProjection(ownerId, request),
    });
  });
});

ipcMain.handle("desktop:native-core-dyson-workspace-projection", async (event, request) => {
  return runRendererNativeOperation("coreDysonWorkspaceProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生戴森球工作区投影请求失败，请重试",
    resultContext: nativeDysonWorkspaceProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativeProjectionHasPlayerAuthorityRun(request) ||
        nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      if (!nativePlayerAuthorityProjectionBroker) {
        throw new NativePlayerAuthorityProjectionBrokerError(
          "native player-authority Dyson projection broker is unavailable",
          "NATIVE_PLAYER_AUTHORITY_PROJECTION_UNAVAILABLE",
        );
      }
      return await nativePlayerAuthorityProjectionBroker.read(ownerId, "dyson-workspace-v1", request);
    }
    return await nativeCoreSessions.dysonWorkspaceProjection(ownerId, request);
  });
});

ipcMain.handle("desktop:native-core-system-space-station-workspace-projection", async (event, request) => {
  return runRendererNativeOperation("coreSystemSpaceStationWorkspaceProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生恒星系空间站工作区投影请求失败，请重试",
    resultContext: nativeSystemSpaceStationWorkspaceProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await routeNativeProjectionRead({
      broker: nativePlayerAuthorityProjectionBroker,
      ownerId,
      projectionType: "system-space-station-workspace-v1",
      request,
      shadowRead: () => nativeCoreSessions.systemSpaceStationWorkspaceProjection(ownerId, request),
    });
  });
});

ipcMain.handle("desktop:native-core-orbital-contract-workspace-projection", async (event, request) => {
  return runRendererNativeOperation("coreOrbitalContractWorkspaceProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生轨道合同工作区投影请求失败，请重试",
    resultContext: nativeOrbitalContractWorkspaceProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      throw new Error("原生轨道合同投影仅对当前玩家权威会话开放");
    }
    return await nativePlayerAuthorityProjectionBroker.read(
      ownerId,
      "orbital-contract-workspace-v1",
      request,
    );
  });
});

ipcMain.handle("desktop:native-core-campaign-workspace-projection", async (event, request) => {
  return runRendererNativeOperation("coreCampaignWorkspaceProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生主线任务工作区投影请求失败，请重试",
    resultContext: nativeCampaignWorkspaceProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      throw new Error("原生主线任务投影仅对当前玩家权威会话开放");
    }
    return await nativePlayerAuthorityProjectionBroker.read(
      ownerId,
      "campaign-workspace-v1",
      request,
    );
  });
});

ipcMain.handle("desktop:native-core-galaxy-account-workspace-projection", async (event, request) => {
  return runRendererNativeOperation("coreGalaxyAccountWorkspaceProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生银河账户工作区投影请求失败，请重试",
    resultContext: nativeGalaxyAccountWorkspaceProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      throw new Error("原生银河账户投影仅对当前玩家权威会话开放");
    }
    return await nativePlayerAuthorityProjectionBroker.read(
      ownerId,
      "galaxy-account-workspace-v1",
      request,
    );
  });
});

ipcMain.handle("desktop:native-core-operations-workspace-projection", async (event, request) => {
  return runRendererNativeOperation("coreOperationsWorkspaceProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生运营中心投影请求失败，请重试",
    resultContext: nativeOperationsWorkspaceProjectionResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityProjectionBroker?.ownsSession(request?.sessionId)) {
      throw new Error("原生运营中心投影仅对当前玩家权威会话开放");
    }
    return await nativePlayerAuthorityProjectionBroker.read(ownerId, "operations-workspace-v1", request);
  });
});

ipcMain.handle("desktop:native-core-command-palette-entity-search", async (event, request) => {
  return runRendererNativeOperation("coreCommandPaletteEntitySearchProjection", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生命令面板设备搜索失败，请重试",
    resultContext: nativeCommandPaletteEntitySearchResultContext(request),
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    return await routeNativeProjectionRead({
      broker: nativePlayerAuthorityProjectionBroker,
      ownerId,
      projectionType: "command-palette-entity-search-v1",
      request,
      shadowRead: () => nativeCoreSessions.commandPaletteEntitySearchProjection(ownerId, request),
    });
  });
});

ipcMain.on("desktop:native-core-projection-subscribe", (event, request) => {
  const port = event.ports?.[0];
  if (!port) return;
  try {
    const rendererOwnerId = requireTrustedNativeSender(event);
    const normalized = normalizeSubscriptionRequest(request);
    const key = `${rendererOwnerId}\0${normalized.subscriptionId}`;
    if (nativeProjectionSubscriptions.has(key)) {
      throw Object.assign(new Error("native projection subscription ID is already active"), {
        code: "NATIVE_PROJECTION_SUBSCRIPTION_DUPLICATE",
      });
    }
    const subscription = new NativeProjectionSubscription({
      port,
      initialRequest: normalized,
      readProjection: (entry) => readNativeProjectionSubscriptionFrame(rendererOwnerId, entry),
      encodeProjection: encodeNativeProjectionTransfer,
      onClosed: (snapshot, reason) => {
        if (nativeProjectionSubscriptions.get(key) === subscription) {
          nativeProjectionSubscriptions.delete(key);
        }
        nativeProjectionSubscriptionHistory.push(Object.freeze({ ...snapshot, reason }));
        if (nativeProjectionSubscriptionHistory.length > 64) {
          nativeProjectionSubscriptionHistory.splice(0,
            nativeProjectionSubscriptionHistory.length - 64);
        }
      },
    });
    nativeProjectionSubscriptions.set(key, subscription);
    subscription.start();
  } catch (error) {
    postNativeProjectionTransferError(port, error);
  }
});

ipcMain.on("desktop:native-core-projection-transfer", (event, request) => {
  const port = event.ports?.[0];
  if (!port) return;
  const run = async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      Reflect.ownKeys(request).length !== 4 ||
      !["sessionId", "projectionType", "sequence", "payload"].every(
        (key) => Object.prototype.hasOwnProperty.call(request, key),
      ) ||
      !validNativeLogicalId(request.sessionId, 128) ||
      !Number.isSafeInteger(request.sequence) || request.sequence < 1 ||
      !["viewport-v1", "viewport-v2", "factory-read-model-v1", "factory-inventory-v1", "construction-inventory-v1", "blueprint-workspace-v1", "blueprint-capture-context-v1", "blueprint-import-context-v1", "blueprint-export-context-v1", "blueprint-enqueue-context-v1", "blueprint-direct-deploy-context-v1", "construction-placement-context-v1", "construction-belt-placement-context-v1", "construction-belt-lane-context-v1", "construction-belt-removal-context-v1", "construction-removal-context-v1", "construction-stack-context-v1", "statistics-v1", "technology-v1", "recipe-workspace-v1", "star-map-overview-v1", "star-map-catalog-v1", "stellar-industry-v1", "stellar-industry-v2", "stellar-quantum-v1", "dyson-workspace-v1", "system-space-station-workspace-v1"].includes(request.projectionType) ||
      !request.payload || typeof request.payload !== "object" ||
      Object.prototype.hasOwnProperty.call(request.payload, "sessionId")) {
      throw new Error("原生投影二进制请求无效");
    }
    const normalizedRequest = { ...request.payload, sessionId: request.sessionId };
    let rawResult;
    if (request.projectionType === "viewport-v1") {
      rawResult = await nativeCoreSessions.viewportProjection(ownerId, normalizedRequest);
    } else if (nativeProjectionHasPlayerAuthorityRun(normalizedRequest) ||
        nativePlayerAuthorityProjectionBroker?.ownsSession(request.sessionId)) {
      if (!nativePlayerAuthorityProjectionBroker) {
        throw new NativePlayerAuthorityProjectionBrokerError(
          "native player-authority projection broker is unavailable",
          "NATIVE_PLAYER_AUTHORITY_PROJECTION_UNAVAILABLE",
        );
      }
      rawResult = await nativePlayerAuthorityProjectionBroker.read(
        ownerId,
        request.projectionType,
        normalizedRequest,
      );
    } else if (request.projectionType === "viewport-v2") {
      rawResult = await nativeCoreSessions.viewportProjectionV2(ownerId, normalizedRequest);
    } else if (request.projectionType === "factory-read-model-v1") {
      rawResult = await nativeCoreSessions.factoryReadModelProjection(ownerId, normalizedRequest);
    } else if (request.projectionType === "factory-inventory-v1") {
      rawResult = await nativeCoreSessions.factoryInventoryProjection(ownerId, normalizedRequest);
    } else if (request.projectionType === "construction-inventory-v1") {
      rawResult = await nativeCoreSessions.constructionInventoryProjection(ownerId, normalizedRequest);
    } else if (request.projectionType === "blueprint-workspace-v1") {
      rawResult = await nativeCoreSessions.blueprintWorkspaceProjection(ownerId, normalizedRequest);
    } else if (request.projectionType === "blueprint-capture-context-v1") {
      rawResult = await nativeCoreSessions.blueprintCaptureContext(ownerId, normalizedRequest);
    } else if (request.projectionType === "blueprint-import-context-v1") {
      rawResult = await nativeCoreSessions.blueprintImportContext(ownerId, normalizedRequest);
    } else if (request.projectionType === "blueprint-export-context-v1") {
      rawResult = await nativeCoreSessions.blueprintExportContext(ownerId, normalizedRequest);
    } else if (request.projectionType === "blueprint-enqueue-context-v1") {
      rawResult = await nativeCoreSessions.blueprintEnqueueContext(ownerId, normalizedRequest);
    } else if (request.projectionType === "blueprint-direct-deploy-context-v1") {
      rawResult = await nativeCoreSessions.blueprintDirectDeployContext(ownerId, normalizedRequest);
    } else if (request.projectionType === "construction-placement-context-v1") {
      rawResult = await nativeCoreSessions.constructionPlacementContext(ownerId, normalizedRequest);
    } else if (request.projectionType === "construction-belt-placement-context-v1") {
      rawResult = await nativeCoreSessions.constructionBeltPlacementContext(ownerId, normalizedRequest);
    } else if (request.projectionType === "construction-belt-lane-context-v1") {
      rawResult = await nativeCoreSessions.constructionBeltLaneContext(ownerId, normalizedRequest);
    } else if (request.projectionType === "construction-belt-removal-context-v1") {
      rawResult = await nativeCoreSessions.constructionBeltRemovalContext(ownerId, normalizedRequest);
    } else if (request.projectionType === "construction-removal-context-v1") {
      rawResult = await nativeCoreSessions.constructionRemovalContext(ownerId, normalizedRequest);
    } else if (request.projectionType === "construction-stack-context-v1") {
      rawResult = await nativeCoreSessions.constructionStackContext(ownerId, normalizedRequest);
    } else if (request.projectionType === "statistics-v1") {
      rawResult = await nativeCoreSessions.statisticsProjection(ownerId, normalizedRequest);
    } else if (request.projectionType === "recipe-workspace-v1") {
      rawResult = await nativeCoreSessions.recipeWorkspaceProjection(ownerId, normalizedRequest);
    } else if (request.projectionType === "star-map-overview-v1") {
      rawResult = await nativeCoreSessions.starMapOverviewProjection(ownerId, normalizedRequest);
    } else if (request.projectionType === "star-map-catalog-v1") {
      rawResult = await nativeCoreSessions.starMapCatalogProjection(ownerId, normalizedRequest);
    } else if (request.projectionType === "stellar-industry-v1") {
      rawResult = await nativeCoreSessions.stellarIndustryProjection(ownerId, normalizedRequest);
    } else if (request.projectionType === "stellar-industry-v2") {
      rawResult = await nativeCoreSessions.stellarIndustryProjectionV2(ownerId, normalizedRequest);
    } else if (request.projectionType === "stellar-quantum-v1") {
      rawResult = await nativeCoreSessions.stellarQuantumProjection(ownerId, normalizedRequest);
    } else if (request.projectionType === "dyson-workspace-v1") {
      rawResult = await nativeCoreSessions.dysonWorkspaceProjection(ownerId, normalizedRequest);
    } else if (request.projectionType === "system-space-station-workspace-v1") {
      rawResult = await nativeCoreSessions.systemSpaceStationWorkspaceProjection(ownerId, normalizedRequest);
    } else {
      rawResult = await nativeCoreSessions.technologyProjection(ownerId, normalizedRequest);
    }
    const result = normalizeRendererNativeResult(
      request.projectionType === "viewport-v1"
        ? "coreViewportProjection"
        : request.projectionType === "viewport-v2"
          ? "coreViewportProjectionV2"
          : request.projectionType === "factory-read-model-v1"
            ? "coreFactoryReadModelProjection"
            : request.projectionType === "factory-inventory-v1"
              ? "coreFactoryInventoryProjection"
              : request.projectionType === "construction-inventory-v1"
                ? "coreConstructionInventoryProjection"
                : request.projectionType === "blueprint-workspace-v1"
                  ? "coreBlueprintWorkspaceProjection"
                : request.projectionType === "blueprint-capture-context-v1"
                  ? "coreBlueprintCaptureContext"
                : request.projectionType === "blueprint-import-context-v1"
                  ? "coreBlueprintImportContext"
                : request.projectionType === "blueprint-export-context-v1"
                  ? "coreBlueprintExportContext"
                : request.projectionType === "blueprint-enqueue-context-v1"
                  ? "coreBlueprintEnqueueContext"
                : request.projectionType === "blueprint-direct-deploy-context-v1"
                  ? "coreBlueprintDirectDeployContext"
                : request.projectionType === "construction-placement-context-v1"
                  ? "coreConstructionPlacementContext"
                : request.projectionType === "construction-belt-placement-context-v1"
                  ? "coreConstructionBeltPlacementContext"
                : request.projectionType === "construction-belt-lane-context-v1"
                  ? "coreConstructionBeltLaneContext"
                : request.projectionType === "construction-belt-removal-context-v1"
                  ? "coreConstructionBeltRemovalContext"
                : request.projectionType === "construction-removal-context-v1"
                  ? "coreConstructionRemovalContext"
                : request.projectionType === "construction-stack-context-v1"
                  ? "coreConstructionStackContext"
                : request.projectionType === "statistics-v1"
                  ? "coreStatisticsProjection"
              : request.projectionType === "recipe-workspace-v1"
                ? "coreRecipeWorkspaceProjection"
                : request.projectionType === "star-map-overview-v1"
                  ? "coreStarMapOverviewProjection"
                  : request.projectionType === "star-map-catalog-v1"
                    ? "coreStarMapCatalogProjection"
                    : request.projectionType === "stellar-industry-v1"
                    ? "coreStellarIndustryProjection"
                  : request.projectionType === "stellar-industry-v2"
                    ? "coreStellarIndustryProjectionV2"
                    : request.projectionType === "stellar-quantum-v1"
                      ? "coreStellarQuantumProjection"
                      : request.projectionType === "dyson-workspace-v1"
                        ? "coreDysonWorkspaceProjection"
                        : request.projectionType === "system-space-station-workspace-v1"
                          ? "coreSystemSpaceStationWorkspaceProjection"
                        : "coreTechnologyProjection",
      rawResult,
      request.projectionType === "viewport-v1"
        ? nativeViewportProjectionResultContext(request.payload)
        : request.projectionType === "viewport-v2"
          ? nativeViewportProjectionV2ResultContext(normalizedRequest)
          : request.projectionType === "factory-read-model-v1"
            ? nativeFactoryReadModelResultContext(normalizedRequest)
            : request.projectionType === "factory-inventory-v1"
              ? nativeFactoryInventoryResultContext(normalizedRequest)
              : request.projectionType === "construction-inventory-v1"
                ? nativeConstructionInventoryResultContext(normalizedRequest)
                : request.projectionType === "blueprint-workspace-v1"
                  ? nativeBlueprintWorkspaceResultContext(normalizedRequest)
                : request.projectionType === "blueprint-capture-context-v1"
                  ? nativeBlueprintCaptureContextResultContext(normalizedRequest)
                : request.projectionType === "blueprint-import-context-v1"
                  ? nativeBlueprintImportContextResultContext(normalizedRequest)
                : request.projectionType === "blueprint-export-context-v1"
                  ? nativeBlueprintExportContextResultContext(normalizedRequest)
                : request.projectionType === "blueprint-enqueue-context-v1"
                  ? nativeBlueprintEnqueueContextResultContext(normalizedRequest)
                : request.projectionType === "blueprint-direct-deploy-context-v1"
                  ? nativeBlueprintDirectDeployContextResultContext(normalizedRequest)
                : request.projectionType === "construction-placement-context-v1"
                  ? nativeConstructionPlacementContextResultContext(normalizedRequest)
                : request.projectionType === "construction-belt-placement-context-v1"
                  ? nativeConstructionBeltPlacementContextResultContext(normalizedRequest)
                : request.projectionType === "construction-belt-lane-context-v1"
                  ? nativeConstructionBeltLaneContextResultContext(normalizedRequest)
                : request.projectionType === "construction-belt-removal-context-v1"
                  ? nativeConstructionBeltRemovalContextResultContext(normalizedRequest)
                : request.projectionType === "construction-removal-context-v1"
                  ? nativeConstructionRemovalContextResultContext(normalizedRequest)
                : request.projectionType === "construction-stack-context-v1"
                  ? nativeConstructionStackContextResultContext(normalizedRequest)
                : request.projectionType === "statistics-v1"
                  ? nativeStatisticsProjectionResultContext(request.payload)
              : request.projectionType === "recipe-workspace-v1"
                ? nativeRecipeWorkspaceProjectionResultContext(normalizedRequest)
                : request.projectionType === "star-map-overview-v1"
                  ? nativeStarMapOverviewProjectionResultContext(normalizedRequest)
                  : request.projectionType === "star-map-catalog-v1"
                    ? nativeStarMapCatalogProjectionResultContext(normalizedRequest)
                    : request.projectionType === "stellar-industry-v1"
                    ? nativeStellarIndustryProjectionResultContext(normalizedRequest)
                  : request.projectionType === "stellar-industry-v2"
                    ? nativeStellarIndustryV2ProjectionResultContext(normalizedRequest)
                    : request.projectionType === "stellar-quantum-v1"
                      ? nativeStellarQuantumProjectionResultContext(normalizedRequest)
                      : request.projectionType === "dyson-workspace-v1"
                        ? nativeDysonWorkspaceProjectionResultContext(normalizedRequest)
                        : request.projectionType === "system-space-station-workspace-v1"
                          ? nativeSystemSpaceStationWorkspaceProjectionResultContext(normalizedRequest)
                        : nativeTechnologyProjectionResultContext(normalizedRequest),
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

// Startup settlement is a read-only candidate transaction. Renderer supplies
// only an exact source proof; main owns both the wall clock and the temporary
// export identity. Rust keeps the source session/checkpoint unchanged until
// the browser validates and persists the streamed v47 envelope.
ipcMain.on("desktop:native-offline-startup-transfer", (event, request) => {
  const port = event.ports?.[0];
  if (!port) return;
  const run = async () => {
    const ownerId = requireTrustedNativeSender(event);
    await streamNativeOfflineStartupCandidate({
      registry: nativeCoreSessions,
      ownerId,
      request,
      observedNowMs: sampleNativeOfflineStartupWallClock(),
      nativeRootPath: resolveFixedNativeSaveRootPath(
        performanceEditionRuntimeIdentity.userDataPath,
      ),
      port,
      normalizeResult: (value) => normalizeRendererNativeResult(
        "coreOfflineCandidateExport",
        value,
      ),
    });
  };
  void run()
    .catch((error) => postNativeOfflineStartupTransferError(port, error))
    .finally(() => closeTransferPort(port));
});

ipcMain.handle("desktop:native-core-apply-command", async (event, request) => {
  return runRendererNativeOperation("coreCommand", {
    fallbackCode: "NATIVE_CORE_COMMAND_FAILED",
    message: "原生影子命令执行失败，请重试",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (nativePlayerAuthorityCommandBroker?.ownsSession(request?.sessionId)) {
      return nativePlayerAuthorityCommandBroker.commit(ownerId, request);
    }
    return nativeCoreSessions.applyCommand(ownerId, request?.sessionId, request?.command);
  });
});

ipcMain.handle("desktop:native-core-reconcile-command", async (event, request) => {
  return runRendererNativeOperation("coreCommandReconcile", {
    fallbackCode: "NATIVE_CORE_COMMAND_RECONCILE_FAILED",
    message: "原生权威命令耐久收据对账失败",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityCommandBroker?.ownsSession(request?.sessionId)) {
      throw new Error("原生玩家权威命令对账会话不可用");
    }
    return nativePlayerAuthorityCommandBroker.reconcile(ownerId, request);
  });
});

ipcMain.handle("desktop:native-player-authority-history-status", async (event, request) => {
  return runRendererNativeOperation("coreCommand", {
    fallbackCode: "NATIVE_PLAYER_AUTHORITY_HISTORY_STATUS_FAILED",
    message: "原生撤销历史读取失败",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityCommandBroker?.ownsSession(request?.sessionId)) {
      throw new Error("原生撤销历史会话不可用");
    }
    return nativePlayerAuthorityCommandBroker.historyStatus(ownerId, request);
  });
});

ipcMain.handle("desktop:native-player-authority-history-commit", async (event, request) => {
  return runRendererNativeOperation("coreCommand", {
    fallbackCode: "NATIVE_PLAYER_AUTHORITY_HISTORY_COMMIT_FAILED",
    message: "原生撤销或重做提交失败",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityCommandBroker?.ownsSession(request?.sessionId)) {
      throw new Error("原生撤销历史会话不可用");
    }
    return nativePlayerAuthorityCommandBroker.commitHistory(ownerId, request);
  });
});

ipcMain.handle("desktop:native-player-authority-system-space-station-intent", async (event, request) => {
  return runRendererNativeOperation("coreCommand", {
    fallbackCode: "NATIVE_PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_COMMAND_FAILED",
    message: "原生恒星系空间站命令提交失败，请重试",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthoritySystemSpaceStationBroker) {
      throw new Error("原生恒星系空间站权威命令不可用");
    }
    return nativePlayerAuthoritySystemSpaceStationBroker.commit(ownerId, request);
  });
});

ipcMain.handle("desktop:native-player-authority-orbital-contract-intent", async (event, request) => {
  return runRendererNativeOperation("coreCommand", {
    fallbackCode: "NATIVE_PLAYER_AUTHORITY_ORBITAL_CONTRACT_COMMAND_FAILED",
    message: "原生轨道合同命令提交失败，请重试",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityOrbitalContractBroker) {
      throw new Error("原生轨道合同权威命令不可用");
    }
    return nativePlayerAuthorityOrbitalContractBroker.commit(ownerId, request);
  });
});

ipcMain.handle("desktop:native-player-authority-operations-setting-intent", async (event, request) => {
  return runRendererNativeOperation("coreCommand", {
    fallbackCode: "NATIVE_PLAYER_AUTHORITY_OPERATIONS_SETTING_COMMAND_FAILED",
    message: "原生运营设置提交失败，请重试",
  }, async () => {
    const ownerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityOperationsSettingBroker) throw new Error("原生运营设置权威命令不可用");
    return nativePlayerAuthorityOperationsSettingBroker.commit(ownerId, request);
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

async function deliverNativeV47Export(prepared, suggestedName) {
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
}

function suggestedNativeExportName(value) {
  return typeof value === "string" && /^[A-Za-z0-9._\-\u4e00-\u9fff]{1,160}\.json$/.test(value)
    ? value
    : `dsp-idle-native-${Date.now()}.json`;
}

ipcMain.handle("desktop:native-core-export-v47", async (event, request) => {
  try {
    const ownerId = requireTrustedNativeSender(event);
    const prepared = normalizeRendererNativeResult(
      "coreExport",
      await nativeCoreSessions.exportV47(ownerId, request),
    );
    return await deliverNativeV47Export(prepared, suggestedNativeExportName(request?.suggestedName));
  } catch (error) {
    throw createRendererNativeError(error, {
      fallbackCode: "NATIVE_CORE_V47_EXPORT_FAILED",
      message: "原生 v47 存档导出失败；目标文件不会接收未经校验的内容",
    });
  }
});

ipcMain.handle("desktop:native-player-authority-checkpoint", async (event) => {
  return runRendererNativeOperation("playerAuthorityCheckpoint", {
    fallbackCode: "NATIVE_PLAYER_AUTHORITY_CHECKPOINT_FAILED",
    message: "Windows 原生权威检查点验证失败，请重试",
  }, async () => {
    const rendererOwnerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityPersistenceBroker) {
      throw Object.assign(new Error("native player-authority persistence broker is unavailable"), {
        code: "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_UNAVAILABLE",
      });
    }
    return nativePlayerAuthorityPersistenceBroker.checkpoint(rendererOwnerId);
  });
});

ipcMain.handle("desktop:native-player-authority-restart-from-durable", async (event, request) => {
  try {
    requireTrustedNativeSender(event);
    if (!request || typeof request !== "object" || Array.isArray(request) ||
        Reflect.ownKeys(request).length !== 1 || !Object.hasOwn(request, "expectedRevision") ||
        !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
        nativePlayerAuthorityRestartScheduled || !nativePlayerAuthorityRuntime || !nativeCoreSessions) {
      throw Object.assign(new Error("native player-authority durable restart request is invalid"), {
        code: "NATIVE_PLAYER_AUTHORITY_DURABLE_RESTART_INVALID",
      });
    }
    const proof = nativePlayerAuthorityRuntime.prepareDurableRestart();
    if (proof.minimumRevision !== request.expectedRevision) {
      throw Object.assign(new Error("native player-authority durable restart revision is stale"), {
        code: "NATIVE_PLAYER_AUTHORITY_DURABLE_RESTART_STALE",
      });
    }
    const owned = nativeCoreSessions.inspectSession("main-player-authority", proof.sessionId);
    if (owned?.ownerId !== "main-player-authority" || owned.slot !== "normal-main" ||
        owned.state !== "owned" || owned.inFlight !== 0) {
      throw Object.assign(new Error("native player-authority durable restart owner is not settled"), {
        code: "NATIVE_PLAYER_AUTHORITY_DURABLE_RESTART_OWNER_INVALID",
      });
    }
    const summary = await nativeCoreSessions.status("main-player-authority", proof.sessionId);
    if (!summary || summary.stateVersion !== 47 || summary.mode !== "normal" ||
        !Number.isSafeInteger(summary.revision) || summary.revision < proof.minimumRevision ||
        summary.coverage?.authorityEligible !== true) {
      throw Object.assign(new Error("native player-authority durable restart state is not recoverable"), {
        code: "NATIVE_PLAYER_AUTHORITY_DURABLE_RESTART_STATE_INVALID",
      });
    }
    nativePlayerAuthorityRestartScheduled = true;
    const response = Object.freeze({
      schemaVersion: 1,
      accepted: true,
      recoveryMode: "rust-durable-reconcile",
      minimumRevision: proof.minimumRevision,
    });
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 100);
    return response;
  } catch (error) {
    throw createRendererNativeError(error, {
      fallbackCode: "NATIVE_PLAYER_AUTHORITY_DURABLE_RESTART_FAILED",
      message: "Windows 原生权威无法从当前 durable 边界安全重启；旧 JavaScript 镜像未启用",
    });
  }
});

ipcMain.handle("desktop:native-player-authority-export-v47", async (event, request) => {
  try {
    const rendererOwnerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityPersistenceBroker || !request || typeof request !== "object" ||
        Reflect.ownKeys(request).some((key) => !["exportId", "savedAtMs", "suggestedName"].includes(key)) ||
        !Object.hasOwn(request, "exportId") || !Object.hasOwn(request, "savedAtMs")) {
      throw Object.assign(new Error("native player-authority export request is invalid"), {
        code: "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_INVALID",
      });
    }
    const prepared = normalizeRendererNativeResult(
      "playerAuthorityExport",
      await nativePlayerAuthorityPersistenceBroker.exportV47(rendererOwnerId, {
        exportId: request.exportId,
        savedAtMs: request.savedAtMs,
      }),
    );
    // Validate the exact renderer-bound session/run before the temporary file
    // can be published. A post-export UI warning must never turn a cross-lineage
    // artifact into a successful download.
    nativePlayerAuthorityPersistenceBroker.assertBoundRendererArtifact(
      rendererOwnerId,
      prepared.authority,
      prepared.result.revision,
    );
    const delivered = await deliverNativeV47Export({
      exportId: prepared.exportId,
      mode: prepared.mode,
      result: prepared.result,
    }, suggestedNativeExportName(request.suggestedName));
    return { authority: prepared.authority, ...delivered };
  } catch (error) {
    throw createRendererNativeError(error, {
      fallbackCode: "NATIVE_PLAYER_AUTHORITY_EXPORT_FAILED",
      message: "Windows 原生权威 v47 存档导出失败；目标文件不会接收未经校验的内容",
    });
  }
});

ipcMain.handle("desktop:native-player-authority-cloud-upload", async (event, request) => {
  try {
    const rendererOwnerId = requireTrustedNativeSender(event);
    if (!nativePlayerAuthorityPersistenceBroker || !nativeHostClient) {
      throw Object.assign(new Error("native player-authority persistence broker is unavailable"), {
        code: "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_UNAVAILABLE",
      });
    }
    const transfer = new NativeAuthorityCloudTransfer({
      rootPath: nativeHostClient.rootPath,
      resolveRequestUrl: resolveApiRequestUrl,
      exportArtifact: (exportRequest) =>
        nativePlayerAuthorityPersistenceBroker.exportV47(rendererOwnerId, exportRequest),
    });
    return await transfer.upload(request, (progress) => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== rendererOwnerId) return;
      mainWindow.webContents.send("desktop:native-player-authority-cloud-progress", progress);
    });
  } catch (error) {
    throw createRendererNativeError(error, {
      fallbackCode: "NATIVE_PLAYER_AUTHORITY_CLOUD_UPLOAD_FAILED",
      message: "Windows 原生权威云上传失败；本地检查点不会被覆盖",
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
    app.setAppUserModelId(desktopRuntimeIdentity.appUserModelId);
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
    dialog.showErrorBox("启动失败", `${desktopRuntimeIdentity.productName} 无法启动：${error instanceof Error ? error.message : "未知错误"}`);
    app.quit();
  });
}

app.on("before-quit", (event) => {
  persistWindowState();
  resetNativePlayerAuthorityRetryCoordinators();
  nativePlayerAuthorityRuntime?.shutdownForProcessExit();
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
