import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

type Outcome = "committed" | "pending" | "not-committed" | "conflict" | "unavailable";

// Audit-only lift of the scheduling portion of the App effect. Terminal state
// mutations are irrelevant here; this probe checks only attempts/timers/cancel.
function installLoop(reconcile: () => Promise<Outcome>, notice: () => void): () => void {
  let cancelled = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = 250;
  let reconciliationAttempts = 0;
  const scheduleRetry = () => {
    if (cancelled) return;
    if (reconciliationAttempts >= 8) {
      notice();
      return;
    }
    retryTimer = setTimeout(runReconciliation, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
  };
  const runReconciliation = () => {
    if (cancelled) return;
    reconciliationAttempts += 1;
    void reconcile().then((outcome) => {
      if (cancelled) return;
      if (outcome === "pending" || outcome === "unavailable") scheduleRetry();
    });
  };
  runReconciliation();
  return () => {
    cancelled = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
  };
}

describe("audit-only native blueprint reconciliation retry loop", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs exactly eight unavailable lookups per generation and leaves no timer", async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn(async () => "unavailable" as const);
    const notice = vi.fn();
    const cleanup = installLoop(reconcile, notice);
    await vi.runAllTimersAsync();
    expect(reconcile).toHaveBeenCalledTimes(8);
    expect(notice).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    cleanup();
    const cleanupNextGeneration = installLoop(reconcile, notice);
    await vi.runAllTimersAsync();
    expect(reconcile).toHaveBeenCalledTimes(16);
    expect(notice).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    cleanupNextGeneration();
  });

  it("cancels an old generation and never retries terminal outcomes", async () => {
    vi.useFakeTimers();
    let resolve!: (value: Outcome) => void;
    const pendingLookup = vi.fn(() => new Promise<Outcome>((done) => { resolve = done; }));
    const notice = vi.fn();
    const cleanup = installLoop(pendingLookup, notice);
    cleanup();
    resolve("unavailable");
    await Promise.resolve();
    expect(pendingLookup).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(notice).not.toHaveBeenCalled();

    for (const outcome of ["committed", "not-committed", "conflict"] as const) {
      const reconcile = vi.fn(async () => outcome);
      const stop = installLoop(reconcile, notice);
      await Promise.resolve();
      await vi.runAllTimersAsync();
      expect(reconcile).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      stop();
    }
  });

  it("statically binds the production effect to the intended authority generation", () => {
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    const block = app.slice(app.indexOf("let reconciliationAttempts = 0"), app.indexOf("const nativePlacementLabel"));
    expect(block).toMatch(/reconciliationAttempts >= 8/);
    expect(block).toMatch(/retryDelayMs = Math\.min\(retryDelayMs \* 2, 5_000\)/);
    expect(block).toMatch(/nativePlayerAuthorityActiveFrame\?\.revision/);
    expect(block).toMatch(/nativePlayerAuthorityActiveFrame\?\.runId/);
    expect(block).toMatch(/nativePlayerAuthorityActiveFrame\?\.sessionId/);
    expect(block).toMatch(/nativePlayerAuthorityCommandPending/);
    expect(block).toMatch(/nativePlayerAuthorityOwnsRuntime/);
  });
});
