import { createContentPackRegistry } from "../../src/game/contentPacks";
import { parseTrustedWorkerEnvelopeChunked } from "../../src/game/storage";
import { serializeSaveEnvelopeToTransfer } from "../../src/game/saveTransfer";
import { decodeVerifiedSaveTransferChunked } from "../../src/game/saveTransferDecode";
import { serializeAuthoritativePrimarySaveInWorker, type AuthoritativeSerializedSaveProofPayload } from "../../src/game/authoritativeSaveSerializationClient";
import type { AuthoritativeSaveSerializationResponse } from "../../src/game/authoritativeSaveSerializationProtocol";
import { SaveStateChunkAssembler, type SaveStateChunkRequest } from "../../src/game/saveStateChunkTransfer";
import type { GameState } from "../../src/game/types";
import type { TerminalOwnerRequest } from "./terminal-owner-protocol";
import { CanonicalTerminalDecoder } from "../../src/game/canonicalTerminalOwnerClient";

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const identity = (state: GameState) => ({ mode: state.mode, version: state.version, activePlanetId: state.activePlanetId,
  elapsedSeconds: state.elapsedSeconds, entityCount: state.entities.length, beltCount: state.belts.length });

export async function runTerminalOwnerProbe(mode = "ui") {
  if (!["ui", "worker-return", "worker-owner", "worker-owner-blob", "integrated-blob"].includes(mode)) throw new Error("Unknown terminal owner mode");
  let source: GameState | null = (await (await fetch("/prepared.json")).json()).state;
  let transfer: ReturnType<typeof serializeSaveEnvelopeToTransfer> | null = serializeSaveEnvelopeToTransfer(source!, {
    formatVersion: 2, savedAt: 1_800_000_000_000, kind: "primary", slot: "main", mode: source!.mode });
  source = null;
  const verification = { integrity: "valid" as const, stateChecksum: transfer.stateChecksum,
    payloadChecksum: transfer.payloadChecksum, byteLength: transfer.byteLength };
  let inputBytes: ArrayBuffer | null = transfer.bytes; transfer = null;
  const blobStart = performance.now();
  const inputBlob = mode === "worker-owner-blob" || mode === "integrated-blob" ? new Blob([inputBytes]) : null;
  const inputPreparationBlobMs = performance.now() - blobStart;
  if (inputBlob) inputBytes = null;
  const registry = createContentPackRegistry();
  const probe = globalThis as typeof globalThis & { requestSaveInputProbe?: () => Promise<void> };
  const button = document.createElement("button"); button.textContent = "Input probe";
  button.style.cssText = "position:fixed;left:0;top:0;width:120px;height:40px"; document.body.append(button);
  let clickedAt = 0; button.addEventListener("click", () => { clickedAt ||= performance.now(); });
  const tasks: { start: number; duration: number }[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
  }); observer.observe({ type: "longtask" });
  const frames: { start: number; end: number; gap: number }[] = [];
  let previous = performance.now(); let frameHandle = 0;
  const frame = () => { const now = performance.now(); frames.push({ start: previous, end: now, gap: now - previous });
    previous = now; frameHandle = requestAnimationFrame(frame); };
  frameHandle = requestAnimationFrame(frame);
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const timings: Record<string, number> = {}; const workerTimings: Record<string, number> = {};
  let state: GameState | null = null; let saved: AuthoritativeSerializedSaveProofPayload;
  let worker: Worker | null = null;
  let decoder: CanonicalTerminalDecoder | null = null;
  const NativeWorker = globalThis.Worker;
  const createdWorkers: string[] = [];
  const sends: { name: string; type: string; durationMs: number }[] = [];
  function MeasuredWorker(url: string | URL, options?: WorkerOptions): Worker {
    const instance = new NativeWorker(url, options);
    const name = options?.name ?? ""; createdWorkers.push(name);
    const post = instance.postMessage.bind(instance);
    Object.defineProperty(instance, "postMessage", { value: (message: unknown, transfer: Transferable[] = []) => {
      const start = performance.now();
      try { post(message, transfer); }
      finally { const value = message as { type?: string; kind?: string }; sends.push({ name, type: value.type ?? value.kind ?? "unknown", durationMs: performance.now() - start }); }
    } });
    return instance;
  }
  const startedAt = performance.now(); const inputRequest = probe.requestSaveInputProbe?.();
  try {
    globalThis.Worker = MeasuredWorker as unknown as typeof Worker;
    if (mode === "ui") {
      const decodeStart = performance.now();
      state = await (async () => {
        const raw = await decodeVerifiedSaveTransferChunked(inputBytes!, verification, { lowMemory: true });
        return parseTrustedWorkerEnvelopeChunked(raw, verification, registry);
      })();
      inputBytes = null; timings.decodeMs = performance.now() - decodeStart;
    } else if (mode === "integrated-blob") {
      decoder = new CanonicalTerminalDecoder(inputBlob!, verification, registry, { isCurrent: () => true });
      state = await decoder.state;
      timings.decodeMs = performance.now() - startedAt;
    } else {
      worker = new Worker(new URL("./terminal-owner.worker.ts", import.meta.url), { type: "module", name: "terminal-owner-probe" });
      const collector = new SaveStateChunkAssembler();
      const ownerResult = await new Promise<AuthoritativeSerializedSaveProofPayload | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Terminal owner probe timeout")), 120_000);
        const fail = (error: unknown) => { clearTimeout(timer); reject(error); };
        worker!.onerror = (event) => fail(new Error(event.message || "Owner Worker crashed"));
        worker!.onmessageerror = () => fail(new Error("Owner Worker clone failed"));
        worker!.onmessage = (event: MessageEvent<SaveStateChunkRequest | (AuthoritativeSaveSerializationResponse & { type?: string; timings?: Record<string, number> })>) => {
          try {
            const data = event.data;
            if ("type" in data && data.type === "owner-timings") { Object.assign(workerTimings, data.timings); return; }
            if ("error" in data && data.error) throw new Error(data.error);
            if ("type" in data && ["state-begin", "state-records", "state-complete"].includes(data.type!)) {
              const received = collector.accept(data as SaveStateChunkRequest);
              if ("ack" in received) worker!.postMessage({ type: "owner-ack", ack: received.ack } satisfies TerminalOwnerRequest);
              else {
                state = received.request.state; timings.decodeMs = performance.now() - startedAt;
                if (mode === "worker-return") { clearTimeout(timer); resolve(null); }
                else worker!.postMessage({ type: "owner-serialize", savedAt: 1_800_000_000_000,
                  expectedStateIdentity: identity(state) } satisfies TerminalOwnerRequest);
              }
              return;
            }
            const response = data as AuthoritativeSaveSerializationResponse;
            if (!state || !(response.bytes instanceof ArrayBuffer) || !response.proof || !response.catalogSeed || !response.summary ||
              response.proof.integrity !== "valid" || response.sourceStateTransfer !== undefined ||
              response.proof.storedByteLength !== response.bytes.byteLength ||
              response.proof.stateChecksum !== response.catalogSeed.stateChecksum || response.summary.stateChecksum !== response.proof.stateChecksum) {
              throw new Error("Owner returned incomplete canonical state or proof");
            }
            clearTimeout(timer);
            resolve({ bytes: response.bytes, proof: response.proof, catalogSeed: response.catalogSeed, summary: response.summary,
              durationMs: response.durationMs ?? 0, compressionDurationMs: response.compressionDurationMs ?? 0 });
          } catch (error) { fail(error); }
        };
        const postStart = performance.now();
        worker!.postMessage({ type: "owner-start", payload: inputBlob ?? inputBytes, verification, registry,
          returnOnly: mode === "worker-return" } satisfies TerminalOwnerRequest, inputBlob ? [] : [inputBytes!]);
        timings.inputPostMs = performance.now() - postStart; inputBytes = null;
      });
      worker.terminate(); worker = null;
      if (ownerResult) saved = ownerResult;
    }
    if (!state) throw new Error("Canonical state was not delivered");
    if (mode !== "worker-owner" && mode !== "worker-owner-blob") saved = await serializeAuthoritativePrimarySaveInWorker(state,
      { savedAt: 1_800_000_000_000, frozenStateIsCurrent: () => true, expectedStateIdentity: identity(state) });
    if (mode === "integrated-blob" && (createdWorkers.length !== 1 || createdWorkers[0] !== "canonical-terminal-decoder" ||
      sends.filter((send) => send.type === "canonical-serialize").length !== 1 || sends.some((send) => send.type === "state-records"))) {
      throw new Error("Integrated probe did not reuse its canonical owner");
    }
    const finishedAt = performance.now();
    await inputRequest;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const operationFrames = frames.filter((entry) => entry.start < finishedAt && entry.end > startedAt);
    const operationTasks = tasks.filter((entry) => entry.start < finishedAt && entry.start + entry.duration > startedAt);
    const stateSha256 = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(state))));
    const body = saved!.proof.transportEncoding === "gzip"
      ? await new Response(new Blob([saved!.bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer() : saved!.bytes;
    const persistedSha256 = hex(await crypto.subtle.digest("SHA-256", body));
    if (persistedSha256 !== saved!.proof.payloadSha256 || body.byteLength !== saved!.proof.byteLength) throw new Error("Actual owner payload proof mismatch");
    return { mode, scope: "canonical decode, bounded UI delivery and actual primary serialization; no IndexedDB/page stop; input preparation and final full hashes excluded; process peak includes preparation and verification",
      totalMs: finishedAt - startedAt, inputPreparationBlobMs, timings, workerTimings, maxFrameGapMs: Math.max(0, ...operationFrames.map((entry) => entry.gap)),
      inputResponseMs: clickedAt ? clickedAt - startedAt : null, operationTasks,
      stateSha256, persistedSha256, persistedBytes: body.byteLength, sourceEnvelopeBytes: verification.byteLength,
      createdWorkers, sends,
      workerDurationMs: saved!.durationMs, entityCount: state.entities.length, beltCount: state.belts.length };
  } finally { worker?.terminate(); decoder?.close(); globalThis.Worker = NativeWorker; observer.disconnect(); cancelAnimationFrame(frameHandle); button.remove(); }
}
Object.assign(globalThis, { runTerminalOwnerProbe });
