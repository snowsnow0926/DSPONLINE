const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dspDesktop", {
  isDesktop: true,
  setFontScale: (scale) => ipcRenderer.invoke("desktop:set-font-scale", scale),
  getReleaseInfo: () => ipcRenderer.invoke("desktop:release-info"),
  getNativePerformanceStatus: () => ipcRenderer.invoke("desktop:native-status"),
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
  applyNativeCoreCommand: (request) => ipcRenderer.invoke("desktop:native-core-apply-command", request),
  advanceNativeCore: (request) => ipcRenderer.invoke("desktop:native-core-advance", request),
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
