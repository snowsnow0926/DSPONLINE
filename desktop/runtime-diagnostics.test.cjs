"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_GPU_DEVICES,
  MAX_PROCESS_METRICS,
  RuntimeDiagnosticsSampler,
  collectRuntimeDiagnostics,
} = require("./runtime-diagnostics.cjs");

const runtimePolicy = {
  schemaVersion: 1,
  hardwareAcceleration: {
    mode: "chromium-default",
    experimentalDisableRequested: false,
    configurationState: "default",
  },
  v8Heap: { mode: "chromium-managed", overrideApplied: false },
  processPriority: { mode: "os-default", mutationApplied: false },
  chromiumCommandLine: { highRiskSwitchesApplied: false },
};

function processMetric(pid, overrides = {}) {
  return {
    pid,
    type: "Tab",
    creationTime: 1_725_000_000_000 + pid,
    sandboxed: true,
    integrityLevel: "low",
    name: `Renderer ${pid}`,
    serviceName: "Renderer",
    cpu: { percentCPUUsage: 2.5, idleWakeupsPerSecond: 0, cumulativeCPUUsage: 3.25 },
    memory: { workingSetSize: 100 + pid, peakWorkingSetSize: 200 + pid, privateBytes: 50 + pid },
    commandLine: "--secret-token=must-not-leak",
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const app = {
    getGPUFeatureStatus: () => ({
      gpu_compositing: "enabled",
      rasterization: "enabled_on",
      webgl: "enabled",
      unexpectedSecret: "must-not-leak",
    }),
    getGPUInfo: async (infoType) => {
      assert.equal(infoType, "basic");
      return {
        gpuDevice: [
          {
            active: true,
            vendorId: 4318,
            deviceId: "0x2684",
            driverVendor: "NVIDIA",
            driverVersion: "32.0.15.6094",
            deviceString: "private-device-name",
          },
        ],
        machineModelName: "must-not-leak",
        auxAttributes: { secret: "must-not-leak" },
      };
    },
    getAppMetrics: () => [processMetric(41, { type: "Browser" }), processMetric(42)],
  };
  const runtimeProcess = {
    getSystemMemoryInfo: () => ({ total: 32_000_000, free: 8_000_000, swapTotal: 4_000_000, swapFree: 3_000_000 }),
    getProcessMemoryInfo: async () => ({ private: 120_000, residentSet: 180_000, shared: 20_000 }),
  };
  const nodeProcess = {
    pid: 41,
    platform: "win32",
    arch: "x64",
    versions: { electron: "38.0.0", chrome: "140.0.7339.41", node: "22.18.0", secret: "must-not-leak" },
    memoryUsage: () => ({ rss: 200_000_000, heapTotal: 80_000_000, heapUsed: 60_000_000, external: 10_000, arrayBuffers: 5_000 }),
    cpuUsage: () => ({ user: 700_000, system: 200_000 }),
    uptime: () => 90.5,
    argv: ["--secret-token=must-not-leak"],
    execArgv: ["--js-flags=must-not-leak"],
  };
  const nodeOs = { getPriority: (pid) => pid === 42 ? -1 : 0 };
  const nodeV8 = {
    getHeapStatistics: () => ({
      heap_size_limit: 4_294_967_296,
      total_heap_size: 80_000_000,
      used_heap_size: 60_000_000,
      external_memory: 10_000,
      malloced_memory: 99_999,
    }),
  };
  return { app, runtimeProcess, nodeProcess, nodeOs, nodeV8, ...overrides };
}

test("collects bounded GPU, Electron process-tree, memory, V8 and priority diagnostics without sensitive fields", async () => {
  const snapshot = await collectRuntimeDiagnostics({
    ...dependencies(),
    runtimePolicy,
    nativeHost: { pid: 88, executablePath: "D:/private/dsp-native-host.exe" },
    sampledAtMs: 1_725_000_123_456,
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.sampledAtMs, 1_725_000_123_456);
  assert.deepEqual(snapshot.runtime, {
    platform: "win32",
    architecture: "x64",
    electronVersion: "38.0.0",
    chromeVersion: "140.0.7339.41",
    nodeVersion: "22.18.0",
  });
  assert.equal(snapshot.policy, runtimePolicy);
  assert.deepEqual(snapshot.gpu.featureStatus, {
    gpu_compositing: "enabled",
    rasterization: "enabled_on",
    webgl: "enabled",
  });
  assert.deepEqual(snapshot.gpu.devices, [{
    active: true,
    vendorId: 4318,
    deviceId: "0x2684",
    driverVendor: "NVIDIA",
    driverVersion: "32.0.15.6094",
  }]);
  assert.equal(snapshot.processTree.scope, "electron-app-metrics");
  assert.equal(snapshot.processTree.includedProcessCount, 2);
  assert.equal(snapshot.processTree.processes[1].priority, -1);
  assert.deepEqual(snapshot.processTree.totalsKib, {
    workingSet: 283,
    peakWorkingSet: 483,
    privateBytes: 183,
  });
  assert.deepEqual(snapshot.nativeHost, {
    state: "running",
    pid: 88,
    includedInElectronProcessTree: false,
  });
  assert.equal(snapshot.memory.systemKib.totalKib, 32_000_000);
  assert.equal(snapshot.memory.mainProcessKib.privateKib, 120_000);
  assert.equal(snapshot.memory.mainNodeBytes.heapUsedBytes, 60_000_000);
  assert.equal(snapshot.memory.mainV8Bytes.heapSizeLimitBytes, 4_294_967_296);
  assert.deepEqual(snapshot.mainProcess.cpu, { userMicros: 700_000, systemMicros: 200_000 });
  assert.deepEqual(snapshot.unavailable, []);

  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ["must-not-leak", "commandLine", "machineModelName", "auxAttributes", "argv", "execArgv", "executablePath", "malloced_memory"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("caps process and GPU arrays while retaining explicit coverage limits", async () => {
  const metrics = Array.from({ length: 300 }, (_, index) => processMetric(index + 1, {
    name: `Renderer ${index} ${"x".repeat(200)}`,
  }));
  const devices = Array.from({ length: 12 }, (_, index) => ({ active: index === 0, vendorId: index + 1, deviceId: index + 100 }));
  const base = dependencies();
  const snapshot = await collectRuntimeDiagnostics({
    ...base,
    app: {
      ...base.app,
      getAppMetrics: () => metrics,
      getGPUInfo: async () => ({ gpuDevice: devices }),
    },
    runtimePolicy,
    nativeHost: null,
  });

  assert.equal(snapshot.processTree.reportedProcessCount, 300);
  assert.equal(snapshot.processTree.scannedProcessCount, 256);
  assert.equal(snapshot.processTree.validProcessCount, 256);
  assert.equal(snapshot.processTree.includedProcessCount, MAX_PROCESS_METRICS);
  assert.equal(snapshot.processTree.processes.length, MAX_PROCESS_METRICS);
  assert.equal(snapshot.processTree.truncated, true);
  assert.equal(snapshot.processTree.totalsComplete, false);
  assert.equal(snapshot.processTree.processes[0].name.length <= 64, true);
  assert.equal(snapshot.gpu.devices.length, MAX_GPU_DEVICES);
  assert.equal(snapshot.gpu.deviceListTruncated, true);
});

test("reports stable unavailable codes and never serializes thrown diagnostic details", async () => {
  const secret = "D:/private/save/token-123";
  const fail = () => { throw new Error(secret); };
  const reject = async () => { throw new Error(secret); };
  const snapshot = await collectRuntimeDiagnostics({
    app: { getGPUFeatureStatus: fail, getGPUInfo: reject, getAppMetrics: fail },
    runtimeProcess: { getSystemMemoryInfo: fail, getProcessMemoryInfo: reject },
    nodeProcess: {
      pid: 7,
      platform: "win32",
      arch: "x64",
      versions: {},
      memoryUsage: fail,
      cpuUsage: fail,
      uptime: fail,
    },
    nodeOs: { getPriority: fail },
    nodeV8: { getHeapStatistics: fail },
    runtimePolicy,
    nativeHost: {},
  });

  assert.deepEqual(snapshot.unavailable, [
    "gpuFeatureStatus",
    "gpuInfo",
    "electronProcessMetrics",
    "systemMemory",
    "mainProcessMemory",
    "nodeMemory",
    "nodeCpu",
    "v8Heap",
  ]);
  assert.equal(snapshot.memory.systemKib, null);
  assert.equal(snapshot.memory.mainProcessKib, null);
  assert.equal(snapshot.memory.mainNodeBytes, null);
  assert.equal(snapshot.memory.mainV8Bytes, null);
  assert.equal(snapshot.mainProcess.priority, null);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
});

test("sampler is single-flight and serves a short-lived cached snapshot", async () => {
  let resolveGpu;
  let gpuCalls = 0;
  let now = 10_000;
  const base = dependencies();
  const sampler = new RuntimeDiagnosticsSampler({
    ...base,
    app: {
      ...base.app,
      getGPUInfo: () => {
        gpuCalls += 1;
        return new Promise((resolve) => { resolveGpu = resolve; });
      },
    },
    getContext: () => ({ runtimePolicy, nativeHost: { pid: 88 } }),
    now: () => now,
    cacheTtlMs: 1_000,
  });

  const first = sampler.sample();
  const concurrent = sampler.sample();
  assert.equal(first, concurrent);
  assert.equal(gpuCalls, 1);
  resolveGpu({ gpuDevice: [] });
  const firstSnapshot = await first;
  const cachedSnapshot = await sampler.sample();
  assert.equal(cachedSnapshot, firstSnapshot);
  assert.equal(gpuCalls, 1);

  now += 1_001;
  const refreshed = sampler.sample();
  assert.equal(gpuCalls, 2);
  resolveGpu({ gpuDevice: [] });
  const refreshedSnapshot = await refreshed;
  assert.notEqual(refreshedSnapshot, firstSnapshot);
  assert.equal(refreshedSnapshot.sampledAtMs, now);
});
