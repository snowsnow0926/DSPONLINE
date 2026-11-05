// Keep ordinary deadlines while allowing bounded waits during Idle validation.
export function startupTimeoutMs(normalTimeoutMs: number): number {
  return process.env.DSP_E2E_LOW_RESOURCE === "1" ? Math.max(normalTimeoutMs, 180_000) : normalTimeoutMs;
}

// Workflow deadlines include repeated cold module loading under the Idle profile.
// State, input timing, performance and per-operation assertions stay unchanged.
export function workflowTimeoutMs(normalTimeoutMs: number): number {
  return process.env.DSP_E2E_LOW_RESOURCE === "1"
    ? Math.max(180_000, normalTimeoutMs * 3)
    : normalTimeoutMs;
}
