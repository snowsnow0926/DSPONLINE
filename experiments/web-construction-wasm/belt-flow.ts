import { applyBeltFlowObservations, BeltFlowSampler } from "../../src/game/beltFlow";
import type { GameState } from "../../src/game/types";

async function stateHash(state: GameState): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(state));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// UI projection only: synthetic constant rates exercise the stable window on
// the real topology. No production, materials or persistence are advanced.
async function runBeltFlowProbe() {
  const initial = (await (await fetch("/prepared.json")).json()).state as GameState;
  const initialSha256 = await stateHash(initial);
  const sampler = new BeltFlowSampler();
  const compatibleSampler = sampler as BeltFlowSampler & {
    consumeChangedIndexes?: () => number[];
    consumeProjectionIndexes?: () => number[];
  };
  const rows = [];
  for (const second of [0, 1, 5, 6, 9, 12]) {
    const state = {
      ...initial,
      elapsedSeconds: initial.elapsedSeconds + second,
      belts: initial.belts.map((belt, index) => {
        const rate = index % 17;
        return { ...belt, totalTransferred: Math.max(0, Math.floor(belt.totalTransferred ?? 0)) + rate * second,
          lastFlow: rate * 0.8, recentFlowSampleSeconds: undefined,
          recentFlowTransferred: undefined, recentFlowSampling: undefined };
      }),
    };
    const inputBeforeSha256 = await stateHash(state);
    const started = performance.now();
    const observations = sampler.sample(state, { planetId: state.activePlanetId });
    const indexes = compatibleSampler.consumeProjectionIndexes?.() ?? compatibleSampler.consumeChangedIndexes?.();
    const observed = applyBeltFlowObservations(state, observations, state.activePlanetId, indexes);
    const projectionMs = performance.now() - started;
    const expected = applyBeltFlowObservations(state, observations, state.activePlanetId);
    const actualSha256 = await stateHash(observed);
    const expectedSha256 = await stateHash(expected);
    const inputAfterSha256 = await stateHash(state);
    rows.push({ second, projectionMs, observations: observations.size, projectionIndexes: indexes?.length ?? null,
      actualSha256, expectedSha256, projectionMatchesFullPass: actualSha256 === expectedSha256,
      inputBeforeSha256, inputAfterSha256, inputUnchanged: inputBeforeSha256 === inputAfterSha256 });
  }
  const sourceUnchanged = initialSha256 === await stateHash(initial);
  return { probeKind: "isolated-synthetic-flow-on-real-topology", entities: initial.entities.length,
    belts: initial.belts.length, initialSha256, sourceUnchanged, rows,
    passed: sourceUnchanged && rows.every((row) => row.projectionMatchesFullPass && row.inputUnchanged) };
}

Object.assign(globalThis, { runBeltFlowProbe });
