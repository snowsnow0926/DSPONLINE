import { describe, expect, it } from "vitest";
import { createSimulationProfiler } from "./engine";
import {
  assertRuntimeWorldSamplesComparable,
  RUNTIME_WORLD_M0_PHASES,
  RUNTIME_WORLD_MAIN_PHASE_BINDINGS,
  runtimeWorldWorkerPhaseDurations,
  summarizeRuntimeWorldPhase,
  summarizeRuntimeWorldProfilerOverhead,
  type RuntimeWorldProfileIdentity,
  type RuntimeWorldProfileSample,
} from "./runtimeWorldObservability";

const identity: RuntimeWorldProfileIdentity = {
  gitSha: "fixed-sha",
  runtimeId: "node-runtime",
  machineId: "machine-a",
  operatingSystem: "windows",
  browser: "chromium-140",
  browserMode: "headless",
  buildMode: "production-preview",
  powerMode: "balanced",
  fixtureId: "fixture-a",
};

function sample(totalMs: number, engineMs = totalMs): RuntimeWorldProfileSample {
  return { identity, mode: "hot", phases: { "engine-domain": engineMs }, totalMs };
}

describe("RuntimeWorld M0 observability contract", () => {
  it("binds every required phase to a Worker field or main-thread event", () => {
    const worker = runtimeWorldWorkerPhaseDurations(createSimulationProfiler());
    const covered = new Set([...Object.keys(worker), ...Object.keys(RUNTIME_WORLD_MAIN_PHASE_BINDINGS)]);
    expect([...RUNTIME_WORLD_M0_PHASES].filter((phase) => !covered.has(phase))).toEqual([]);
    expect(Object.values(worker).every((value) => value === 0)).toBe(true);
  });

  it("rejects mixed process temperatures and environment identities", () => {
    expect(() => assertRuntimeWorldSamplesComparable([sample(10), { ...sample(11), mode: "cold" }]))
      .toThrow(/cold\/hot\/continuous/);
    expect(() => assertRuntimeWorldSamplesComparable([
      sample(10),
      { ...sample(11), identity: { ...identity, buildMode: "development" } },
    ])).toThrow(/buildMode/);
  });

  it("reports absolute and comparable relative phase values", () => {
    const current = [sample(9, 4), sample(10, 5), sample(12, 6)];
    const baseline = [sample(18, 8), sample(20, 10), sample(22, 12)];
    expect(summarizeRuntimeWorldPhase(current, "engine-domain", baseline)).toEqual({
      samples: 3,
      medianMs: 5,
      p95Ms: 6,
      baselineMedianMs: 10,
      relativeToBaseline: -0.5,
    });
  });

  it("reports paired profiler overhead without hiding absolute timings", () => {
    expect(summarizeRuntimeWorldProfilerOverhead([100, 102, 104], [104, 106, 108])).toEqual({
      diagnosticsOffMedianMs: 102,
      diagnosticsOnMedianMs: 106,
      overheadRatio: 0.0392,
    });
  });
});

