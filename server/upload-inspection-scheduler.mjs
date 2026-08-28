import { Worker } from "node:worker_threads";
import { gunzip as gunzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(gunzipCallback);

function uploadError(message, statusCode, code, retryAfterSeconds = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
    error.retryAfterSeconds = retryAfterSeconds;
  }
  return error;
}

function abortedUploadError(reason = null) {
  if (reason?.code === "SERVER_SHUTTING_DOWN") return reason;
  return uploadError("云存档上传已取消，本地存档未修改", 499, "UPLOAD_CANCELLED");
}

function exactTransferBuffer(raw) {
  if (raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength) return raw.buffer;
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  return copy.buffer;
}

function workerFailure(error) {
  if (error?.statusCode && error?.code) return error;
  return uploadError("云存档后台检查失败，请稍后重试", 503, "UPLOAD_INSPECTION_FAILED", 1);
}

const rejectionCategoryByCode = Object.freeze({
  REQUEST_BODY_TOO_LARGE: "requestBodyTooLarge",
  REQUEST_EXPANDED_BODY_TOO_LARGE: "expandedBodyTooLarge",
  REQUEST_ENCODING_UNSUPPORTED: "encodingUnsupported",
  REQUEST_ENCODING_INVALID: "encodingInvalid",
  REQUEST_FORMAT_INVALID: "requestFormatInvalid",
  REQUEST_SIZE_INVALID: "declaredSizeInvalid",
  EXPECTED_REVISION_INVALID: "expectedRevisionInvalid",
  OPERATION_ID_INVALID: "operationIdInvalid",
  SAVE_SIZE_TOO_LARGE: "saveSizeTooLarge",
  SAVE_INTEGRITY_INVALID: "saveIntegrityInvalid",
  SAVE_FORMAT_INVALID: "saveFormatInvalid",
  SAVE_MODE_MISMATCH: "saveModeMismatch",
  UPLOAD_INSPECTION_BUSY: "busy",
  UPLOAD_INSPECTION_FAILED: "inspectionFailed",
  UPLOAD_CANCELLED: "cancelled",
  SERVER_SHUTTING_DOWN: "shutdown",
});

function runInspectionWorker(raw, descriptor, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedUploadError(signal.reason));
    const worker = new Worker(new URL("./upload-inspection-worker.mjs", import.meta.url));
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => {
      finish(() => {
        void worker.terminate();
        reject(abortedUploadError(signal?.reason));
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message) => {
      finish(() => {
        void worker.terminate();
        if (!message?.ok) {
          const error = uploadError(
            typeof message?.error?.message === "string" ? message.error.message : "云存档后台检查失败，请稍后重试",
            Number.isInteger(message?.error?.statusCode) ? message.error.statusCode : 503,
            typeof message?.error?.code === "string" ? message.error.code : "UPLOAD_INSPECTION_FAILED",
            Number.isInteger(message?.error?.retryAfterSeconds) ? message.error.retryAfterSeconds : null,
          );
          reject(error);
          return;
        }
        resolve(message.result);
      });
    });
    worker.once("error", (error) => finish(() => reject(workerFailure(error))));
    worker.once("exit", (code) => {
      if (!settled) finish(() => reject(workerFailure(new Error(`upload inspection worker exited with ${code} before returning a result`))));
    });
    const buffer = exactTransferBuffer(raw);
    worker.postMessage({ buffer, descriptor }, [buffer]);
  });
}

function decodeReturnedPayload(result) {
  if (!result?.validPayload) return { ...result, payload: undefined, payloadBuffer: undefined };
  if (!(result.payloadBuffer instanceof ArrayBuffer)) {
    throw uploadError("云存档后台检查未返回原始正文", 503, "UPLOAD_INSPECTION_FAILED", 1);
  }
  let payload;
  try {
    payload = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.payloadBuffer);
  } catch {
    throw uploadError("请求正文不是有效 UTF-8", 400, "REQUEST_FORMAT_INVALID");
  }
  if (payload.charCodeAt(0) === 0xfeff) {
    throw uploadError("请求正文不能包含 UTF-8 BOM", 400, "REQUEST_FORMAT_INVALID");
  }
  return { ...result, payload, payloadBuffer: undefined };
}

export class UploadInspectionScheduler {
  constructor({
    inspectInline,
    concurrency = 2,
    queueLimit = 16,
    workerThresholdBytes = 1024 * 1024,
    maximumConcurrentExpandedBytes = 320 * 1024 * 1024,
  } = {}) {
    if (typeof inspectInline !== "function") throw new TypeError("inspectInline is required");
    this.inspectInline = inspectInline;
    this.concurrency = Math.max(1, Math.min(8, Math.floor(concurrency) || 2));
    this.queueLimit = Math.max(this.concurrency, Math.min(64, Math.floor(queueLimit) || 16));
    this.workerThresholdBytes = Math.max(64 * 1024, Math.floor(workerThresholdBytes) || 1024 * 1024);
    this.maximumConcurrentExpandedBytes = Math.max(
      1024 * 1024,
      Math.floor(maximumConcurrentExpandedBytes) || 320 * 1024 * 1024,
    );
    this.active = 0;
    this.activeExpandedBytes = 0;
    this.queue = [];
    this.closed = false;
    this.activeControllers = new Set();
    this.metrics = {
      accepted: 0,
      completed: 0,
      cancelled: 0,
      rejectedBusy: 0,
      failed: 0,
      workerRuns: 0,
      inlineRuns: 0,
      maxQueued: 0,
      maxExpandedBytes: 0,
      maxActiveExpandedBytes: 0,
      maxWorkerHeapBytes: 0,
      lastTotalMs: 0,
      lastDecompressionMs: 0,
      lastInspectionMs: 0,
      rejectionReasons: {},
    };
  }

  snapshot() {
    return {
      active: this.active,
      queued: this.queue.length,
      concurrency: this.concurrency,
      queueLimit: this.queueLimit,
      activeExpandedBytes: this.activeExpandedBytes,
      maximumConcurrentExpandedBytes: this.maximumConcurrentExpandedBytes,
      ...this.metrics,
      rejectionReasons: { ...this.metrics.rejectionReasons },
    };
  }

  recordRejection(code) {
    const category = rejectionCategoryByCode[code] ?? "other";
    this.metrics.rejectionReasons[category] = (this.metrics.rejectionReasons[category] ?? 0) + 1;
  }

  shouldSchedule({ encoding = "", contentLength = null, declaredOriginalBytes = null } = {}) {
    return encoding === "gzip" || !Number.isSafeInteger(contentLength) || contentLength >= this.workerThresholdBytes ||
      Number.isSafeInteger(declaredOriginalBytes) && declaredOriginalBytes >= this.workerThresholdBytes;
  }

  async run(task, { scheduled = true, signal = null, expandedBytes = 0 } = {}) {
    if (typeof task !== "function") throw new TypeError("task is required");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    this.activeControllers.add(controller);
    let release = null;
    try {
      if (this.closed) {
        this.recordRejection("SERVER_SHUTTING_DOWN");
        throw uploadError("服务正在安全关闭，请稍后重试", 503, "SERVER_SHUTTING_DOWN", 1);
      }
      if (controller.signal.aborted) {
        this.recordRejection("UPLOAD_CANCELLED");
        throw abortedUploadError(controller.signal.reason);
      }
      if (scheduled) release = await this.acquire(controller.signal, expandedBytes);
      return await task({
        signal: controller.signal,
        inspect: (raw, descriptor) => this.inspect(raw, descriptor, controller.signal),
      });
    } finally {
      release?.();
      signal?.removeEventListener("abort", forwardAbort);
      this.activeControllers.delete(controller);
    }
  }

  acquire(signal, expandedBytes = 0) {
    if (this.closed) return Promise.reject(uploadError("服务正在安全关闭，请稍后重试", 503, "SERVER_SHUTTING_DOWN", 1));
    if (signal?.aborted) return Promise.reject(abortedUploadError(signal.reason));
    const reservedBytes = Math.max(0, Math.min(this.maximumConcurrentExpandedBytes, Math.floor(expandedBytes) || 0));
    if (this.active < this.concurrency && this.queue.length === 0 && this.activeExpandedBytes + reservedBytes <= this.maximumConcurrentExpandedBytes) {
      this.active += 1;
      this.activeExpandedBytes += reservedBytes;
      this.metrics.maxActiveExpandedBytes = Math.max(this.metrics.maxActiveExpandedBytes, this.activeExpandedBytes);
      this.metrics.accepted += 1;
      return Promise.resolve(this.releaseFactory(reservedBytes));
    }
    if (this.queue.length >= this.queueLimit) {
      this.metrics.rejectedBusy += 1;
      this.recordRejection("UPLOAD_INSPECTION_BUSY");
      return Promise.reject(uploadError("云存档检查队列繁忙，请稍后重试；本地存档未修改", 503, "UPLOAD_INSPECTION_BUSY", 1));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, reservedBytes, onAbort: null };
      entry.onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        this.metrics.cancelled += 1;
        this.recordRejection("UPLOAD_CANCELLED");
        reject(abortedUploadError(signal?.reason));
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
      this.metrics.maxQueued = Math.max(this.metrics.maxQueued, this.queue.length);
      // A smaller request may fit the byte budget while an earlier large
      // request is waiting. Re-evaluate immediately instead of waiting for an
      // unrelated active upload to finish.
      this.dispatch();
    });
  }

  releaseFactory(reservedBytes = 0) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.activeExpandedBytes = Math.max(0, this.activeExpandedBytes - reservedBytes);
      this.dispatch();
    };
  }

  dispatch() {
    while (!this.closed && this.active < this.concurrency && this.queue.length > 0) {
      const nextIndex = this.queue.findIndex((candidate) => this.activeExpandedBytes + candidate.reservedBytes <= this.maximumConcurrentExpandedBytes);
      if (nextIndex < 0) return;
      const [entry] = this.queue.splice(nextIndex, 1);
      entry.signal?.removeEventListener("abort", entry.onAbort);
      if (entry.signal?.aborted) {
        this.metrics.cancelled += 1;
        this.recordRejection("UPLOAD_CANCELLED");
        entry.reject(abortedUploadError(entry.signal.reason));
        continue;
      }
      this.active += 1;
      this.activeExpandedBytes += entry.reservedBytes;
      this.metrics.maxActiveExpandedBytes = Math.max(this.metrics.maxActiveExpandedBytes, this.activeExpandedBytes);
      this.metrics.accepted += 1;
      entry.resolve(this.releaseFactory(entry.reservedBytes));
    }
  }

  async inspect(rawInput, descriptor, externalSignal = null) {
    const startedAt = performance.now();
    let raw = Buffer.isBuffer(rawInput) ? rawInput : Buffer.from(rawInput ?? []);
    let decompressionMs = 0;
    try {
      if (externalSignal?.aborted) throw abortedUploadError(externalSignal.reason);
      if (descriptor.encoding === "gzip") {
        const decompressionStartedAt = performance.now();
        try {
          raw = await gunzip(raw, { maxOutputLength: descriptor.expandedLimit });
        } catch (cause) {
          const tooLarge = cause && typeof cause === "object" && "code" in cause && cause.code === "ERR_BUFFER_TOO_LARGE";
          const error = uploadError(
            tooLarge ? "解压后的请求内容超过允许上限" : "请求压缩内容无效",
            tooLarge ? 413 : 400,
            tooLarge ? "REQUEST_EXPANDED_BODY_TOO_LARGE" : "REQUEST_ENCODING_INVALID",
          );
          if (tooLarge) {
            error.originalBytes = descriptor.declaredOriginalBytes;
            error.compressedBytes = raw.byteLength;
            error.expandedBytes = Number.isSafeInteger(descriptor.declaredOriginalBytes)
              ? descriptor.declaredOriginalBytes
              : descriptor.expandedLimit + 1;
            error.expandedBytesAtLeast = !Number.isSafeInteger(descriptor.declaredOriginalBytes);
            error.expandedLimitBytes = descriptor.expandedLimit;
            error.payloadLimitBytes = descriptor.payloadLimit;
            error.overBytes = Math.max(1, error.expandedBytes - descriptor.expandedLimit);
          }
          throw error;
        }
        decompressionMs = Math.max(0, performance.now() - decompressionStartedAt);
      }
      if (externalSignal?.aborted) throw abortedUploadError(externalSignal.reason);
      if (raw.byteLength > descriptor.expandedLimit) {
        const error = uploadError("解压后的请求内容超过允许上限", 413, "REQUEST_EXPANDED_BODY_TOO_LARGE");
        error.originalBytes = descriptor.declaredOriginalBytes ?? raw.byteLength;
        error.compressedBytes = descriptor.encoding === "gzip" ? null : raw.byteLength;
        error.expandedBytes = raw.byteLength;
        error.expandedLimitBytes = descriptor.expandedLimit;
        error.payloadLimitBytes = descriptor.payloadLimit;
        throw error;
      }
      this.metrics.maxExpandedBytes = Math.max(this.metrics.maxExpandedBytes, raw.byteLength);
      const useWorker = raw.byteLength >= this.workerThresholdBytes;
      const inspectionStartedAt = performance.now();
      let result;
      if (useWorker) {
        this.metrics.workerRuns += 1;
        result = decodeReturnedPayload(await runInspectionWorker(raw, descriptor, externalSignal));
      } else {
        this.metrics.inlineRuns += 1;
        result = this.inspectInline(raw, descriptor);
      }
      const inspectionMs = Math.max(0, performance.now() - inspectionStartedAt);
      this.metrics.completed += 1;
      this.metrics.lastTotalMs = Math.max(0, performance.now() - startedAt);
      this.metrics.lastDecompressionMs = decompressionMs;
      this.metrics.lastInspectionMs = inspectionMs;
      this.metrics.maxWorkerHeapBytes = Math.max(this.metrics.maxWorkerHeapBytes, Number(result.workerHeapBytes) || 0);
      return { ...result, workerHeapBytes: undefined, timings: { totalMs: this.metrics.lastTotalMs, decompressionMs, inspectionMs, worker: useWorker } };
    } catch (error) {
      if (error?.code === "UPLOAD_CANCELLED" || error?.code === "SERVER_SHUTTING_DOWN") this.metrics.cancelled += 1;
      else this.metrics.failed += 1;
      this.recordRejection(error?.code);
      throw error;
    } finally {
      raw = Buffer.alloc(0);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const reason = uploadError("服务正在安全关闭，请稍后重试", 503, "SERVER_SHUTTING_DOWN", 1);
    for (const entry of this.queue.splice(0)) {
      entry.signal?.removeEventListener("abort", entry.onAbort);
      this.recordRejection("SERVER_SHUTTING_DOWN");
      entry.reject(reason);
    }
    for (const controller of this.activeControllers) controller.abort(reason);
  }
}
