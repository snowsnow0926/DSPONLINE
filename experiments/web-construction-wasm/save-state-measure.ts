import { measureSaveStateJson, computeSaveStateChecksumFromJson } from "../../src/game/saveEnvelopeIntegrity";
import { projectPersistentSaveState } from "../../src/game/saveProjection";
import { createContentPackRegistry } from "../../src/game/contentPacks";
import { measureSaveStateJsonAscii } from "../web-save-checkpoints/state-measure-ascii";
import type { GameState } from "../../src/game/types";

async function runSaveStateMeasure() {
  const state = (await (await fetch("/prepared.json")).json()).state as GameState;
  const persistent = projectPersistentSaveState(state, createContentPackRegistry());
  const json = JSON.stringify(persistent);
  const expected = measureSaveStateJson(2, json);
  const calls = { baseline: measureSaveStateJson, ascii: measureSaveStateJsonAscii };
  const samples = [];
  for (const variant of ["baseline", "ascii", "ascii", "baseline", "ascii", "baseline"] as const) {
    const started = performance.now();
    const result = calls[variant](2, json);
    const milliseconds = performance.now() - started;
    if (result.stateChecksum !== expected.stateChecksum || result.byteLength !== expected.byteLength) throw Error("Complete state measurement differs");
    samples.push({ variant, milliseconds, ...result });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const before = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)));
  let vectors = 0;
  const cases = ["", "a", "ab", "abc", "abcd", "abcde", "磁石🚀", "\ud800", "\udc00", "\ud800x\udc00", "\ud800\udc00", "\udbff\udfff"];
  for (let offset = 0; offset < 12; offset++) for (const value of cases) for (const version of [2, 47, -0, 2.5, 1e30, NaN, Infinity]) {
    const text = "a".repeat(offset) + value + "b".repeat(11 - offset);
    const actual = measureSaveStateJsonAscii(version, text);
    if (actual.stateChecksum !== computeSaveStateChecksumFromJson(version, text) || actual.byteLength !== new TextEncoder().encode(text).byteLength) throw Error("Boundary vector differs");
    vectors++;
  }
  const after = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(persistent))));
  const hash = (bytes: Uint8Array) => [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  if (hash(before) !== hash(after)) throw Error("Input projection changed");
  return { scope: "Experimental UTF-16 checksum and UTF-8 sizing only; no storage, page latency or memory qualification", entityCount: state.entities.length, beltCount: state.belts.length,
    stateJsonSha256: hash(before), originalUnchanged: true, vectors, samples };
}
Object.assign(globalThis, { runSaveStateMeasure });
