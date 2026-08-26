const { spawn } = require("node:child_process");
const path = require("node:path");

const FRAME_MAGIC = Buffer.from("DSPNATV1", "ascii");
const FRAME_HEADER_BYTES = 36;
const FRAME_PROTOCOL_VERSION = 1;
const CONTROL_REQUEST_KIND = 1;
const CONTROL_RESPONSE_KIND = 2;
const MAX_FRAME_PAYLOAD_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function encodeFrame({ requestId, kind = CONTROL_REQUEST_KIND, sequence = 0, flags = 0, payload }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.byteLength > MAX_FRAME_PAYLOAD_BYTES) throw new RangeError("native frame payload exceeds the bounded IPC limit");
  if (!Number.isSafeInteger(requestId) || requestId < 1) throw new TypeError("native request ID is invalid");
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.byteLength);
  FRAME_MAGIC.copy(frame, 0);
  frame.writeUInt16LE(FRAME_PROTOCOL_VERSION, 8);
  frame.writeUInt16LE(kind, 10);
  frame.writeUInt32LE(flags >>> 0, 12);
  frame.writeBigUInt64LE(BigInt(requestId), 16);
  frame.writeUInt32LE(sequence >>> 0, 24);
  frame.writeUInt32LE(body.byteLength, 28);
  frame.writeUInt32LE(crc32(body), 32);
  body.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.byteLength - offset >= FRAME_HEADER_BYTES) {
    if (!buffer.subarray(offset, offset + 8).equals(FRAME_MAGIC)) throw new Error("native frame magic is invalid");
    const protocolVersion = buffer.readUInt16LE(offset + 8);
    if (protocolVersion !== FRAME_PROTOCOL_VERSION) throw new Error(`native protocol version ${protocolVersion} is unsupported`);
    const payloadLength = buffer.readUInt32LE(offset + 28);
    if (payloadLength > MAX_FRAME_PAYLOAD_BYTES) throw new Error("native response frame is too large");
    const end = offset + FRAME_HEADER_BYTES + payloadLength;
    if (end > buffer.byteLength) break;
    const payload = buffer.subarray(offset + FRAME_HEADER_BYTES, end);
    if (buffer.readUInt32LE(offset + 32) !== crc32(payload)) throw new Error("native response checksum is invalid");
    const requestId = Number(buffer.readBigUInt64LE(offset + 16));
    if (!Number.isSafeInteger(requestId)) throw new Error("native response request ID is invalid");
    frames.push({
      protocolVersion,
      kind: buffer.readUInt16LE(offset + 10),
      flags: buffer.readUInt32LE(offset + 12),
      requestId,
      sequence: buffer.readUInt32LE(offset + 24),
      payload: Buffer.from(payload),
    });
    offset = end;
  }
  return { frames, remaining: Buffer.from(buffer.subarray(offset)) };
}

function nativeHostBinaryPath({ appPath, resourcesPath, isPackaged }) {
  return isPackaged
    ? path.join(resourcesPath, "native", "dsp-native-host.exe")
    : path.join(appPath, "native", "target", "release", "dsp-native-host.exe");
}

class NativeHostError extends Error {
  constructor(message, code = "NATIVE_HOST_ERROR") {
    super(message);
    this.name = "NativeHostError";
    this.code = code;
  }
}

class NativeHostClient {
  constructor({ binaryPath, rootPath, spawnProcess = spawn, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    if (!path.isAbsolute(binaryPath) || !path.isAbsolute(rootPath)) throw new TypeError("native host paths must be absolute");
    this.binaryPath = binaryPath;
    this.rootPath = rootPath;
    this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = Math.max(5_000, Math.min(300_000, requestTimeoutMs));
    this.child = null;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrTail = "";
    this.exited = false;
  }

  async start(clientVersion = "1.2.0") {
    if (this.child && !this.exited) return this.hello;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const child = this.spawnProcess(this.binaryPath, ["serve", "--root", this.rootPath], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
      this.child = child;
      this.exited = false;
      child.stdout.on("data", (chunk) => this.onStdout(chunk));
      child.stderr.on("data", (chunk) => {
        this.stderrTail = `${this.stderrTail}${Buffer.from(chunk).toString("utf8")}`.slice(-8_192);
      });
      child.once("error", (error) => this.failAll(new NativeHostError(`native host failed to start: ${error.message}`, "NATIVE_HOST_START_FAILED")));
      child.once("exit", (code, signal) => {
        this.exited = true;
        const detail = this.stderrTail.trim();
        this.failAll(new NativeHostError(
          `native host exited (${signal || (code ?? "unknown")})${detail ? `: ${detail}` : ""}`,
          "NATIVE_HOST_EXITED",
        ));
      });
      this.hello = await this.request({ operation: "hello", clientVersion });
      return this.hello;
    })().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  request(request, timeoutMs = this.requestTimeoutMs) {
    if (!this.child || this.exited || !this.child.stdin.writable) {
      return Promise.reject(new NativeHostError("native host is not running", "NATIVE_HOST_UNAVAILABLE"));
    }
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    if (!Number.isSafeInteger(this.nextRequestId)) this.nextRequestId = 1;
    const payload = Buffer.from(JSON.stringify(request), "utf8");
    const frame = encodeFrame({ requestId, payload });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new NativeHostError("native host request timed out", "NATIVE_HOST_TIMEOUT"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.stdin.write(frame, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(new NativeHostError(`native host write failed: ${error.message}`, "NATIVE_HOST_WRITE_FAILED"));
      });
    });
  }

  async stop() {
    const child = this.child;
    if (!child || this.exited) return;
    try { await this.request({ operation: "shutdown" }, 5_000); } catch { /* process exit is handled below */ }
    if (!this.exited) child.kill();
  }

  onStdout(chunk) {
    try {
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, Buffer.from(chunk)]);
      const parsed = parseFrames(this.stdoutBuffer);
      this.stdoutBuffer = parsed.remaining;
      for (const frame of parsed.frames) this.onFrame(frame);
    } catch (error) {
      this.failAll(new NativeHostError(error instanceof Error ? error.message : "native response decode failed", "NATIVE_PROTOCOL_INVALID"));
      this.child?.kill();
    }
  }

  onFrame(frame) {
    if (frame.kind !== CONTROL_RESPONSE_KIND) throw new Error("native host returned an unexpected frame kind");
    const pending = this.pending.get(frame.requestId);
    if (!pending) return;
    this.pending.delete(frame.requestId);
    clearTimeout(pending.timer);
    let response;
    try { response = JSON.parse(frame.payload.toString("utf8")); } catch {
      pending.reject(new NativeHostError("native host returned invalid JSON", "NATIVE_PROTOCOL_INVALID"));
      return;
    }
    if (response?.ok === true) pending.resolve(response.value);
    else pending.reject(new NativeHostError(response?.error?.message || "native operation failed", response?.error?.code || "NATIVE_OPERATION_FAILED"));
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function validLogicalId(value, maximumLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function normalizeNativeSaveBegin(value) {
  if (!value || typeof value !== "object") throw new TypeError("native save request is invalid");
  if (!validLogicalId(value.slot, 64)) throw new TypeError("native save slot is invalid");
  if (!validLogicalId(value.registryFingerprint, 256)) throw new TypeError("native registry fingerprint is invalid");
  if (!/^[a-fA-F0-9]{8,128}$/.test(value.baseChecksum || "")) throw new TypeError("native base checksum is invalid");
  if (!["normal", "speedrun"].includes(value.mode)) throw new TypeError("native save mode is invalid");
  if (!Number.isSafeInteger(value.stateVersion) || value.stateVersion !== 47) throw new TypeError("native save state version is invalid");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new TypeError("native save revision is invalid");
  if (!Number.isSafeInteger(value.savedAtMs) || value.savedAtMs < 0) throw new TypeError("native save timestamp is invalid");
  return {
    operation: "saveBegin",
    slot: value.slot,
    mode: value.mode,
    stateVersion: value.stateVersion,
    baseChecksum: value.baseChecksum.toLowerCase(),
    registryFingerprint: value.registryFingerprint,
    revision: value.revision,
    savedAtMs: value.savedAtMs,
  };
}

function normalizeNativeSaveRecords(records) {
  if (!Array.isArray(records) || records.length < 1 || records.length > 8) throw new TypeError("native save batch size is invalid");
  let totalBytes = 0;
  return records.map((record) => {
    if (!record || typeof record !== "object" || typeof record.key !== "string" || record.key.length < 1 || record.key.length > 512 ||
      record.key.includes("..") || /[\\/\0]/.test(record.key)) throw new TypeError("native save record key is invalid");
    if (record.value !== null && typeof record.value !== "string") throw new TypeError("native save record value is invalid");
    totalBytes += Buffer.byteLength(record.key, "utf8") + (record.value === null ? 0 : Buffer.byteLength(record.value, "utf8"));
    if (totalBytes > MAX_FRAME_PAYLOAD_BYTES - 16_384) throw new RangeError("native save batch exceeds the bounded IPC limit");
    return { key: record.key, value: record.value };
  });
}

class NativeSaveSessionRegistry {
  constructor(client) {
    this.client = client;
    this.sessions = new Map();
  }

  async begin(ownerId, request) {
    const value = await this.client.request(normalizeNativeSaveBegin(request));
    if (!validLogicalId(value?.transactionId, 128) || this.sessions.has(value.transactionId)) {
      throw new NativeHostError("native host returned an invalid transaction", "NATIVE_PROTOCOL_INVALID");
    }
    this.sessions.set(value.transactionId, { ownerId, slot: request.slot, revision: request.revision });
    return value;
  }

  async write(ownerId, transactionId, records) {
    this.assertOwner(ownerId, transactionId);
    const normalized = normalizeNativeSaveRecords(records);
    for (const record of normalized) {
      await this.client.request({ operation: "savePut", transactionId, ...record });
    }
    return { acceptedRecords: normalized.length };
  }

  async commit(ownerId, transactionId) {
    this.assertOwner(ownerId, transactionId);
    try { return await this.client.request({ operation: "saveCommit", transactionId }); }
    finally { this.sessions.delete(transactionId); }
  }

  async abort(ownerId, transactionId) {
    this.assertOwner(ownerId, transactionId);
    this.sessions.delete(transactionId);
    return this.client.request({ operation: "saveAbort", transactionId });
  }

  async abortOwner(ownerId) {
    const owned = [...this.sessions.entries()].filter(([, session]) => session.ownerId === ownerId);
    await Promise.allSettled(owned.map(([transactionId]) => this.client.request({ operation: "saveAbort", transactionId })));
    for (const [transactionId] of owned) this.sessions.delete(transactionId);
  }

  assertOwner(ownerId, transactionId) {
    if (!validLogicalId(transactionId, 128) || this.sessions.get(transactionId)?.ownerId !== ownerId) {
      throw new NativeHostError("native save transaction is not owned by this renderer", "NATIVE_TRANSACTION_INVALID");
    }
  }
}

function normalizeNativeCoreOpen(value) {
  if (!value || typeof value !== "object") throw new TypeError("native core open request is invalid");
  if (!validLogicalId(value.slot, 64)) throw new TypeError("native core slot is invalid");
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw new TypeError("native core generation is invalid");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new TypeError("native core revision is invalid");
  if (typeof value.rootHash !== "string" || !/^[a-f0-9]{64}$/.test(value.rootHash)) throw new TypeError("native core root hash is invalid");
  if (!validLogicalId(value.registryFingerprint, 256)) throw new TypeError("native core registry fingerprint is invalid");
  const catalog = value.catalog;
  if (!catalog || typeof catalog !== "object" || catalog.protocolVersion !== 1 ||
    catalog.registryFingerprint !== value.registryFingerprint || !Array.isArray(catalog.items) ||
    !Array.isArray(catalog.buildings) || !Array.isArray(catalog.recipes) || !Array.isArray(catalog.belts)) {
    throw new TypeError("native core catalog is invalid");
  }
  const entryCount = catalog.items.length + catalog.buildings.length + catalog.recipes.length + catalog.belts.length;
  if (entryCount < 1 || entryCount > 65_536) throw new RangeError("native core catalog entry count is invalid");
  const encodedBytes = Buffer.byteLength(JSON.stringify(catalog), "utf8");
  if (encodedBytes > MAX_FRAME_PAYLOAD_BYTES - 16_384) throw new RangeError("native core catalog exceeds the bounded IPC limit");
  return {
    operation: "coreOpen",
    slot: value.slot,
    generation: value.generation,
    rootHash: value.rootHash,
    revision: value.revision,
    registryFingerprint: value.registryFingerprint,
    catalog,
  };
}

function normalizeNativeCoreCommand(value) {
  if (!value || typeof value !== "object" || value.protocolVersion !== 1 ||
    !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0) {
    throw new TypeError("native core command is invalid");
  }
  for (const key of ["topLevelChanges", "changedEntities", "addedEntities", "removedEntityIds", "changedBelts", "addedBelts", "removedBeltIds"]) {
    if (!Array.isArray(value[key])) throw new TypeError(`native core command ${key} is invalid`);
  }
  const encodedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (encodedBytes > MAX_FRAME_PAYLOAD_BYTES - 16_384) throw new RangeError("native core command exceeds the bounded IPC limit");
  return value;
}

function normalizeNativeCoreCommitOperation(value) {
  if (!value || typeof value !== "object" || !validLogicalId(value.commandId, 128) ||
    !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0 ||
    !Number.isFinite(value.simulationSeconds) || value.simulationSeconds < 0 ||
    !Number.isFinite(value.wallSeconds) || value.wallSeconds < 0 ||
    value.includeDiagnostics !== undefined && typeof value.includeDiagnostics !== "boolean") {
    throw new TypeError("native core authoritative operation is invalid");
  }
  const command = value.command == null ? null : normalizeNativeCoreCommand(value.command);
  if (command && command.baseRevision !== value.baseRevision) {
    throw new TypeError("native core authoritative command revision is invalid");
  }
  if (!command && value.simulationSeconds === 0 && value.wallSeconds === 0) {
    throw new TypeError("native core authoritative operation is empty");
  }
  const request = {
    commandId: value.commandId,
    baseRevision: value.baseRevision,
    command,
    simulationSeconds: value.simulationSeconds,
    wallSeconds: value.wallSeconds,
    includeDiagnostics: value.includeDiagnostics ?? false,
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_FRAME_PAYLOAD_BYTES - 16_384) {
    throw new RangeError("native core authoritative operation exceeds the bounded IPC limit");
  }
  return request;
}

class NativeCoreSessionRegistry {
  constructor(client) {
    this.client = client;
    this.sessions = new Map();
  }

  async open(ownerId, request) {
    const value = await this.client.request(normalizeNativeCoreOpen(request));
    if (!validLogicalId(value?.sessionId, 128) || this.sessions.has(value.sessionId) || value?.authority !== "shadow") {
      throw new NativeHostError("native host returned an invalid core session", "NATIVE_PROTOCOL_INVALID");
    }
    this.sessions.set(value.sessionId, { ownerId, slot: request.slot });
    return value;
  }

  status(ownerId, sessionId) {
    this.assertOwner(ownerId, sessionId);
    return this.client.request({ operation: "coreStatus", sessionId });
  }

  projection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const validSelectors = (values, maximum) => Array.isArray(values) && values.length <= maximum &&
      values.every((value) => validLogicalId(value, 160));
    if (!validSelectors(request?.baseFields, 64) || !validSelectors(request?.entityIds, 32) ||
      !validSelectors(request?.beltIds, 64) ||
      request.baseFields.some((field) => field === "entities" || field === "belts")) {
      throw new TypeError("native core projection request is invalid");
    }
    return this.client.request({
      operation: "coreProjection",
      sessionId: request.sessionId,
      baseFields: request.baseFields,
      entityIds: request.entityIds,
      beltIds: request.beltIds,
    });
  }

  applyCommand(ownerId, sessionId, command) {
    this.assertOwner(ownerId, sessionId);
    return this.client.request({ operation: "coreApplyCommand", sessionId, command: normalizeNativeCoreCommand(command) });
  }

  advance(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (!Number.isSafeInteger(request?.baseRevision) || request.baseRevision < 0 ||
      !Number.isFinite(request?.simulationSeconds) || request.simulationSeconds < 0 ||
      !Number.isFinite(request?.wallSeconds) || request.wallSeconds < 0 ||
      request?.includeDiagnostics !== undefined && typeof request.includeDiagnostics !== "boolean") {
      throw new TypeError("native core advance request is invalid");
    }
    return this.client.request({
      operation: "coreAdvance",
      sessionId: request.sessionId,
      request: {
        baseRevision: request.baseRevision,
        simulationSeconds: request.simulationSeconds,
        wallSeconds: request.wallSeconds,
        includeDiagnostics: request.includeDiagnostics ?? true,
      },
    });
  }

  commitOperation(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    return this.client.request({
      operation: "coreCommitOperation",
      sessionId: request.sessionId,
      request: normalizeNativeCoreCommitOperation(request),
    });
  }

  checkpoint(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (!Number.isSafeInteger(request?.savedAtMs) || request.savedAtMs < 0) {
      throw new TypeError("native core checkpoint timestamp is invalid");
    }
    return this.client.request({
      operation: "coreCheckpoint",
      sessionId: request.sessionId,
      savedAtMs: request.savedAtMs,
    });
  }

  compare(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (!Number.isSafeInteger(request?.revision) || request.revision < 0 ||
      typeof request?.canonicalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(request.canonicalSha256) ||
      typeof request?.domainSha256 !== "string" || !/^[a-f0-9]{64}$/.test(request.domainSha256)) {
      throw new TypeError("native core comparison request is invalid");
    }
    return this.client.request({
      operation: "coreCompare",
      sessionId: request.sessionId,
      revision: request.revision,
      canonicalSha256: request.canonicalSha256,
      domainSha256: request.domainSha256,
    });
  }

  async close(ownerId, sessionId) {
    this.assertOwner(ownerId, sessionId);
    this.sessions.delete(sessionId);
    return this.client.request({ operation: "coreClose", sessionId });
  }

  async closeOwner(ownerId) {
    const owned = [...this.sessions.entries()].filter(([, session]) => session.ownerId === ownerId);
    await Promise.allSettled(owned.map(([sessionId]) => this.client.request({ operation: "coreClose", sessionId })));
    for (const [sessionId] of owned) this.sessions.delete(sessionId);
  }

  assertOwner(ownerId, sessionId) {
    if (!validLogicalId(sessionId, 128) || this.sessions.get(sessionId)?.ownerId !== ownerId) {
      throw new NativeHostError("native core session is not owned by this renderer", "NATIVE_CORE_SESSION_INVALID");
    }
  }
}

module.exports = {
  CONTROL_REQUEST_KIND,
  CONTROL_RESPONSE_KIND,
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_PROTOCOL_VERSION,
  MAX_FRAME_PAYLOAD_BYTES,
  NativeHostClient,
  NativeHostError,
  NativeCoreSessionRegistry,
  NativeSaveSessionRegistry,
  crc32,
  encodeFrame,
  nativeHostBinaryPath,
  normalizeNativeSaveBegin,
  normalizeNativeSaveRecords,
  normalizeNativeCoreCommand,
  normalizeNativeCoreCommitOperation,
  normalizeNativeCoreOpen,
  parseFrames,
};
