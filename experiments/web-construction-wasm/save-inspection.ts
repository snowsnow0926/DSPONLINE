import { createContentPackRegistry } from "../../src/game/contentPacks";
import { projectPersistentSaveState } from "../../src/game/saveProjection";
import { serializeSaveEnvelopeToTransfer } from "../../src/game/saveTransfer";
import { inspectCanonicalSaveEnvelope as baseline } from "../web-save-checkpoints/inspection-baseline";
import { inspectCanonicalSaveEnvelope as candidate } from "../web-save-checkpoints/inspection-slice";
import { inspectCanonicalSaveEnvelope as regexp } from "../../src/game/canonicalSaveEnvelopeInspection";
import type { GameState } from "../../src/game/types";

async function runSaveInspection() {
  const { raw, byteLength } = await (async () => {
    const state = (await (await fetch("/prepared.json")).json()).state as GameState;
    const persistent = projectPersistentSaveState(state, createContentPackRegistry());
    const transfer = serializeSaveEnvelopeToTransfer(persistent, {
      formatVersion: 2, savedAt: 1_800_000_000_000, kind: "primary", mode: state.mode, slot: "main",
    });
    return { raw: new TextDecoder("utf-8", { fatal: true }).decode(transfer.bytes), byteLength: transfer.byteLength };
  })();
  const expected = JSON.stringify(baseline(raw));
  const samples = [];
  for (const name of ["baseline", "candidate", "regexp", "regexp", "candidate", "baseline", "candidate", "baseline", "regexp"] as const) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const collectGarbage = (globalThis as typeof globalThis & { collectSaveProbeGarbage?: () => Promise<void> }).collectSaveProbeGarbage;
    if (collectGarbage) await collectGarbage();
    const start = performance.now();
    const result = (name === "baseline" ? baseline : name === "candidate" ? candidate : regexp)(raw);
    const durationMs = performance.now() - start;
    if (JSON.stringify(result) !== expected) throw new Error("Inspection result changed");
    samples.push({ name, durationMs });
  }
  return { scope: "canonical envelope scanner only; same in-memory payload, no storage", bytes: byteLength,
    expected: JSON.parse(expected), samples };
}

Object.assign(globalThis, { runSaveInspection });
