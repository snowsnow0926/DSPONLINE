import { createContentPackRegistry, type ContentPackRegistry } from "../../src/game/contentPacks";
import { migrateGame, parseTrustedWorkerEnvelope } from "../../src/game/storage";
import { computeSavePayloadChecksum, decodeVerifiedSaveTransfer, serializeSaveEnvelopeToTransfer, type SaveTransferVerification } from "../../src/game/saveTransfer";
import { decodeVerifiedSaveTransferChunked } from "../../src/game/saveTransferDecode";
import { serializeAuthoritativePrimarySaveInWorker } from "../../src/game/authoritativeSaveSerializationClient";
import type { GameState } from "../../src/game/types";

type CooperativeParser = (raw: string, verification: SaveTransferVerification, registry: ContentPackRegistry) => Promise<GameState>;

export async function runTerminalDecodeProbe(mode = "profile", cooperativeParser?: CooperativeParser) {
  if (!["profile", "sync", "chunked", "worker", "cooperative"].includes(mode)) throw new Error("Unknown decode variant");
  let source: GameState | null = (await (await fetch("/prepared.json")).json()).state;
  const registry = createContentPackRegistry();
  let transfer: ReturnType<typeof serializeSaveEnvelopeToTransfer> | null = serializeSaveEnvelopeToTransfer(source!, {
    formatVersion: 2, kind: "primary", mode: source!.mode, slot: "main", savedAt: 1_800_000_000_000,
  });
  source = null;
  const verification = { integrity: "valid" as const, stateChecksum: transfer.stateChecksum,
    payloadChecksum: transfer.payloadChecksum, byteLength: transfer.byteLength };
  const input = globalThis as typeof globalThis & { requestSaveInputProbe?: () => Promise<void>;
    __terminalMigrationPhases?: { phase: string; at: number }[]; recordTerminalPersistedProof?: boolean };
  input.__terminalMigrationPhases = [];
  const button = document.createElement("button");
  button.textContent = "Input probe";
  button.style.cssText = "position:fixed;left:0;top:0;width:120px;height:40px";
  document.body.append(button);
  let clickedAt = 0;
  button.addEventListener("click", () => { clickedAt ||= performance.now(); });
  const frames: { start: number; end: number; gap: number }[] = [];
  const tasks: { start: number; duration: number }[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
  });
  observer.observe({ type: "longtask" });
  let previous = performance.now();
  let frameHandle = 0;
  const frame = () => {
    const now = performance.now(); frames.push({ start: previous, end: now, gap: now - previous }); previous = now;
    frameHandle = requestAnimationFrame(frame);
  };
  frameHandle = requestAnimationFrame(frame);
  const yieldControl = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  let result: GameState;
  const timings: Record<string, number> = {};
  let workerTimings: Record<string, number> | undefined;
  const startedAt = performance.now();
  const inputRequest = input.requestSaveInputProbe?.();
  try {
    if (mode === "worker") {
      let start = performance.now();
      const payload = new Blob([transfer.bytes]);
      timings.blobCreateMs = performance.now() - start;
      transfer = null;
      const worker = new Worker(new URL("./terminal-decode.worker.ts", import.meta.url), { type: "module", name: "terminal-decode-probe" });
      try {
        const received = await new Promise<{ state: GameState; workerTimings: Record<string, number> }>((resolve, reject) => {
          worker.onerror = (event) => reject(new Error(event.message || "Decode Worker failed"));
          worker.onmessageerror = () => reject(new Error("Decode Worker message failed"));
          worker.onmessage = (event) => {
            start = performance.now();
            const value = event.data;
            timings.messageDataAccessMs = performance.now() - start;
            if (value.error || !value.state) reject(new Error(value.error || "Decode Worker state missing"));
            else resolve(value);
          };
          worker.postMessage({ payload, verification, registry });
        });
        result = received.state; workerTimings = received.workerTimings;
      } finally { worker.terminate(); }
    } else if (mode === "profile") {
      let start = performance.now();
      if (computeSavePayloadChecksum(transfer.bytes) !== verification.payloadChecksum) throw new Error("Payload mismatch");
      timings.byteChecksumMs = performance.now() - start;
      await yieldControl(); start = performance.now();
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(transfer.bytes);
      timings.textDecodeMs = performance.now() - start;
      await yieldControl(); start = performance.now();
      const parsed = JSON.parse(raw);
      timings.jsonParseMs = performance.now() - start;
      await yieldControl(); start = performance.now();
      input.__terminalMigrationPhases.push({ phase: "start", at: start });
      result = migrateGame(parsed.state, registry)!;
      timings.normalizationMs = performance.now() - start;
      input.__terminalMigrationPhases.push({ phase: "top-level-and-finish", at: performance.now() });
    } else {
      let start = performance.now();
      const raw = mode === "chunked" || mode === "cooperative"
        ? await decodeVerifiedSaveTransferChunked(transfer.bytes, verification, { lowMemory: true })
        : decodeVerifiedSaveTransfer(transfer.bytes, verification);
      timings.verifyDecodeMs = performance.now() - start;
      if (mode === "chunked") await yieldControl();
      start = performance.now();
      if (mode === "cooperative") {
        if (!cooperativeParser) throw new Error("Cooperative parser missing");
        result = await cooperativeParser(raw, verification, registry);
      } else result = parseTrustedWorkerEnvelope(raw, verification, registry);
      timings.parseNormalizeMs = performance.now() - start;
    }
    const finishedAt = performance.now();
    await inputRequest;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await yieldControl();
    const operationFrames = frames.filter((entry) => entry.start < finishedAt && entry.end > startedAt);
    const operationTasks = tasks.filter((entry) => entry.start < finishedAt && entry.start + entry.duration > startedAt);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(result)));
    let persistedProof: { sha256: string; bytes: number } | undefined;
    if (input.recordTerminalPersistedProof) {
      const saved = await serializeAuthoritativePrimarySaveInWorker(result, { savedAt: 1_800_000_000_000 });
      const body = saved.proof.transportEncoding === "gzip"
        ? await new Response(new Blob([saved.bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer() : saved.bytes;
      const digest = await crypto.subtle.digest("SHA-256", body);
      const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (sha256 !== saved.proof.payloadSha256) throw new Error("Actual save Worker proof mismatch");
      persistedProof = { sha256, bytes: body.byteLength };
    }
    return { scope: "one canonical terminal decode; source generation and final hashing excluded from decode timing; memory peak includes verification",
      mode, fullEnvelopeBytes: verification.byteLength, totalMs: finishedAt - startedAt, timings, workerTimings,
      maxFrameGapMs: Math.max(0, ...operationFrames.map((entry) => entry.gap)),
      inputResponseMs: clickedAt ? clickedAt - startedAt : null, operationTasks,
      migrationPhases: input.__terminalMigrationPhases.map((entry, index, entries) => ({ phase: entry.phase,
        durationMs: index === 0 ? 0 : entry.at - entries[index - 1].at })),
      stateSha256: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      ...(persistedProof ? { persistedProof } : {}),
      entityCount: result.entities.length, beltCount: result.belts.length };
  } finally { observer.disconnect(); cancelAnimationFrame(frameHandle); button.remove(); }
}

Object.assign(globalThis, { runTerminalDecodeProbe });
