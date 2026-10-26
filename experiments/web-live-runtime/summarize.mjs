import { readFile } from "node:fs/promises";

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  return {
    count: sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted.at(-1),
  };
}

for (const path of process.argv.slice(2)) {
  const evidence = JSON.parse(await readFile(path, "utf8"));
  const { trace } = evidence;
  if (!trace) throw Error(`Missing complete runtime evidence: ${path}`);
  const phases = [...new Set(trace.frames.map((frame) => frame.phase))].map((phase) => {
    const frames = trace.frames.filter((frame) => frame.phase === phase);
    return { phase, frameGapMs: distribution(frames.map((frame) => frame.gap)),
      framesOver50Ms: frames.filter((frame) => frame.gap > 50).length };
  });
  const regular = trace.events.filter((event) => event.type === "factory-response" && event.phase === "warmup");
  const macros = trace.events.filter((event) => event.summary);
  const profileTotals = {};
  for (const event of regular) for (const [key, value] of Object.entries(event.profiler ?? {})) {
    if (key.endsWith("Ms")) profileTotals[key] = (profileTotals[key] ?? 0) + value;
  }
  const memories = (evidence.processSamples ?? []).flatMap((sample) => sample.memory ?? []);
  console.log(JSON.stringify({ path, supply: evidence.supply, profiled: evidence.profiled,
    phases, warmup: evidence.warmup, stopMs: evidence.stopMs,
    regularWorkerMs: distribution(regular.map((event) => event.durationMs)),
    regularProfileTotals: Object.fromEntries(Object.entries(profileTotals).sort((a, b) => b[1] - a[1])),
    macroWorkerMs: distribution(macros.filter((event) => event.type === "advanced").map((event) => event.durationMs)),
    firstMacro: macros[0], lastMacro: macros.at(-1),
    maxRendererPeakWorkingSet: memories.length ? Math.max(...memories.map((sample) => sample.PeakWorkingSet64)) : null,
  }, null, 2));
}
