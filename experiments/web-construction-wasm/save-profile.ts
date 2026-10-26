import { createContentPackRegistry } from "../../src/game/contentPacks";
import { projectPersistentSaveState } from "../../src/game/saveProjection";
import { decodeVerifiedSaveTransfer, serializeSaveEnvelopeToTransfer } from "../../src/game/saveTransfer";
import type { GameState } from "../../src/game/types";

async function runSaveProfile() {
  const state = (await (await fetch("/prepared.json")).json()).state as GameState;
  const registry = createContentPackRegistry();
  const options = { formatVersion: 2, savedAt: 1_800_000_000_000, kind: "primary" as const,
    mode: state.mode, slot: "main" as const };
  const sample = async () => {
    let start = performance.now();
    const persistent = projectPersistentSaveState(state, registry);
    const projectionMs = performance.now() - start;
    start = performance.now();
    const transfer = serializeSaveEnvelopeToTransfer(persistent, options);
    const serializationMs = performance.now() - start;
    start = performance.now();
    const raw = decodeVerifiedSaveTransfer(transfer.bytes, transfer);
    const verifyDecodeMs = performance.now() - start;
    start = performance.now();
    const encoded = new TextEncoder().encode(raw);
    const reencodeMs = performance.now() - start;
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    const finalHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return { projectionMs, serializationMs, verifyDecodeMs, reencodeMs,
      totalMs: projectionMs + serializationMs + verifyDecodeMs + reencodeMs,
      stateChecksum: transfer.stateChecksum, payloadChecksum: transfer.payloadChecksum,
      serializedBytes: transfer.byteLength, finalHash };
  };
  const samples = [];
  for (let index = 0; index < 3; index++) {
    samples.push(await sample());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (new Set(samples.map((sample) => sample.finalHash)).size !== 1) throw new Error("Serialization changed across samples");
  return { scope: "persistent projection, transfer serialization and compatibility decode; no storage I/O", samples };
}

Object.assign(globalThis, { runSaveProfile });
