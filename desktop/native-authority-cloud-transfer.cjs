"use strict";

const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { contract } = require("./cloud-transport.cjs");

const TOKEN_PATTERN = /^native-cloud-[a-f0-9-]{36}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;

class NativeAuthorityCloudTransferError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "NativeAuthorityCloudTransferError";
    this.code = code;
  }
}

function transferError(message, code = "NATIVE_AUTHORITY_CLOUD_INVALID") {
  return new NativeAuthorityCloudTransferError(message, code);
}

function exactObject(value, keys, label) {
  const allowed = keys.map((key) => key.endsWith("?") ? key.slice(0, -1) : key);
  const required = keys.filter((key) => !key.endsWith("?"));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) {
    throw transferError(`${label} is invalid`);
  }
  return value;
}

function normalizeAuthorization(value) {
  if (typeof value !== "string" || value.length > 512) {
    throw transferError("native authority cloud authorization is invalid");
  }
  const normalized = value.trim();
  if (!/^Bearer [^\s\u0000-\u001f\u007f]{8,480}$/i.test(normalized)) {
    throw transferError("native authority cloud authorization is invalid");
  }
  return normalized;
}

function sha256File(filePath, fileSystem = fs) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fileSystem.createReadStream(filePath, { highWaterMark: contract.ipcChunkBytes });
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function readBoundedResponse(response) {
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (declared > MAXIMUM_RESPONSE_BYTES) throw transferError("native cloud response is too large");
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAXIMUM_RESPONSE_BYTES) {
      throw transferError("native cloud response is too large");
    }
    return text;
  }
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      bytes += chunk.length;
      if (bytes > MAXIMUM_RESPONSE_BYTES) throw transferError("native cloud response is too large");
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

class NativeAuthorityCloudTransfer {
  constructor(options) {
    exactObject(options, ["rootPath", "resolveRequestUrl", "exportArtifact", "fetchImpl?", "fileSystem?", "now?", "createToken?"], "native authority cloud transfer options");
    if (typeof options.rootPath !== "string" || !path.isAbsolute(options.rootPath) ||
        typeof options.resolveRequestUrl !== "function" || typeof options.exportArtifact !== "function") {
      throw new TypeError("native authority cloud transfer options are invalid");
    }
    this.rootPath = path.resolve(options.rootPath);
    this.resolveRequestUrl = options.resolveRequestUrl;
    this.exportArtifact = options.exportArtifact;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fileSystem = options.fileSystem ?? fs;
    this.now = options.now ?? Date.now;
    this.createToken = options.createToken ?? (() => `native-cloud-${randomUUID()}`);
    this.pendingRoot = path.join(this.rootPath, "cloud-pending");
    this.exportRoot = path.join(this.rootPath, "exports");
  }

  candidatePath(token) {
    if (!TOKEN_PATTERN.test(token)) throw transferError("native authority cloud retry token is invalid");
    return path.join(this.pendingRoot, `${token}.json`);
  }

  async writeCandidate(candidate) {
    await this.fileSystem.promises.mkdir(this.pendingRoot, { recursive: true });
    const target = this.candidatePath(candidate.token);
    const temporary = `${target}.${process.pid}.part`;
    await this.fileSystem.promises.writeFile(temporary, JSON.stringify(candidate), { flag: "wx", mode: 0o600 });
    await this.fileSystem.promises.rename(temporary, target);
  }

  async readCandidate(token) {
    const target = this.candidatePath(token);
    const stat = await this.fileSystem.promises.lstat(target);
    if (!stat.isFile() || stat.size < 2 || stat.size > 16 * 1024) {
      throw transferError("native authority cloud candidate is invalid");
    }
    const candidate = JSON.parse(await this.fileSystem.promises.readFile(target, "utf8"));
    exactObject(candidate, ["formatVersion", "token", "exportId", "expectedRevision", "savedAtMs", "byteLength", "envelopeSha256", "stateChecksum", "revision"], "native authority cloud candidate");
    if (candidate.formatVersion !== 1 || candidate.token !== token ||
        typeof candidate.exportId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(candidate.exportId) ||
        !Number.isSafeInteger(candidate.expectedRevision) || candidate.expectedRevision < 0 ||
        !Number.isSafeInteger(candidate.savedAtMs) || candidate.savedAtMs < 0 ||
        !Number.isSafeInteger(candidate.byteLength) || candidate.byteLength < 1 ||
        candidate.byteLength > contract.savePayloadLimitBytes ||
        !SHA256_PATTERN.test(candidate.envelopeSha256) ||
        typeof candidate.stateChecksum !== "string" || !/^[a-f0-9]{8}$/.test(candidate.stateChecksum) ||
        !Number.isSafeInteger(candidate.revision) || candidate.revision < 0) {
      throw transferError("native authority cloud candidate is invalid");
    }
    return candidate;
  }

  async prepare(expectedRevision) {
    const token = this.createToken();
    if (!TOKEN_PATTERN.test(token)) throw transferError("native authority cloud token generator is invalid");
    const exportId = `cloud-${token.slice("native-cloud-".length)}`;
    const savedAtMs = Math.max(0, Math.floor(this.now()));
    const prepared = await this.exportArtifact({ exportId, savedAtMs });
    if (!prepared || prepared.exportId !== exportId || prepared.mode !== "normal" ||
        prepared.result?.savedAtMs !== savedAtMs || !Number.isSafeInteger(prepared.result?.revision) ||
        !Number.isSafeInteger(prepared.result?.byteLength) || prepared.result.byteLength < 1 ||
        prepared.result.byteLength > contract.savePayloadLimitBytes ||
        !SHA256_PATTERN.test(prepared.result?.envelopeSha256 ?? "") ||
        !/^[a-f0-9]{8}$/.test(prepared.result?.stateChecksum ?? "")) {
      throw transferError("native authority cloud export proof is invalid");
    }
    const candidate = {
      formatVersion: 1,
      token,
      exportId,
      expectedRevision,
      savedAtMs,
      byteLength: prepared.result.byteLength,
      envelopeSha256: prepared.result.envelopeSha256,
      stateChecksum: prepared.result.stateChecksum,
      revision: prepared.result.revision,
    };
    await this.verifyArtifact(candidate);
    await this.writeCandidate(candidate);
    return candidate;
  }

  async verifyArtifact(candidate) {
    const sourcePath = path.join(this.exportRoot, `${candidate.exportId}.json`);
    if (path.dirname(sourcePath) !== this.exportRoot) throw transferError("native cloud export escaped its root");
    const stat = await this.fileSystem.promises.lstat(sourcePath);
    if (!stat.isFile() || stat.size !== candidate.byteLength ||
        await sha256File(sourcePath, this.fileSystem) !== candidate.envelopeSha256) {
      throw transferError("native authority cloud export identity mismatch", "NATIVE_AUTHORITY_CLOUD_EXPORT_IDENTITY_INVALID");
    }
    return sourcePath;
  }

  async upload(request, onProgress = () => undefined) {
    exactObject(request, ["authorization", "expectedRevision", "retryToken?"], "native authority cloud upload request");
    const authorization = normalizeAuthorization(request.authorization);
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
      throw transferError("native authority cloud expected revision is invalid");
    }
    if (request.retryToken !== undefined && !TOKEN_PATTERN.test(request.retryToken)) {
      throw transferError("native authority cloud retry token is invalid");
    }
    let candidate = request.retryToken
      ? await this.readCandidate(request.retryToken)
      : await this.prepare(request.expectedRevision);
    if (candidate.expectedRevision !== request.expectedRevision) {
      throw transferError("native authority cloud retry revision changed");
    }
    const sourcePath = await this.verifyArtifact(candidate);
    onProgress(Object.freeze({ stage: "uploading", token: candidate.token, sentBytes: 0, totalBytes: candidate.byteLength }));
    const source = this.fileSystem.createReadStream(sourcePath, { highWaterMark: contract.ipcChunkBytes });
    let sentBytes = 0;
    source.on("data", (chunk) => {
      sentBytes += chunk.length;
      onProgress(Object.freeze({ stage: "uploading", token: candidate.token, sentBytes, totalBytes: candidate.byteLength }));
    });
    let response;
    try {
      response = await this.fetchImpl(this.resolveRequestUrl("/cloud-save"), {
        method: "PUT",
        headers: {
          authorization,
          "content-type": contract.directPayloadContentType,
          [contract.expectedRevisionHeader]: String(candidate.expectedRevision),
          [contract.requestIdHeader]: candidate.token,
          [contract.originalBytesHeader]: String(candidate.byteLength),
        },
        body: source,
        duplex: "half",
        redirect: "error",
      });
    } catch (error) {
      source.destroy();
      onProgress(Object.freeze({ stage: "unknown", token: candidate.token, sentBytes, totalBytes: candidate.byteLength }));
      return Object.freeze({ status: "unknown", token: candidate.token, revision: candidate.revision, errorCode: error?.name === "AbortError" ? "ABORTED" : "NETWORK_STATUS_UNKNOWN" });
    }
    let body;
    try {
      body = await readBoundedResponse(response);
    } catch {
      onProgress(Object.freeze({ stage: "unknown", token: candidate.token, sentBytes, totalBytes: candidate.byteLength }));
      return Object.freeze({ status: "unknown", token: candidate.token, revision: candidate.revision, errorCode: "RESPONSE_STATUS_UNKNOWN" });
    }
    if (!response.ok) {
      const status = response.status >= 500 ? "unknown" : "rejected";
      onProgress(Object.freeze({ stage: status, token: candidate.token, sentBytes, totalBytes: candidate.byteLength }));
      return Object.freeze({ status, token: candidate.token, revision: candidate.revision, httpStatus: response.status, body });
    }
    let value;
    try { value = JSON.parse(body); } catch {
      return Object.freeze({ status: "unknown", token: candidate.token, revision: candidate.revision, errorCode: "RESPONSE_STATUS_UNKNOWN" });
    }
    if (!value?.cloudSave || !Number.isSafeInteger(value.cloudSave.revision) ||
        value.cloudSave.revision !== candidate.expectedRevision + 1) {
      return Object.freeze({ status: "unknown", token: candidate.token, revision: candidate.revision, errorCode: "RESPONSE_STATUS_UNKNOWN" });
    }
    await this.fileSystem.promises.rm(this.candidatePath(candidate.token), { force: true });
    await this.fileSystem.promises.rm(sourcePath, { force: true });
    onProgress(Object.freeze({ stage: "confirmed", token: candidate.token, sentBytes: candidate.byteLength, totalBytes: candidate.byteLength }));
    return Object.freeze({ status: "confirmed", token: candidate.token, revision: candidate.revision, cloudSave: value.cloudSave });
  }
}

module.exports = {
  NativeAuthorityCloudTransfer,
  NativeAuthorityCloudTransferError,
  readBoundedResponse,
  sha256File,
};
