import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Isolated diagnostics only. Never pause a Worker or change engine options.
export async function createMacroWorkerCpuCapture({
  browser, origin, output, name, readClock,
  commandTimeoutMs = 5000, captureLimitMs = 120_000,
  writeEvidence = (file, text) => writeFile(resolve(output, file), text, { flag: "wx" }),
}) {
  const base = new URL(origin);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !/^[a-z0-9-]+$/i.test(name)) {
    throw Error("Only named isolated loopback Worker diagnostics are allowed");
  }
  const timed = (promise, milliseconds = commandTimeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Worker CPU diagnostic timeout")), milliseconds);
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
  });
  const root = await timed(browser.newBrowserCDPSession());
  const errors = [], targets = new Set(), pending = new Map();
  const timing = {};
  let sessionId, sequence = 0, started = false, stopped = false;
  let beginPromise, finishPromise, captureTimer;
  let resolveFound;
  const found = new Promise(resolve => { resolveFound = resolve; });
  const rootSend = (method, params = {}) => timed(root.send(method, params));
  const recordError = error => errors.push(String(error));
  const matches = target => {
    if (!target || target.type !== "worker") return false;
    try {
      const url = new URL(target.url);
      return url.origin === base.origin && /^\/assets\/pureIdleMacro\.worker-[a-z0-9_-]+\.js$/i.test(url.pathname);
    } catch { return false; }
  };
  const settle = (id, result, error) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer);
    if (error) entry.reject(error); else entry.resolve(result);
  };
  const receive = event => {
    if (event.sessionId !== sessionId) return;
    try {
      const message = JSON.parse(event.message);
      if (message.id !== undefined) settle(message.id, message.result,
        message.error ? Error(message.error.message) : undefined);
    } catch (error) { recordError(error); }
  };
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => settle(id, undefined, Error("Worker CPU command timeout: " + method)), commandTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    rootSend("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) })
      .catch(error => settle(id, undefined, error));
  });
  const begin = async target => {
    timing.workerScript = new URL(target.url).pathname.split("/").at(-1);
    ({ sessionId } = await rootSend("Target.attachToTarget", { targetId: target.targetId, flatten: false }));
    await request("Profiler.enable");
    await request("Profiler.setSamplingInterval", { interval: 1000 });
    timing.startTraceBeforeMs = await timed(readClock());
    await request("Profiler.start"); started = true;
    timing.startTraceAfterMs = await timed(readClock());
    resolveFound(true);
  };
  const created = ({ targetInfo }) => {
    if (!matches(targetInfo) || targets.has(targetInfo.targetId)) return;
    targets.add(targetInfo.targetId);
    if (targets.size !== 1) { recordError("More than one macro Worker; profile ownership is ambiguous"); return; }
    beginPromise = begin(targetInfo).catch(error => { recordError(error); resolveFound(false); });
  };
  const cleanup = async () => {
    clearTimeout(captureTimer);
    root.off("Target.targetCreated", created);
    root.off("Target.targetInfoChanged", created);
    if (sessionId) {
      if (started) await request("Profiler.disable").catch(recordError);
      await rootSend("Target.detachFromTarget", { sessionId }).catch(recordError);
    }
    root.off("Target.receivedMessageFromTarget", receive);
    for (const id of [...pending.keys()]) settle(id, undefined, Error("Worker CPU capture closed"));
    await timed(root.detach()).catch(recordError);
  };
  const finish = ({ readyObserved = true } = {}) => {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      let profile, profileFile;
      try {
        if (readyObserved) {
          if (!await timed(found, commandTimeoutMs * 2)) throw Error("Macro Worker CPU capture did not start");
        } else if (beginPromise) await timed(beginPromise, commandTimeoutMs * 4);
        if (!readyObserved) recordError("Ready boundary was not observed within the diagnostic capture");
        if (started) {
          timing.stopTraceBeforeMs = await timed(readClock());
          ({ profile } = await request("Profiler.stop")); stopped = true;
          timing.stopTraceAfterMs = await timed(readClock());
          const text = JSON.stringify(profile ?? null);
          if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw Error("Worker CPU profile exceeded its size limit");
          profileFile = name + "-macro-worker.cpuprofile";
          await writeEvidence(profileFile, text);
          if (!profile?.nodes?.length || !profile.samples?.length || profile.samples.length !== profile.timeDeltas?.length ||
            !(profile.endTime > profile.startTime)) throw Error("Incomplete macro Worker CPU profile");
        } else throw Error("Macro Worker was never sampled");
      } catch (error) { recordError(error); }
      finally { await cleanup(); }
      const result = { scope: "Dedicated macro Worker startup CPU diagnostic only; not unprofiled timing or memory qualification",
        complete: readyObserved && started && stopped && targets.size === 1 && errors.length === 0,
        pausedWorker: false, forcedGc: false, engineOptionsChanged: false, samplingIntervalUs: 1000,
        matchingTargetCount: targets.size, profileFile, samples: profile?.samples?.length ?? 0,
        ...timing, errors };
      await writeEvidence(name + "-macro-worker-cpu.json", JSON.stringify(result, null, 2));
      return result;
    })();
    return finishPromise;
  };
  try {
    const existing = await rootSend("Target.getTargets");
    if (existing.targetInfos.some(matches)) throw Error("Macro Worker already exists before the startup diagnostic");
    root.on("Target.receivedMessageFromTarget", receive);
    root.on("Target.targetCreated", created);
    root.on("Target.targetInfoChanged", created);
    await rootSend("Target.setDiscoverTargets", { discover: true });
    captureTimer = setTimeout(() => { void finish({ readyObserved: false }).catch(recordError); }, captureLimitMs);
  } catch (error) { await cleanup(); throw error; }
  return { finish };
}
