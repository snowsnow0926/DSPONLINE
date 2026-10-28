import { createContentPackRegistry } from "../../src/game/contentPacks";
import { projectPersistentSaveState } from "../../src/game/saveProjection";
import { serializeSaveEnvelopeToTransfer } from "../../src/game/saveTransfer";
import { inspectCanonicalSaveEnvelope as baseline } from "../../src/game/canonicalSaveEnvelopeInspection";
import { inspectCanonicalSaveEnvelope as candidate } from "../web-save-checkpoints/inspection-stack-reuse";
import type { GameState } from "../../src/game/types";

const metadata = { formatVersion: 2, savedAt: 1_800_000_000_000, kind: "primary" as const, mode: "normal" as const, slot: "main" as const };
function differential(candidate: typeof baseline) {
  let checked = 0;
  let rejected = 0;
  const compare = (raw: string) => {
    const expected = JSON.stringify(baseline(raw));
    if (JSON.stringify(candidate(raw)) !== expected) throw new Error("Stack reuse scanner public differential differs");
    checked++; if (expected === "null") rejected++;
  };
  for (let index = 0; index < 128; index++) {
    const text = ["ASCII", "中文🙂", 'escaped\\\"}][{', "\u0000\ud800"][index % 4];
    const records = Array.from({ length: index % 13 }, (_, row) => ({ id: `public-${row}`, text,
      payload: row % 3 === 0 ? { deep: [[[[{ values: [null, false, true, -0.125, 1e30, 1e-20] }]]]] }
        : row % 3 === 1 ? {} : { shallow: [text] } }));
    const state = { mode: "normal", version: 47, activePlanetId: "home", elapsedSeconds: index + 0.25,
      research: { completedTechIds: ["one", "two"] }, dysonSphere: { structurePoints: index }, entities: records, belts: [...records].reverse() };
    const frame = serializeSaveEnvelopeToTransfer(state, metadata);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(frame.bytes);
    compare(raw); compare(` \n${raw}\t`); compare(raw.slice(0, -1));
    compare(raw.replace('"research":', '"research":],"bad":'));
    compare(raw.replace('"home"', '"home\u0000"')); compare(raw.replace('"entities":[', '"entities":{'));
  }
  return { checked, rejected };
}

export async function runInspectionComparison(candidate: typeof baseline, strategy: string) {
  const { raw, bytes } = await (async () => {
    const state = (await (await fetch("/prepared.json")).json()).state as GameState;
    const frame = serializeSaveEnvelopeToTransfer(projectPersistentSaveState(state, createContentPackRegistry()), { ...metadata, mode: state.mode });
    return { raw: new TextDecoder("utf-8", { fatal: true }).decode(frame.bytes), bytes: frame.byteLength };
  })();
  const expected = JSON.stringify(baseline(raw));
  if (expected === "null") throw new Error("Prepared canonical envelope rejected");
  const samples = [];
  for (const implementation of ["baseline", "candidate", "candidate", "baseline", "candidate", "baseline"] as const) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const start = performance.now();
    const result = (implementation === "baseline" ? baseline : candidate)(raw);
    const durationMs = performance.now() - start;
    if (JSON.stringify(result) !== expected) throw new Error("Complete large-envelope inspection differs");
    samples.push({ implementation, durationMs });
  }
  const payloadSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  return { scope: "Canonical structure scan plus unchanged full UTF-16 checksum only; no storage/UI/whole-handoff qualification",
    strategy, bytes, payloadSha256, samples, differential: differential(candidate), publicDifferentialAfterTiming: true,
    inspection: JSON.parse(expected), forcedGc: false };
}

const runSaveInspectionStack = () => runInspectionComparison(candidate, "array-local-stack");
Object.assign(globalThis, { runSaveInspectionStack });
