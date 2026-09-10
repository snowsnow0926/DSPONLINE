"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { NativeHostClient } = require("./native-host.cjs");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");
const {
  createNativeOfflineExportId,
  streamNativeOfflineCandidateResult,
} = require("./native-offline-startup-transfer.cjs");

const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_CHUNK_BYTES = 1024 * 1024;
const SOURCE_IDLE_TIMEOUT_MS = 30_000;
const SOURCE_CAPABILITY = "native-core-offline-runtime-source-export-v1";
const SOURCE_START_KEYS = ["registryFingerprint", "catalog", "sourceSavedAtMs"];
const SOURCE_REQUEST_KEYS = ["registryFingerprint", "catalog", "sourceSavedAtMs",
  "expectedCanonicalSha256", "expectedDomainSha256", "strategy"];

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function normalizeNativeOfflineSourceIntent(value, sourceOnly = false) {
  if (!exactKeys(value, sourceOnly ? SOURCE_START_KEYS : SOURCE_REQUEST_KEYS) ||
      typeof value.registryFingerprint !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.registryFingerprint) ||
      !Number.isSafeInteger(value.sourceSavedAtMs) || value.sourceSavedAtMs < 0) {
    throw new TypeError("native offline runtime source intent is invalid");
  }
  if (!sourceOnly && (typeof value.expectedCanonicalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedCanonicalSha256) ||
      typeof value.expectedDomainSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedDomainSha256) ||
      value.strategy !== "macro-v1")) throw new TypeError("native offline runtime source proof is invalid");
  const catalog = value.catalog;
  if (!catalog || typeof catalog !== "object" || catalog.protocolVersion !== 1 ||
      catalog.registryFingerprint !== value.registryFingerprint ||
      ![catalog.items, catalog.buildings, catalog.recipes, catalog.belts].every(Array.isArray)) {
    throw new TypeError("native offline runtime source catalog is invalid");
  }
  const entries = catalog.items.length + catalog.buildings.length + catalog.recipes.length + catalog.belts.length;
  if (entries < 1 || entries > 65_536) throw new RangeError("native offline runtime source catalog is too large");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 8 * 1024 * 1024 - 16_384) {
    throw new RangeError("native offline runtime source intent exceeds the IPC limit");
  }
  return Object.freeze(JSON.parse(encoded));
}

function cancelledError() {
  return Object.assign(new Error("native offline runtime source cancelled"), { name: "AbortError", code: "ABORTED" });
}

function checkCancellation(signal) {
  if (signal.aborted) throw cancelledError();
}

/** Observe actual process termination before its private directory can be removed. */
async function closeTemporaryHost(client, cancelled) {
  const child = client?.child;
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!cancelled && (child.exitCode !== 0 || child.signalCode !== null)) {
      throw new Error("temporary offline host did not close normally");
    }
    return;
  }
  let timer;
  const closed = new Promise((resolve, reject) => {
    child.once("close", (code, signal) => {
      if (cancelled || (code === 0 && signal === null)) resolve();
      else reject(new Error("temporary offline host did not close normally"));
    });
    timer = setTimeout(() => {
      child.kill();
      reject(new Error("temporary offline host close timed out"));
    }, 5_000);
  });
  try {
    if (cancelled) child.kill();
    await Promise.all([closed, cancelled ? Promise.resolve() : client.request({ operation: "shutdown" }, 5_000)]);
  } finally { clearTimeout(timer); }
}

/** One private calculation process: cancellation cannot stop the gameplay Host. */
class NativeOfflineRuntimeSourceBroker {
  constructor({ binaryPath, temporaryParent, createClient = (options) => new NativeHostClient(options),
    idleTimeoutMs = SOURCE_IDLE_TIMEOUT_MS }) {
    if (!path.isAbsolute(binaryPath) || !path.isAbsolute(temporaryParent)) {
      throw new TypeError("native offline runtime source broker paths must be absolute");
    }
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > SOURCE_IDLE_TIMEOUT_MS) {
      throw new TypeError("native offline source idle timeout is invalid");
    }
    this.binaryPath = binaryPath;
    this.temporaryParent = path.resolve(temporaryParent);
    this.createClient = createClient;
    this.idleTimeoutMs = idleTimeoutMs;
    this.active = null;
  }

  run({ ownerId, request, observedNowMs, port }) {
    // Main samples time when this header arrives, before renderer proof/encoding.
    const intent = normalizeNativeOfflineSourceIntent(request, true);
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 ||
        !Number.isSafeInteger(observedNowMs) || observedNowMs < intent.sourceSavedAtMs ||
        !port || typeof port.on !== "function" || typeof port.postMessage !== "function") {
      throw new TypeError("native offline runtime source transaction is invalid");
    }
    if (this.active) throw new Error("native offline runtime source transaction is busy");
    const entry = { ownerId, controller: new AbortController(), promise: null };
    this.active = entry;
    entry.promise = this.perform({ intent, observedNowMs, port, signal: entry.controller.signal,
      cancel: () => entry.controller.abort() }).finally(() => {
      if (this.active === entry) this.active = null;
    });
    return entry.promise;
  }

  cancelOwner(ownerId) {
    if (this.active?.ownerId === ownerId) this.active.controller.abort();
  }

  async close() {
    const entry = this.active;
    if (!entry) return;
    entry.controller.abort();
    await entry.promise.catch(() => undefined);
  }

  async perform({ intent, observedNowMs, port, signal, cancel }) {
    let root = null;
    let sourceHandle = null;
    let client = null;
    let waiter = null;
    let uploadPhase = true;
    let completed = false;
    let failure = null;
    const abort = () => {
      failure ??= cancelledError();
      waiter?.reject(failure);
      waiter = null;
      client?.child?.kill();
    };
    const onClose = () => { if (!completed) cancel(); };
    const onMessage = (event) => {
      const message = event?.data;
      if (exactKeys(message, ["cancel"]) && message.cancel === true) { cancel(); return; }
      if (!uploadPhase) return; // Candidate response ACKs belong to the shared export reader.
      if (!waiter) {
        failure = new Error("native offline source sender ignored backpressure");
        cancel();
        return;
      }
      const pending = waiter;
      waiter = null;
      pending.resolve(message);
    };
    const nextMessage = () => new Promise((resolve, reject) => {
      if (failure || signal.aborted) { reject(failure || cancelledError()); return; }
      const timer = setTimeout(() => {
        failure = new Error("native offline source upload timed out");
        cancel();
      }, this.idleTimeoutMs);
      waiter = { resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); } };
    });
    signal.addEventListener("abort", abort);
    port.on("close", onClose);
    port.on("message", onMessage);
    port.start?.();
    try {
      checkCancellation(signal);
      const parent = await fs.promises.lstat(this.temporaryParent);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("offline temporary parent is not a direct directory");
      root = await fs.promises.mkdtemp(path.join(this.temporaryParent, "dsp-offline-source-"));
      checkCancellation(signal);
      const sourcePath = path.join(root, "runtime.json");
      sourceHandle = await fs.promises.open(sourcePath, "wx");
      checkCancellation(signal);
      const digest = createHash("sha256");
      let bytes = 0;
      let finalIntent = null;
      let pending = nextMessage();
      pending.catch(() => undefined); // A port write may throw before the following await.
      port.postMessage({ sourceReady: true });
      while (true) {
        const message = await pending;
        checkCancellation(signal);
        if (exactKeys(message, ["sourceEnd", "totalBytes", "expectedCanonicalSha256", "expectedDomainSha256"]) && message.sourceEnd === true) {
          if (message.totalBytes !== bytes || bytes === 0) throw new Error("native offline source final length changed");
          finalIntent = normalizeNativeOfflineSourceIntent({ ...intent,
            expectedCanonicalSha256: message.expectedCanonicalSha256,
            expectedDomainSha256: message.expectedDomainSha256, strategy: "macro-v1" });
          break;
        }
        const chunk = message?.sourceChunk;
        if (!exactKeys(message, ["sourceChunk", "offset"]) || !(chunk instanceof Uint8Array) ||
            chunk.byteLength < 1 || chunk.byteLength > MAX_SOURCE_CHUNK_BYTES ||
            !Number.isSafeInteger(message.offset) || message.offset !== bytes + chunk.byteLength ||
            message.offset > MAX_SOURCE_BYTES) throw new Error("native offline source chunk is invalid");
        // Preserve the same 64 MiB headroom used by ordinary native saves.
        // The size is measured from the received chunk, never a renderer claim.
        if (typeof fs.promises.statfs === "function") {
          let capacity;
          try { capacity = await fs.promises.statfs(root, { bigint: true }); }
          catch (error) {
            if (!["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "ERR_METHOD_NOT_IMPLEMENTED", "ERR_NOT_IMPLEMENTED"].includes(error?.code)) throw error;
          }
          if (capacity && (capacity.bsize <= 0n || capacity.bavail < 0n ||
              capacity.bsize * capacity.bavail < BigInt(chunk.byteLength) + 64n * 1024n * 1024n)) {
            throw new Error("native offline source disk headroom is insufficient");
          }
        }
        checkCancellation(signal);
        await sourceHandle.writeFile(chunk);
        digest.update(chunk);
        bytes = message.offset;
        checkCancellation(signal);
        pending = nextMessage();
        pending.catch(() => undefined);
        port.postMessage({ sourceAck: bytes });
      }
      uploadPhase = false;
      await sourceHandle.sync();
      await sourceHandle.close();
      sourceHandle = null;
      checkCancellation(signal);
      const nativeRootPath = path.join(root, "native-store");
      client = this.createClient({ binaryPath: this.binaryPath, rootPath: nativeRootPath, requestTimeoutMs: 300_000 });
      const hello = await client.start("offline-runtime-source-v1");
      checkCancellation(signal);
      if (!hello.capabilities?.includes(SOURCE_CAPABILITY)) throw new Error("temporary offline Host capability is missing");
      const exportId = createNativeOfflineExportId();
      const result = normalizeRendererNativeResult("coreOfflineCandidateExport", await client.request({
        operation: "corePrepareOfflineSourceExport", sourcePath,
        request: { ...finalIntent, sourceByteLength: bytes, sourceSha256: digest.digest("hex"), observedNowMs, exportId },
      }, 300_000));
      checkCancellation(signal);
      await closeTemporaryHost(client, false);
      checkCancellation(signal);
      await streamNativeOfflineCandidateResult({ result, exportId, nativeRootPath, port, signal });
      checkCancellation(signal);
      // Resolve the renderer only after the source, export and private store are gone.
      await this.removeOwnedRoot(root);
      root = null;
      completed = true;
      port.postMessage({ sourceClosed: true });
      return result;
    } finally {
      waiter?.reject(cancelledError());
      waiter = null;
      signal.removeEventListener("abort", abort);
      port.off("close", onClose);
      port.off("message", onMessage);
      if (sourceHandle) await sourceHandle.close();
      await closeTemporaryHost(client, true);
      if (root) await this.removeOwnedRoot(root);
    }
  }

  async removeOwnedRoot(root) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== this.temporaryParent || !path.basename(resolved).startsWith("dsp-offline-source-")) {
      throw new Error("native offline source cleanup escaped its temporary parent");
    }
    const stat = await fs.promises.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("native offline source cleanup root changed");
    await fs.promises.rm(resolved, { recursive: true });
  }
}

module.exports = { MAX_SOURCE_BYTES, MAX_SOURCE_CHUNK_BYTES, SOURCE_IDLE_TIMEOUT_MS,
  SOURCE_CAPABILITY, normalizeNativeOfflineSourceIntent, NativeOfflineRuntimeSourceBroker };
