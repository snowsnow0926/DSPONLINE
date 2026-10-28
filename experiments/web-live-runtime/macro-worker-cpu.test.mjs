import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createMacroWorkerCpuCapture } from "./macro-worker-cpu.mjs";

const origin = "http://127.0.0.1:4490";
const target = (targetId = "macro") => ({ targetId, type: "worker", url: origin + "/assets/pureIdleMacro.worker-test.js" });
const profile = { nodes: [{ id: 1 }], samples: [1, 1], timeDeltas: [1000, 1000], startTime: 1, endTime: 2001 };

class FakeSession extends EventEmitter {
  calls = [];
  workerCalls = [];
  detached = false;
  sampling = false;
  constructor(options = {}) { super(); this.options = options; }
  async send(method, params = {}) {
    this.calls.push({ method, params });
    if (this.options.failRoot === method) throw Error("root rejected " + method);
    if (method === "Target.getTargets") return { targetInfos: this.options.existing ?? [] };
    if (method === "Target.attachToTarget") return { sessionId: "owned-session" };
    if (method === "Target.sendMessageToTarget") {
      const message = JSON.parse(params.message);
      this.workerCalls.push(message);
      if (this.options.hangWorker === message.method) return {};
      const error = this.options.failWorker === message.method ? { message: "worker rejected " + message.method } : undefined;
      if (!error && message.method === "Profiler.start") this.sampling = true;
      if (!error && ["Profiler.stop", "Profiler.disable"].includes(message.method)) this.sampling = false;
      queueMicrotask(() => this.emit("Target.receivedMessageFromTarget", { sessionId: params.sessionId,
        message: JSON.stringify({ id: message.id, ...(error ? { error } : {
          result: message.method === "Profiler.stop" ? { profile: this.options.profile ?? profile } : {},
        }) }) }));
    }
    return {};
  }
  async detach() { this.detached = true; if (this.options.failDetach) throw Error("root detach rejected"); }
}

async function setup(options = {}) {
  const root = new FakeSession(options);
  const files = new Map();
  let clock = 10;
  const capture = await createMacroWorkerCpuCapture({ browser: { newBrowserCDPSession: async () => root },
    origin, name: "test", output: "unused", readClock: async () => ++clock,
    commandTimeoutMs: 100, captureLimitMs: options.captureLimitMs ?? 3000,
    writeEvidence: async (name, text) => {
      if (options.failWrite && name.endsWith(".cpuprofile")) throw Error("profile write rejected");
      assert(!files.has(name)); files.set(name, JSON.parse(text));
    } });
  return { root, files, capture };
}

test("samples only the new owned macro Worker and preserves the complete profile", async () => {
  const { root, files, capture } = await setup();
  root.emit("Target.targetCreated", { targetInfo: { ...target(), url: "https://example.com/assets/pureIdleMacro.worker-other.js" } });
  root.emit("Target.targetCreated", { targetInfo: { ...target(), url: origin + "/assets/simulation.worker-other.js" } });
  root.emit("Target.targetCreated", { targetInfo: null });
  root.emit("Target.targetCreated", { targetInfo: target() });
  root.emit("Target.targetCreated", { targetInfo: target() });
  const result = await capture.finish();
  assert.equal(result.complete, true);
  assert.equal(result.matchingTargetCount, 1);
  assert.deepEqual(files.get("test-macro-worker.cpuprofile"), profile);
  assert.equal(files.get("test-macro-worker-cpu.json").complete, true);
  assert.deepEqual(root.workerCalls.map(c => c.method), ["Profiler.enable", "Profiler.setSamplingInterval", "Profiler.start", "Profiler.stop", "Profiler.disable"]);
  assert.deepEqual(root.workerCalls[1].params, { interval: 1000 });
  assert.equal(root.sampling, false);
  assert.equal(root.detached, true);
  assert.equal(root.listenerCount("Target.targetCreated"), 0);
  assert.equal(root.listenerCount("Target.receivedMessageFromTarget"), 0);
  assert.equal(await capture.finish(), result);
});

test("rejects an existing macro Worker and detaches without profiling", async () => {
  const root = new FakeSession({ existing: [target()] });
  await assert.rejects(createMacroWorkerCpuCapture({ browser: { newBrowserCDPSession: async () => root }, origin,
    name: "test", output: "unused", readClock: async () => 1 }), /already exists/);
  assert.equal(root.detached, true);
  assert.equal(root.workerCalls.length, 0);
});

for (const method of ["Profiler.enable", "Profiler.start", "Profiler.stop"]) {
  test("rejects a failed " + method + " command and releases all listeners", async () => {
    const { root, capture } = await setup({ failWorker: method });
    root.emit("Target.targetCreated", { targetInfo: target() });
    const result = await capture.finish();
    assert.equal(result.complete, false);
    assert(result.errors.some(error => error.includes("worker rejected")));
    assert.equal(root.detached, true);
    assert.equal(root.sampling, false);
    assert.equal(root.listenerCount("Target.receivedMessageFromTarget"), 0);
  });
}

test("times out a missing Worker response and still detaches", async () => {
  const { root, capture } = await setup({ hangWorker: "Profiler.start" });
  root.emit("Target.targetCreated", { targetInfo: target() });
  const result = await capture.finish();
  assert.equal(result.complete, false);
  assert(result.errors.some(error => /timeout/.test(error)));
  assert.equal(root.detached, true);
});

test("a second matching Worker makes attribution incomplete", async () => {
  const { root, capture } = await setup();
  root.emit("Target.targetCreated", { targetInfo: target() });
  await setImmediate();
  root.emit("Target.targetCreated", { targetInfo: target("replacement") });
  const result = await capture.finish();
  assert.equal(result.complete, false);
  assert.equal(result.matchingTargetCount, 2);
  assert.equal(root.calls.filter(c => c.method === "Target.attachToTarget").length, 1);
  assert.equal(root.detached, true);
});

test("preserves an incomplete raw profile but refuses to qualify it", async () => {
  const incomplete = { ...profile, timeDeltas: [] };
  const { root, files, capture } = await setup({ profile: incomplete });
  root.emit("Target.targetCreated", { targetInfo: target() });
  const result = await capture.finish();
  assert.equal(result.complete, false);
  assert.deepEqual(files.get("test-macro-worker.cpuprofile"), incomplete);
  assert.equal(root.detached, true);
});

test("a failed profile write preserves failure metadata after cleanup", async () => {
  const { root, files, capture } = await setup({ failWrite: true });
  root.emit("Target.targetCreated", { targetInfo: target() });
  const result = await capture.finish();
  assert.equal(result.complete, false);
  assert(result.errors.some(error => error.includes("write rejected")));
  assert.equal(files.get("test-macro-worker-cpu.json").complete, false);
  assert.equal(root.detached, true);
});

test("bounds a missing-target watch and does not leave a capture running", async () => {
  const { root, capture } = await setup({ captureLimitMs: 20 });
  await setTimeout(40);
  const result = await capture.finish();
  assert.equal(result.complete, false);
  assert.equal(result.matchingTargetCount, 0);
  assert.equal(root.detached, true);
});

test("refuses a lost ready boundary even when samples were obtained", async () => {
  const { root, capture } = await setup();
  root.emit("Target.targetCreated", { targetInfo: target() });
  const result = await capture.finish({ readyObserved: false });
  assert.equal(result.complete, false);
  assert.equal(result.samples, 2);
  assert.equal(root.detached, true);
});

test("a detach failure keeps the diagnostic incomplete", async () => {
  const { root, capture } = await setup({ failDetach: true });
  root.emit("Target.targetCreated", { targetInfo: target() });
  assert.equal((await capture.finish()).complete, false);
});

test("bounds browser-session creation and rejects failed discovery", async () => {
  await assert.rejects(createMacroWorkerCpuCapture({ browser: { newBrowserCDPSession: () => new Promise(() => {}) },
    origin, name: "test", output: "unused", readClock: async () => 1, commandTimeoutMs: 20 }), /timeout/);
  const root = new FakeSession({ failRoot: "Target.setDiscoverTargets" });
  await assert.rejects(createMacroWorkerCpuCapture({ browser: { newBrowserCDPSession: async () => root },
    origin, name: "test", output: "unused", readClock: async () => 1 }), /root rejected/);
  assert.equal(root.detached, true);
  assert.equal(root.listenerCount("Target.targetCreated"), 0);
});

const runnerSource = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
const prelude = runnerSource.slice(runnerSource.indexOf("const options ="), runnerSource.indexOf("const output ="));
const profiledExpression = runnerSource.match(/\n\s+profiled: (.+),\r?\n/)[1];
const cli = args => vm.runInNewContext(prelude + "\n({ macroWorkerCpu, processMemoryTail, profiled: " + profiledExpression + " })", {
  URL, process: { argv: ["node", "run.mjs", ...args], platform: "win32" },
});

test("default and natural-memory runs remain unprofiled; CPU mode is always diagnostic", () => {
  assert.equal(cli([]).profiled, false);
  assert.equal(cli(["--all-process-memory=1", "--process-memory-tail=1"]).profiled, false);
  assert.equal(cli(["--macro-mode=stable", "--macro-worker-cpu=1"]).profiled, true);
  assert.equal(cli(["--macro-worker-cpu=0"]).macroWorkerCpu, false);
  assert.throws(() => cli(["--macro-worker-cpu=invalid"]), /Invalid/);
});

for (const args of [
  ["--macro-mode=replication"], ["--profile=1"], ["--engine-profile=1"], ["--worker-heaps=1"],
  ["--timeline=stopping"], ["--retain-debt=1"], ["--process-memory-tail=1", "--all-process-memory=1"],
]) {
  test("refuses combined CPU diagnostic flags " + args.join(" "), () => {
    assert.throws(() => cli(["--macro-mode=stable", "--macro-worker-cpu=1", ...args]), /isolated stable-mode/);
  });
}
