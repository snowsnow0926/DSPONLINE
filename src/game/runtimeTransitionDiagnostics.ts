export type RuntimeTransitionName = "resume" | "pause" | "autosave" | "pure-idle-stop";

export interface RuntimeTransitionDiagnosticEvent {
  phase: string;
  startedAt: number;
  durationMs: number;
  transition?: RuntimeTransitionName;
  detail?: Record<string, number | string | boolean | null>;
}

export interface RuntimeTransitionDiagnosticState {
  enabled: boolean;
  events: RuntimeTransitionDiagnosticEvent[];
  active: Partial<Record<RuntimeTransitionName, number>>;
  counters?: Record<string, { count: number; totalMs: number; maxMs: number }>;
}

declare global {
  interface Window {
    __DSP_RUNTIME_TRANSITIONS__?: RuntimeTransitionDiagnosticState;
  }
}

const MAX_EVENTS = 500;

function state(): RuntimeTransitionDiagnosticState | null {
  if (typeof window === "undefined") return null;
  const diagnostics = window.__DSP_RUNTIME_TRANSITIONS__;
  return diagnostics?.enabled ? diagnostics : null;
}

function addCounter(
  diagnostics: RuntimeTransitionDiagnosticState,
  phase: string,
  durationMs: number,
): void {
  diagnostics.counters ??= {};
  const current = diagnostics.counters[phase] ?? { count: 0, totalMs: 0, maxMs: 0 };
  current.count += 1;
  current.totalMs += Math.max(0, durationMs);
  current.maxMs = Math.max(current.maxMs, durationMs);
  diagnostics.counters[phase] = current;
}

export function runtimeTransitionDiagnosticsEnabled(): boolean {
  return state() !== null;
}

export function beginRuntimeTransition(transition: RuntimeTransitionName): void {
  const diagnostics = state();
  if (!diagnostics) return;
  if (diagnostics.active[transition] !== undefined) return;
  const startedAt = performance.now();
  diagnostics.active[transition] = startedAt;
  recordRuntimeTransitionPhase("transition-start", startedAt, 0, undefined, transition);
}

export function recordRuntimeTransitionPhase(
  phase: string,
  startedAt: number,
  durationMs = performance.now() - startedAt,
  detail?: RuntimeTransitionDiagnosticEvent["detail"],
  transition?: RuntimeTransitionName,
): void {
  const diagnostics = state();
  if (!diagnostics) return;
  const boundedDurationMs = Math.max(0, durationMs);
  diagnostics.events.push({
    phase,
    startedAt,
    durationMs: boundedDurationMs,
    ...(transition ? { transition } : {}),
    ...(detail ? { detail } : {}),
  });
  addCounter(diagnostics, phase, boundedDurationMs);
  if (diagnostics.events.length > MAX_EVENTS) diagnostics.events.splice(0, diagnostics.events.length - MAX_EVENTS);
}

export function recordActiveRuntimeTransitionPhase(
  phase: string,
  detail?: RuntimeTransitionDiagnosticEvent["detail"],
): void {
  const diagnostics = state();
  if (!diagnostics) return;
  const now = performance.now();
  for (const transition of ["resume", "pause", "autosave", "pure-idle-stop"] as const) {
    const startedAt = diagnostics.active[transition];
    if (startedAt === undefined) continue;
    recordRuntimeTransitionPhase(phase, startedAt, now - startedAt, detail, transition);
  }
}

export function recordRuntimeTransitionCounter(phase: string, durationMs: number): void {
  const diagnostics = state();
  if (!diagnostics) return;
  addCounter(diagnostics, phase, durationMs);
}

export function completeRuntimeTransition(
  transition: RuntimeTransitionName,
  phase: string,
  detail?: RuntimeTransitionDiagnosticEvent["detail"],
): void {
  const diagnostics = state();
  const startedAt = diagnostics?.active[transition];
  if (!diagnostics || startedAt === undefined) return;
  recordRuntimeTransitionPhase(phase, startedAt, performance.now() - startedAt, detail, transition);
  delete diagnostics.active[transition];
}

export function measureRuntimeTransitionPhase<T>(
  phase: string,
  operation: () => T,
  detail?: RuntimeTransitionDiagnosticEvent["detail"],
): T {
  const diagnostics = state();
  if (!diagnostics) return operation();
  const startedAt = performance.now();
  try {
    return operation();
  } finally {
    recordRuntimeTransitionPhase(phase, startedAt, performance.now() - startedAt, detail);
  }
}

export function installRuntimeLongTaskDiagnostics(): () => void {
  const diagnostics = state();
  if (!diagnostics || typeof PerformanceObserver === "undefined") return () => undefined;
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordRuntimeTransitionPhase("main-thread-longtask", entry.startTime, entry.duration, { name: entry.name });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    return () => undefined;
  }
  return () => observer?.disconnect();
}
