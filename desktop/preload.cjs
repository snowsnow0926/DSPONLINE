const { contextBridge, ipcRenderer } = require("electron");
const { createHash } = require("node:crypto");
const {
  createRendererNativeError,
  createRendererNativeRejection,
} = require("./native-renderer-boundary.cjs");
const {
  subscribeRendererToNativePlayerAuthorityHandoff,
} = require("./native-player-authority-handoff-ipc.cjs");

const MAX_NATIVE_PROJECTION_TRANSFER_BYTES = 1024 * 1024;
const MAX_STELLAR_PROJECTION_REQUEST_BYTES = 32_768;
const MAX_BLUEPRINT_CAPTURE_REQUEST_BYTES = 1024 * 1024;
const MAX_BLUEPRINT_CAPTURE_ENTITY_IDS = 512;
const MAX_BLUEPRINT_CAPTURE_OPAQUE_ID_BYTES = 512;
const NATIVE_CORE_TRANSFER_PROJECTION_TYPES = Object.freeze([
  "viewport-v1", "viewport-v2", "factory-read-model-v1", "factory-inventory-v1", "construction-inventory-v1", "blueprint-workspace-v1", "blueprint-capture-context-v1", "blueprint-import-context-v1", "blueprint-export-context-v1", "blueprint-enqueue-context-v1", "blueprint-direct-deploy-context-v1", "construction-placement-context-v1", "construction-belt-placement-context-v1", "construction-belt-lane-context-v1", "construction-belt-removal-context-v1", "construction-removal-context-v1", "construction-stack-context-v1", "statistics-v1", "technology-v1",
  "recipe-workspace-v1", "star-map-overview-v1", "star-map-catalog-v1", "stellar-industry-v1", "stellar-industry-v2",
  "stellar-quantum-v1",
  "dyson-workspace-v1", "system-space-station-workspace-v1",
]);
let nativeProjectionSequence = 0;

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every(
    (key) => typeof key === "string" && expected.includes(key),
  ) && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validBoundedPreloadText(value, maximumBytes) {
  return typeof value === "string" && value.length > 0 && hasWellFormedUnicode(value) &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function validLogicalPreloadId(value, maximumLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    /^[A-Za-z0-9_.:-]+$/.test(value);
}

function normalizeAuthorityWorkspacePreloadRequest(request) {
  if (!hasExactKeys(request, [
    "sessionId", "runId", "expectedRevision", "expectedRegistryFingerprint",
  ]) || !validLogicalPreloadId(request.sessionId, 128) ||
      !validLogicalPreloadId(request.runId, 128) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      request.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !validLogicalPreloadId(request.expectedRegistryFingerprint, 256)) {
    throw new TypeError("原生权威工作区投影请求无效");
  }
  const normalized = {
    sessionId: request.sessionId,
    runId: request.runId,
    expectedRevision: request.expectedRevision,
    expectedRegistryFingerprint: request.expectedRegistryFingerprint,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_STELLAR_PROJECTION_REQUEST_BYTES) {
    throw new TypeError("原生权威工作区投影请求超过安全上限");
  }
  return normalized;
}

function normalizeOperationsSettingPreloadRequest(request) {
  if (!hasExactKeys(request, [
    "expectedSessionId", "expectedRunId", "expectedRevision", "expectedRegistryFingerprint", "intent",
  ]) || !validLogicalPreloadId(request.expectedSessionId, 128) ||
      !validLogicalPreloadId(request.expectedRunId, 128) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      request.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !validLogicalPreloadId(request.expectedRegistryFingerprint, 256) ||
      !hasExactKeys(request.intent, ["type", "value"])) {
    throw new TypeError("原生运营设置请求无效");
  }
  const { type, value } = request.intent;
  const validIntent = type === "set-simulation-speed"
    ? value === 1 || value === 2 || value === 4
    : type === "set-technology-layout"
      ? value === "standard" || value === "compact"
      : type === "set-default-belt-route-mode"
        ? value === "auto" || value === "bezier" || value === "upper" || value === "lower"
        : type === "set-proliferator-buffer-limit"
          ? Number.isSafeInteger(value) && value >= 1 && value <= 100_000_000
          : type === "set-production-buffer-limit" || type === "set-logistics-buffer-limit" ||
              type === "set-belt-buffer-limit"
            ? Number.isSafeInteger(value) && value >= 1_000 && value <= 100_000_000
            : false;
  if (!validIntent) throw new TypeError("原生运营设置意图无效");
  return {
    expectedSessionId: request.expectedSessionId,
    expectedRunId: request.expectedRunId,
    expectedRevision: request.expectedRevision,
    expectedRegistryFingerprint: request.expectedRegistryFingerprint,
    intent: { type: request.intent.type, value: request.intent.value },
  };
}

function normalizeBlueprintCapturePreloadRequest(request) {
  if (!hasExactKeys(request, [
    "sessionId",
    "expectedRevision",
    "expectedRegistryFingerprint",
    "entityIds",
  ]) || !validLogicalPreloadId(request.sessionId, 128) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      request.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !validLogicalPreloadId(request.expectedRegistryFingerprint, 256) ||
      !Array.isArray(request.entityIds) || request.entityIds.length < 1 ||
      request.entityIds.length > MAX_BLUEPRINT_CAPTURE_ENTITY_IDS) {
    throw new TypeError("原生蓝图捕获请求无效");
  }
  const seen = new Set();
  const entityIds = [];
  for (const id of request.entityIds) {
    if (!validBoundedPreloadText(id, MAX_BLUEPRINT_CAPTURE_OPAQUE_ID_BYTES) || seen.has(id)) {
      throw new TypeError("原生蓝图捕获实体 ID 无效");
    }
    seen.add(id);
    entityIds.push(id);
  }
  const normalized = {
    sessionId: request.sessionId,
    expectedRevision: request.expectedRevision,
    expectedRegistryFingerprint: request.expectedRegistryFingerprint,
    entityIds,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_BLUEPRINT_CAPTURE_REQUEST_BYTES) {
    throw new TypeError("原生蓝图捕获请求超过安全上限");
  }
  return normalized;
}

function normalizeBlueprintImportPreloadRequest(request) {
  if (!hasExactKeys(request, [
    "sessionId", "expectedRevision", "expectedRegistryFingerprint", "raw",
  ]) || !validLogicalPreloadId(request.sessionId, 128) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      request.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !validLogicalPreloadId(request.expectedRegistryFingerprint, 256) ||
      typeof request.raw !== "string" || request.raw.trim().length < 1 ||
      !hasWellFormedUnicode(request.raw) ||
      Buffer.byteLength(request.raw, "utf8") > MAX_NATIVE_PROJECTION_TRANSFER_BYTES) {
    throw new TypeError("原生蓝图导入请求无效");
  }
  return {
    sessionId: request.sessionId,
    expectedRevision: request.expectedRevision,
    expectedRegistryFingerprint: request.expectedRegistryFingerprint,
    raw: request.raw,
  };
}

function normalizeBlueprintExportPreloadRequest(request) {
  if (!hasExactKeys(request, [
    "sessionId", "expectedRevision", "expectedRegistryFingerprint", "blueprintId",
    "blueprintRevision",
  ]) || !validLogicalPreloadId(request.sessionId, 128) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      request.expectedRevision > Number.MAX_SAFE_INTEGER ||
      !validLogicalPreloadId(request.expectedRegistryFingerprint, 256) ||
      !validBoundedPreloadText(request.blueprintId, 512) ||
      !Number.isSafeInteger(request.blueprintRevision) || request.blueprintRevision < 1) {
    throw new TypeError("原生蓝图导出请求无效");
  }
  return {
    sessionId: request.sessionId,
    expectedRevision: request.expectedRevision,
    expectedRegistryFingerprint: request.expectedRegistryFingerprint,
    blueprintId: request.blueprintId,
    blueprintRevision: request.blueprintRevision,
  };
}

function invokeNativeBlueprintCaptureContext(request) {
  const normalized = normalizeBlueprintCapturePreloadRequest(request);
  return invokeNative("desktop:native-core-blueprint-capture-context", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生蓝图捕获上下文请求失败，请重试",
  }, normalized);
}

function invokeNativeBlueprintImportContext(request) {
  const normalized = normalizeBlueprintImportPreloadRequest(request);
  return invokeNative("desktop:native-core-blueprint-import-context", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生蓝图导入上下文请求失败，请重试",
  }, normalized);
}

function invokeNativeBlueprintExportContext(request) {
  const normalized = normalizeBlueprintExportPreloadRequest(request);
  return invokeNative("desktop:native-core-blueprint-export-context", {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生蓝图导出上下文请求失败，请重试",
  }, normalized);
}

function invokeNative(channel, options, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((error) => {
    throw createRendererNativeRejection(error, options);
  });
}

function localNativeError(options) {
  return createRendererNativeError(null, options);
}

function subscribeNativePlayerAuthorityState(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("Windows 原生玩家权威状态监听器无效");
  }
  const handler = (_event, state) => listener(state);
  let subscribed = true;
  ipcRenderer.on("desktop:native-player-authority-state-changed", handler);
  return () => {
    if (!subscribed) return;
    subscribed = false;
    // Remove only the wrapper installed for this listener. Other renderer
    // consumers must never be disconnected by an unrelated unsubscribe.
    ipcRenderer.removeListener("desktop:native-player-authority-state-changed", handler);
  };
}

function requestNativeCoreProjectionTransfer(request) {
  return new Promise((resolve, reject) => {
    if (!hasExactKeys(request, ["sessionId", "projectionType", "payload"]) ||
      typeof request.sessionId !== "string" ||
      !NATIVE_CORE_TRANSFER_PROJECTION_TYPES.includes(request.projectionType) ||
      !request.payload || typeof request.payload !== "object") {
      reject(localNativeError({ fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生投影请求无效" }));
      return;
    }
    let normalizedPayload = request.payload;
    if (request.projectionType === "blueprint-capture-context-v1") {
      try {
        if (!hasExactKeys(request.payload, [
          "expectedRevision",
          "expectedRegistryFingerprint",
          "entityIds",
        ])) throw new TypeError("原生蓝图捕获 transfer payload 无效");
        const normalized = normalizeBlueprintCapturePreloadRequest({
          ...request.payload,
          sessionId: request.sessionId,
        });
        normalizedPayload = {
          expectedRevision: normalized.expectedRevision,
          expectedRegistryFingerprint: normalized.expectedRegistryFingerprint,
          entityIds: normalized.entityIds,
        };
      } catch {
        reject(localNativeError({ fallbackCode: "NATIVE_PROTOCOL_INVALID", message: "原生蓝图捕获请求无效" }));
        return;
      }
    } else if (request.projectionType === "blueprint-import-context-v1") {
      try {
        if (!hasExactKeys(request.payload, [
          "expectedRevision", "expectedRegistryFingerprint", "raw",
        ])) throw new TypeError("原生蓝图导入 transfer payload 无效");
        const normalized = normalizeBlueprintImportPreloadRequest({
          ...request.payload,
          sessionId: request.sessionId,
        });
        normalizedPayload = {
          expectedRevision: normalized.expectedRevision,
          expectedRegistryFingerprint: normalized.expectedRegistryFingerprint,
          raw: normalized.raw,
        };
      } catch {
        reject(localNativeError({ fallbackCode: "NATIVE_PROTOCOL_INVALID", message: "原生蓝图导入请求无效" }));
        return;
      }
    } else if (request.projectionType === "blueprint-export-context-v1") {
      try {
        if (!hasExactKeys(request.payload, [
          "expectedRevision", "expectedRegistryFingerprint", "blueprintId", "blueprintRevision",
        ])) throw new TypeError("原生蓝图导出 transfer payload 无效");
        const normalized = normalizeBlueprintExportPreloadRequest({
          ...request.payload,
          sessionId: request.sessionId,
        });
        normalizedPayload = {
          expectedRevision: normalized.expectedRevision,
          expectedRegistryFingerprint: normalized.expectedRegistryFingerprint,
          blueprintId: normalized.blueprintId,
          blueprintRevision: normalized.blueprintRevision,
        };
      } catch {
        reject(localNativeError({ fallbackCode: "NATIVE_PROTOCOL_INVALID", message: "原生蓝图导出请求无效" }));
        return;
      }
    }
    if (["blueprint-workspace-v1", "blueprint-export-context-v1", "blueprint-enqueue-context-v1", "blueprint-direct-deploy-context-v1", "star-map-overview-v1", "star-map-catalog-v1", "stellar-industry-v1", "stellar-industry-v2", "stellar-quantum-v1", "dyson-workspace-v1", "system-space-station-workspace-v1"].includes(request.projectionType)) {
      let requestBytes;
      try {
        requestBytes = Buffer.byteLength(JSON.stringify({
          ...normalizedPayload,
          sessionId: request.sessionId,
        }), "utf8");
      } catch {
        requestBytes = Number.POSITIVE_INFINITY;
      }
      if (requestBytes > MAX_STELLAR_PROJECTION_REQUEST_BYTES) {
        reject(localNativeError({ fallbackCode: "NATIVE_PROTOCOL_INVALID", message: "原生投影请求超过安全上限" }));
        return;
      }
    }
    nativeProjectionSequence = nativeProjectionSequence >= Number.MAX_SAFE_INTEGER
      ? 1
      : nativeProjectionSequence + 1;
    const sequence = nativeProjectionSequence;
    const channel = new MessageChannel();
    let settled = false;
    const watchdog = setTimeout(() => {
      finish(() => reject(localNativeError({ fallbackCode: "NATIVE_CORE_PROJECTION_TIMEOUT", message: "原生投影响应超时，请重试" })));
    }, 15_000);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      channel.port1.close();
      callback();
    };
    channel.port1.onmessage = (event) => {
      if (event.data?.error) {
        const error = createRendererNativeError(event.data.error, {
          fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
          message: "原生投影请求失败，请重试",
        });
        finish(() => reject(error));
        return;
      }
      const header = event.data?.header;
      const rawPayload = event.data?.payload;
      const payload = rawPayload instanceof Uint8Array
        ? rawPayload
        : rawPayload instanceof ArrayBuffer
          ? new Uint8Array(rawPayload)
          : null;
      if (!header || header.schemaVersion !== 1 || header.sessionId !== request.sessionId ||
        header.sequence !== sequence || header.projectionType !== request.projectionType ||
        !Number.isSafeInteger(header.revision) || header.revision < 0 ||
        !Number.isSafeInteger(header.payloadLength) || header.payloadLength < 1 ||
        header.payloadLength > MAX_NATIVE_PROJECTION_TRANSFER_BYTES ||
        typeof header.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(header.sha256) ||
        !payload || payload.byteLength !== header.payloadLength) {
        finish(() => reject(localNativeError({ fallbackCode: "NATIVE_PROTOCOL_INVALID", message: "原生投影响应验证失败，请重试" })));
        return;
      }
      const checksum = createHash("sha256")
        .update(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength))
        .digest("hex");
      if (checksum !== header.sha256) {
        finish(() => reject(localNativeError({ fallbackCode: "NATIVE_PROTOCOL_INVALID", message: "原生投影响应验证失败，请重试" })));
        return;
      }
      const bodyBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
      channel.port1.postMessage({ projectionAck: { sequence, sha256: header.sha256 } });
      finish(() => resolve({ header, bodyBuffer }));
    };
    channel.port1.onmessageerror = () => {
      finish(() => reject(localNativeError({ fallbackCode: "NATIVE_PROTOCOL_INVALID", message: "原生投影响应无法读取，请重试" })));
    };
    ipcRenderer.postMessage("desktop:native-core-projection-transfer", {
      sessionId: request.sessionId,
      projectionType: request.projectionType,
      sequence,
      payload: normalizedPayload,
    }, [channel.port2]);
  });
}

contextBridge.exposeInMainWorld("dspDesktop", {
  isDesktop: true,
  setFontScale: (scale) => ipcRenderer.invoke("desktop:set-font-scale", scale),
  getReleaseInfo: () => ipcRenderer.invoke("desktop:release-info"),
  getNativePerformanceStatus: () => invokeNative("desktop:native-status", { fallbackCode: "NATIVE_STATUS_FAILED", message: "无法读取 Windows 原生性能服务状态" }),
  // Authority identity and durable control remain main-owned. The only macro
  // mutation surface accepts bounded time budgets plus a start-only observed
  // revision fence (or an empty finish/retry), and never accepts a session,
  // run, checkpoint, lease or operation ID.
  getNativePlayerAuthorityState: () => invokeNative("desktop:native-player-authority-state", { fallbackCode: "NATIVE_PLAYER_AUTHORITY_STATE_FAILED", message: "无法读取 Windows 原生玩家权威时钟" }),
  onNativePlayerAuthorityState: subscribeNativePlayerAuthorityState,
  // The renderer supplies only player intent. Main owns the current
  // session/run/revision and chooses the durable wall-clock anchor.
  setNativePlayerAuthorityPaused: (request) => invokeNative("desktop:native-player-authority-set-paused",
    { fallbackCode: "NATIVE_PLAYER_AUTHORITY_PAUSE_FAILED", message: "Windows 原生暂停状态切换失败" },
    request,
  ),
  // Response-only internal handshake. The listener cannot start a handoff,
  // select an owner, or invoke transferOwner; it can only answer a currently
  // pending challenge generated and bound by main.
  onNativePlayerAuthorityHandoffRequest: (listener) =>
    subscribeRendererToNativePlayerAuthorityHandoff(ipcRenderer, listener),
  // Persistence is main-owned after handoff. Neither method accepts a
  // session, run, owner, lease, checkpoint, or fencing identity.
  checkpointNativePlayerAuthority: () => invokeNative("desktop:native-player-authority-checkpoint", { fallbackCode: "NATIVE_PLAYER_AUTHORITY_CHECKPOINT_FAILED", message: "Windows 原生权威检查点验证失败，请重试" }),
  exportNativePlayerAuthorityV47: (request) => invokeNative("desktop:native-player-authority-export-v47", { fallbackCode: "NATIVE_PLAYER_AUTHORITY_EXPORT_FAILED", message: "Windows 原生权威 v47 存档导出失败" }, request),
  startNativePlayerAuthorityMacro: (request) => invokeNative("desktop:native-player-authority-macro-start", { fallbackCode: "NATIVE_PLAYER_AUTHORITY_MACRO_FAILED", message: "Windows 原生纯挂机结算启动失败" }, request),
  advanceNativePlayerAuthorityMacro: (request) => invokeNative("desktop:native-player-authority-macro-advance", { fallbackCode: "NATIVE_PLAYER_AUTHORITY_MACRO_FAILED", message: "Windows 原生纯挂机结算推进失败" }, request),
  finishNativePlayerAuthorityMacro: () => invokeNative("desktop:native-player-authority-macro-finish", { fallbackCode: "NATIVE_PLAYER_AUTHORITY_MACRO_FAILED", message: "Windows 原生纯挂机结算结束失败" }, {}),
  recoverNativePlayerAuthorityMacro: () => invokeNative("desktop:native-player-authority-macro-recover", { fallbackCode: "NATIVE_PLAYER_AUTHORITY_MACRO_FAILED", message: "Windows 原生纯挂机结算恢复失败" }, {}),
  getRuntimeDiagnostics: () => ipcRenderer.invoke("desktop:runtime-diagnostics"),
  getNativePerformancePolicy: () => invokeNative("desktop:native-performance-policy", { fallbackCode: "NATIVE_PERFORMANCE_POLICY_READ_FAILED", message: "无法读取 Windows 原生性能策略" }),
  setNativePerformancePolicy: (request) => invokeNative("desktop:set-native-performance-policy", { fallbackCode: "NATIVE_PERFORMANCE_POLICY_WRITE_FAILED", message: "无法保存 Windows 原生性能策略" }, request),
  beginNativeSave: (request) => invokeNative("desktop:native-save-begin", { fallbackCode: "NATIVE_SAVE_BEGIN_FAILED", message: "原生存档事务启动失败，请重试" }, request),
  writeNativeSave: (request) => invokeNative("desktop:native-save-write", { fallbackCode: "NATIVE_SAVE_WRITE_FAILED", message: "原生存档分块写入失败，请重试" }, request),
  commitNativeSave: (request) => invokeNative("desktop:native-save-commit", { fallbackCode: "NATIVE_SAVE_COMMIT_FAILED", message: "原生存档提交失败，请重新检查存档状态" }, request),
  abortNativeSave: (request) => invokeNative("desktop:native-save-abort", { fallbackCode: "NATIVE_SAVE_ABORT_FAILED", message: "原生存档事务取消失败，请重新检查存档状态" }, request),
  recoverNativeSave: (request) => invokeNative("desktop:native-save-recover", { fallbackCode: "NATIVE_SAVE_RECOVER_FAILED", message: "原生存档恢复检查失败，请重试" }, request),
  readNativeSave: (request) => invokeNative("desktop:native-save-read", { fallbackCode: "NATIVE_SAVE_READ_FAILED", message: "原生存档区块读取失败，请重试" }, request),
  appendNativeWal: (request) => invokeNative("desktop:native-wal-append", { fallbackCode: "NATIVE_WAL_APPEND_FAILED", message: "原生存档日志写入失败，请重新检查存档状态" }, request),
  compactNativeSave: (request) => invokeNative("desktop:native-save-compact", { fallbackCode: "NATIVE_SAVE_COMPACT_FAILED", message: "原生存档空闲合并失败，请稍后重试" }, request),
  openNativeCore: (request) => invokeNative("desktop:native-core-open", { fallbackCode: "NATIVE_CORE_OPEN_FAILED", message: "原生影子核心打开失败，请重试" }, request),
  importNativeCoreV47: (request) => invokeNative("desktop:native-core-import-v47", { fallbackCode: "NATIVE_CORE_V47_IMPORT_FAILED", message: "原生 v47 存档导入失败；未验证的内容不会进入游戏会话" }, request),
  getNativeCoreStatus: (request) => invokeNative("desktop:native-core-status", { fallbackCode: "NATIVE_CORE_STATUS_FAILED", message: "原生影子核心状态读取失败，请重试" }, request),
  getNativeCoreProjection: (request) => invokeNative("desktop:native-core-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生投影请求失败，请重试" }, request),
  getNativeCoreViewportProjection: (request) => invokeNative("desktop:native-core-viewport-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生视口投影请求失败，请重试" }, request),
  getNativeCoreViewportProjectionV2: (request) => invokeNative("desktop:native-core-viewport-projection-v2", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生视口 v2 投影请求失败，请重试" }, request),
  getNativeCoreFactoryReadModel: (request) => invokeNative("desktop:native-core-factory-read-model", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生工厂只读模型请求失败，请重试" }, request),
  getNativeCoreFactoryInventory: (request) => invokeNative("desktop:native-core-factory-inventory", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生工厂库存请求失败，请重试" }, request),
  getNativeCoreConstructionInventory: (request) => invokeNative("desktop:native-core-construction-inventory", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生建筑库存请求失败，请重试" }, request),
  getNativeCoreBlueprintWorkspace: (request) => invokeNative("desktop:native-core-blueprint-workspace", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生蓝图只读模型请求失败，请重试" }, request),
  getNativeCoreBlueprintCaptureContext: invokeNativeBlueprintCaptureContext,
  getNativeCoreBlueprintImportContext: invokeNativeBlueprintImportContext,
  getNativeCoreBlueprintExportContext: invokeNativeBlueprintExportContext,
  getNativeCoreBlueprintEnqueueContext: (request) => invokeNative("desktop:native-core-blueprint-enqueue-context", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生蓝图入队上下文请求失败，请重试" }, request),
  getNativeCoreBlueprintDirectDeployContext: (request) => invokeNative("desktop:native-core-blueprint-direct-deploy-context", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生蓝图直接部署上下文请求失败，请重试" }, request),
  getNativeCoreConstructionPlacementContext: (request) => invokeNative("desktop:native-core-construction-placement-context", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生建筑放置上下文请求失败，请重试" }, request),
  getNativeCoreConstructionBeltPlacementContext: (request) => invokeNative("desktop:native-core-construction-belt-placement-context", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生传送带放置上下文请求失败，请重试" }, request),
  getNativeCoreConstructionBeltLaneContext: (request) => invokeNative("desktop:native-core-construction-belt-lane-context", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生传送带并联调整上下文请求失败，请重试" }, request),
  getNativeCoreConstructionBeltRemovalContext: (request) => invokeNative("desktop:native-core-construction-belt-removal-context", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生传送带回收上下文请求失败，请重试" }, request),
  getNativeCoreConstructionRemovalContext: (request) => invokeNative("desktop:native-core-construction-removal-context", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生建筑回收上下文请求失败，请重试" }, request),
  getNativeCoreConstructionStackContext: (request) => invokeNative("desktop:native-core-construction-stack-context", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生建筑堆叠上下文请求失败，请重试" }, request),
  getNativeCoreStatisticsProjection: (request) => invokeNative("desktop:native-core-statistics-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生统计投影请求失败，请重试" }, request),
  getNativeCoreTechnologyProjection: (request) => invokeNative("desktop:native-core-technology-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生科研投影请求失败，请重试" }, request),
  getNativeCoreRecipeWorkspaceProjection: (request) => invokeNative("desktop:native-core-recipe-workspace-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生生产资料库投影请求失败，请重试" }, request),
  getNativeCoreStarMapOverviewProjection: (request) => invokeNative("desktop:native-core-star-map-overview-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生星图总览投影请求失败，请重试" }, request),
  getNativeCoreStarMapCatalogProjection: (request) => invokeNative("desktop:native-core-star-map-catalog-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生星图目录投影请求失败，请重试" }, request),
  getNativeCoreStellarIndustryProjection: (request) => invokeNative("desktop:native-core-stellar-industry-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生恒星工业投影请求失败，请重试" }, request),
  getNativeCoreStellarIndustryV2Projection: (request) => invokeNative("desktop:native-core-stellar-industry-v2-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生恒星工业 v2 投影请求失败，请重试" }, request),
  getNativeCoreStellarQuantumProjection: (request) => invokeNative("desktop:native-core-stellar-quantum-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生量子库存投影请求失败，请重试" }, request),
  getNativeCoreDysonWorkspaceProjection: (request) => invokeNative("desktop:native-core-dyson-workspace-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生戴森球工作区投影请求失败，请重试" }, request),
  getNativeCoreSystemSpaceStationWorkspaceProjection: (request) => invokeNative("desktop:native-core-system-space-station-workspace-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生恒星系空间站工作区投影请求失败，请重试" }, request),
  getNativeCoreOrbitalContractWorkspaceProjection: (request) => invokeNative("desktop:native-core-orbital-contract-workspace-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生轨道合同工作区投影请求失败，请重试" }, request),
  getNativeCoreCampaignWorkspaceProjection: (request) => invokeNative("desktop:native-core-campaign-workspace-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生主线任务工作区投影请求失败，请重试" }, normalizeAuthorityWorkspacePreloadRequest(request)),
  getNativeCoreOperationsWorkspaceProjection: (request) => invokeNative("desktop:native-core-operations-workspace-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生运营中心投影请求失败，请重试" }, normalizeAuthorityWorkspacePreloadRequest(request)),
  getNativeCoreGalaxyAccountWorkspaceProjection: (request) => invokeNative("desktop:native-core-galaxy-account-workspace-projection", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生银河账户工作区投影请求失败，请重试" }, normalizeAuthorityWorkspacePreloadRequest(request)),
  getNativeCoreCommandPaletteEntitySearch: (request) => invokeNative("desktop:native-core-command-palette-entity-search", { fallbackCode: "NATIVE_CORE_PROJECTION_FAILED", message: "原生命令面板设备搜索失败，请重试" }, request),
  requestNativeCoreProjectionTransfer,
  applyNativeCoreCommand: (request) => invokeNative("desktop:native-core-apply-command", { fallbackCode: "NATIVE_CORE_COMMAND_FAILED", message: "原生影子命令执行失败，请重试" }, request),
  reconcileNativeCoreCommand: (request) => invokeNative("desktop:native-core-reconcile-command", { fallbackCode: "NATIVE_CORE_COMMAND_RECONCILE_FAILED", message: "原生权威命令耐久收据对账失败" }, request),
  commitNativeSystemSpaceStationIntent: (request) => invokeNative("desktop:native-player-authority-system-space-station-intent", { fallbackCode: "NATIVE_PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_COMMAND_FAILED", message: "原生恒星系空间站命令提交失败，请重试" }, request),
  commitNativeOrbitalContractIntent: (request) => invokeNative("desktop:native-player-authority-orbital-contract-intent", { fallbackCode: "NATIVE_PLAYER_AUTHORITY_ORBITAL_CONTRACT_COMMAND_FAILED", message: "原生轨道合同命令提交失败，请重试" }, request),
  commitNativeOperationsSettingIntent: (request) => invokeNative("desktop:native-player-authority-operations-setting-intent", { fallbackCode: "NATIVE_PLAYER_AUTHORITY_OPERATIONS_SETTING_COMMAND_FAILED", message: "原生运营设置提交失败，请重试" }, normalizeOperationsSettingPreloadRequest(request)),
  advanceNativeCore: (request) => invokeNative("desktop:native-core-advance", { fallbackCode: "NATIVE_CORE_ADVANCE_FAILED", message: "原生影子模拟推进失败，请重试" }, request),
  commitNativeCoreOperation: (request) => invokeNative("desktop:native-core-commit-operation", { fallbackCode: "NATIVE_CORE_COMMIT_FAILED", message: "原生影子事务提交失败，请重新检查影子状态" }, request),
  checkpointNativeCore: (request) => invokeNative("desktop:native-core-checkpoint", { fallbackCode: "NATIVE_CORE_CHECKPOINT_FAILED", message: "原生影子检查点生成失败，请重试" }, request),
  exportNativeCoreV47: (request) => invokeNative("desktop:native-core-export-v47", { fallbackCode: "NATIVE_CORE_V47_EXPORT_FAILED", message: "原生 v47 存档导出失败；目标文件不会接收未经校验的内容" }, request),
  compareNativeCore: (request) => invokeNative("desktop:native-core-compare", { fallbackCode: "NATIVE_CORE_COMPARE_FAILED", message: "原生影子一致性比较失败，请重试" }, request),
  closeNativeCore: (request) => invokeNative("desktop:native-core-close", { fallbackCode: "NATIVE_CORE_CLOSE_FAILED", message: "原生影子会话关闭失败，请重新检查影子状态" }, request),
  requestApi: (request) => ipcRenderer.invoke("desktop:api-request", request),
  requestApiTransfer: (request, body) => new Promise((resolve, reject) => {
    if (!(body instanceof ArrayBuffer)) {
      reject(new TypeError("桌面 API 可转移正文无效"));
      return;
    }
    const channel = new MessageChannel();
    let settled = false;
    const watchdogMs = Math.max(15_000, Math.min(65_000, Number(request?.timeoutMs) + 5_000 || 65_000));
    let watchdog = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        ipcRenderer.send("desktop:api-request-cancel", request?.requestId);
        finish(() => reject(Object.assign(new Error("桌面云请求超时"), { name: "AbortError", code: "CLOUD_REQUEST_TIMEOUT" })));
      }, watchdogMs);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      channel.port1.close();
      callback();
    };
    armWatchdog();
    const chunks = [];
    let receivedBytes = 0;
    let responseMetadata = null;
    channel.port1.onmessage = (event) => {
      armWatchdog();
      if (event.data?.error) {
        const error = new Error(event.data.error.message || "桌面云请求失败");
        error.name = event.data.error.name || "Error";
        error.code = event.data.error.code;
        finish(() => reject(error));
        return;
      }
      if (event.data?.responseStart) {
        responseMetadata = event.data.responseStart;
        return;
      }
      if (event.data?.responseChunk instanceof Uint8Array) {
        chunks.push(event.data.responseChunk);
        receivedBytes += event.data.responseChunk.byteLength;
        channel.port1.postMessage({ responseAck: receivedBytes });
        return;
      }
      if (event.data?.responseEnd) {
        if (!responseMetadata || receivedBytes !== event.data.totalBytes) {
          finish(() => reject(new Error("桌面云响应长度不一致")));
          return;
        }
        const body = new Uint8Array(receivedBytes);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        finish(() => resolve({ ...responseMetadata, bodyBuffer: body.buffer }));
      }
    };
    channel.port1.onmessageerror = () => {
      finish(() => reject(new Error("桌面云请求响应无法读取")));
    };
    ipcRenderer.postMessage("desktop:api-request-transfer", request, [channel.port2]);
    let offset = 0;
    const sendNextChunk = (event) => {
      if (event && !Object.prototype.hasOwnProperty.call(event.data ?? {}, "requestAck")) return;
      const expectedOffset = event?.data?.requestAck;
      if (expectedOffset !== undefined && expectedOffset !== offset) {
        finish(() => reject(new Error("桌面云请求分片确认无效")));
        return;
      }
      if (offset >= body.byteLength) {
        channel.port1.removeEventListener("message", sendNextChunk);
        channel.port1.postMessage({ requestEnd: true, totalBytes: offset });
        return;
      }
      const end = Math.min(body.byteLength, offset + 1024 * 1024);
      const chunk = new Uint8Array(body.slice(offset, end));
      offset = end;
      channel.port1.postMessage({ requestChunk: chunk, offset });
    };
    channel.port1.addEventListener("message", sendNextChunk);
    sendNextChunk();
  }),
  cancelApiRequest: (requestId) => ipcRenderer.send("desktop:api-request-cancel", requestId),
  downloadAccountArchive: async (request) => {
    const result = await ipcRenderer.invoke("desktop:download-account-archive", request);
    if (result?.ok) return result.value;
    const error = new Error(result?.error?.message || "账号归档下载失败");
    error.name = result?.error?.name || "Error";
    error.code = result?.error?.code || "ACCOUNT_ARCHIVE_DOWNLOAD_FAILED";
    if (Number.isSafeInteger(result?.error?.status)) error.status = result.error.status;
    if (typeof result?.error?.serverCode === "string") error.serverCode = result.error.serverCode;
    throw error;
  },
  cancelAccountArchiveDownload: (requestId) => ipcRenderer.send("desktop:cancel-account-archive-download", requestId),
  checkForUpdates: () => ipcRenderer.invoke("desktop:check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("desktop:download-update"),
  installUpdate: () => ipcRenderer.invoke("desktop:install-update"),
  confirmUpdateReady: () => ipcRenderer.invoke("desktop:update-ready"),
  onPrepareForUpdate: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("desktop:prepare-for-update", handler);
    return () => ipcRenderer.removeListener("desktop:prepare-for-update", handler);
  },
  onUpdateStatus: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on("desktop:update-status", handler);
    return () => ipcRenderer.removeListener("desktop:update-status", handler);
  },
});
