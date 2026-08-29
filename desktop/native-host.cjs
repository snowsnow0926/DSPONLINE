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
const MAX_COMMAND_PALETTE_SEARCH_REQUEST_BYTES = 32_768;
const MAX_COMMAND_PALETTE_QUERY_BYTES = 256;
const MAX_COMMAND_PALETTE_SELECTOR_IDS = 256;
const MAX_COMMAND_PALETTE_ROWS = 16;
const MAX_STELLAR_PROJECTION_REQUEST_BYTES = 32_768;
const MAX_STELLAR_PROJECTION_PAGE_ROWS = 64;
const MAX_STELLAR_ROUTE_QUERY_BYTES = 512;
const MAX_DYSON_WORKSPACE_ID_BYTES = 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const NATIVE_EXACT_REALTIME_LEASE_CAPABILITY = "native-core-exact-realtime-lease-v2";
const NATIVE_EXACT_REALTIME_WRITER_FENCE_CAPABILITY =
  "native-core-exact-realtime-writer-fence-v1";
const NATIVE_PLAYER_AUTHORITY_GATE_CAPABILITY = "native-core-player-authority-gate-v1";
const NATIVE_PLAYER_AUTHORITY_TICK_CAPABILITY = "native-core-player-authority-tick-v1";
const NATIVE_PLAYER_AUTHORITY_COMMAND_CAPABILITY = "native-core-player-authority-command-v1";
const NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY =
  "native-core-player-authority-pure-idle-macro-v1";
const NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY =
  "native-core-player-authority-startup-recovery-v1";
const NATIVE_FACTORY_INVENTORY_CAPABILITY = "native-core-factory-inventory-v1";
const NATIVE_CONSTRUCTION_INVENTORY_CAPABILITY = "native-core-construction-inventory-v1";
const MAIN_PLAYER_AUTHORITY_OWNER_ID = "main-player-authority";
const MAX_DURABLE_PLAYER_AUTHORITY_COMMAND_BYTES = 1_750_000;
const MAX_PLAYER_AUTHORITY_MACRO_BUDGET_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
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
    !["viewport-v1", "viewport-v2", "factory-read-model-v1", "factory-inventory-v1", "construction-inventory-v1", "statistics-v1", "technology-v1", "recipe-workspace-v1", "star-map-overview-v1", "star-map-catalog-v1", "stellar-industry-v1", "stellar-industry-v2", "stellar-quantum-v1", "dyson-workspace-v1"].includes(projectionType) || !result || typeof result !== "object" ||
    result.schemaVersion !== (["viewport-v2", "stellar-industry-v2"].includes(projectionType) ? 2 : 1) || result.projectionType !== projectionType ||
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

function validDysonWorkspaceId(value) {
  return validOpaqueId(value, MAX_DYSON_WORKSPACE_ID_BYTES) &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return character.length === 1 && code >= 0xd800 && code <= 0xdfff;
    });
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

function normalizeDurablePlayerAuthorityCommand(value) {
  exactObjectKeys(value, [
    "protocolVersion", "baseRevision", "topLevelChanges", "changedEntities", "addedEntities",
    "removedEntityIds", "changedBelts", "addedBelts", "removedBeltIds",
  ], "native player-authority command patch");
  normalizeNativeCoreCommand(value);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_DURABLE_PLAYER_AUTHORITY_COMMAND_BYTES) {
    throw new RangeError("native player-authority command exceeds its durable payload limit");
  }
  return JSON.parse(encoded);
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

function normalizeStablePlayerAuthorityChangeIds(value, label) {
  if (!Array.isArray(value) || value.length > 65_536) {
    throw new NativeHostError(label, "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");
  }
  for (const id of value) {
    if (typeof id !== "string" || id.length < 1 || id.includes("\0") ||
        Buffer.byteLength(id, "utf8") > 512) {
      throw new NativeHostError(label, "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");
    }
    for (let index = 0; index < id.length; index += 1) {
      const unit = id.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = id.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw new NativeHostError(label, "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");
        }
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new NativeHostError(label, "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");
      }
    }
  }
  for (let index = 1; index < value.length; index += 1) {
    if (Buffer.compare(Buffer.from(value[index - 1], "utf8"), Buffer.from(value[index], "utf8")) >= 0) {
      throw new NativeHostError(label, "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");
    }
  }
  return Object.freeze([...value]);
}

function normalizePlayerAuthorityStartupRecovery(value) {
  const baseKeys = [
    "schemaVersion", "kind", "ownerId", "sessionId", "runId", "registryFingerprint",
    "revision", "checkpoint", "acknowledgedSequence", "nextSequence",
    "settledDeadlineMs", "nextDeadlineMs", "commandId", "commandBaseRevision",
    "changedEntityIds", "changedBeltIds", "topologyDirty", "summary",
  ];
  const macroKeys = [
    "macroSessionId", "recoveredMacroOperationId", "macroAlgorithmVersion",
    "macroSimulationMilliseconds", "macroWallMilliseconds",
  ];
  const cleanupKeys = [
    "pendingMacroCleanupSessionId", "pendingMacroCleanupRevision",
  ];
  const recoveryKeys = ["entryCheckpoint"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      baseKeys.some((key) => !Object.hasOwn(value, key)) ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" ||
        !baseKeys.includes(key) && !macroKeys.includes(key) &&
        !cleanupKeys.includes(key) && !recoveryKeys.includes(key))) {
    throw new NativeHostError(
      "native host returned an invalid player-authority startup recovery receipt",
      "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
    );
  }
  const checkpoint = normalizePlayerAuthorityCheckpoint(
    value.checkpoint,
    "native player-authority startup checkpoint",
  );
  const entryCheckpoint = Object.hasOwn(value, "entryCheckpoint")
    ? normalizePlayerAuthorityCheckpoint(
      value.entryCheckpoint,
      "native player-authority startup entry checkpoint",
    )
    : null;
  const summary = value.summary;
  const changedEntityIds = normalizeStablePlayerAuthorityChangeIds(
    value.changedEntityIds,
    "native player-authority startup entity receipt is invalid",
  );
  const changedBeltIds = normalizeStablePlayerAuthorityChangeIds(
    value.changedBeltIds,
    "native player-authority startup belt receipt is invalid",
  );
  const hasCommand = value.commandId !== null || value.commandBaseRevision !== null;
  const presentMacroKeys = macroKeys.filter((key) => Object.hasOwn(value, key));
  const hasMacro = presentMacroKeys.length > 0;
  const presentCleanupKeys = cleanupKeys.filter((key) => Object.hasOwn(value, key));
  const hasCleanup = presentCleanupKeys.length > 0;
  const validMacro = !hasMacro || (
    presentMacroKeys.length === macroKeys.length && !hasCommand &&
    changedEntityIds.length === 0 && changedBeltIds.length === 0 && !value.topologyDirty &&
    validLogicalId(value.macroSessionId, 128) &&
    validLogicalId(value.recoveredMacroOperationId, 128) &&
    validLogicalId(value.macroAlgorithmVersion, 128) &&
    Number.isSafeInteger(value.macroSimulationMilliseconds) &&
    value.macroSimulationMilliseconds >= 1 &&
    value.macroSimulationMilliseconds <= MAX_PLAYER_AUTHORITY_MACRO_BUDGET_MILLISECONDS &&
    Number.isSafeInteger(value.macroWallMilliseconds) &&
    value.macroWallMilliseconds >= 1 &&
    value.macroWallMilliseconds <= MAX_PLAYER_AUTHORITY_MACRO_BUDGET_MILLISECONDS
  );
  const validCleanup = !hasCleanup || (
    presentCleanupKeys.length === cleanupKeys.length && !hasMacro &&
    entryCheckpoint !== null &&
    validLogicalId(value.pendingMacroCleanupSessionId, 128) &&
    Number.isSafeInteger(value.pendingMacroCleanupRevision) &&
    value.pendingMacroCleanupRevision >= entryCheckpoint.revision &&
    Number.isSafeInteger(value.revision) &&
    value.pendingMacroCleanupRevision <= value.revision
  );
  if (value.schemaVersion !== 1 ||
    value.kind !== NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY ||
    value.ownerId !== MAIN_PLAYER_AUTHORITY_OWNER_ID ||
    !validLogicalId(value.sessionId, 128) || !validLogicalId(value.runId, 128) ||
    !validLogicalId(value.registryFingerprint, 256) ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    checkpoint.revision !== value.revision ||
    entryCheckpoint && entryCheckpoint.revision > checkpoint.revision ||
    !Number.isSafeInteger(value.acknowledgedSequence) || value.acknowledgedSequence < 0 ||
    !Number.isSafeInteger(value.nextSequence) ||
    value.nextSequence !== value.acknowledgedSequence + 1 ||
    !Number.isSafeInteger(value.settledDeadlineMs) || value.settledDeadlineMs < 0 ||
    !Number.isSafeInteger(value.nextDeadlineMs) ||
    value.nextDeadlineMs !== value.settledDeadlineMs + 1_000 ||
    changedEntityIds.length + changedBeltIds.length > 65_536 ||
    typeof value.topologyDirty !== "boolean" ||
    !validMacro ||
    !validCleanup ||
    hasCommand && (!validLogicalId(value.commandId, 128) ||
      !Number.isSafeInteger(value.commandBaseRevision) || value.commandBaseRevision < 0 ||
      value.commandBaseRevision + 1 !== value.revision) ||
    !hasCommand && (value.commandId !== null || value.commandBaseRevision !== null ||
      changedEntityIds.length !== 0 || changedBeltIds.length !== 0 || value.topologyDirty) ||
    !summary || typeof summary !== "object" || Array.isArray(summary) ||
    summary.revision !== value.revision || summary.stateVersion !== 47 ||
    summary.mode !== "normal" || summary.paused !== false ||
    summary.registryFingerprint !== value.registryFingerprint ||
    !validSha256(summary.canonicalSha256) || !validSha256(summary.domainSha256) ||
    summary.coverage?.authorityEligible !== true) {
    throw new NativeHostError(
      "native host returned an invalid player-authority startup recovery receipt",
      "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: value.kind,
    ownerId: value.ownerId,
    sessionId: value.sessionId,
    runId: value.runId,
    registryFingerprint: value.registryFingerprint,
    revision: value.revision,
    checkpoint: Object.freeze(checkpoint),
    ...(entryCheckpoint ? { entryCheckpoint: Object.freeze(entryCheckpoint) } : {}),
    acknowledgedSequence: value.acknowledgedSequence,
    nextSequence: value.nextSequence,
    settledDeadlineMs: value.settledDeadlineMs,
    nextDeadlineMs: value.nextDeadlineMs,
    commandId: value.commandId,
    commandBaseRevision: value.commandBaseRevision,
    changedEntityIds,
    changedBeltIds,
    topologyDirty: value.topologyDirty,
    ...(hasMacro ? {
      macroSessionId: value.macroSessionId,
      recoveredMacroOperationId: value.recoveredMacroOperationId,
      macroAlgorithmVersion: value.macroAlgorithmVersion,
      macroSimulationMilliseconds: value.macroSimulationMilliseconds,
      macroWallMilliseconds: value.macroWallMilliseconds,
    } : {}),
    ...(hasCleanup ? {
      pendingMacroCleanupSessionId: value.pendingMacroCleanupSessionId,
      pendingMacroCleanupRevision: value.pendingMacroCleanupRevision,
    } : {}),
    summary: Object.freeze(JSON.parse(JSON.stringify(summary))),
  });
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
    this.playerAuthorityStartupRecovery = null;
    const startupRecovery = client.hello?.playerAuthorityStartupRecovery;
    if (startupRecovery !== undefined) {
      if (!client.hello?.capabilities?.includes(NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY)) {
        throw new NativeHostError(
          "native host supplied player-authority recovery without its capability",
          "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
        );
      }
      const receipt = normalizePlayerAuthorityStartupRecovery(startupRecovery);
      if (receipt.macroSessionId !== undefined &&
          !client.hello?.capabilities?.includes(NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY)) {
        throw new NativeHostError(
          "native host supplied macro recovery without its macro capability",
          "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
        );
      }
      this.sessions.set(receipt.sessionId, {
        ownerId: MAIN_PLAYER_AUTHORITY_OWNER_ID,
        slot: "normal-main",
        ownerEpoch: 1,
        state: "owned",
        inFlight: 0,
      });
      this.playerAuthorityStartupRecovery = receipt;
    }
  }

  takePlayerAuthorityStartupRecovery(ownerId) {
    const receipt = this.playerAuthorityStartupRecovery;
    if (receipt === null) return null;
    this.assertOwner(ownerId, receipt.sessionId);
    if (ownerId !== MAIN_PLAYER_AUTHORITY_OWNER_ID) {
      throw new NativeHostError(
        "player-authority startup recovery belongs to the main owner",
        "NATIVE_CORE_PLAYER_AUTHORITY_OWNER_REQUIRED",
      );
    }
    this.playerAuthorityStartupRecovery = null;
    return receipt;
  }

  async open(ownerId, request) {
    const value = await this.client.request(normalizeNativeCoreOpen(request));
    if (!validLogicalId(value?.sessionId, 128) || this.sessions.has(value.sessionId) || value?.authority !== "shadow") {
      throw new NativeHostError("native host returned an invalid core session", "NATIVE_PROTOCOL_INVALID");
    }
    this.sessions.set(value.sessionId, {
      ownerId,
      slot: request.slot,
      ownerEpoch: 1,
      state: "owned",
      inFlight: 0,
    });
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
      ownerEpoch: 1,
      state: "owned",
      inFlight: 0,
    });
    return value;
  }

  status(ownerId, sessionId) {
    return this.requestOwned(ownerId, sessionId, { operation: "coreStatus", sessionId });
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
    return this.requestOwned(ownerId, request.sessionId, {
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
    return this.requestOwned(ownerId, request.sessionId, {
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
    return this.requestOwned(ownerId, request.sessionId, {
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
    return this.requestOwned(ownerId, request.sessionId, {
      operation: "coreFactoryReadModelProjection",
      sessionId: request.sessionId,
      selectedEntityIds,
      selectedBeltIds,
    });
  }

  factoryInventoryProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    exactObjectKeys(request, [
      "sessionId", "expectedRevision", "cursor", "limit",
    ], "native factory inventory projection request");
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !Number.isSafeInteger(request.cursor) || request.cursor < 0 ||
      !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 256) {
      throw new TypeError("native factory inventory projection request is invalid");
    }
    return this.requestOwned(ownerId, request.sessionId, {
      operation: "coreFactoryInventoryProjection",
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      cursor: request.cursor,
      limit: request.limit,
    });
  }

  constructionInventoryProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    exactObjectKeys(request, [
      "sessionId", "expectedRevision", "expectedRegistryFingerprint", "cursor", "limit",
    ], "native construction inventory projection request");
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !validLogicalId(request.expectedRegistryFingerprint, 256) ||
      !Number.isSafeInteger(request.cursor) || request.cursor < 0 ||
      !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 256) {
      throw new TypeError("native construction inventory projection request is invalid");
    }
    return this.requestOwned(ownerId, request.sessionId, {
      operation: "coreConstructionInventoryProjection",
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      expectedRegistryFingerprint: request.expectedRegistryFingerprint,
      cursor: request.cursor,
      limit: request.limit,
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
    return this.requestOwned(ownerId, request.sessionId, {
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

  technologyProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (!Number.isSafeInteger(request?.expectedRevision) || request.expectedRevision < 0) {
      throw new TypeError("native core technology projection request is invalid");
    }
    return this.requestOwned(ownerId, request.sessionId, {
      operation: "coreTechnologyProjection",
      sessionId: request.sessionId,
    });
  }

  recipeWorkspaceProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const itemIds = request?.itemIds ?? [];
    const location = request?.location ?? null;
    const allowedKeys = new Set([
      "sessionId", "expectedRevision", "expectedRegistryFingerprint", "itemIds",
      "selectedItemId", "location",
    ]);
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      Reflect.ownKeys(request).some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !validLogicalId(request.expectedRegistryFingerprint, 256) ||
      !Array.isArray(itemIds) || itemIds.length > 256 || new Set(itemIds).size !== itemIds.length ||
      itemIds.some((itemId) => !validOpaqueId(itemId)) || !validOpaqueId(request.selectedItemId) ||
      location !== null && location !== undefined && (
        !location || typeof location !== "object" || Array.isArray(location) ||
        Reflect.ownKeys(location).some((key) => !["planetId", "cursor", "limit"].includes(key)) ||
        !validOpaqueId(location.planetId) || !Number.isSafeInteger(location.cursor) || location.cursor < 0 ||
        !Number.isSafeInteger(location.limit) || location.limit < 1 || location.limit > 4096
      )) {
      throw new TypeError("native recipe workspace projection request is invalid");
    }
    return this.requestOwned(ownerId, request.sessionId, {
      operation: "coreRecipeWorkspaceProjection",
      sessionId: request.sessionId,
      expectedRegistryFingerprint: request.expectedRegistryFingerprint,
      itemIds,
      selectedItemId: request.selectedItemId,
      ...(location ? {
        locationPlanetId: location.planetId,
        locationCursor: location.cursor,
        locationLimit: location.limit,
      } : {}),
    });
  }

  starMapOverviewProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const allowedKeys = new Set([
      "sessionId", "expectedRevision", "expectedRegistryFingerprint", "cursor", "limit",
    ]);
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      Reflect.ownKeys(request).some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !validLogicalId(request.expectedRegistryFingerprint, 256) ||
      !Number.isSafeInteger(request.cursor) || request.cursor < 0 || request.cursor > 0xffff_ffff ||
      !Number.isSafeInteger(request.limit) || request.limit < 1 ||
      request.limit > MAX_STELLAR_PROJECTION_PAGE_ROWS) {
      throw new TypeError("native star-map overview projection request is invalid");
    }
    const hostRequest = {
      operation: "coreStarMapOverviewProjection",
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      expectedRegistryFingerprint: request.expectedRegistryFingerprint,
      cursor: request.cursor,
      limit: request.limit,
    };
    if (Buffer.byteLength(JSON.stringify(hostRequest), "utf8") > MAX_STELLAR_PROJECTION_REQUEST_BYTES) {
      throw new RangeError("native star-map overview projection request exceeds the bounded IPC limit");
    }
    return this.requestOwned(ownerId, request.sessionId, hostRequest);
  }

  starMapCatalogProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const allowedKeys = new Set([
      "sessionId", "expectedRevision", "expectedRegistryFingerprint", "systemCursor",
      "systemLimit", "planetCursor", "planetLimit",
    ]);
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      Reflect.ownKeys(request).some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !validLogicalId(request.expectedRegistryFingerprint, 256) ||
      !Number.isSafeInteger(request.systemCursor) || request.systemCursor < 0 ||
      request.systemCursor > 0xffff_ffff ||
      !Number.isSafeInteger(request.systemLimit) || request.systemLimit < 1 ||
      request.systemLimit > MAX_STELLAR_PROJECTION_PAGE_ROWS ||
      !Number.isSafeInteger(request.planetCursor) || request.planetCursor < 0 ||
      request.planetCursor > 0xffff_ffff ||
      !Number.isSafeInteger(request.planetLimit) || request.planetLimit < 1 ||
      request.planetLimit > MAX_STELLAR_PROJECTION_PAGE_ROWS) {
      throw new TypeError("native star-map catalog projection request is invalid");
    }
    const hostRequest = {
      operation: "coreStarMapCatalogProjection",
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      expectedRegistryFingerprint: request.expectedRegistryFingerprint,
      systemCursor: request.systemCursor,
      systemLimit: request.systemLimit,
      planetCursor: request.planetCursor,
      planetLimit: request.planetLimit,
    };
    if (Buffer.byteLength(JSON.stringify(hostRequest), "utf8") > MAX_STELLAR_PROJECTION_REQUEST_BYTES) {
      throw new RangeError("native star-map catalog projection request exceeds the bounded IPC limit");
    }
    return this.requestOwned(ownerId, request.sessionId, hostRequest);
  }

  stellarIndustryProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const allowedKeys = new Set([
      "sessionId", "expectedRevision", "expectedRegistryFingerprint", "systemId", "planetId",
      "planetCursor", "planetLimit", "stationCursor", "stationLimit",
    ]);
    const validOptionalId = (value) => value === null || validOpaqueId(value);
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      Reflect.ownKeys(request).some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !validLogicalId(request.expectedRegistryFingerprint, 256) ||
      !validOptionalId(request.systemId) || !validOptionalId(request.planetId) ||
      !Number.isSafeInteger(request.planetCursor) || request.planetCursor < 0 ||
      request.planetCursor > 0xffff_ffff ||
      !Number.isSafeInteger(request.planetLimit) || request.planetLimit < 1 ||
      request.planetLimit > MAX_STELLAR_PROJECTION_PAGE_ROWS ||
      !Number.isSafeInteger(request.stationCursor) || request.stationCursor < 0 ||
      request.stationCursor > 0xffff_ffff ||
      !Number.isSafeInteger(request.stationLimit) || request.stationLimit < 1 ||
      request.stationLimit > MAX_STELLAR_PROJECTION_PAGE_ROWS) {
      throw new TypeError("native stellar industry projection request is invalid");
    }
    const hostRequest = {
      operation: "coreStellarIndustryProjection",
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      expectedRegistryFingerprint: request.expectedRegistryFingerprint,
      systemId: request.systemId,
      planetId: request.planetId,
      planetCursor: request.planetCursor,
      planetLimit: request.planetLimit,
      stationCursor: request.stationCursor,
      stationLimit: request.stationLimit,
    };
    if (Buffer.byteLength(JSON.stringify(hostRequest), "utf8") > MAX_STELLAR_PROJECTION_REQUEST_BYTES) {
      throw new RangeError("native stellar industry projection request exceeds the bounded IPC limit");
    }
    return this.requestOwned(ownerId, request.sessionId, hostRequest);
  }

  stellarIndustryProjectionV2(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const allowedKeys = new Set([
      "sessionId", "expectedRevision", "expectedRegistryFingerprint", "systemId", "planetId",
      "planetCursor", "planetLimit", "stationCursor", "stationLimit", "routeCursor",
      "routeLimit", "routeFilter", "query",
    ]);
    const validOptionalId = (value) => value === null || validOpaqueId(value);
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      Reflect.ownKeys(request).some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !validLogicalId(request.expectedRegistryFingerprint, 256) ||
      !validOptionalId(request.systemId) || !validOptionalId(request.planetId) ||
      !Number.isSafeInteger(request.planetCursor) || request.planetCursor < 0 ||
      request.planetCursor > 0xffff_ffff ||
      !Number.isSafeInteger(request.planetLimit) || request.planetLimit < 1 ||
      request.planetLimit > MAX_STELLAR_PROJECTION_PAGE_ROWS ||
      !Number.isSafeInteger(request.stationCursor) || request.stationCursor < 0 ||
      request.stationCursor > 0xffff_ffff ||
      !Number.isSafeInteger(request.stationLimit) || request.stationLimit < 1 ||
      request.stationLimit > MAX_STELLAR_PROJECTION_PAGE_ROWS ||
      !Number.isSafeInteger(request.routeCursor) || request.routeCursor < 0 ||
      request.routeCursor > 0xffff_ffff ||
      !Number.isSafeInteger(request.routeLimit) || request.routeLimit < 1 ||
      request.routeLimit > MAX_STELLAR_PROJECTION_PAGE_ROWS ||
      !["all", "remote", "issues"].includes(request.routeFilter) ||
      typeof request.query !== "string" || Buffer.byteLength(request.query, "utf8") > MAX_STELLAR_ROUTE_QUERY_BYTES ||
      /[\u0000-\u001f\u007f]/.test(request.query)) {
      throw new TypeError("native stellar industry v2 projection request is invalid");
    }
    const hostRequest = {
      operation: "coreStellarIndustryProjectionV2",
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      expectedRegistryFingerprint: request.expectedRegistryFingerprint,
      systemId: request.systemId,
      planetId: request.planetId,
      planetCursor: request.planetCursor,
      planetLimit: request.planetLimit,
      stationCursor: request.stationCursor,
      stationLimit: request.stationLimit,
      routeCursor: request.routeCursor,
      routeLimit: request.routeLimit,
      routeFilter: request.routeFilter,
      query: request.query,
    };
    if (Buffer.byteLength(JSON.stringify(hostRequest), "utf8") > MAX_STELLAR_PROJECTION_REQUEST_BYTES) {
      throw new RangeError("native stellar industry v2 projection request exceeds the bounded IPC limit");
    }
    return this.requestOwned(ownerId, request.sessionId, hostRequest);
  }

  stellarQuantumProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const allowedKeys = new Set([
      "sessionId", "expectedRevision", "expectedRegistryFingerprint", "itemCursor", "itemLimit",
      "collectorCursor", "collectorLimit",
    ]);
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      Reflect.ownKeys(request).some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !validLogicalId(request.expectedRegistryFingerprint, 256) ||
      !Number.isSafeInteger(request.itemCursor) || request.itemCursor < 0 ||
      request.itemCursor > 0xffff_ffff ||
      !Number.isSafeInteger(request.itemLimit) || request.itemLimit < 1 ||
      request.itemLimit > MAX_STELLAR_PROJECTION_PAGE_ROWS ||
      !Number.isSafeInteger(request.collectorCursor) || request.collectorCursor < 0 ||
      request.collectorCursor > 0xffff_ffff ||
      !Number.isSafeInteger(request.collectorLimit) || request.collectorLimit < 1 ||
      request.collectorLimit > MAX_STELLAR_PROJECTION_PAGE_ROWS) {
      throw new TypeError("native stellar quantum projection request is invalid");
    }
    const hostRequest = {
      operation: "coreStellarQuantumProjection",
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      expectedRegistryFingerprint: request.expectedRegistryFingerprint,
      itemCursor: request.itemCursor,
      itemLimit: request.itemLimit,
      collectorCursor: request.collectorCursor,
      collectorLimit: request.collectorLimit,
    };
    if (Buffer.byteLength(JSON.stringify(hostRequest), "utf8") > MAX_STELLAR_PROJECTION_REQUEST_BYTES) {
      throw new RangeError("native stellar quantum projection request exceeds the bounded IPC limit");
    }
    return this.requestOwned(ownerId, request.sessionId, hostRequest);
  }

  dysonWorkspaceProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const allowedKeys = new Set([
      "sessionId", "expectedRevision", "expectedRegistryFingerprint", "selectedSystemId",
      "systemCursor", "systemLimit", "layerCursor", "layerLimit", "orbitCursor",
      "orbitLimit", "nodeCursor", "nodeLimit", "frameCursor", "frameLimit",
      "shellCursor", "shellLimit",
    ]);
    const pages = [
      [request?.systemCursor, request?.systemLimit],
      [request?.layerCursor, request?.layerLimit],
      [request?.orbitCursor, request?.orbitLimit],
      [request?.nodeCursor, request?.nodeLimit],
      [request?.frameCursor, request?.frameLimit],
      [request?.shellCursor, request?.shellLimit],
    ];
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      Reflect.ownKeys(request).some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      allowedKeys.size !== Reflect.ownKeys(request).length ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !validLogicalId(request.expectedRegistryFingerprint, 256) ||
      !validDysonWorkspaceId(request.selectedSystemId) ||
      pages.some(([cursor, limit]) => !Number.isSafeInteger(cursor) || cursor < 0 ||
        cursor > 0xffff_ffff || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > MAX_STELLAR_PROJECTION_PAGE_ROWS)) {
      throw new TypeError("native Dyson workspace projection request is invalid");
    }
    const hostRequest = {
      operation: "coreDysonWorkspaceProjection",
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      expectedRegistryFingerprint: request.expectedRegistryFingerprint,
      selectedSystemId: request.selectedSystemId,
      systemCursor: request.systemCursor,
      systemLimit: request.systemLimit,
      layerCursor: request.layerCursor,
      layerLimit: request.layerLimit,
      orbitCursor: request.orbitCursor,
      orbitLimit: request.orbitLimit,
      nodeCursor: request.nodeCursor,
      nodeLimit: request.nodeLimit,
      frameCursor: request.frameCursor,
      frameLimit: request.frameLimit,
      shellCursor: request.shellCursor,
      shellLimit: request.shellLimit,
    };
    if (Buffer.byteLength(JSON.stringify(hostRequest), "utf8") > MAX_STELLAR_PROJECTION_REQUEST_BYTES) {
      throw new RangeError("native Dyson workspace projection request exceeds the bounded IPC limit");
    }
    return this.requestOwned(ownerId, request.sessionId, hostRequest);
  }

  commandPaletteEntitySearchProjection(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    const allowedKeys = new Set([
      "sessionId", "expectedRevision", "expectedRegistryFingerprint", "query", "cursor",
      "limit", "buildingIds", "resourceIds", "planetIds",
    ]);
    const buildingIds = request?.buildingIds ?? [];
    const resourceIds = request?.resourceIds ?? [];
    const planetIds = request?.planetIds ?? [];
    const selectorCount = buildingIds.length + resourceIds.length + planetIds.length;
    const validSelectorIds = (values) => Array.isArray(values) &&
      values.every((id, index) => validLogicalId(id, 160) && (index === 0 || values[index - 1] < id));
    if (!request || typeof request !== "object" || Array.isArray(request) ||
      Reflect.ownKeys(request).some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !validLogicalId(request.expectedRegistryFingerprint, 256) ||
      typeof request.query !== "string" || request.query.length < 2 ||
      Buffer.byteLength(request.query, "utf8") > MAX_COMMAND_PALETTE_QUERY_BYTES ||
      request.query.trim() !== request.query || request.query.toLocaleLowerCase("zh-CN") !== request.query ||
      /[\u0000-\u001f\u007f]/.test(request.query) ||
      !Number.isSafeInteger(request.cursor) || request.cursor < 0 ||
      !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > MAX_COMMAND_PALETTE_ROWS ||
      selectorCount > MAX_COMMAND_PALETTE_SELECTOR_IDS ||
      !validSelectorIds(buildingIds) || !validSelectorIds(resourceIds) || !validSelectorIds(planetIds)) {
      throw new TypeError("native command palette entity-search request is invalid");
    }
    const hostRequest = {
      operation: "coreCommandPaletteEntitySearchProjection",
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      expectedRegistryFingerprint: request.expectedRegistryFingerprint,
      query: request.query,
      cursor: request.cursor,
      limit: request.limit,
      buildingIds,
      resourceIds,
      planetIds,
    };
    if (Buffer.byteLength(JSON.stringify(hostRequest), "utf8") > MAX_COMMAND_PALETTE_SEARCH_REQUEST_BYTES) {
      throw new RangeError("native command palette entity-search request exceeds the bounded IPC limit");
    }
    return this.requestOwned(ownerId, request.sessionId, hostRequest);
  }

  applyCommand(ownerId, sessionId, command) {
    this.assertOwner(ownerId, sessionId);
    return this.requestOwned(ownerId, sessionId, {
      operation: "coreApplyCommand",
      sessionId,
      command: normalizeNativeCoreCommand(command),
    });
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
    return this.requestOwned(ownerId, request.sessionId, {
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
    return this.requestOwned(ownerId, request.sessionId, {
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
    return this.requestOwned(ownerId, request.sessionId, {
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
    return this.requestOwned(ownerId, request.sessionId, {
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
    return this.requestOwned(ownerId, request.sessionId, {
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
    return this.requestOwned(ownerId, request.sessionId, {
      operation: "coreCommitPlayerAuthorityTick",
      sessionId: request.sessionId,
      request: {
        runId: request.runId,
        sequence: request.sequence,
      },
    }, 300_000);
  }

  commitPlayerAuthorityCommand(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (ownerId !== MAIN_PLAYER_AUTHORITY_OWNER_ID) {
      throw new NativeHostError(
        "durable player-authority commands require the main authority owner",
        "NATIVE_CORE_PLAYER_AUTHORITY_OWNER_REQUIRED",
      );
    }
    if (!this.client.hello?.capabilities?.includes(NATIVE_PLAYER_AUTHORITY_COMMAND_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide durable player-authority commands",
        "NATIVE_CORE_PLAYER_AUTHORITY_COMMAND_UNAVAILABLE",
      );
    }
    exactObjectKeys(request, [
      "sessionId", "runId", "commandId", "baseRevision", "command",
    ], "native player-authority command request");
    if (!validLogicalId(request.runId, 128) || !validLogicalId(request.commandId, 128) ||
      !Number.isSafeInteger(request.baseRevision) || request.baseRevision < 0) {
      throw new TypeError("native player-authority command request is invalid");
    }
    const command = normalizeDurablePlayerAuthorityCommand(request.command);
    if (command.baseRevision !== request.baseRevision) {
      throw new TypeError("native player-authority command revision is invalid");
    }
    return this.requestOwned(ownerId, request.sessionId, {
      operation: "coreCommitPlayerAuthorityCommand",
      sessionId: request.sessionId,
      request: {
        runId: request.runId,
        commandId: request.commandId,
        baseRevision: request.baseRevision,
        command,
      },
    }, 300_000);
  }

  recoverPlayerAuthorityCommand(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (ownerId !== MAIN_PLAYER_AUTHORITY_OWNER_ID) {
      throw new NativeHostError(
        "player-authority recovery requires the main authority owner",
        "NATIVE_CORE_PLAYER_AUTHORITY_OWNER_REQUIRED",
      );
    }
    if (!this.client.hello?.capabilities?.includes(NATIVE_PLAYER_AUTHORITY_COMMAND_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide durable player-authority commands",
        "NATIVE_CORE_PLAYER_AUTHORITY_COMMAND_UNAVAILABLE",
      );
    }
    exactObjectKeys(request, ["sessionId"], "native player-authority command recovery request");
    return this.requestOwned(ownerId, request.sessionId, {
      operation: "coreRecoverPlayerAuthorityCommand",
      sessionId: request.sessionId,
    }, 300_000);
  }

  commitPlayerAuthorityMacroAdvance(ownerId, request) {
    const session = this.assertOwner(ownerId, request?.sessionId);
    if (ownerId !== MAIN_PLAYER_AUTHORITY_OWNER_ID || session.slot !== "normal-main") {
      throw new NativeHostError(
        "player-authority macro advances require the main authority owner",
        "NATIVE_CORE_PLAYER_AUTHORITY_OWNER_REQUIRED",
      );
    }
    if (!this.client.hello?.capabilities?.includes(NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide durable player-authority macro advances",
        "NATIVE_CORE_PLAYER_AUTHORITY_MACRO_ADVANCE_UNAVAILABLE",
      );
    }
    exactObjectKeys(request, [
      "sessionId", "runId", "macroSessionId", "operationId", "baseRevision",
      "simulationMilliseconds", "wallMilliseconds",
    ], "native player-authority macro advance request");
    if (!validLogicalId(request.runId, 128) || !validLogicalId(request.macroSessionId, 128) ||
      !validLogicalId(request.operationId, 128) ||
      !Number.isSafeInteger(request.baseRevision) || request.baseRevision < 0 ||
      !Number.isSafeInteger(request.simulationMilliseconds) || request.simulationMilliseconds < 1 ||
      request.simulationMilliseconds > MAX_PLAYER_AUTHORITY_MACRO_BUDGET_MILLISECONDS ||
      !Number.isSafeInteger(request.wallMilliseconds) || request.wallMilliseconds < 1 ||
      request.wallMilliseconds > MAX_PLAYER_AUTHORITY_MACRO_BUDGET_MILLISECONDS) {
      throw new TypeError("native player-authority macro advance request is invalid");
    }
    return this.requestOwned(ownerId, request.sessionId, {
      operation: "coreCommitPlayerAuthorityMacroAdvance",
      sessionId: request.sessionId,
      request: {
        runId: request.runId,
        macroSessionId: request.macroSessionId,
        operationId: request.operationId,
        baseRevision: request.baseRevision,
        simulationMilliseconds: request.simulationMilliseconds,
        wallMilliseconds: request.wallMilliseconds,
      },
    }, 300_000);
  }

  finishPlayerAuthorityMacroSession(ownerId, request) {
    const session = this.assertOwner(ownerId, request?.sessionId);
    if (ownerId !== MAIN_PLAYER_AUTHORITY_OWNER_ID || session.slot !== "normal-main") {
      throw new NativeHostError(
        "player-authority macro finish requires the main authority owner",
        "NATIVE_CORE_PLAYER_AUTHORITY_OWNER_REQUIRED",
      );
    }
    if (!this.client.hello?.capabilities?.includes(NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide durable player-authority macro advances",
        "NATIVE_CORE_PLAYER_AUTHORITY_MACRO_ADVANCE_UNAVAILABLE",
      );
    }
    exactObjectKeys(request, [
      "sessionId", "runId", "macroSessionId",
    ], "native player-authority macro finish request");
    if (!validLogicalId(request.runId, 128) || !validLogicalId(request.macroSessionId, 128)) {
      throw new TypeError("native player-authority macro finish request is invalid");
    }
    return this.requestOwned(ownerId, request.sessionId, {
      operation: "coreFinishPlayerAuthorityMacroSession",
      sessionId: request.sessionId,
      request: {
        runId: request.runId,
        macroSessionId: request.macroSessionId,
      },
    }, 300_000);
  }

  recoverPlayerAuthorityMacroAdvance(ownerId, request) {
    const session = this.assertOwner(ownerId, request?.sessionId);
    if (ownerId !== MAIN_PLAYER_AUTHORITY_OWNER_ID || session.slot !== "normal-main") {
      throw new NativeHostError(
        "player-authority macro recovery requires the main authority owner",
        "NATIVE_CORE_PLAYER_AUTHORITY_OWNER_REQUIRED",
      );
    }
    if (!this.client.hello?.capabilities?.includes(NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY)) {
      throw new NativeHostError(
        "native host does not provide durable player-authority macro advances",
        "NATIVE_CORE_PLAYER_AUTHORITY_MACRO_ADVANCE_UNAVAILABLE",
      );
    }
    exactObjectKeys(request, ["sessionId"], "native player-authority macro recovery request");
    return this.requestOwned(ownerId, request.sessionId, {
      operation: "coreRecoverPlayerAuthorityMacroAdvance",
      sessionId: request.sessionId,
    }, 300_000);
  }

  checkpoint(ownerId, request) {
    this.assertOwner(ownerId, request?.sessionId);
    if (!Number.isSafeInteger(request?.savedAtMs) || request.savedAtMs < 0) {
      throw new TypeError("native core checkpoint timestamp is invalid");
    }
    return this.requestOwned(ownerId, request.sessionId, {
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
    return this.requestOwned(ownerId, request.sessionId, {
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
    return this.requestOwned(ownerId, request.sessionId, {
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
    return this.requestOwned(ownerId, request.sessionId, {
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
    return this.requestOwned(ownerId, request.sessionId, {
      operation: "coreCompare",
      sessionId: request.sessionId,
      revision: request.revision,
      canonicalSha256: request.canonicalSha256,
      domainSha256: request.domainSha256,
    });
  }

  inspectSession(ownerId, sessionId) {
    const session = this.assertOwner(ownerId, sessionId);
    return Object.freeze({
      kind: "native-core-session-owner-state-v1",
      sessionId,
      ownerId: session.ownerId,
      slot: session.slot,
      ownerEpoch: session.ownerEpoch,
      state: session.state,
      inFlight: session.inFlight,
    });
  }

  transferOwner(ownerId, nextOwnerId, request) {
    exactObjectKeys(request, [
      "sessionId", "expectedSlot", "expectedOwnerEpoch",
    ], "native core session owner transfer request");
    const session = this.assertOwner(ownerId, request.sessionId);
    if ((!validLogicalId(nextOwnerId, 128) &&
        !(Number.isSafeInteger(nextOwnerId) && nextOwnerId >= 1)) || nextOwnerId === ownerId ||
      !validLogicalId(request.expectedSlot, 64) || session.slot !== request.expectedSlot ||
      !Number.isSafeInteger(request.expectedOwnerEpoch) || request.expectedOwnerEpoch < 1 ||
      session.ownerEpoch !== request.expectedOwnerEpoch) {
      throw new NativeHostError(
        "native core session owner transfer identity is invalid",
        "NATIVE_CORE_SESSION_TRANSFER_INVALID",
      );
    }
    if (session.state !== "owned" || session.inFlight !== 0) {
      throw new NativeHostError(
        "native core session has in-flight work and cannot transfer owners",
        "NATIVE_CORE_SESSION_BUSY",
      );
    }
    if (!Number.isSafeInteger(session.ownerEpoch + 1)) {
      throw new NativeHostError(
        "native core session owner epoch is exhausted",
        "NATIVE_CORE_SESSION_TRANSFER_INVALID",
      );
    }

    // No await or host call is allowed between the zero-in-flight check and
    // the owner/epoch write.  In the main-process event loop this makes the
    // handoff atomic with requestOwned's synchronous in-flight increment.
    session.state = "transferring";
    const previousOwnerEpoch = session.ownerEpoch;
    session.ownerId = nextOwnerId;
    session.ownerEpoch += 1;
    session.state = "owned";
    return Object.freeze({
      kind: "native-core-session-owner-transfer-v1",
      sessionId: request.sessionId,
      previousOwnerId: ownerId,
      ownerId: nextOwnerId,
      slot: session.slot,
      previousOwnerEpoch,
      ownerEpoch: session.ownerEpoch,
      inFlight: session.inFlight,
    });
  }

  requestOwned(ownerId, sessionId, request, timeoutMs) {
    const session = this.assertOwner(ownerId, sessionId);
    if (!request || typeof request !== "object" || Array.isArray(request) || request.sessionId !== sessionId) {
      throw new TypeError("native core owner request session is invalid");
    }
    if (session.state !== "owned" || !Number.isSafeInteger(session.inFlight) || session.inFlight < 0 ||
      session.inFlight === Number.MAX_SAFE_INTEGER) {
      throw new NativeHostError(
        "native core session is not accepting owner operations",
        "NATIVE_CORE_SESSION_BUSY",
      );
    }
    session.inFlight += 1;
    let operation;
    try {
      operation = this.client.request(request, timeoutMs);
    } catch (error) {
      session.inFlight -= 1;
      throw error;
    }
    return Promise.resolve(operation).finally(() => {
      session.inFlight -= 1;
    });
  }

  async close(ownerId, sessionId) {
    const session = this.assertOwner(ownerId, sessionId);
    if (session.state !== "owned" || session.inFlight !== 0) {
      throw new NativeHostError(
        "native core session has in-flight work and cannot close",
        "NATIVE_CORE_SESSION_BUSY",
      );
    }
    session.state = "closing";
    this.sessions.delete(sessionId);
    return this.client.request({ operation: "coreClose", sessionId });
  }

  async closeOwner(ownerId) {
    const owned = [...this.sessions.entries()].filter(([, session]) => session.ownerId === ownerId);
    // Window destruction is a forced teardown, not a handoff proof.  Remove
    // ownership synchronously even when host requests are still in flight so
    // a concurrent coordinator must fail closed instead of transferring a
    // session whose renderer disappeared.
    for (const [sessionId, session] of owned) {
      session.state = "closing";
      this.sessions.delete(sessionId);
    }
    await Promise.allSettled(owned.map(([sessionId]) => this.client.request({ operation: "coreClose", sessionId })));
  }

  assertOwner(ownerId, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!validLogicalId(sessionId, 128) || session?.ownerId !== ownerId) {
      throw new NativeHostError("native core session is not owned by this caller", "NATIVE_CORE_SESSION_INVALID");
    }
    return session;
  }
}

module.exports = {
  CONTROL_REQUEST_KIND,
  CONTROL_RESPONSE_KIND,
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_PROTOCOL_VERSION,
  MAX_FRAME_PAYLOAD_BYTES,
  MAX_COMMAND_PALETTE_SEARCH_REQUEST_BYTES,
  MAX_NATIVE_PROJECTION_TRANSFER_BYTES,
  NATIVE_FACTORY_INVENTORY_CAPABILITY,
  NATIVE_CONSTRUCTION_INVENTORY_CAPABILITY,
  NATIVE_EXACT_REALTIME_LEASE_CAPABILITY,
  NATIVE_EXACT_REALTIME_WRITER_FENCE_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_GATE_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_COMMAND_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY,
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
