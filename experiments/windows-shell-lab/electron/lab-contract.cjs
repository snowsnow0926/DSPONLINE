const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const METRICS_SCHEMA_VERSION = 1;
const METRICS_KIND = "dsp-windows-shell-lab";
const DEFAULT_DURATION_MS = 15_000;
const DEFAULT_INSTANCE_COUNT = 10_000;
const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 600_000;
const MIN_INSTANCE_COUNT = 100;
const MAX_INSTANCE_COUNT = 100_000;

function optionValue(argumentsList, name) {
  const prefix = `--${name}=`;
  const values = argumentsList.filter((argument) => argument.startsWith(prefix));
  if (values.length > 1) throw new Error(`duplicate --${name} option`);
  return values.length === 1 ? values[0].slice(prefix.length) : undefined;
}

function integerOption(argumentsList, name, fallback, minimum, maximum) {
  const raw = optionValue(argumentsList, name);
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`--${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function pathIsInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveLabOptions(
  argumentsList,
  {
    temporaryDirectory = os.tmpdir(),
    createRunId = () => crypto.randomUUID().replaceAll("-", ""),
  } = {},
) {
  if (!Array.isArray(argumentsList)) throw new TypeError("lab arguments must be an array");
  const resolvedTemporaryDirectory = path.resolve(temporaryDirectory);
  const requestedUserData = optionValue(argumentsList, "lab-user-data-dir");
  const userDataDirectory = path.resolve(
    requestedUserData || path.join(resolvedTemporaryDirectory, `dsp-shell-lab-electron-${process.pid}-${createRunId()}`),
  );
  const temporaryRelativePath = path.relative(resolvedTemporaryDirectory, userDataDirectory);
  const isDirectChild = pathIsInside(resolvedTemporaryDirectory, userDataDirectory) &&
    !temporaryRelativePath.includes(path.sep);
  const hasDedicatedName = path.basename(userDataDirectory).startsWith("dsp-shell-lab-electron-");
  if (!isDirectChild || !hasDedicatedName) {
    throw new Error("shell lab userData must be a dedicated direct child of the operating-system temporary directory");
  }
  return Object.freeze({
    schemaVersion: METRICS_SCHEMA_VERSION,
    durationMs: integerOption(argumentsList, "lab-duration-ms", DEFAULT_DURATION_MS, MIN_DURATION_MS, MAX_DURATION_MS),
    instanceCount: integerOption(
      argumentsList,
      "lab-instance-count",
      DEFAULT_INSTANCE_COUNT,
      MIN_INSTANCE_COUNT,
      MAX_INSTANCE_COUNT,
    ),
    userDataDirectory,
    metricsPath: path.join(userDataDirectory, "renderer-metrics.json"),
    autoExit: argumentsList.includes("--lab-auto-exit"),
    nativeHostEnabled: !argumentsList.includes("--lab-disable-native-host"),
    fixtureId: "deterministic-canvas-v1",
    fixtureSeed: 0x5eed1234,
  });
}

function finiteNumber(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function integer(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TypeError(`${label} is invalid`);
  return value;
}

function latencySummary(value, label) {
  if (!value || typeof value !== "object") throw new TypeError(`${label} is invalid`);
  const sampleCount = integer(value.sampleCount, `${label}.sampleCount`, 10_000_000);
  if (sampleCount === 0) {
    for (const key of ["p50", "p95", "p99", "max"]) {
      if (value[key] !== null) throw new TypeError(`${label}.${key} must be null without samples`);
    }
    return { sampleCount, p50: null, p95: null, p99: null, max: null };
  }
  return {
    sampleCount,
    p50: finiteNumber(value.p50, `${label}.p50`, { maximum: 60_000 }),
    p95: finiteNumber(value.p95, `${label}.p95`, { maximum: 60_000 }),
    p99: finiteNumber(value.p99, `${label}.p99`, { maximum: 60_000 }),
    max: finiteNumber(value.max, `${label}.max`, { maximum: 60_000 }),
  };
}

function validateRendererMetrics(value, options) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("renderer metrics are invalid");
  if (value.schemaVersion !== METRICS_SCHEMA_VERSION) throw new TypeError("renderer metrics schema is unsupported");
  if (value.fixtureId !== options.fixtureId || value.fixtureSeed !== options.fixtureSeed ||
    value.instanceCount !== options.instanceCount || value.beltCount !== options.instanceCount) {
    throw new TypeError("renderer fixture identity does not match the requested lab run");
  }
  const viewport = value.viewport;
  if (!viewport || typeof viewport !== "object") throw new TypeError("renderer viewport is invalid");
  const javascriptHeap = value.javascriptHeap;
  const normalizedHeap = javascriptHeap === null
    ? null
    : {
        usedBytes: integer(javascriptHeap?.usedBytes, "javascriptHeap.usedBytes"),
        totalBytes: integer(javascriptHeap?.totalBytes, "javascriptHeap.totalBytes"),
        limitBytes: integer(javascriptHeap?.limitBytes, "javascriptHeap.limitBytes"),
      };
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    fixtureId: value.fixtureId,
    fixtureSeed: integer(value.fixtureSeed, "fixtureSeed", 0xffffffff),
    instanceCount: integer(value.instanceCount, "instanceCount", MAX_INSTANCE_COUNT),
    beltCount: integer(value.beltCount, "beltCount", MAX_INSTANCE_COUNT * 2),
    durationMs: finiteNumber(value.durationMs, "durationMs", {
      minimum: options.durationMs,
      maximum: options.durationMs + 30_000,
    }),
    frameCount: integer(value.frameCount, "frameCount", 10_000_000),
    firstFrameMs: finiteNumber(value.firstFrameMs, "firstFrameMs", { maximum: 120_000 }),
    frameIntervalMs: latencySummary(value.frameIntervalMs, "frameIntervalMs"),
    drawDurationMs: latencySummary(value.drawDurationMs, "drawDurationMs"),
    inputLatencyMs: latencySummary(value.inputLatencyMs, "inputLatencyMs"),
    longFramesOver16_7Ms: integer(value.longFramesOver16_7Ms, "longFramesOver16_7Ms", 10_000_000),
    longFramesOver33_3Ms: integer(value.longFramesOver33_3Ms, "longFramesOver33_3Ms", 10_000_000),
    longFramesOver50Ms: integer(value.longFramesOver50Ms, "longFramesOver50Ms", 10_000_000),
    longTaskCount: integer(value.longTaskCount, "longTaskCount", 10_000_000),
    longTaskDurationMs: finiteNumber(value.longTaskDurationMs, "longTaskDurationMs", { maximum: MAX_DURATION_MS * 10 }),
    hiddenFrameCount: integer(value.hiddenFrameCount, "hiddenFrameCount", 10_000_000),
    viewport: {
      width: integer(viewport.width, "viewport.width", 32_768),
      height: integer(viewport.height, "viewport.height", 32_768),
      deviceScaleFactor: finiteNumber(viewport.deviceScaleFactor, "viewport.deviceScaleFactor", { minimum: 0.25, maximum: 8 }),
    },
    javascriptHeap: normalizedHeap,
  };
}

function roundedMilliseconds(value) {
  return Math.round(finiteNumber(value, "timing", { maximum: 3_600_000 }) * 1_000) / 1_000;
}

function buildMetricsEnvelope({ rendererMetrics, options, nativeHost, timings, runtime, capturedAt = new Date() }) {
  const renderer = validateRendererMetrics(rendererMetrics, options);
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    kind: METRICS_KIND,
    shell: "electron",
    status: "renderer-complete",
    capturedAtUtc: capturedAt.toISOString(),
    configuration: {
      durationMs: options.durationMs,
      instanceCount: options.instanceCount,
      fixtureId: options.fixtureId,
      fixtureSeed: options.fixtureSeed,
      nativeHostEnabled: options.nativeHostEnabled,
      cloudEnabled: false,
      updatesEnabled: false,
    },
    runtime: {
      electron: String(runtime.electron),
      chrome: String(runtime.chrome),
      node: String(runtime.node),
      platform: String(runtime.platform),
      architecture: String(runtime.architecture),
    },
    nativeHost: {
      available: nativeHost.available === true,
      state: String(nativeHost.state),
      protocolVersion: Number.isSafeInteger(nativeHost.protocolVersion) ? nativeHost.protocolVersion : null,
      nativeFormatVersion: Number.isSafeInteger(nativeHost.nativeFormatVersion) ? nativeHost.nativeFormatVersion : null,
      hostVersion: typeof nativeHost.hostVersion === "string" ? nativeHost.hostVersion : null,
      capabilities: Array.isArray(nativeHost.capabilities)
        ? nativeHost.capabilities.filter((entry) => typeof entry === "string").slice(0, 64)
        : [],
    },
    timings: {
      appReadyMs: roundedMilliseconds(timings.appReadyMs),
      nativeHostReadyMs: roundedMilliseconds(timings.nativeHostReadyMs),
      windowCreatedMs: roundedMilliseconds(timings.windowCreatedMs),
      rendererLoadedMs: roundedMilliseconds(timings.rendererLoadedMs),
      windowShownMs: roundedMilliseconds(timings.windowShownMs),
    },
    renderer,
  };
}

module.exports = {
  DEFAULT_DURATION_MS,
  DEFAULT_INSTANCE_COUNT,
  MAX_DURATION_MS,
  MAX_INSTANCE_COUNT,
  METRICS_KIND,
  METRICS_SCHEMA_VERSION,
  buildMetricsEnvelope,
  pathIsInside,
  resolveLabOptions,
  validateRendererMetrics,
};
