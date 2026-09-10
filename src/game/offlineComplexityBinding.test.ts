/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "./engine";
import { bindOfflineComplexity, matchingOfflineComplexity } from "./offlineComplexityBinding";
import * as complexityModule from "./offlineComplexity";
import { runOfflineSimulationInWorkerDetailed, type OfflineSimulationWorkerRequest } from "./offlineSimulation";
import type { DeferredLoadedGame } from "./storage";

function source(): DeferredLoadedGame {
  return { state: createInitialState(), savedAt: 1800000000000, offlineSeconds: 600, offlineReport: null, recovery: { source: "primary", issues: [] } };
}

function classifiedPrompt(loaded = source()) {
  const report = complexityModule.classifyOfflineWorkload(loaded.state, loaded.offlineSeconds);
  return { loaded, report, binding: bindOfflineComplexity(loaded, report) };
}

class WaitingWorker {
  static instances: WaitingWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: OfflineSimulationWorkerRequest[] = [];
  terminated = false;
  constructor() { WaitingWorker.instances.push(this); }
  postMessage(message: OfflineSimulationWorkerRequest) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); WaitingWorker.instances = []; });

describe("menu offline complexity identity binding", () => {
  it("reuses the report only for the immutable source shown by the current prompt", () => {
    const prompt = classifiedPrompt();
    expect(matchingOfflineComplexity(prompt.loaded, prompt.binding)).toBe(prompt.report);
    expect(matchingOfflineComplexity({ ...prompt.loaded }, prompt.binding)).toBeUndefined();
    expect(matchingOfflineComplexity(prompt.loaded)).toBeUndefined();
  });

  it.each([
    ["state", (loaded: DeferredLoadedGame) => { loaded.state = { ...loaded.state }; }],
    ["seconds", (loaded: DeferredLoadedGame) => { loaded.offlineSeconds += 1; }],
    ["savedAt", (loaded: DeferredLoadedGame) => { loaded.savedAt += 1; }],
    ["recovery source", (loaded: DeferredLoadedGame) => { loaded.recovery!.source = "backup"; }],
    ["recovery identity", (loaded: DeferredLoadedGame) => { loaded.recovery = { ...loaded.recovery! }; }],
  ] as const)("declines reuse when %s changes on the existing load wrapper", (_name, change) => {
    const prompt = classifiedPrompt();
    change(prompt.loaded);
    expect(matchingOfflineComplexity(prompt.loaded, prompt.binding)).toBeUndefined();
  });

  it("reuses the prompt report without rescanning, and cancelling never changes its source", async () => {
    vi.stubGlobal("Worker", WaitingWorker);
    const prompt = classifiedPrompt();
    const before = JSON.stringify(prompt.loaded);
    const classify = vi.spyOn(complexityModule, "classifyOfflineWorkload");
    const onComplexity = vi.fn();
    const controller = new AbortController();
    const pending = runOfflineSimulationInWorkerDetailed(prompt.loaded.state, prompt.loaded.offlineSeconds, {
      approximate: true, complexity: matchingOfflineComplexity(prompt.loaded, prompt.binding), signal: controller.signal, onComplexity,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(classify).not.toHaveBeenCalled();
    expect(onComplexity).toHaveBeenCalledWith(prompt.report);
    expect(WaitingWorker.instances[0].messages[0]).toMatchObject({ type: "start", seconds: 600, approximate: true });
    controller.abort();
    await rejected;
    expect(WaitingWorker.instances[0].terminated).toBe(true);
    expect(JSON.stringify(prompt.loaded)).toBe(before);
  });

  it("rescans a changed boundary through the existing Worker entrypoint", async () => {
    vi.stubGlobal("Worker", WaitingWorker);
    const prompt = classifiedPrompt();
    prompt.loaded.offlineSeconds = 700;
    const classify = vi.spyOn(complexityModule, "classifyOfflineWorkload");
    const controller = new AbortController();
    const pending = runOfflineSimulationInWorkerDetailed(prompt.loaded.state, prompt.loaded.offlineSeconds, {
      approximate: true, complexity: matchingOfflineComplexity(prompt.loaded, prompt.binding), signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(classify).toHaveBeenCalledExactlyOnceWith(prompt.loaded.state, 700);
    controller.abort(); await rejected;
  });

  it("preserves exact selection even when the displayed recommendation is conservative", async () => {
    vi.stubGlobal("Worker", WaitingWorker);
    const loaded = source();
    const report = complexityModule.classifyOfflineWorkload(loaded.state, loaded.offlineSeconds, { serializedBytes: 128 * 1024 * 1024 });
    expect(report.recommendedStrategy).toBe("conservative");
    const binding = bindOfflineComplexity(loaded, report);
    const controller = new AbortController();
    const pending = runOfflineSimulationInWorkerDetailed(loaded.state, loaded.offlineSeconds, {
      approximate: false, complexity: matchingOfflineComplexity(loaded, binding), signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(WaitingWorker.instances[0].messages[0]).toMatchObject({ type: "start", approximate: false, conservativeOnly: false });
    expect(WaitingWorker.instances[0].messages[0]).not.toHaveProperty("deadlineMs", expect.any(Number));
    controller.abort(); await rejected;
  });
});
