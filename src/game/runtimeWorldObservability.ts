import type { SimulationProfiler } from "./engine";

export const RUNTIME_WORLD_PROFILE_MODES = ["cold", "hot", "continuous"] as const;
export type RuntimeWorldProfileMode = typeof RUNTIME_WORLD_PROFILE_MODES[number];

export const RUNTIME_WORLD_M0_PHASES = [
  "compile",
  "command-patch",
  "command-apply",
  "domain-invalidation",
  "engine-domain",
  "journal",
  "projection",
  "post-message",
  "main-merge",
  "react-commit",
  "paint",
  "save-worker",
  "idb-write",
] as const;

export type RuntimeWorldM0Phase = typeof RUNTIME_WORLD_M0_PHASES[number];

export interface RuntimeWorldProfileIdentity {
  gitSha: string;
  runtimeId: string;
  machineId: string;
  operatingSystem: string;
  browser: string;
  browserMode: "headless" | "headed";
  buildMode: "development" | "production-preview";
  powerMode: string;
  fixtureId: string;
}

export interface RuntimeWorldProfileSample {
  identity: RuntimeWorldProfileIdentity;
  mode: RuntimeWorldProfileMode;
  phases: Partial<Record<RuntimeWorldM0Phase, number>>;
  totalMs: number;
}

export interface RuntimeWorldPhaseSummary {
  samples: number;
  medianMs: number;
  p95Ms: number;
  baselineMedianMs?: number;
  relativeToBaseline?: number;
}

export const RUNTIME_WORLD_MAIN_PHASE_BINDINGS: Readonly<Record<Exclude<RuntimeWorldM0Phase,
  "compile" | "command-apply" | "domain-invalidation" | "engine-domain" | "journal" | "projection">, string>> = {
  "command-patch": "runtimeworld-command-patch",
  "post-message": "runtimeworld-post-message",
  "main-merge": "worker-projection-apply",
  "react-commit": "react-layout-commit",
  paint: "second-painted-frame",
  "save-worker": "runtimeworld-save-worker",
  "idb-write": "runtimeworld-idb-write",
};

function finiteDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Project Worker-only numeric phases without encoding or retaining records. */
export function runtimeWorldWorkerPhaseDurations(profiler: SimulationProfiler): Partial<Record<RuntimeWorldM0Phase, number>> {
  return {
    compile: finiteDuration(profiler.compileMs),
    "command-apply": finiteDuration(profiler.commandApplyMs),
    "domain-invalidation": finiteDuration(profiler.domainInvalidationMs),
    "engine-domain": finiteDuration(profiler.engineDomainMs),
    journal: finiteDuration(profiler.journalMs),
    projection: finiteDuration(profiler.projectionMs),
  };
}

function identityDifference(left: RuntimeWorldProfileIdentity, right: RuntimeWorldProfileIdentity): string | undefined {
  for (const key of Object.keys(left) as Array<keyof RuntimeWorldProfileIdentity>) {
    if (left[key] !== right[key]) return key;
  }
  return undefined;
}

/** Prevent accidental cross-machine/dev-preview percentage claims. */
export function assertRuntimeWorldSamplesComparable(samples: readonly RuntimeWorldProfileSample[]): void {
  const first = samples[0];
  if (!first) throw new Error("RuntimeWorld profile report requires at least one sample");
  for (const sample of samples.slice(1)) {
    const difference = identityDifference(first.identity, sample.identity);
    if (difference) throw new Error(`RuntimeWorld profile identity mismatch: ${difference}`);
    if (sample.mode !== first.mode) throw new Error("RuntimeWorld profile report cannot mix cold/hot/continuous modes");
  }
}

function percentile(values: readonly number[], ratio: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))] ?? 0;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

/** Always reports absolute timings; relative values exist only beside a comparable baseline. */
export function summarizeRuntimeWorldPhase(
  samples: readonly RuntimeWorldProfileSample[],
  phase: RuntimeWorldM0Phase,
  baseline: readonly RuntimeWorldProfileSample[] = [],
): RuntimeWorldPhaseSummary {
  assertRuntimeWorldSamplesComparable(samples);
  if (baseline.length > 0) {
    assertRuntimeWorldSamplesComparable(baseline);
    const difference = identityDifference(samples[0].identity, baseline[0].identity);
    if (difference) throw new Error(`RuntimeWorld baseline identity mismatch: ${difference}`);
    if (samples[0].mode !== baseline[0].mode) throw new Error("RuntimeWorld baseline mode mismatch");
  }
  const values = samples.map((sample) => finiteDuration(sample.phases[phase] ?? 0));
  const medianMs = percentile(values, 0.5);
  const result: RuntimeWorldPhaseSummary = {
    samples: values.length,
    medianMs: round(medianMs),
    p95Ms: round(percentile(values, 0.95)),
  };
  if (baseline.length > 0) {
    const baselineMedianMs = percentile(baseline.map((sample) => finiteDuration(sample.phases[phase] ?? 0)), 0.5);
    result.baselineMedianMs = round(baselineMedianMs);
    result.relativeToBaseline = Number((baselineMedianMs > 0 ? medianMs / baselineMedianMs - 1 : 0).toFixed(4));
  }
  return result;
}

export interface RuntimeWorldProfilerOverheadSummary {
  diagnosticsOffMedianMs: number;
  diagnosticsOnMedianMs: number;
  overheadRatio: number;
}

export function summarizeRuntimeWorldProfilerOverhead(
  diagnosticsOffMs: readonly number[],
  diagnosticsOnMs: readonly number[],
): RuntimeWorldProfilerOverheadSummary {
  if (diagnosticsOffMs.length === 0 || diagnosticsOnMs.length === 0) {
    throw new Error("RuntimeWorld profiler overhead requires paired non-empty samples");
  }
  const off = percentile(diagnosticsOffMs.map(finiteDuration), 0.5);
  const on = percentile(diagnosticsOnMs.map(finiteDuration), 0.5);
  return {
    diagnosticsOffMedianMs: round(off),
    diagnosticsOnMedianMs: round(on),
    overheadRatio: Number((off > 0 ? on / off - 1 : 0).toFixed(4)),
  };
}

