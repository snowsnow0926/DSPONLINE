const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { requireNativeSaveDiskBudget } = require("./native-save-disk-budget.cjs");

const FRAME_MAGIC = Buffer.from("DSPNATV1", "ascii");
const FRAME_HEADER_BYTES = 36;
const FRAME_PROTOCOL_VERSION = 1;
const CONTROL_REQUEST_KIND = 1;
const CONTROL_RESPONSE_KIND = 2;
const MAX_FRAME_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_PROJECTION_TRANSFER_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const NATIVE_EXACT_REALTIME_LEASE_CAPABILITY = "native-core-exact-realtime-lease-v2";
const NATIVE_EXACT_REALTIME_WRITER_FENCE_CAPABILITY =
  "native-core-exact-realtime-writer-fence-v1";
const NATIVE_PLAYER_AUTHORITY_GATE_CAPABILITY = "native-core-player-authority-gate-v1";
const NATIVE_PLAYER_AUTHORITY_TICK_CAPABILITY = "native-core-player-authority-tick-v1";
const NATIVE_V47_STREAM_IMPORT_CAPABILITY = "native-core-v47-stream-import-v1";
const NATIVE_HOST_SPAWN_ENVIRONMENT_KEYS = new Set([
  "DSP_NATIVE_CORE_THREADS",
  "DSP_NATIVE_CORE_SYNC_RECORD_DROP",
]);
const NATIVE_CORE_THREAD_ENVIRONMENT_VALUES = new Set(["auto", "1", "2", "4", "8"]);

function normalizeNativeHostSpawnEnvironment(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("native host spawn environment is invalid");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !NATIVE_HOST_SPAWN_ENVIRONMENT_KEYS.has(key))) {
    throw new TypeError("native host spawn environment contains an unsupported field");
  }
  const normalized = {};
  if (Object.hasOwn(value, "DSP_NATIVE_CORE_THREADS")) {
    const threadSetting = String(value.DSP_NATIVE_CORE_THREADS);
    if (!NATIVE_CORE_THREAD_ENVIRONMENT_VALUES.has(threadSetting)) {
      throw new TypeError("native host core thread setting is invalid");
    }
    normalized.DSP_NATIVE_CORE_THREADS = threadSetting;
  }
  if (Object.hasOwn(value, "DSP_NATIVE_CORE_SYNC_RECORD_DROP")) {
    if (String(value.DSP_NATIVE_CORE_SYNC_RECORD_DROP) !== "1") {
      throw new TypeError("native host synchronous record-drop setting is invalid");
    }
    normalized.DSP_NATIVE_CORE_SYNC_RECORD_DROP = "1";
  }
  return normalized;
}

function encodeNativeProjectionTransfer({ sessionId, sequence, projectionType, result }) {
  if (!validLogicalId(sessionId, 128) || !Number.isSafeInteger(sequence) || sequence < 1 ||
    !["viewport-v1", "viewport-v2", "factory-read-model-v1", "statistics-v1"].includes(projectionType) || !result || typeof result !== "object" ||
    result.schemaVersion !== (projectionType === "viewport-v2" ? 2 : 1) || result.projectionType !== projectionType ||
    !Number.isSafeInteger(result.revision) || result.revision < 0) {
    throw new TypeError("native core projection transfer is invalid");
  }
  const payload = Buffer.from(JSON.stringify(result), "utf8");
  if (payload.byteLength > MAX_NATIVE_PROJECTION_TRANSFER_BYTES) {
    throw new RangeError("native core projection exceeds the transferable block limit");
  }
  return {
    header: {
      schemaVersion: 1,
      sessionId,
      revision: result.revision,
      sequence,
      projectionType,
      payloadLength: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
    },
    payload,
  };
}

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
  constructor({
    binaryPath,
    rootPath,
    spawnProcess = spawn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    spawnEnvironment = {},
  }) {
    if (!path.isAbsolute(binaryPath) || !path.isAbsolute(rootPath)) throw new TypeError("native host paths must be absolute");
    this.binaryPath = binaryPath;
    this.rootPath = rootPath;
    this.spawnProcess = spawnProcess;
    this.spawnEnvironment = normalizeNativeHostSpawnEnvironment(spawnEnvironment);
    this.requestTimeoutMs = Math.max(5_000, Math.min(300_000, requestTimeoutMs));
    this.child = null;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrTail = "";
    this.exited = false;
  }

  async start(clientVersion = "1.2.3") {
    if (this.child && !this.exited) return this.hello;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const child = this.spawnProcess(this.binaryPath, ["serve", "--root", this.rootPath], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: { ...process.env, ...this.spawnEnvironment },
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

function validOpaqueId(value, maximumBytes = 512) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function exactObjectKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} is invalid`);
  }
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function normalizeExactRealtimeCheckpoint(value) {
  exactObjectKeys(value, ["generation", "rootHash", "revision"], "native exact realtime checkpoint");
  if (!Number.isSafeInteger(value.generation) || value.generation < 1 ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 || !validSha256(value.rootHash)) {
    throw new TypeError("native exact realtime checkpoint is invalid");
  }
  return { generation: value.generation, rootHash: value.rootHash, revision: value.revision };
}

function normalizeExactRealtimeProof(value, label = "native exact realtime proof") {
  exactObjectKeys(value, ["revision", "canonicalSha256", "domainSha256"], label);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !validSha256(value.canonicalSha256) || !validSha256(value.domainSha256)) {
    throw new TypeError(`${label} is invalid`);
  }
  return { ...value };
}

function requireExactRealtimeIdentity(value, keys) {
  exactObjectKeys(value, keys, "native exact realtime lease request");
  if (!validLogicalId(value.runId, 128) || !validLogicalId(value.registryFingerprint, 256)) {
    throw new TypeError("native exact realtime lease identity is invalid");
  }
}

function normalizeNativeExactRealtimeLeaseRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.action !== "string") {
    throw new TypeError("native exact realtime lease request is invalid");
  }
  switch (value.action) {
    case "inspect":
      exactObjectKeys(value, ["action"], "native exact realtime inspect request");
      return { action: "inspect" };
    case "prepare": {
      requireExactRealtimeIdentity(value, ["action", "runId", "registryFingerprint", "checkpoint", "proof", "settledDeadlineMs"]);
      const checkpoint = normalizeExactRealtimeCheckpoint(value.checkpoint);
      const proof = normalizeExactRealtimeProof(value.proof);
      if (proof.revision !== checkpoint.revision || !Number.isSafeInteger(value.settledDeadlineMs) || value.settledDeadlineMs < 0) {
        throw new TypeError("native exact realtime prepare request is invalid");
      }
      return { ...value, checkpoint, proof };
    }
    case "activate":
    case "beginFinalizing":
      requireExactRealtimeIdentity(value, ["action", "runId", "registryFingerprint"]);
      return { ...value };
    case "pause":
      requireExactRealtimeIdentity(value, ["action", "runId", "registryFingerprint", "reasonCode"]);
      if (!validLogicalId(value.reasonCode, 160)) throw new TypeError("native exact realtime pause reason is invalid");
      return { ...value };
    case "stageExactTick":
      requireExactRealtimeIdentity(value, [
        "action", "runId", "registryFingerprint", "sequence", "commandId", "baseRevision",
        "expectedRevision", "simulationSeconds", "wallSeconds", "settledDeadlineMs",
      ]);
      if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || !validLogicalId(value.commandId, 128) ||
        !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0 ||
        value.expectedRevision !== value.baseRevision + 1 || value.simulationSeconds !== 1 || value.wallSeconds !== 1 ||
        !Number.isSafeInteger(value.settledDeadlineMs) || value.settledDeadlineMs < 0) {
        throw new TypeError("native exact realtime staged tick is invalid");
      }
      return { ...value };
    case "recordPublicPrimaryReadback":
    case "clearFinalized": {
      requireExactRealtimeIdentity(value, ["action", "runId", "registryFingerprint", "publicPrimaryReadbackProof"]);
      const proof = value.publicPrimaryReadbackProof;
      exactObjectKeys(proof, [
        "kind", "revision", "canonicalSha256", "domainSha256", "registryFingerprint",
        "payloadSha256", "baseChecksum", "byteLength", "savedAtMs",
      ], "native exact realtime public readback proof");
      if (proof.kind !== "public-primary-readback-v1" || !Number.isSafeInteger(proof.revision) || proof.revision < 0 ||
        !validSha256(proof.canonicalSha256) || !validSha256(proof.domainSha256) ||
        proof.registryFingerprint !== value.registryFingerprint || !validSha256(proof.payloadSha256) ||
        typeof proof.baseChecksum !== "string" || !/^[a-f0-9]{8,128}$/.test(proof.baseChecksum) ||
        !Number.isSafeInteger(proof.byteLength) || proof.byteLength < 1 ||
        !Number.isSafeInteger(proof.savedAtMs) || proof.savedAtMs < 0) {
        throw new TypeError("native exact realtime public readback proof is invalid");
      }
      return { ...value, publicPrimaryReadbackProof: { ...proof } };
    }
    default:
      throw new TypeError("native exact realtime lease action is not allowed");
  }
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
  const keys = new Set();
  return records.map((record) => {
    if (!record || typeof record !== "object" || typeof record.key !== "string" || record.key.length < 1 || record.key.length > 512 ||
      record.key.includes("..") || /[\\/\0]/.test(record.key)) throw new TypeError("native save record key is invalid");
    if (keys.has(record.key)) throw new TypeError("native save batch repeats a record key");
    keys.add(record.key);
    if (record.value !== null && typeof record.value !== "string") throw new TypeError("native save record value is invalid");
    totalBytes += Buffer.byteLength(record.key, "utf8") + (record.value === null ? 0 : Buffer.byteLength(record.value, "utf8"));
    if (totalBytes > MAX_FRAME_PAYLOAD_BYTES - 16_384) throw new RangeError("native save batch exceeds the bounded IPC limit");
    return { key: record.key, value: record.value };
  });
}

class NativeSaveSessionRegistry {
  constructor(client, options = {}) {
    this.client = client;
    this.sessions = new Map();
    this.diskBudgetTargetPath = options.diskBudgetTargetPath ?? null;
    this.diskBudgetCheck = options.diskBudgetCheck ?? requireNativeSaveDiskBudget;
    if (this.diskBudgetTargetPath !== null &&
        (typeof this.diskBudgetTargetPath !== "string" || !path.isAbsolute(this.diskBudgetTargetPath))) {
      throw new TypeError("native save disk budget target is invalid");
    }
    if (typeof this.diskBudgetCheck !== "function") {
      throw new TypeError("native save disk budget checker is invalid");
    }
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
    if (this.diskBudgetTargetPath !== null) {
      this.diskBudgetCheck({
        targetPath: this.diskBudgetTargetPath,
        payload: JSON.stringify(normalized),
      });
    }
    if (this.client.hello?.capabilities?.includes("native-save-put-batch-v1")) {
      const result = await this.client.request({
        operation: "savePutBatch",
        transactionId,
        records: normalized,
      });
      if (result?.acceptedRecords !== normalized.length) {
        throw new NativeHostError("native host returned an invalid save batch receipt", "NATIVE_PROTOCOL_INVALID");
      }
      return { acceptedRecords: normalized.length };
    }
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

function normalizeNativeCoreImport(value, sourcePath) {
  exactObjectKeys(value, ["registryFingerprint", "catalog"], "native core v47 import request");
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath) || sourcePath.length > 32_767) {
    throw new TypeError("native core v47 import source is invalid");
  }
  if (!validLogicalId(value.registryFingerprint, 256)) {
    throw new TypeError("native core v47 import registry fingerprint is invalid");
  }
  const catalog = value.catalog;
  if (!catalog || typeof catalog !== "object" || catalog.protocolVersion !== 1 ||
    catalog.registryFingerprint !== value.registryFingerprint || !Array.isArray(catalog.items) ||
    !Array.isArray(catalog.buildings) || !Array.isArray(catalog.recipes) || !Array.isArray(catalog.belts)) {
    throw new TypeError("native core v47 import catalog is invalid");
  }
  const entryCount = catalog.items.length + catalog.buildings.length + catalog.recipes.length + catalog.belts.length;
  if (entryCount < 1 || entryCount > 65_536) {
    throw new RangeError("native core v47 import catalog entry count is invalid");
  }
  const request = {
    operation: "coreImportV47",
    sourcePath,
    registryFingerprint: value.registryFingerprint,
    catalog,
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_FRAME_PAYLOAD_BYTES - 16_384) {
    throw new RangeError("native core v47 import catalog exceeds the bounded IPC limit");
  }
  return request;
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
    value.includeDiagnostics !== undefined && typeof value.includeDiagnostics !== "boolean" ||
    value.advanceMode !== undefined && !["exact", "pure-idle-conservative-v2", "pure-idle-macro-v10"].includes(value.advanceMode)) {
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
    advanceMode: value.advanceMode ?? "exact",
    includeDiagnostics: value.includeDiagnostics ?? false,
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_FRAME_PAYLOAD_BYTES - 16_384) {
    throw new RangeError("native core authoritative operation exceeds the bounded IPC limit");
  }
  return request;
}

function normalizePlayerAuthorityCheckpoint(value, label) {
  exactObjectKeys(value, ["generation", "rootHash", "revision"], label);
  if (!Number.isSafeInteger(value.generation) || value.generation < 1 ||
    typeof value.rootHash !== "string" || !/^[a-f0-9]{64}$/.test(value.rootHash) ||
    !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return {
    generation: value.generation,
    rootHash: value.rootHash,
    revision: value.revision,
  };
}

class NativeExactRealtimeLeaseRegistry {
  constructor(client) {
    this.client = client;
  }

  request(request) {
    if (!this.client.hello?.capabilities?.includes(NATIVE_EXACT_REALTIME_LEASE_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide the Rust exact realtime lease capability",
        "NATIVE_CORE_EXACT_REALTIME_RUST_LEASE_UNAVAILABLE",
      );
    }
    return this.client.request({
      operation: "exactRealtimeLease",
      request: normalizeNativeExactRealtimeLeaseRequest(request),
    });
  }
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

  async importV47(ownerId, request, sourcePath) {
    if (!this.client.hello?.capabilities?.includes(NATIVE_V47_STREAM_IMPORT_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide bounded v47 import",
        "NATIVE_CORE_V47_IMPORT_UNAVAILABLE",
      );
    }
    const value = await this.client.request(normalizeNativeCoreImport(request, sourcePath), 300_000);
    if (!validLogicalId(value?.sessionId, 128) || this.sessions.has(value.sessionId) ||
      value?.authority !== "shadow" || !value?.checkpoint || !value?.import || !value?.summary ||
      !["normal", "speedrun"].includes(value.import.mode) || value.summary.mode !== value.import.mode) {
      if (validLogicalId(value?.sessionId, 128) && !this.sessions.has(value.sessionId)) {
        await this.client.request({ operation: "coreClose", sessionId: value.sessionId }).catch(() => undefined);
      }
      throw new NativeHostError("native host returned an invalid imported core session", "NATIVE_PROTOCOL_INVALID");
    }
    this.sessions.set(value.sessionId, {
      ownerId,
      slot: value.import.mode === "speedrun" ? "speedrun-main" : "normal-main",
    });
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

  viewportProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const baseFields = request?.baseFields ?? [];
    const bounds = request?.bounds;
    const finiteBound = (value) => Number.isFinite(value) && Math.abs(value) <= 10_000_000;
    if (!Array.isArray(baseFields) || baseFields.length > 64 ||
      baseFields.some((field) => !validLogicalId(field, 160) || field === "entities" || field === "belts") ||
      !validLogicalId(request?.planetId, 160) || !bounds ||
      !finiteBound(bounds.minX) || !finiteBound(bounds.minY) ||
      !finiteBound(bounds.maxX) || !finiteBound(bounds.maxY) ||
      bounds.minX > bounds.maxX || bounds.minY > bounds.maxY ||
      !Number.isSafeInteger(request?.entityCursor ?? 0) || (request?.entityCursor ?? 0) < 0 ||
      !Number.isSafeInteger(request?.entityLimit) || request.entityLimit < 1 || request.entityLimit > 4096 ||
      !Number.isSafeInteger(request?.beltLimit) || request.beltLimit < 0 || request.beltLimit > 8192) {
      throw new TypeError("native core viewport projection request is invalid");
    }
    return this.client.request({
      operation: "coreViewportProjection",
      sessionId: request.sessionId,
      baseFields,
      planetId: request.planetId,
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
      entityCursor: request.entityCursor ?? 0,
      entityLimit: request.entityLimit,
      beltLimit: request.beltLimit,
    });
  }

  viewportProjectionV2(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const baseFields = request?.baseFields ?? [];
    const bounds = request?.bounds;
    const pinnedEntityIds = request?.pinnedEntityIds ?? [];
    const pinnedBeltIds = request?.pinnedBeltIds ?? [];
    const finiteBound = (value) => Number.isFinite(value) && Math.abs(value) <= 10_000_000;
    if (!Array.isArray(baseFields) || baseFields.length > 64 ||
      baseFields.some((field) => !validLogicalId(field, 160) || field === "entities" || field === "belts") ||
      !validOpaqueId(request?.planetId) || !bounds ||
      !finiteBound(bounds.minX) || !finiteBound(bounds.minY) ||
      !finiteBound(bounds.maxX) || !finiteBound(bounds.maxY) ||
      bounds.minX > bounds.maxX || bounds.minY > bounds.maxY ||
      !Number.isSafeInteger(request?.entityCursor ?? 0) || (request?.entityCursor ?? 0) < 0 ||
      !Number.isSafeInteger(request?.entityLimit) || request.entityLimit < 1 || request.entityLimit > 4096 ||
      !Number.isSafeInteger(request?.beltCursor ?? 0) || (request?.beltCursor ?? 0) < 0 ||
      !Number.isSafeInteger(request?.beltLimit) || request.beltLimit < 1 || request.beltLimit > 8192 ||
      !Array.isArray(pinnedEntityIds) || pinnedEntityIds.length > 32 ||
      !Array.isArray(pinnedBeltIds) || pinnedBeltIds.length > 64 ||
      pinnedEntityIds.some((id) => !validOpaqueId(id)) || pinnedBeltIds.some((id) => !validOpaqueId(id))) {
      throw new TypeError("native core viewport v2 projection request is invalid");
    }
    return this.client.request({
      operation: "coreViewportProjectionV2",
      sessionId: request.sessionId,
      baseFields,
      planetId: request.planetId,
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
      entityCursor: request.entityCursor ?? 0,
      entityLimit: request.entityLimit,
      beltCursor: request.beltCursor ?? 0,
      beltLimit: request.beltLimit,
      pinnedEntityIds,
      pinnedBeltIds,
    });
  }

  factoryReadModelProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const selectedEntityIds = request?.selectedEntityIds ?? [];
    const selectedBeltIds = request?.selectedBeltIds ?? [];
    if (!Number.isSafeInteger(request?.expectedRevision) || request.expectedRevision < 0 ||
      !Array.isArray(selectedEntityIds) || selectedEntityIds.length > 64 ||
      !Array.isArray(selectedBeltIds) || selectedBeltIds.length > 64 ||
      selectedEntityIds.some((id) => !validOpaqueId(id)) ||
      selectedBeltIds.some((id) => !validOpaqueId(id))) {
      throw new TypeError("native factory read-model projection request is invalid");
    }
    return this.client.request({
      operation: "coreFactoryReadModelProjection",
      sessionId: request.sessionId,
      selectedEntityIds,
      selectedBeltIds,
    });
  }

  statisticsProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const validElapsed = (value) => Number.isFinite(value) && value >= 0 && value <= 30 * 24 * 60 * 60 * 10_000;
    if (!validElapsed(request?.minElapsedSeconds) || !validElapsed(request?.maxElapsedSeconds) ||
      request.minElapsedSeconds > request.maxElapsedSeconds ||
      !Number.isSafeInteger(request?.cursor ?? 0) || (request?.cursor ?? 0) < 0 ||
      !Number.isSafeInteger(request?.limit) || request.limit < 1 || request.limit > 512 ||
      request?.planetId !== undefined && request.planetId !== null && !validLogicalId(request.planetId, 160) ||
      request?.itemId !== undefined && request.itemId !== null && !validLogicalId(request.itemId, 160)) {
      throw new TypeError("native core statistics projection request is invalid");
    }
    return this.client.request({
      operation: "coreStatisticsProjection",
      sessionId: request.sessionId,
      minElapsedSeconds: request.minElapsedSeconds,
      maxElapsedSeconds: request.maxElapsedSeconds,
      cursor: request.cursor ?? 0,
      limit: request.limit,
      ...(request.planetId ? { planetId: request.planetId } : {}),
      ...(request.itemId ? { itemId: request.itemId } : {}),
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
      request?.includeDiagnostics !== undefined && typeof request.includeDiagnostics !== "boolean" ||
      request?.advanceMode !== undefined && !["exact", "pure-idle-conservative-v2", "pure-idle-macro-v10"].includes(request.advanceMode)) {
      throw new TypeError("native core advance request is invalid");
    }
    return this.client.request({
      operation: "coreAdvance",
      sessionId: request.sessionId,
      request: {
        baseRevision: request.baseRevision,
        simulationSeconds: request.simulationSeconds,
        wallSeconds: request.wallSeconds,
        advanceMode: request.advanceMode ?? "exact",
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

  commitOperationExactRealtime(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (!this.client.hello?.capabilities?.includes(NATIVE_EXACT_REALTIME_WRITER_FENCE_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide the exact realtime writer fence capability",
        "NATIVE_CORE_EXACT_REALTIME_WRITER_FENCE_UNAVAILABLE",
      );
    }
    exactObjectKeys(request, [
      "sessionId", "runId", "registryFingerprint",
    ], "native exact realtime commit request");
    if (!validLogicalId(request.runId, 128) || !validLogicalId(request.registryFingerprint, 256)) {
      throw new TypeError("native exact realtime commit identity is invalid");
    }
    return this.client.request({
      operation: "coreCommitOperationExactRealtime",
      sessionId: request.sessionId,
      request: {
        runId: request.runId,
        registryFingerprint: request.registryFingerprint,
      },
    }, 300_000);
  }

  preparePlayerAuthority(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (!this.client.hello?.capabilities?.includes(NATIVE_PLAYER_AUTHORITY_GATE_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide the player-authority gate capability",
        "NATIVE_CORE_PLAYER_AUTHORITY_GATE_UNAVAILABLE",
      );
    }
    exactObjectKeys(request, [
      "sessionId", "runId", "expectedCheckpoint", "settledDeadlineMs",
    ], "native player-authority prepare request");
    if (!validLogicalId(request.runId, 128) ||
      !Number.isSafeInteger(request.settledDeadlineMs) || request.settledDeadlineMs < 0) {
      throw new TypeError("native player-authority prepare request is invalid");
    }
    const expectedCheckpoint = normalizePlayerAuthorityCheckpoint(
      request.expectedCheckpoint,
      "native player-authority prepare checkpoint",
    );
    return this.client.request({
      operation: "corePreparePlayerAuthority",
      sessionId: request.sessionId,
      request: {
        runId: request.runId,
        expectedCheckpoint,
        settledDeadlineMs: request.settledDeadlineMs,
      },
    }, 300_000);
  }

  activatePlayerAuthority(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (!this.client.hello?.capabilities?.includes(NATIVE_PLAYER_AUTHORITY_GATE_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide the player-authority gate capability",
        "NATIVE_CORE_PLAYER_AUTHORITY_GATE_UNAVAILABLE",
      );
    }
    exactObjectKeys(request, [
      "sessionId", "runId", "expectedCheckpoint",
    ], "native player-authority activate request");
    if (!validLogicalId(request.runId, 128)) {
      throw new TypeError("native player-authority activate request is invalid");
    }
    const expectedCheckpoint = normalizePlayerAuthorityCheckpoint(
      request.expectedCheckpoint,
      "native player-authority activate checkpoint",
    );
    return this.client.request({
      operation: "coreActivatePlayerAuthority",
      sessionId: request.sessionId,
      request: {
        runId: request.runId,
        expectedCheckpoint,
      },
    }, 300_000);
  }

  commitPlayerAuthorityTick(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (!this.client.hello?.capabilities?.includes(NATIVE_PLAYER_AUTHORITY_TICK_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide the player-authority tick capability",
        "NATIVE_CORE_PLAYER_AUTHORITY_TICK_UNAVAILABLE",
      );
    }
    exactObjectKeys(request, [
      "sessionId", "runId", "sequence",
    ], "native player-authority tick request");
    if (!validLogicalId(request.runId, 128) ||
      !Number.isSafeInteger(request.sequence) || request.sequence < 1) {
      throw new TypeError("native player-authority tick request is invalid");
    }
    return this.client.request({
      operation: "coreCommitPlayerAuthorityTick",
      sessionId: request.sessionId,
      request: {
        runId: request.runId,
        sequence: request.sequence,
      },
    }, 300_000);
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

  checkpointAndAcknowledgeExactRealtime(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (!this.client.hello?.capabilities?.includes(NATIVE_EXACT_REALTIME_LEASE_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide the Rust exact realtime lease capability",
        "NATIVE_CORE_EXACT_REALTIME_RUST_LEASE_UNAVAILABLE",
      );
    }
    exactObjectKeys(request, [
      "sessionId", "runId", "registryFingerprint", "sequence", "commandId", "settledDeadlineMs",
    ], "native exact realtime checkpoint ACK request");
    if (!validLogicalId(request.runId, 128) || !validLogicalId(request.registryFingerprint, 256) ||
      !Number.isSafeInteger(request.sequence) || request.sequence < 1 || !validLogicalId(request.commandId, 128) ||
      !Number.isSafeInteger(request.settledDeadlineMs) || request.settledDeadlineMs < 0) {
      throw new TypeError("native exact realtime checkpoint ACK request is invalid");
    }
    return this.client.request({
      operation: "coreCheckpointAcknowledgeExactRealtime",
      sessionId: request.sessionId,
      request: {
        runId: request.runId,
        registryFingerprint: request.registryFingerprint,
        sequence: request.sequence,
        commandId: request.commandId,
        settledDeadlineMs: request.settledDeadlineMs,
      },
    }, 300_000);
  }

  checkpointExactRealtimeFinalization(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (!this.client.hello?.capabilities?.includes(NATIVE_EXACT_REALTIME_LEASE_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide the Rust exact realtime lease capability",
        "NATIVE_CORE_EXACT_REALTIME_RUST_LEASE_UNAVAILABLE",
      );
    }
    exactObjectKeys(request, [
      "sessionId", "runId", "registryFingerprint", "savedAtMs",
    ], "native exact realtime finalization checkpoint request");
    if (!validLogicalId(request.runId, 128) || !validLogicalId(request.registryFingerprint, 256) ||
      !Number.isSafeInteger(request.savedAtMs) || request.savedAtMs < 0) {
      throw new TypeError("native exact realtime finalization checkpoint request is invalid");
    }
    return this.client.request({
      operation: "coreCheckpointExactRealtimeFinalization",
      sessionId: request.sessionId,
      request: {
        runId: request.runId,
        registryFingerprint: request.registryFingerprint,
        savedAtMs: request.savedAtMs,
      },
    }, 300_000);
  }

  exportV47(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (!validLogicalId(request?.exportId, 128) || request.exportId.includes(":") || request.exportId.includes(".") ||
      !Number.isSafeInteger(request?.savedAtMs) || request.savedAtMs < 0) {
      throw new TypeError("native core export request is invalid");
    }
    return this.client.request({
      operation: "coreExportV47",
      sessionId: request.sessionId,
      exportId: request.exportId,
      savedAtMs: request.savedAtMs,
    }, 300_000);
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
  MAX_NATIVE_PROJECTION_TRANSFER_BYTES,
  NATIVE_EXACT_REALTIME_LEASE_CAPABILITY,
  NATIVE_EXACT_REALTIME_WRITER_FENCE_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_GATE_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_TICK_CAPABILITY,
  NATIVE_V47_STREAM_IMPORT_CAPABILITY,
  NativeHostClient,
  NativeHostError,
  NativeCoreSessionRegistry,
  NativeExactRealtimeLeaseRegistry,
  NativeSaveSessionRegistry,
  crc32,
  encodeNativeProjectionTransfer,
  encodeFrame,
  nativeHostBinaryPath,
  normalizeNativeSaveBegin,
  normalizeNativeSaveRecords,
  normalizeNativeCoreCommand,
  normalizeNativeCoreCommitOperation,
  normalizeNativeCoreOpen,
  normalizeNativeCoreImport,
  normalizeNativeExactRealtimeLeaseRequest,
  normalizeNativeHostSpawnEnvironment,
  parseFrames,
};
