// Keep ordinary deadlines while allowing bounded waits during Idle validation.
export function startupTimeoutMs(normalTimeoutMs: number): number {
  return process.env.DSP_E2E_LOW_RESOURCE === "1" ? Math.max(normalTimeoutMs, 60_000) : normalTimeoutMs;
}
