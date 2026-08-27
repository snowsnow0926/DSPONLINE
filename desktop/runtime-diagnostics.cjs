"use strict";

const MAX_GPU_DEVICES = 8;
const MAX_PROCESS_METRICS = 64;
const MAX_SCANNED_PROCESS_METRICS = 256;
const MAX_TEXT_LENGTH = 128;
const RUNTIME_DIAGNOSTICS_SCHEMA_VERSION = 1;
const DEFAULT_CACHE_TTL_MS = 5_000;

const GPU_FEATURE_KEYS = Object.freeze([
  "2d_canvas",
  "gpu_compositing",
  "multiple_raster_threads",
  "native_gpu_memory_buffers",
  "rasterization",
  "video_decode",
  "video_encode",
  "vpx_decode",
  "webgl",
  "webgl2",
]);

function finiteInteger(value, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function finiteNumber(value, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, value);
}

function safeText(value, maximumLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return null;
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return withoutControls ? withoutControls.slice(0, maximumLength) : null;
}

function safeVersion(value) {
  const text = safeText(value, 64);
  return text && /^[0-9A-Za-z.+_-]+$/.test(text) ? text : null;
}

function attempt(callback) {
  try {
    return { ok: true, value: callback() };
  } catch {
    return { ok: false, value: null };
  }
}

async function attemptAsync(callback) {
  try {
    return { ok: true, value: await callback() };
  } catch {
    return { ok: false, value: null };
  }
}

function sanitizeGpuFeatureStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const key of GPU_FEATURE_KEYS) {
    const status = safeText(value[key], 64);
    if (status) result[key] = status;
  }
  return result;
}

function safeDeviceIdentifier(value) {
  const number = finiteInteger(value);
  if (number !== null) return number;
  const text = safeText(value, 32);
  return text && /^[0-9A-Za-z_.:-]+$/.test(text) ? text : null;
}

function sanitizeGpuDevices(gpuInfo) {
  const source = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice : [];
  return source.slice(0, MAX_GPU_DEVICES).flatMap((device) => {
    if (!device || typeof device !== "object" || Array.isArray(device)) return [];
    const vendorId = safeDeviceIdentifier(device.vendorId);
    const deviceId = safeDeviceIdentifier(device.deviceId);
    const driverVendor = safeText(device.driverVendor, 64);
    const driverVersion = safeVersion(device.driverVersion);
    const result = {};
    if (typeof device.active === "boolean") result.active = device.active;
    if (vendorId !== null) result.vendorId = vendorId;
    if (deviceId !== null) result.deviceId = deviceId;
    if (driverVendor) result.driverVendor = driverVendor;
    if (driverVersion) result.driverVersion = driverVersion;
    return Object.keys(result).length > 0 ? [result] : [];
  });
}

function sanitizeMemoryKib(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const [sourceKey, destinationKey] of keys) {
    const amount = finiteInteger(value[sourceKey]);
    if (amount !== null) result[destinationKey] = amount;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function safePriority(nodeOs, pid) {
  if (!nodeOs || typeof nodeOs.getPriority !== "function") return null;
  const result = attempt(() => nodeOs.getPriority(pid));
  if (!result.ok || !Number.isInteger(result.value) || result.value < -20 || result.value > 19) return null;
  return result.value;
}

function sanitizeProcessMetric(metric, nodeOs) {
  if (!metric || typeof metric !== "object" || Array.isArray(metric)) return null;
  const pid = finiteInteger(metric.pid, 1);
  if (pid === null) return null;
  const type = safeText(metric.type, 32) || "Unknown";
  const memory = sanitizeMemoryKib(metric.memory, [
    ["workingSetSize", "workingSetKib"],
    ["peakWorkingSetSize", "peakWorkingSetKib"],
    ["privateBytes", "privateBytesKib"],
  ]);
  const cpu = metric.cpu && typeof metric.cpu === "object" && !Array.isArray(metric.cpu)
    ? {
        percent: finiteNumber(metric.cpu.percentCPUUsage) ?? 0,
        idleWakeupsPerSecond: finiteNumber(metric.cpu.idleWakeupsPerSecond) ?? 0,
        cumulativeSeconds: finiteNumber(metric.cpu.cumulativeCPUUsage),
      }
    : null;
  const result = { pid, type, priority: safePriority(nodeOs, pid) };
  const name = safeText(metric.name, 64);
  const serviceName = safeText(metric.serviceName, 64);
  const creationTimeMs = finiteInteger(metric.creationTime);
  if (name) result.name = name;
  if (serviceName) result.serviceName = serviceName;
  if (creationTimeMs !== null) result.creationTimeMs = creationTimeMs;
  if (typeof metric.sandboxed === "boolean") result.sandboxed = metric.sandboxed;
  if (["untrusted", "low", "medium", "high", "unknown"].includes(metric.integrityLevel)) {
    result.integrityLevel = metric.integrityLevel;
  }
  if (memory) result.memoryKib = memory;
  if (cpu) {
    if (cpu.cumulativeSeconds === null) delete cpu.cumulativeSeconds;
    result.cpu = cpu;
  }
  return result;
}

function sanitizeProcessTree(metrics, nodeOs) {
  const source = Array.isArray(metrics) ? metrics : [];
  const scanned = source.slice(0, MAX_SCANNED_PROCESS_METRICS);
  const processes = [];
  const totalsKib = { workingSet: 0, peakWorkingSet: 0, privateBytes: 0 };
  let validProcessCount = 0;
  for (const metric of scanned) {
    const processMetric = sanitizeProcessMetric(metric, nodeOs);
    if (!processMetric) continue;
    validProcessCount += 1;
    totalsKib.workingSet += processMetric.memoryKib?.workingSetKib ?? 0;
    totalsKib.peakWorkingSet += processMetric.memoryKib?.peakWorkingSetKib ?? 0;
    totalsKib.privateBytes += processMetric.memoryKib?.privateBytesKib ?? 0;
    if (processes.length < MAX_PROCESS_METRICS) processes.push(processMetric);
  }
  return {
    scope: "electron-app-metrics",
    reportedProcessCount: finiteInteger(source.length) ?? 0,
    scannedProcessCount: scanned.length,
    validProcessCount,
    includedProcessCount: processes.length,
    truncated: validProcessCount > MAX_PROCESS_METRICS || source.length > MAX_SCANNED_PROCESS_METRICS,
    totalsComplete: source.length <= MAX_SCANNED_PROCESS_METRICS,
    totalsKib,
    processes,
  };
}

function sanitizeNodeMemoryBytes(value) {
  return sanitizeMemoryKib(value, [
    ["rss", "rssBytes"],
    ["heapTotal", "heapTotalBytes"],
    ["heapUsed", "heapUsedBytes"],
    ["external", "externalBytes"],
    ["arrayBuffers", "arrayBuffersBytes"],
  ]);
}

function sanitizeV8HeapBytes(value) {
  return sanitizeMemoryKib(value, [
    ["heap_size_limit", "heapSizeLimitBytes"],
    ["total_heap_size", "totalHeapSizeBytes"],
    ["used_heap_size", "usedHeapSizeBytes"],
    ["external_memory", "externalMemoryBytes"],
  ]);
}

function sanitizeNativeHost(value) {
  const pid = finiteInteger(value?.pid, 1);
  return {
    state: pid === null ? "not-running" : "running",
    ...(pid === null ? {} : { pid }),
    includedInElectronProcessTree: false,
  };
}

async function collectRuntimeDiagnostics({
  app,
  runtimeProcess,
  nodeProcess,
  nodeOs,
  nodeV8,
  runtimePolicy,
  nativeHost,
  sampledAtMs = Date.now(),
}) {
  const gpuFeatureResult = attempt(() => app.getGPUFeatureStatus());
  const processMetricsResult = attempt(() => app.getAppMetrics());
  const systemMemoryResult = attempt(() => runtimeProcess.getSystemMemoryInfo());
  const nodeMemoryResult = attempt(() => nodeProcess.memoryUsage());
  const nodeCpuResult = attempt(() => nodeProcess.cpuUsage());
  const nodeHeapResult = attempt(() => nodeV8.getHeapStatistics());
  const [gpuInfoResult, processMemoryResult] = await Promise.all([
    attemptAsync(() => app.getGPUInfo("basic")),
    attemptAsync(() => runtimeProcess.getProcessMemoryInfo()),
  ]);
  const unavailable = [];
  for (const [name, result] of [
    ["gpuFeatureStatus", gpuFeatureResult],
    ["gpuInfo", gpuInfoResult],
    ["electronProcessMetrics", processMetricsResult],
    ["systemMemory", systemMemoryResult],
    ["mainProcessMemory", processMemoryResult],
    ["nodeMemory", nodeMemoryResult],
    ["nodeCpu", nodeCpuResult],
    ["v8Heap", nodeHeapResult],
  ]) {
    if (!result.ok) unavailable.push(name);
  }
  const nodeMemory = nodeMemoryResult.ok ? sanitizeNodeMemoryBytes(nodeMemoryResult.value) : null;
  const nodeCpu = nodeCpuResult.ok && nodeCpuResult.value && typeof nodeCpuResult.value === "object"
    ? {
        userMicros: finiteInteger(nodeCpuResult.value.user) ?? 0,
        systemMicros: finiteInteger(nodeCpuResult.value.system) ?? 0,
      }
    : null;
  const uptimeSeconds = attempt(() => nodeProcess.uptime());
  const mainPid = finiteInteger(nodeProcess.pid, 1);
  return {
    schemaVersion: RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
    sampledAtMs: finiteInteger(sampledAtMs) ?? 0,
    runtime: {
      platform: safeText(nodeProcess.platform, 16) || "unknown",
      architecture: safeText(nodeProcess.arch, 16) || "unknown",
      electronVersion: safeVersion(nodeProcess.versions?.electron),
      chromeVersion: safeVersion(nodeProcess.versions?.chrome),
      nodeVersion: safeVersion(nodeProcess.versions?.node),
    },
    policy: runtimePolicy,
    gpu: {
      featureStatus: gpuFeatureResult.ok ? sanitizeGpuFeatureStatus(gpuFeatureResult.value) : {},
      devices: gpuInfoResult.ok ? sanitizeGpuDevices(gpuInfoResult.value) : [],
      deviceListTruncated: Array.isArray(gpuInfoResult.value?.gpuDevice) && gpuInfoResult.value.gpuDevice.length > MAX_GPU_DEVICES,
    },
    processTree: processMetricsResult.ok
      ? sanitizeProcessTree(processMetricsResult.value, nodeOs)
      : sanitizeProcessTree([], nodeOs),
    nativeHost: sanitizeNativeHost(nativeHost),
    memory: {
      systemKib: systemMemoryResult.ok ? sanitizeMemoryKib(systemMemoryResult.value, [
        ["total", "totalKib"],
        ["free", "freeKib"],
        ["swapTotal", "swapTotalKib"],
        ["swapFree", "swapFreeKib"],
      ]) : null,
      mainProcessKib: processMemoryResult.ok ? sanitizeMemoryKib(processMemoryResult.value, [
        ["private", "privateKib"],
        ["residentSet", "residentSetKib"],
        ["shared", "sharedKib"],
      ]) : null,
      mainNodeBytes: nodeMemory,
      mainV8Bytes: nodeHeapResult.ok ? sanitizeV8HeapBytes(nodeHeapResult.value) : null,
    },
    mainProcess: {
      ...(mainPid === null ? {} : { pid: mainPid }),
      priority: mainPid === null ? null : safePriority(nodeOs, mainPid),
      uptimeSeconds: uptimeSeconds.ok ? finiteNumber(uptimeSeconds.value) : null,
      cpu: nodeCpu,
    },
    unavailable,
  };
}

class RuntimeDiagnosticsSampler {
  constructor({
    app,
    runtimeProcess,
    nodeProcess,
    nodeOs,
    nodeV8,
    getContext = () => ({}),
    now = Date.now,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  }) {
    this.dependencies = { app, runtimeProcess, nodeProcess, nodeOs, nodeV8 };
    this.getContext = getContext;
    this.now = now;
    this.cacheTtlMs = Math.max(250, Math.min(60_000, finiteInteger(cacheTtlMs) ?? DEFAULT_CACHE_TTL_MS));
    this.cached = null;
    this.cachedAtMs = 0;
    this.inFlight = null;
  }

  sample() {
    const nowMs = finiteInteger(this.now()) ?? Date.now();
    if (this.cached && nowMs - this.cachedAtMs < this.cacheTtlMs) return Promise.resolve(this.cached);
    if (this.inFlight) return this.inFlight;
    const context = attempt(() => this.getContext());
    this.inFlight = collectRuntimeDiagnostics({
      ...this.dependencies,
      ...(context.ok && context.value && typeof context.value === "object" ? context.value : {}),
      sampledAtMs: nowMs,
    }).then((snapshot) => {
      this.cached = snapshot;
      this.cachedAtMs = nowMs;
      return snapshot;
    }).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  clear() {
    this.cached = null;
    this.cachedAtMs = 0;
  }
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  MAX_GPU_DEVICES,
  MAX_PROCESS_METRICS,
  MAX_SCANNED_PROCESS_METRICS,
  RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
  RuntimeDiagnosticsSampler,
  collectRuntimeDiagnostics,
  sanitizeGpuDevices,
  sanitizeGpuFeatureStatus,
  sanitizeProcessTree,
};
