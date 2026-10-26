import { serializeEnvelopeInWorker } from "../../src/game/storage";
import type { GameState } from "../../src/game/types";

async function runSaveResponsiveness() {
  const inputProbe = globalThis as typeof globalThis & { requestSaveInputProbe?: () => Promise<void>; recordHeapMeasurements?: boolean; collectSaveProbeGarbage?: () => Promise<void> };
  const button = document.createElement("button");
  button.textContent = "Input probe";
  button.style.cssText = "position:fixed;left:0;top:0;width:120px;height:40px";
  document.body.append(button);
  let inputAt = 0;
  button.addEventListener("click", () => { inputAt ||= performance.now(); });
  const state = (await (await fetch("/prepared.json")).json()).state as GameState;
  const heap = () => inputProbe.recordHeapMeasurements
    ? (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0 : 0;
  const heapBefore = heap();
  let sampledHeapMax = heapBefore;
  let trackMemory = true;
  const NativeWorker = globalThis.Worker;
  let postMs = 0, responseAt = 0;
  let messageDataAccessMs = 0;
  const workerDiagnostics: string[] = [];
  class MeasuredWorker extends NativeWorker {
    constructor(url: URL | string, options?: WorkerOptions) {
      workerDiagnostics.push(String(url));
      super(url, options);
      this.addEventListener("error", (event) => workerDiagnostics.push(event.message || "worker error"));
      this.addEventListener("message", (event) => {
        responseAt ||= performance.now();
        void inputProbe.requestSaveInputProbe?.();
        const start = performance.now();
        void event.data;
        messageDataAccessMs = performance.now() - start;
      }, { once: true });
      const original = this.postMessage.bind(this);
      Object.defineProperty(this, "postMessage", { value: (message: unknown, transfers: Transferable[] = []) => {
        const start = performance.now();
        try { original(message, transfers); } finally { postMs += performance.now() - start; }
      } });
    }
  }
  const longTasks: { start: number; duration: number }[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration });
  });
  observer.observe({ type: "longtask" });
  const ticks: { start: number; end: number; duration: number }[] = [];
  const frames: { start: number; end: number; duration: number }[] = [];
  let previousFrame = performance.now();
  let frameHandle = 0;
  const frame = () => {
    const now = performance.now();
    frames.push({ start: previousFrame, end: now, duration: now - previousFrame });
    previousFrame = now;
    frameHandle = requestAnimationFrame(frame);
  };
  frameHandle = requestAnimationFrame(frame);
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    ticks.push({ start: previous, end: now, duration: now - previous });
    if (trackMemory) sampledHeapMax = Math.max(sampledHeapMax, heap());
    previous = now;
  }, 4);
  globalThis.Worker = MeasuredWorker;
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const startedAt = performance.now();
    const result = await serializeEnvelopeInWorker(state, 1_800_000_000_000);
    const finishedAt = performance.now();
    const heapAfterReturn = heap();
    sampledHeapMax = Math.max(sampledHeapMax, heapAfterReturn);
    trackMemory = false;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!result.usedWorker || responseAt === 0) throw new Error(`Save unexpectedly used the synchronous fallback: ${workerDiagnostics.join(" | ")}`);
    let heapAfterGc: number | undefined;
    if (inputProbe.collectSaveProbeGarbage) {
      await inputProbe.collectSaveProbeGarbage();
      heapAfterGc = heap();
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(result.raw));
    const finalHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const overlaps = (start: number, end: number) => start < finishedAt && end > responseAt;
    return {
      scope: "actual save Worker round trip; timer gap is a main-thread responsiveness proxy, not FPS",
      roundTripMs: finishedAt - startedAt, postMessageMs: postMs, workerReportedMs: result.durationMs,
      messageDataAccessMs,
      returnDecodeMs: finishedAt - responseAt,
      maxTimerGapMs: Math.max(0, ...ticks.filter((tick) => tick.start < finishedAt && tick.end > startedAt).map((tick) => tick.duration)),
      maxReturnTimerGapMs: Math.max(0, ...ticks.filter((tick) => overlaps(tick.start, tick.end)).map((tick) => tick.duration)),
      maxReturnFrameGapMs: Math.max(0, ...frames.filter((frame) => overlaps(frame.start, frame.end)).map((frame) => frame.duration)),
      inputResponseMs: inputAt ? inputAt - responseAt : null,
      returnLongTasks: longTasks.filter((task) => overlaps(task.start, task.start + task.duration)),
      operationLongTasks: longTasks.filter((task) => task.start < finishedAt && task.start + task.duration > startedAt),
      serializedBytes: result.verification.byteLength, finalHash,
      sourceEntityCount: state.entities.length,
      ...(inputProbe.recordHeapMeasurements ? { pageHeap: { before: heapBefore, afterReturn: heapAfterReturn,
        sampledMax: sampledHeapMax, afterGc: heapAfterGc, scope: "sampled page JS heap only; source and raw kept live; excludes Worker and native allocations" } } : {}),
    };
  } finally {
    clearInterval(timer);
    observer.disconnect();
    cancelAnimationFrame(frameHandle);
    button.remove();
    globalThis.Worker = NativeWorker;
  }
}

Object.assign(globalThis, { runSaveResponsiveness });
