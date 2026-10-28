import { createContentPackRegistry } from "../../src/game/contentPacks";
import { serializePersistentSaveEnvelopeToTransfer } from "./terminal-projection-prototype";
import { projectPersistentSaveState } from "../../src/game/saveProjection";
import { serializeSaveEnvelopeToTransfer } from "../../src/game/saveTransfer";
import type { GameState } from "../../src/game/types";

const digest = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map((value) => value.toString(16).padStart(2, "0")).join("");

async function runSaveProjectionChunks() {
  const state = (await (await fetch("/prepared.json")).json()).state as GameState;
  const registry = createContentPackRegistry();
  const metadata = { formatVersion: 2, kind: "primary" as const, savedAt: 1_800_000_000_000,
    mode: state.mode, slot: "main" as const };
  const before = await digest(new TextEncoder().encode(JSON.stringify(state)).buffer);
  const samples = [];
  for (const implementation of ["full", "bounded", "bounded", "full"] as const) {
    const start = performance.now();
    const result = implementation === "full"
      ? serializeSaveEnvelopeToTransfer(projectPersistentSaveState(state, registry), metadata)
      : serializePersistentSaveEnvelopeToTransfer(state, registry, metadata);
    const durationMs = performance.now() - start;
    const sha256 = await digest(result.bytes);
    samples.push({ implementation, durationMs, byteLength: result.byteLength,
      stateChecksum: result.stateChecksum, payloadChecksum: result.payloadChecksum, sha256 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (new Set(samples.map((sample) => sample.sha256)).size !== 1) throw new Error("Bounded projection changed complete bytes");
  if (before !== await digest(new TextEncoder().encode(JSON.stringify(state)).buffer)) throw new Error("Read-only source changed");
  return { scope: "projection plus v2 serialization only, no canonical decode, persistence or UI; diagnostic with per-sample SHA outside timing",
    inputUnchanged: true, samples };
}

Object.assign(globalThis, { runSaveProjectionChunks });
