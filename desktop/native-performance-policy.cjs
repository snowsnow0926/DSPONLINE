const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const NATIVE_PERFORMANCE_POLICY_SCHEMA_VERSION = 1;
const NATIVE_PERFORMANCE_POLICY_FILE = "native-performance-policy-v1.json";
const MAX_NATIVE_PERFORMANCE_POLICY_BYTES = 512;
const DEFAULT_NATIVE_PERFORMANCE_POLICY = Object.freeze({ mode: "balanced" });
const NATIVE_PERFORMANCE_MODES = new Set(["quiet", "balanced", "performance", "custom"]);
const NATIVE_CORE_THREAD_SETTINGS = new Set(["auto", 1, 2, 4, 8]);
const SUPPORTED_FIXED_THREAD_SETTINGS = [1, 2, 4, 8];

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedJsonBytes(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError("native performance policy must be serializable");
  }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > MAX_NATIVE_PERFORMANCE_POLICY_BYTES) {
    throw new RangeError("native performance policy exceeds the bounded IPC limit");
  }
  return encoded;
}

function normalizeNativePerformancePolicyRequest(value) {
  if (!isPlainRecord(value)) throw new TypeError("native performance policy is invalid");
  boundedJsonBytes(value);
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "mode" && key !== "customThreads")) {
    throw new TypeError("native performance policy contains an unsupported field");
  }
  if (!NATIVE_PERFORMANCE_MODES.has(value.mode)) throw new TypeError("native performance policy mode is invalid");
  if (value.mode === "custom") {
    if (!NATIVE_CORE_THREAD_SETTINGS.has(value.customThreads)) {
      throw new TypeError("native performance custom thread count is invalid");
    }
    return { mode: "custom", customThreads: value.customThreads };
  }
  if (Object.hasOwn(value, "customThreads")) {
    throw new TypeError("native performance custom thread count is only valid for custom mode");
  }
  return { mode: value.mode };
}

function normalizeNativePerformancePolicyDocument(value) {
  if (!isPlainRecord(value)) throw new TypeError("native performance policy document is invalid");
  boundedJsonBytes(value);
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "schemaVersion" && key !== "mode" && key !== "customThreads") ||
    value.schemaVersion !== NATIVE_PERFORMANCE_POLICY_SCHEMA_VERSION) {
    throw new TypeError("native performance policy schema is unsupported");
  }
  return normalizeNativePerformancePolicyRequest({
    mode: value.mode,
    ...(Object.hasOwn(value, "customThreads") ? { customThreads: value.customThreads } : {}),
  });
}

function detectLogicalCpuCount(osModule = os) {
  const cpuCount = (() => {
    try {
      const cpus = osModule.cpus?.();
      return Array.isArray(cpus) && cpus.length > 0 ? cpus.length : null;
    } catch {
      return null;
    }
  })();
  const availableCount = (() => {
    try {
      const value = osModule.availableParallelism?.();
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  })();
  const detected = cpuCount && availableCount ? Math.min(cpuCount, availableCount) : (availableCount ?? cpuCount ?? 1);
  return Math.max(1, Math.min(256, detected));
}

function largestSupportedThreadCount(maximum) {
  let selected = 1;
  for (const candidate of SUPPORTED_FIXED_THREAD_SETTINGS) {
    if (candidate > maximum) break;
    selected = candidate;
  }
  return selected;
}

function resolveNativePerformancePolicy(policy, logicalCpuCount) {
  const normalized = normalizeNativePerformancePolicyRequest(policy);
  const conservativeLogicalCpuCount = Number.isSafeInteger(logicalCpuCount) && logicalCpuCount > 0
    ? Math.min(256, logicalCpuCount)
    : 1;
  let threadSetting;
  if (normalized.mode === "quiet") threadSetting = 1;
  else if (normalized.mode === "balanced") threadSetting = "auto";
  else if (normalized.mode === "performance") threadSetting = largestSupportedThreadCount(conservativeLogicalCpuCount);
  else if (normalized.customThreads === "auto") threadSetting = "auto";
  else threadSetting = largestSupportedThreadCount(Math.min(normalized.customThreads, conservativeLogicalCpuCount));
  return { mode: normalized.mode, threadSetting };
}

function policyDocument(policy) {
  return {
    schemaVersion: NATIVE_PERFORMANCE_POLICY_SCHEMA_VERSION,
    ...normalizeNativePerformancePolicyRequest(policy),
  };
}

function readNativePerformancePolicy(userDataPath, fileSystem = fs) {
  const filePath = path.join(userDataPath, NATIVE_PERFORMANCE_POLICY_FILE);
  try {
    const stats = fileSystem.statSync(filePath);
    if (!stats.isFile() || stats.size < 2 || stats.size > MAX_NATIVE_PERFORMANCE_POLICY_BYTES) {
      throw new TypeError("native performance policy file size is invalid");
    }
    const encoded = fileSystem.readFileSync(filePath, "utf8");
    return {
      policy: normalizeNativePerformancePolicyDocument(JSON.parse(encoded)),
      configurationState: "loaded",
    };
  } catch (error) {
    return {
      policy: { ...DEFAULT_NATIVE_PERFORMANCE_POLICY },
      configurationState: error && error.code === "ENOENT" ? "default" : "invalid",
    };
  }
}

function writeNativePerformancePolicy(userDataPath, policy, fileSystem = fs) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) {
    throw new TypeError("native performance policy root must be absolute");
  }
  const document = policyDocument(policy);
  const encoded = `${JSON.stringify(document)}\n`;
  const filePath = path.join(userDataPath, NATIVE_PERFORMANCE_POLICY_FILE);
  fileSystem.mkdirSync(userDataPath, { recursive: true });
  const nonce = crypto.randomBytes(8).toString("hex");
  const temporaryPath = path.join(userDataPath, `.${NATIVE_PERFORMANCE_POLICY_FILE}.${process.pid}.${nonce}.tmp`);
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(temporaryPath, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, encoded, "utf8");
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = null;
    fileSystem.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== null) {
      try { fileSystem.closeSync(descriptor); } catch { /* best-effort descriptor cleanup */ }
    }
    try { fileSystem.unlinkSync(temporaryPath); } catch { /* best-effort temporary cleanup */ }
    throw error;
  }
  return document;
}

class NativePerformancePolicyStore {
  constructor({ userDataPath, logicalCpuCount = detectLogicalCpuCount(), fileSystem = fs }) {
    if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) {
      throw new TypeError("native performance policy root must be absolute");
    }
    this.userDataPath = userDataPath;
    this.logicalCpuCount = Number.isSafeInteger(logicalCpuCount) && logicalCpuCount > 0
      ? Math.min(256, logicalCpuCount)
      : 1;
    this.fileSystem = fileSystem;
    this.requestedPolicy = { ...DEFAULT_NATIVE_PERFORMANCE_POLICY };
    this.effectivePolicy = resolveNativePerformancePolicy(this.requestedPolicy, this.logicalCpuCount);
    this.configurationState = "default";
    this.initialized = false;
  }

  initialize() {
    if (this.initialized) return this.status();
    const loaded = readNativePerformancePolicy(this.userDataPath, this.fileSystem);
    this.requestedPolicy = loaded.policy;
    this.effectivePolicy = resolveNativePerformancePolicy(loaded.policy, this.logicalCpuCount);
    this.configurationState = loaded.configurationState;
    this.initialized = true;
    return this.status();
  }

  save(request) {
    if (!this.initialized) this.initialize();
    const requestedPolicy = normalizeNativePerformancePolicyRequest(request);
    writeNativePerformancePolicy(this.userDataPath, requestedPolicy, this.fileSystem);
    this.requestedPolicy = requestedPolicy;
    this.configurationState = "saved";
    return this.status();
  }

  spawnEnvironment() {
    if (!this.initialized) this.initialize();
    return { DSP_NATIVE_CORE_THREADS: String(this.effectivePolicy.threadSetting) };
  }

  status() {
    const requestedEffective = resolveNativePerformancePolicy(this.requestedPolicy, this.logicalCpuCount);
    return {
      schemaVersion: NATIVE_PERFORMANCE_POLICY_SCHEMA_VERSION,
      requestedPolicy: { ...this.requestedPolicy },
      effectivePolicy: { ...this.effectivePolicy },
      logicalCpuCount: this.logicalCpuCount,
      restartRequired: requestedEffective.threadSetting !== this.effectivePolicy.threadSetting,
      configurationState: this.configurationState,
    };
  }
}

module.exports = {
  DEFAULT_NATIVE_PERFORMANCE_POLICY,
  MAX_NATIVE_PERFORMANCE_POLICY_BYTES,
  NATIVE_PERFORMANCE_POLICY_FILE,
  NATIVE_PERFORMANCE_POLICY_SCHEMA_VERSION,
  NativePerformancePolicyStore,
  detectLogicalCpuCount,
  normalizeNativePerformancePolicyDocument,
  normalizeNativePerformancePolicyRequest,
  readNativePerformancePolicy,
  resolveNativePerformancePolicy,
  writeNativePerformancePolicy,
};
