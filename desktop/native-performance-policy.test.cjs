const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_NATIVE_PERFORMANCE_POLICY,
  NATIVE_PERFORMANCE_POLICY_FILE,
  NativePerformancePolicyStore,
  normalizeNativePerformancePolicyDocument,
  normalizeNativePerformancePolicyRequest,
  readNativePerformancePolicy,
  resolveNativePerformancePolicy,
  writeNativePerformancePolicy,
} = require("./native-performance-policy.cjs");

function withTemporaryDirectory(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-policy-test-"));
  return Promise.resolve()
    .then(() => run(root))
    .finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

test("native performance modes map conservatively to Rust-supported thread settings", () => {
  assert.deepEqual(resolveNativePerformancePolicy({ mode: "quiet" }, 32), { mode: "quiet", threadSetting: 1 });
  assert.deepEqual(resolveNativePerformancePolicy({ mode: "balanced" }, 32), { mode: "balanced", threadSetting: "auto" });
  assert.deepEqual(resolveNativePerformancePolicy({ mode: "performance" }, 12), { mode: "performance", threadSetting: 8 });
  assert.deepEqual(resolveNativePerformancePolicy({ mode: "performance" }, 3), { mode: "performance", threadSetting: 2 });
  assert.deepEqual(resolveNativePerformancePolicy({ mode: "custom", customThreads: 8 }, 6), { mode: "custom", threadSetting: 4 });
  assert.deepEqual(resolveNativePerformancePolicy({ mode: "custom", customThreads: "auto" }, 1), { mode: "custom", threadSetting: "auto" });
});

test("native performance policy rejects renderer-controlled environment, paths and unknown fields", () => {
  assert.throws(() => normalizeNativePerformancePolicyRequest({ mode: "performance", PATH: "C:\\attacker" }), /unsupported field/);
  assert.throws(() => normalizeNativePerformancePolicyRequest({ mode: "quiet", customThreads: 8 }), /only valid/);
  assert.throws(() => normalizeNativePerformancePolicyRequest({ mode: "custom", customThreads: 16 }), /thread count/);
  assert.throws(() => normalizeNativePerformancePolicyRequest({ mode: "custom", customThreads: "8" }), /thread count/);
  assert.throws(() => normalizeNativePerformancePolicyDocument({ schemaVersion: 2, mode: "balanced" }), /schema/);
  assert.throws(() => normalizeNativePerformancePolicyDocument({ schemaVersion: 1, mode: "balanced", filePath: "outside" }), /schema/);
  assert.throws(() => normalizeNativePerformancePolicyRequest({ mode: "balanced", padding: "x".repeat(1_024) }), /bounded IPC|unsupported field/);
});

test("missing or damaged policy files fail safely to balanced auto", () => withTemporaryDirectory((root) => {
  assert.deepEqual(readNativePerformancePolicy(root), {
    policy: { ...DEFAULT_NATIVE_PERFORMANCE_POLICY },
    configurationState: "default",
  });

  const filePath = path.join(root, NATIVE_PERFORMANCE_POLICY_FILE);
  fs.writeFileSync(filePath, "{not-json", "utf8");
  assert.deepEqual(readNativePerformancePolicy(root), {
    policy: { ...DEFAULT_NATIVE_PERFORMANCE_POLICY },
    configurationState: "invalid",
  });

  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, mode: "performance", env: { PATH: "outside" } }), "utf8");
  assert.deepEqual(readNativePerformancePolicy(root), {
    policy: { ...DEFAULT_NATIVE_PERFORMANCE_POLICY },
    configurationState: "invalid",
  });
}));

test("policy persistence uses an atomic same-directory replacement and leaves one versioned JSON", () => withTemporaryDirectory((root) => {
  const renameCalls = [];
  const tracedFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") {
        return (source, destination) => {
          renameCalls.push({ source, destination });
          return target.renameSync(source, destination);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  writeNativePerformancePolicy(root, { mode: "performance" }, tracedFileSystem);
  writeNativePerformancePolicy(root, { mode: "custom", customThreads: 4 }, tracedFileSystem);

  const entries = fs.readdirSync(root);
  assert.deepEqual(entries, [NATIVE_PERFORMANCE_POLICY_FILE]);
  assert.equal(renameCalls.length, 2);
  assert.ok(renameCalls.every(({ source, destination }) => path.dirname(source) === root && destination === path.join(root, NATIVE_PERFORMANCE_POLICY_FILE)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, NATIVE_PERFORMANCE_POLICY_FILE), "utf8")), {
    schemaVersion: 1,
    mode: "custom",
    customThreads: 4,
  });
}));

test("runtime policy changes never restart the host and become effective only after app restart", () => withTemporaryDirectory((root) => {
  fs.writeFileSync(path.join(root, NATIVE_PERFORMANCE_POLICY_FILE), JSON.stringify({
    schemaVersion: 1,
    mode: "quiet",
  }), "utf8");
  const store = new NativePerformancePolicyStore({ userDataPath: root, logicalCpuCount: 12 });
  assert.deepEqual(store.initialize(), {
    schemaVersion: 1,
    requestedPolicy: { mode: "quiet" },
    effectivePolicy: { mode: "quiet", threadSetting: 1 },
    logicalCpuCount: 12,
    restartRequired: false,
    configurationState: "loaded",
  });
  assert.deepEqual(store.spawnEnvironment(), { DSP_NATIVE_CORE_THREADS: "1" });

  const saved = store.save({ mode: "performance" });
  assert.deepEqual(saved.requestedPolicy, { mode: "performance" });
  assert.deepEqual(saved.effectivePolicy, { mode: "quiet", threadSetting: 1 });
  assert.equal(saved.restartRequired, true);
  assert.deepEqual(store.spawnEnvironment(), { DSP_NATIVE_CORE_THREADS: "1" });

  const restarted = new NativePerformancePolicyStore({ userDataPath: root, logicalCpuCount: 12 });
  assert.deepEqual(restarted.initialize().effectivePolicy, { mode: "performance", threadSetting: 8 });
  assert.equal(restarted.status().restartRequired, false);
}));
