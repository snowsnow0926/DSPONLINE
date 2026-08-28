import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native player-authority command App boundary", () => {
  it("binds one command source to one exact active frame", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const binding = app.slice(
      app.indexOf("const nativePlayerAuthorityOwnsRuntime ="),
      app.indexOf("const nativePlayerAuthorityMacroDisplay"),
    );

    expect(binding).toMatch(/nativePlayerAuthorityBoundFrame !== null/);
    expect(binding).toMatch(/nativePlayerAuthorityMacroStatus !== null/);
    expect(binding).toMatch(/if \(!nativePlayerAuthorityActiveFrame\)[\s\S]*?nativePlayerAuthorityCommandBindingRef\.current = null/);
    expect(binding).toMatch(/commandFrameKey[\s\S]*?sessionId[\s\S]*?runId[\s\S]*?revision[\s\S]*?acknowledgedSequence[\s\S]*?nextSequence[\s\S]*?nextDeadlineMs/);
    expect(binding).toMatch(/commandFrameKey = JSON\.stringify\(\[/);
    expect(binding).not.toMatch(/commandFrameKey[\s\S]*?\.join\(":"\)/);
    expect(binding).toMatch(/createNativePlayerAuthorityCommandSource\([\s\S]*?desktopBridge[\s\S]*?nativePlayerAuthorityActiveFrame/);
  });

  it("routes an accepted edit to Rust before any renderer history or state publication", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const commit = app.slice(
      app.indexOf("const commitGame = useCallback"),
      app.indexOf("useEffect(() => {", app.indexOf("const commitGame = useCallback")),
    );
    const nativeBranch = commit.indexOf("if (nativePlayerAuthorityOwnsRuntimeRef.current)");
    const historyRecord = commit.indexOf("gameHistoryRef.current.record");

    expect(nativeBranch).toBeGreaterThanOrEqual(0);
    expect(historyRecord).toBeGreaterThan(nativeBranch);
    expect(commit).toMatch(/createSimulationCommandPatch\(current, next, binding\.source\.baseRevision\)/);
    expect(commit).toMatch(/binding\.source\.applyCommand\(command\)/);
    expect(commit).toMatch(/does not install `next` or predict the[\s\S]*?bounded projections/);
    expect(commit.slice(nativeBranch, historyRecord)).not.toMatch(/publishRuntimeGame|gameRef\.current\s*=|setGame\(|gameHistoryRef\.current\.record/);
  });

  it("never lets the legacy Worker or scheduler advance beside Rust authority", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const workerGuard = app.indexOf("if (nativePlayerAuthorityOwnsRuntime)");
    const workerEffect = app.slice(
      workerGuard,
      app.indexOf("if (typeof Worker === \"undefined\")", workerGuard),
    );
    expect(workerEffect).toMatch(/simulationWorkerDisabledRef\.current = true/);
    expect(workerEffect).toMatch(/simulationSubmissionRef\.current = null/);
    expect(workerEffect).toMatch(/simulationPendingSecondsRef\.current = 0/);
    expect(workerEffect).toMatch(/return;/);

    const scheduler = app.slice(
      app.indexOf("let previous = performance.now();"),
      app.indexOf("// Keep the autosave timer responsive"),
    );
    const guard = scheduler.indexOf("if (nativePlayerAuthorityOwnsRuntimeRef.current)");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(scheduler.indexOf("return;", guard)).toBeLessThan(
      scheduler.indexOf("simulationWorkerRef.current", guard),
    );
  });

  it("fails closed for still-untyped pause, time-warp and history commands", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    for (const [start, end] of [
      ["const togglePause", "const handleTimeWarpEnabledChange"],
      ["const handleTimeWarpEnabledChange", "const abortPureIdleForWorkerFailure"],
      ["const undoGame", "const redoGame"],
      ["const redoGame", "const clearHistory"],
    ] as const) {
      const block = app.slice(app.indexOf(start), app.indexOf(end));
      expect(block).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?本次操作未应用[\s\S]*?return;/);
    }
  });

  it("keeps contract rollover and persisted viewports behind the native authority boundary", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const contractRollover = app.slice(
      app.indexOf("const synchronizeTaskDay"),
      app.indexOf("const persistPlanetViewport"),
    );
    expect(contractRollover).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?return;/);
    expect(contractRollover.indexOf("nativePlayerAuthorityOwnsRuntimeRef.current")).toBeLessThan(
      contractRollover.indexOf("synchronizeStationContracts"),
    );

    const viewport = app.slice(
      app.indexOf("const persistPlanetViewport"),
      app.indexOf("const undoGame"),
    );
    const nativeBranch = viewport.indexOf("if (nativePlayerAuthorityOwnsRuntimeRef.current)");
    expect(nativeBranch).toBeGreaterThanOrEqual(0);
    expect(viewport.slice(nativeBranch)).toMatch(/commitGame\(\(authoritativeMirror\)[\s\S]*?planetViewports/);
    expect(viewport.slice(nativeBranch, viewport.indexOf("pendingPlanetViewportRef.current.delete", nativeBranch)))
      .not.toMatch(/publishRuntimeGame|gameRef\.current\s*=|setGame\(/);
  });
});
