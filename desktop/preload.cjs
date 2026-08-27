const { contextBridge, ipcRenderer } = require("electron");
const { createHash } = require("node:crypto");

const MAX_NATIVE_PROJECTION_TRANSFER_BYTES = 1024 * 1024;
let nativeProjectionSequence = 0;

function requestNativeCoreProjectionTransfer(request) {
  return new Promise((resolve, reject) => {
    if (!request || typeof request !== "object" || typeof request.sessionId !== "string" ||
      !["viewport-v1", "statistics-v1"].includes(request.projectionType) ||
      !request.payload || typeof request.payload !== "object") {
      reject(new TypeError("原生投影二进制请求无效"));
      return;
    }
    nativeProjectionSequence = nativeProjectionSequence >= Number.MAX_SAFE_INTEGER
      ? 1
      : nativeProjectionSequence + 1;
    const sequence = nativeProjectionSequence;
    const channel = new MessageChannel();
    let settled = false;
    const watchdog = setTimeout(() => {
      finish(() => reject(new Error("原生投影二进制响应超时")));
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
        const error = new Error(event.data.error.message || "原生投影二进制请求失败");
        error.name = event.data.error.name || "Error";
        error.code = event.data.error.code;
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
        finish(() => reject(new Error("原生投影二进制响应头无效")));
        return;
      }
      const checksum = createHash("sha256")
        .update(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength))
        .digest("hex");
      if (checksum !== header.sha256) {
        finish(() => reject(new Error("原生投影二进制响应校验失败")));
        return;
      }
      const bodyBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
      channel.port1.postMessage({ projectionAck: { sequence, sha256: header.sha256 } });
      finish(() => resolve({ header, bodyBuffer }));
    };
    channel.port1.onmessageerror = () => {
      finish(() => reject(new Error("原生投影二进制响应无法读取")));
    };
    ipcRenderer.postMessage("desktop:native-core-projection-transfer", {
      sessionId: request.sessionId,
      projectionType: request.projectionType,
      sequence,
      payload: request.payload,
    }, [channel.port2]);
  });
}

contextBridge.exposeInMainWorld("dspDesktop", {
  isDesktop: true,
  setFontScale: (scale) => ipcRenderer.invoke("desktop:set-font-scale", scale),
  getReleaseInfo: () => ipcRenderer.invoke("desktop:release-info"),
  getNativePerformanceStatus: () => ipcRenderer.invoke("desktop:native-status"),
  getRuntimeDiagnostics: () => ipcRenderer.invoke("desktop:runtime-diagnostics"),
  getNativePerformancePolicy: () => ipcRenderer.invoke("desktop:native-performance-policy"),
  setNativePerformancePolicy: (request) => ipcRenderer.invoke("desktop:set-native-performance-policy", request),
  beginNativeSave: (request) => ipcRenderer.invoke("desktop:native-save-begin", request),
  writeNativeSave: (request) => ipcRenderer.invoke("desktop:native-save-write", request),
  commitNativeSave: (request) => ipcRenderer.invoke("desktop:native-save-commit", request),
  abortNativeSave: (request) => ipcRenderer.invoke("desktop:native-save-abort", request),
  recoverNativeSave: (request) => ipcRenderer.invoke("desktop:native-save-recover", request),
  readNativeSave: (request) => ipcRenderer.invoke("desktop:native-save-read", request),
  appendNativeWal: (request) => ipcRenderer.invoke("desktop:native-wal-append", request),
  compactNativeSave: (request) => ipcRenderer.invoke("desktop:native-save-compact", request),
  openNativeCore: (request) => ipcRenderer.invoke("desktop:native-core-open", request),
  getNativeCoreStatus: (request) => ipcRenderer.invoke("desktop:native-core-status", request),
  getNativeCoreProjection: (request) => ipcRenderer.invoke("desktop:native-core-projection", request),
  getNativeCoreViewportProjection: (request) => ipcRenderer.invoke("desktop:native-core-viewport-projection", request),
  getNativeCoreStatisticsProjection: (request) => ipcRenderer.invoke("desktop:native-core-statistics-projection", request),
  requestNativeCoreProjectionTransfer,
  applyNativeCoreCommand: (request) => ipcRenderer.invoke("desktop:native-core-apply-command", request),
  advanceNativeCore: (request) => ipcRenderer.invoke("desktop:native-core-advance", request),
  commitNativeCoreOperation: (request) => ipcRenderer.invoke("desktop:native-core-commit-operation", request),
  checkpointNativeCore: (request) => ipcRenderer.invoke("desktop:native-core-checkpoint", request),
  exportNativeCoreV47: (request) => ipcRenderer.invoke("desktop:native-core-export-v47", request),
  compareNativeCore: (request) => ipcRenderer.invoke("desktop:native-core-compare", request),
  closeNativeCore: (request) => ipcRenderer.invoke("desktop:native-core-close", request),
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
