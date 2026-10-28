import { createContentPackRegistry } from "../../src/game/contentPacks";
import { projectPersistentSaveState } from "../../src/game/saveProjection";
import { serializeSaveEnvelopeToTransfer } from "../../src/game/saveTransfer";
import { inspectCanonicalSaveEnvelope as baseline } from "../../src/game/canonicalSaveEnvelopeInspection";
import { inspectCanonicalSaveEnvelope as runs } from "../web-save-checkpoints/inspection-run-skip";
import { inspectCanonicalSaveEnvelope as tokens } from "../web-save-checkpoints/inspection-token-skip";
import type { GameState } from "../../src/game/types";

const metadata = { formatVersion: 2, savedAt: 1_800_000_000_000, kind: "primary" as const, mode: "normal" as const, slot: "main" as const };
function publicDifferential() {
  let checked = 0;
  let rejected = 0;
  const compare = (raw: string) => {
    const expected = JSON.stringify(baseline(raw));
    if (JSON.stringify(runs(raw)) !== expected || JSON.stringify(tokens(raw)) !== expected) throw new Error("Scanner public differential differs");
    checked++;
    if (expected === "null") rejected++;
  };
  for (let index = 0; index < 96; index++) {
    const text = ["ASCII", "中文🙂", 'escaped\\\"}][{', "\u0000\ud800"][index % 4];
    const state = { mode: "normal", version: 47, activePlanetId: "home", elapsedSeconds: index + 0.25,
      research: { completedTechIds: ["one", "two"] }, dysonSphere: { structurePoints: index },
      entities: Array.from({ length: index % 7 }, (_, row) => ({ id: `public-${row}`, text,
        nested: [{ a: true, b: false, c: null, values: [index, -0.125, 1e30, 1e-20] }, [text, { kept: index }]] })),
      belts: Array.from({ length: index % 11 }, (_, row) => ({ id: `belt-${row}`, text, progress: 0.3333333333333 })) };
    const frame = serializeSaveEnvelopeToTransfer(state, metadata);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(frame.bytes);
    compare(raw);
    compare(` \n${raw}\t`);
    compare(raw.slice(0, -1));
    compare(raw.replace('"research":', '"research":],"bad":'));
    compare(raw.replace('"home"', '"home\u0000"'));
    compare(raw.replace('"entities":[', '"entities":{'));
  }
  return { checked, rejected };
}

async function runSaveInspectionRuns() {
  const differential = publicDifferential();
  const { raw, bytes } = await (async () => {
    const state = (await (await fetch("/prepared.json")).json()).state as GameState;
    const frame = serializeSaveEnvelopeToTransfer(projectPersistentSaveState(state, createContentPackRegistry()), { ...metadata, mode: state.mode });
    return { raw: new TextDecoder("utf-8", { fatal: true }).decode(frame.bytes), bytes: frame.byteLength };
  })();
  const expected = JSON.stringify(baseline(raw));
  if (expected === "null") throw new Error("Prepared canonical envelope rejected");
  const samples = [];
  for (const implementation of ["baseline", "runs", "tokens", "tokens", "runs", "baseline"] as const) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const start = performance.now();
    const result = (implementation === "baseline" ? baseline : implementation === "runs" ? runs : tokens)(raw);
    const durationMs = performance.now() - start;
    if (JSON.stringify(result) !== expected) throw new Error("Full large-envelope inspection result differs");
    samples.push({ implementation, durationMs });
  }
  const payloadSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  return { scope: "Only canonical structure scan plus unchanged full UTF-16 checksum, in-memory; public differential precedes timing; no persistence/UI qualification",
    bytes, payloadSha256, differential, samples, inspection: JSON.parse(expected), forcedGc: false };
}

Object.assign(globalThis, { runSaveInspectionRuns });
