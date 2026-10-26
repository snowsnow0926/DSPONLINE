import { createContentPackRegistry } from "../../src/game/contentPacks";
import { migrateGame } from "../../src/game/storage";
import { serializeAuthoritativePrimarySaveInWorker } from "../../src/game/authoritativeSaveSerializationClient";
import type { GameState } from "../../src/game/types";
import type { SaveStateChunkAck } from "../../src/game/saveStateChunkTransfer";

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const stateHash = async (state: GameState) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(state))));

export async function runSaveStateChunksProbe(mode = "clone") {
  if (mode !== "clone" && mode !== "chunks") throw new Error("Unknown save transport mode");
  let loaded: GameState | null = (await (await fetch("/prepared.json")).json()).state;
  const state = migrateGame(loaded!, createContentPackRegistry());
  loaded = null;
  if (!state) throw new Error("Canonical state unavailable");
  const sourceSha256Before = await stateHash(state);
  const input = globalThis as typeof globalThis & { requestSaveInputProbe?: () => Promise<void> };
  const button = document.createElement("button");
  button.textContent = "Input probe";
  button.style.cssText = "position:fixed;left:0;top:0;width:120px;height:40px";
  document.body.append(button);
  let clickedAt = 0;
  button.addEventListener("click", () => { clickedAt ||= performance.now(); });
  const tasks: { start: number; duration: number }[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
  });
  observer.observe({ type: "longtask" });
  const frames: { start: number; end: number; gap: number }[] = [];
  let previous = performance.now();
  let frameHandle = 0;
  const frame = () => {
    const now = performance.now(); frames.push({ start: previous, end: now, gap: now - previous }); previous = now;
    frameHandle = requestAnimationFrame(frame);
  };
  frameHandle = requestAnimationFrame(frame);
  const NativeWorker = globalThis.Worker;
  const postTimes: number[] = [];
  let ackCount = 0;
  function WorkerFactory(url: string | URL, options?: WorkerOptions): Worker {
    const worker = new NativeWorker(url, options);
    const post = worker.postMessage.bind(worker);
    const send = (message: unknown, transfers: Transferable[] = []) => {
      const start = performance.now();
      try { post(message, transfers); } finally { postTimes.push(performance.now() - start); }
    };
    worker.addEventListener("message", (event: MessageEvent<{ stateChunkAck?: SaveStateChunkAck }>) => {
      if (event.data.stateChunkAck) {
        ackCount += 1;
      }
    });
    Object.defineProperty(worker, "postMessage", { value: send });
    return worker;
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const startedAt = performance.now();
  const inputRequest = input.requestSaveInputProbe?.();
  try {
    globalThis.Worker = WorkerFactory as unknown as typeof Worker;
    const pending = serializeAuthoritativePrimarySaveInWorker(state, { savedAt: 1_800_000_000_000,
      ...(mode === "chunks" ? { frozenStateIsCurrent: () => true } : {}),
      expectedStateIdentity: { mode: state.mode, version: state.version, activePlanetId: state.activePlanetId,
        entityCount: state.entities.length, beltCount: state.belts.length, elapsedSeconds: state.elapsedSeconds } });
    globalThis.Worker = NativeWorker;
    const result = await pending;
    const finishedAt = performance.now();
    await inputRequest;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const operationFrames = frames.filter((entry) => entry.start < finishedAt && entry.end > startedAt);
    const operationTasks = tasks.filter((entry) => entry.start < finishedAt && entry.start + entry.duration > startedAt);
    const body = result.proof.transportEncoding === "gzip"
      ? await new Response(new Blob([result.bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer() : result.bytes;
    const persistedSha256 = hex(await crypto.subtle.digest("SHA-256", body));
    if (persistedSha256 !== result.proof.payloadSha256 || body.byteLength !== result.proof.byteLength) throw new Error("Full save Worker proof differs from actual body");
    const sourceSha256After = await stateHash(state);
    if (sourceSha256After !== sourceSha256Before) throw new Error("Caller-owned source was mutated");
    return { mode, scope: "canonical frozen-state serialization Worker round-trip only; no IndexedDB, no page stop; preparation and full proof hashing excluded; process peak includes verification",
      totalMs: finishedAt - startedAt, maxFrameGapMs: Math.max(0, ...operationFrames.map((entry) => entry.gap)),
      inputResponseMs: clickedAt ? clickedAt - startedAt : null, operationTasks,
      postCount: postTimes.length, postTotalMs: postTimes.reduce((sum, value) => sum + value, 0),
      maxPostMs: Math.max(0, ...postTimes), ackCount, workerDurationMs: result.durationMs,
      compressionDurationMs: result.compressionDurationMs,
      sourceSha256Before, sourceSha256After, persistedSha256, persistedBytes: body.byteLength,
      proof: result.proof, catalogSeed: result.catalogSeed, entityCount: state.entities.length, beltCount: state.belts.length };
  } finally { globalThis.Worker = NativeWorker; observer.disconnect(); cancelAnimationFrame(frameHandle); button.remove(); }
}

Object.assign(globalThis, { runSaveStateChunksProbe });
