const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const MAX_NATIVE_OFFLINE_EXPORT_BYTES = 256 * 1024 * 1024;
const NATIVE_OFFLINE_EXPORT_CHUNK_BYTES = 1024 * 1024;
const NATIVE_OFFLINE_EXPORT_ACK_TIMEOUT_MS = 30_000;

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    actual.every((key) => typeof key === "string" && keys.includes(key));
}

function validLogicalId(value, maximumLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    /^[A-Za-z0-9_.:-]+$/.test(value);
}

function normalizeNativeOfflineStartupIntent(value) {
  const keys = [
    "sessionId", "expectedGeneration", "expectedRootHash", "expectedRevision",
    "expectedRegistryFingerprint", "expectedCanonicalSha256", "expectedDomainSha256", "strategy",
  ];
  if (!exactKeys(value, keys) || !validLogicalId(value.sessionId, 128) ||
      !Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 1 ||
      typeof value.expectedRootHash !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRootHash) ||
      !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
      !validLogicalId(value.expectedRegistryFingerprint, 256) ||
      typeof value.expectedCanonicalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedCanonicalSha256) ||
      typeof value.expectedDomainSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedDomainSha256) ||
      value.strategy !== "macro-v1") {
    throw new TypeError("native offline startup intent is invalid");
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function createNativeOfflineExportId() {
  return `offlinecandidate${randomUUID().replaceAll("-", "")}`;
}

function waitForPortMessage(port, accept, timeoutMs = NATIVE_OFFLINE_EXPORT_ACK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      port.off("message", onMessage);
      port.off("close", onClose);
    };
    const onMessage = (event) => {
      if (!accept(event?.data)) return;
      cleanup();
      resolve(event.data);
    };
    const onClose = () => {
      cleanup();
      reject(Object.assign(new Error("native offline startup transfer port closed"), {
        code: "NATIVE_OFFLINE_STARTUP_TRANSFER_CLOSED",
      }));
    };
    port.on("message", onMessage);
    port.on("close", onClose);
    timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error("native offline startup transfer acknowledgement timed out"), {
        code: "NATIVE_OFFLINE_STARTUP_TRANSFER_TIMEOUT",
      }));
    }, timeoutMs);
  });
}

async function streamNativeOfflineStartupCandidate({
  registry,
  ownerId,
  request,
  observedNowMs,
  nativeRootPath,
  port,
  normalizeResult,
  fileSystem = fs,
  createExportId = createNativeOfflineExportId,
}) {
  const intent = normalizeNativeOfflineStartupIntent(request);
  if (!registry || typeof registry.prepareOfflineSettlementExport !== "function" ||
      !Number.isSafeInteger(observedNowMs) || observedNowMs < 0 ||
      typeof nativeRootPath !== "string" || !path.isAbsolute(nativeRootPath) ||
      !port || typeof port.postMessage !== "function" || typeof port.on !== "function" ||
      typeof normalizeResult !== "function") {
    throw new TypeError("native offline startup transfer dependencies are invalid");
  }
  const exportId = createExportId();
  if (!validLogicalId(exportId, 128) || exportId.includes(":") || exportId.includes(".")) {
    throw new TypeError("native offline startup export identity is invalid");
  }
  let exportPath = null;
  let exportHandle = null;
  try {
    port.start?.();
    const result = normalizeResult(await registry.prepareOfflineSettlementExport(
      ownerId,
      intent,
      observedNowMs,
      exportId,
    ));
    if (!result.prepared) {
      port.postMessage({ start: result, payloadByteLength: 0 });
      port.postMessage({ end: true, totalBytes: 0, envelopeSha256: null });
      await waitForPortMessage(port, (message) =>
        exactKeys(message, ["completeAck"]) && message.completeAck === null);
      return result;
    }
    // The export identity is main-generated, so this is the only candidate
    // path this transaction may ever clean up, including malformed Host ACKs.
    exportPath = path.join(nativeRootPath, "exports", `${exportId}.json`);
    const proof = result.export?.result;
    if (result.export?.exportId !== exportId || !proof ||
        !Number.isSafeInteger(proof.byteLength) || proof.byteLength < 1 ||
        proof.byteLength > MAX_NATIVE_OFFLINE_EXPORT_BYTES ||
        typeof proof.envelopeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(proof.envelopeSha256)) {
      throw new Error("native offline startup export proof is invalid");
    }
    exportHandle = await fileSystem.promises.open(exportPath, "r");
    const [stat, pathStat] = await Promise.all([
      exportHandle.stat(),
      fileSystem.promises.lstat(exportPath),
    ]);
    if (!stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() ||
        stat.size !== proof.byteLength || pathStat.size !== proof.byteLength) {
      throw new Error("native offline startup export file identity is invalid");
    }
    port.postMessage({ start: result, payloadByteLength: proof.byteLength });
    const digest = createHash("sha256");
    let offset = 0;
    const stream = fileSystem.createReadStream(exportPath, {
      fd: exportHandle.fd,
      autoClose: false,
      highWaterMark: NATIVE_OFFLINE_EXPORT_CHUNK_BYTES,
    });
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      offset += chunk.byteLength;
      if (offset > proof.byteLength) throw new Error("native offline startup export exceeded its proof");
      digest.update(chunk);
      port.postMessage({
        chunk: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        offset,
      });
      await waitForPortMessage(port, (message) =>
        exactKeys(message, ["ack"]) && message.ack === offset);
    }
    const envelopeSha256 = digest.digest("hex");
    if (offset !== proof.byteLength || envelopeSha256 !== proof.envelopeSha256) {
      throw new Error("native offline startup export stream verification failed");
    }
    port.postMessage({ end: true, totalBytes: offset, envelopeSha256 });
    await waitForPortMessage(port, (message) =>
      exactKeys(message, ["completeAck"]) && message.completeAck === envelopeSha256);
    return result;
  } finally {
    if (exportHandle) await exportHandle.close().catch(() => undefined);
    if (exportPath) await fileSystem.promises.rm(exportPath, { force: true }).catch(() => undefined);
  }
}

module.exports = {
  MAX_NATIVE_OFFLINE_EXPORT_BYTES,
  NATIVE_OFFLINE_EXPORT_ACK_TIMEOUT_MS,
  NATIVE_OFFLINE_EXPORT_CHUNK_BYTES,
  createNativeOfflineExportId,
  normalizeNativeOfflineStartupIntent,
  streamNativeOfflineStartupCandidate,
};
