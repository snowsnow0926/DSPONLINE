const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  METRICS_KIND,
  buildMetricsEnvelope,
  pathIsInside,
  resolveLabOptions,
  validateRendererMetrics,
} = require("../electron/lab-contract.cjs");

function rendererFixture(options) {
  return {
    schemaVersion: 1,
    fixtureId: options.fixtureId,
    fixtureSeed: options.fixtureSeed,
    instanceCount: options.instanceCount,
    beltCount: options.instanceCount,
    durationMs: options.durationMs,
    frameCount: 120,
    firstFrameMs: 12.5,
    frameIntervalMs: { sampleCount: 119, p50: 16, p95: 18, p99: 21, max: 24 },
    drawDurationMs: { sampleCount: 120, p50: 4, p95: 6, p99: 8, max: 9 },
    inputLatencyMs: { sampleCount: 0, p50: null, p95: null, p99: null, max: null },
    longFramesOver16_7Ms: 4,
    longFramesOver33_3Ms: 0,
    longFramesOver50Ms: 0,
    longTaskCount: 0,
    longTaskDurationMs: 0,
    hiddenFrameCount: 0,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1.25 },
    javascriptHeap: { usedBytes: 1_000, totalBytes: 2_000, limitBytes: 4_000 },
  };
}

test("lab options require a dedicated operating-system temp child", () => {
  const temporaryDirectory = path.join(os.tmpdir(), "dsp-shell-contract-temp");
  const requested = path.join(temporaryDirectory, "dsp-shell-lab-electron-run-1");
  const options = resolveLabOptions([
    `--lab-user-data-dir=${requested}`,
    "--lab-duration-ms=2000",
    "--lab-instance-count=10000",
    "--lab-auto-exit",
  ], { temporaryDirectory });
  assert.equal(options.userDataDirectory, path.resolve(requested));
  assert.equal(options.metricsPath, path.join(path.resolve(requested), "renderer-metrics.json"));
  assert.equal(options.autoExit, true);
  assert.equal(options.nativeHostEnabled, true);
  assert.equal(pathIsInside(temporaryDirectory, requested), true);
  assert.throws(
    () => resolveLabOptions([`--lab-user-data-dir=${path.join(temporaryDirectory, "unrelated")}`], { temporaryDirectory }),
    /dedicated direct child/,
  );
  assert.throws(
    () => resolveLabOptions(
      [`--lab-user-data-dir=${path.join(temporaryDirectory, "nested", "dsp-shell-lab-electron-run")}`],
      { temporaryDirectory },
    ),
    /dedicated direct child/,
  );
  assert.throws(
    () => resolveLabOptions([`--lab-user-data-dir=${path.resolve(__dirname, "../../..")}`], { temporaryDirectory }),
    /operating-system temporary directory/,
  );
});

test("lab options reject ambiguous or unbounded measurement requests", () => {
  assert.throws(() => resolveLabOptions(["--lab-duration-ms=999"], { createRunId: () => "run" }), /between 1000/);
  assert.throws(() => resolveLabOptions(["--lab-instance-count=100001"], { createRunId: () => "run" }), /between 100/);
  assert.throws(() => resolveLabOptions([
    "--lab-duration-ms=1000",
    "--lab-duration-ms=2000",
  ], { createRunId: () => "run" }), /duplicate/);
});

test("renderer metrics are identity-bound and cannot inject unbounded fields", () => {
  const options = resolveLabOptions(["--lab-duration-ms=2000"], { createRunId: () => "run" });
  const fixture = rendererFixture(options);
  const normalized = validateRendererMetrics({ ...fixture, ignored: "not retained" }, options);
  assert.equal(normalized.instanceCount, 10_000);
  assert.equal(Object.hasOwn(normalized, "ignored"), false);
  assert.throws(() => validateRendererMetrics({ ...fixture, fixtureId: "other" }, options), /identity/);
  assert.throws(() => validateRendererMetrics({ ...fixture, fixtureSeed: 1 }, options), /identity/);
  assert.throws(() => validateRendererMetrics({ ...fixture, durationMs: options.durationMs - 1 }, options), /durationMs/);
  assert.throws(() => validateRendererMetrics({
    ...fixture,
    frameIntervalMs: { ...fixture.frameIntervalMs, p95: Number.NaN },
  }, options), /frameIntervalMs.p95/);
});

test("metrics envelope keeps cloud, updates, and authority outside the lab", () => {
  const options = resolveLabOptions(["--lab-duration-ms=2000"], { createRunId: () => "run" });
  const envelope = buildMetricsEnvelope({
    rendererMetrics: rendererFixture(options),
    options,
    nativeHost: { available: true, state: "ready", protocolVersion: 1, capabilities: ["native-core-shadow-v1"] },
    timings: { appReadyMs: 1, nativeHostReadyMs: 2, windowCreatedMs: 3, rendererLoadedMs: 4, windowShownMs: 5 },
    runtime: { electron: "43.1.1", chrome: "142", node: "24", platform: "win32", architecture: "x64" },
    capturedAt: new Date("2026-08-27T00:00:00.000Z"),
  });
  assert.equal(envelope.kind, METRICS_KIND);
  assert.equal(envelope.configuration.cloudEnabled, false);
  assert.equal(envelope.configuration.updatesEnabled, false);
  assert.equal(envelope.nativeHost.capabilities[0], "native-core-shadow-v1");
  assert.equal(Object.hasOwn(envelope, "authorityEligible"), false);
});

test("static lab boundary contains no production entry, updater, or remote asset", () => {
  const labRoot = path.resolve(__dirname, "..");
  const main = fs.readFileSync(path.join(labRoot, "electron", "main.cjs"), "utf8");
  const html = fs.readFileSync(path.join(labRoot, "electron", "index.html"), "utf8");
  assert.doesNotMatch(main, /electron-updater|desktop[\\/]main\.cjs|cloud-transport|release-channels/);
  assert.match(main, /app\.setPath\("userData"/);
  assert.match(main, /onBeforeRequest/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("measurement schema identifies all three shells without claiming placeholders completed", () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "metrics.schema.json"), "utf8"));
  assert.deepEqual(schema.properties.shell.enum, ["electron", "tauri", "winui"]);
  assert.equal(schema.properties.processTree.properties.sampleCount.minimum, 0);
  assert.deepEqual(
    schema.properties.processTree.properties.roles.required,
    ["main", "renderer", "gpu", "utility", "native-host", "crashpad", "child"],
  );
  for (const shell of ["tauri", "winui"]) {
    const readme = fs.readFileSync(path.resolve(__dirname, "..", shell, "README.md"), "utf8");
    assert.match(readme, /No-Go/);
    assert.match(readme, /not built/);
  }
});
