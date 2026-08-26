import { afterEach, describe, expect, it } from "vitest";
import {
  beginRuntimeTransition,
  completeRuntimeTransition,
  measureRuntimeTransitionPhase,
  recordActiveRuntimeTransitionPhase,
  recordRuntimeTransitionPhase,
  trackRuntimeRetentionReference,
  type RuntimeTransitionDiagnosticState,
} from "./runtimeTransitionDiagnostics";

describe("runtime transition diagnostics", () => {
  const originalWindow = globalThis.window;
  afterEach(() => Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }));

  it("is inert unless an explicit diagnostics sink is enabled", () => {
    const productionWindow: { __DSP_RUNTIME_TRANSITIONS__?: RuntimeTransitionDiagnosticState } = {};
    Object.defineProperty(globalThis, "window", { configurable: true, value: productionWindow });
    beginRuntimeTransition("autosave");
    expect(measureRuntimeTransitionPhase("noop", () => 7)).toBe(7);
    recordActiveRuntimeTransitionPhase("noop-active");
    completeRuntimeTransition("autosave", "noop-complete");
    expect(productionWindow.__DSP_RUNTIME_TRANSITIONS__).toBeUndefined();
  });

  it("records bounded transition and measured phase timings", () => {
    const diagnostics: RuntimeTransitionDiagnosticState = { enabled: true, events: [], active: {} };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __DSP_RUNTIME_TRANSITIONS__: diagnostics } });
    beginRuntimeTransition("resume");
    expect(measureRuntimeTransitionPhase("projection-apply", () => "ok", { entities: 12 })).toBe("ok");
    recordActiveRuntimeTransitionPhase("react-layout-commit");
    completeRuntimeTransition("resume", "first-frame");
    expect(diagnostics.events.map((event) => event.phase)).toEqual([
      "transition-start",
      "projection-apply",
      "react-layout-commit",
      "first-frame",
    ]);
    expect(diagnostics.active.resume).toBeUndefined();
  });

  it("keeps the first start boundary when a nested persistence phase reuses a transition", () => {
    const diagnostics: RuntimeTransitionDiagnosticState = { enabled: true, events: [], active: {} };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __DSP_RUNTIME_TRANSITIONS__: diagnostics } });
    beginRuntimeTransition("pure-idle-stop");
    const startedAt = diagnostics.active["pure-idle-stop"];
    beginRuntimeTransition("pure-idle-stop");
    expect(diagnostics.active["pure-idle-stop"]).toBe(startedAt);
    expect(diagnostics.events.filter((event) => event.phase === "transition-start")).toHaveLength(1);
  });

  it("keeps aggregate counters after bounded raw events are evicted", () => {
    const diagnostics: RuntimeTransitionDiagnosticState = { enabled: true, events: [], active: {} };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __DSP_RUNTIME_TRANSITIONS__: diagnostics } });
    for (let index = 0; index < 505; index += 1) {
      recordRuntimeTransitionPhase(`phase-${index}`, index, index);
    }
    expect(diagnostics.events).toHaveLength(500);
    expect(diagnostics.events[0].phase).toBe("phase-5");
    expect(diagnostics.counters?.["phase-0"]).toMatchObject({ count: 1, totalMs: 0, maxMs: 0 });
    expect(diagnostics.counters?.["phase-504"]).toMatchObject({ count: 1, totalMs: 504, maxMs: 504 });
  });

  it("tracks diagnostic generations through weak references", () => {
    const diagnostics: RuntimeTransitionDiagnosticState = { enabled: true, events: [], active: {} };
    const diagnosticWindow: Pick<Window, "__DSP_RUNTIME_TRANSITIONS__" | "__DSP_RUNTIME_RETENTION__"> = {
      __DSP_RUNTIME_TRANSITIONS__: diagnostics,
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: diagnosticWindow });
    const target = {};
    trackRuntimeRetentionReference("projection", target);
    expect(diagnosticWindow.__DSP_RUNTIME_RETENTION__?.groups.projection.totalTracked).toBe(1);
    expect(diagnosticWindow.__DSP_RUNTIME_RETENTION__?.groups.projection.entries[0].reference.deref()).toBe(target);
  });
});
