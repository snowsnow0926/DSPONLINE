import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("main-owned authority clock App wiring", () => {
  it("binds the optional read-only clock to the already-open native controller session", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");

    expect(app).toMatch(/new NativePlayerAuthorityClockController\(desktopBridge\)/);
    expect(app).toMatch(/useSyncExternalStore\([\s\S]*?nativePlayerAuthorityClock\.subscribe/);
    expect(app).toMatch(/nativeCoreProjectionSessionId = windowsNativeCoreBetaControllerRef\.current\.snapshot\(\)\.authority\.sessionId/);
    expect(app).toMatch(/nativePlayerAuthorityClock\.bindSession\(nativeCoreProjectionSessionId\)/);
    expect(app).toMatch(/selectActiveNativePlayerAuthorityFrame\([\s\S]*?nativeCoreProjectionSessionId/);
    expect(app).toMatch(/selectBoundNativePlayerAuthorityFrame\([\s\S]*?nativeCoreProjectionSessionId/);
    expect(app).toMatch(/selectNativePlayerAuthorityMacroStatus\([\s\S]*?nativePlayerAuthorityClockSnapshot,[\s\S]*?nativeCoreProjectionSessionId/);
  });

  it("uses the Rust authority revision without allowing the JS revision to overwrite it", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const expectedRevisionAssignment = app.slice(
      app.indexOf("const factoryThinViewExpectedRevision"),
      app.indexOf("const factoryThinViewAllSelectedEntityIds"),
    );

    expect(expectedRevisionAssignment).toMatch(/nativePlayerAuthorityBoundFrame\?\.revision \?\?[\s\S]*?simulationStateRevisionRef\.current/);
    expect(expectedRevisionAssignment).toMatch(/nativePlayerAuthorityActiveFrame[\s\S]*?"native-authoritative"/);
    expect(expectedRevisionAssignment).toMatch(/nativePlayerAuthorityBoundFrame[\s\S]*?"native-authoritative-paused"/);
    expect(expectedRevisionAssignment.indexOf("nativePlayerAuthorityBoundFrame?.revision")).toBeLessThan(
      expectedRevisionAssignment.indexOf("simulationStateRevisionRef.current"),
    );
  });

  it("reads authority projections only for an active exact-session frame and holds terminal frames", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const refreshEffect = app.slice(
      app.indexOf("if (nativeFactoryThinViewMode === \"native-authoritative-paused\")"),
      app.indexOf("const simulationProjectionIndexRef"),
    );

    expect(refreshEffect).toMatch(/native-authoritative-paused[\s\S]*?return;/);
    expect(refreshEffect).toMatch(/nativeFactoryThinViewMode === "native-authoritative"[\s\S]*?createNativePlayerAuthorityProjectionSource\([\s\S]*?desktopBridge[\s\S]*?nativePlayerAuthorityActiveFrame\?\.sessionId/);
    expect(refreshEffect).toMatch(/nativeFactoryThinViewStore\.refresh\(projectionSource,[\s\S]*?expectedRevision:\s*factoryThinViewExpectedRevision/);
    expect(refreshEffect).not.toMatch(/applyNativeCoreCommand|advanceNativeCore|commitNativeCoreOperation|checkpointNativeCore/);
  });

  it("holds every macro push or pull as read-only without projection, command, or JS simulation fallback", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const modeBlock = app.slice(
      app.indexOf("const nativeFactoryThinViewMode"),
      app.indexOf("const nativeFactoryThinViewActive"),
    );
    expect(modeBlock).toMatch(/nativePlayerAuthorityMacroReadOnly[\s\S]*?"native-authoritative-paused"/);
    expect(modeBlock.indexOf("nativePlayerAuthorityMacroReadOnly")).toBeLessThan(
      modeBlock.indexOf("nativePlayerAuthorityActiveFrame"),
    );
    expect(modeBlock.indexOf("nativePlayerAuthorityMacroReadOnly")).toBeLessThan(
      modeBlock.indexOf("javascript-shadow"),
    );

    const refreshEffects = app.slice(
      app.indexOf("if (nativeFactoryThinViewMode === \"native-authoritative-paused\")"),
      app.indexOf("const simulationProjectionIndexRef"),
    );
    const pausedReturn = refreshEffects.indexOf("return;");
    const factoryProjection = refreshEffects.indexOf("createNativePlayerAuthorityProjectionSource(");
    expect(pausedReturn).toBeGreaterThanOrEqual(0);
    expect(factoryProjection).toBeGreaterThan(pausedReturn);
    for (const sourceName of [
      "createNativePlayerAuthorityTechnologyProjectionSource(",
      "createNativePlayerAuthorityRecipeWorkspaceProjectionSource(",
      "createNativePlayerAuthorityCommandPaletteEntitySearchSource(",
    ]) {
      const sourceIndex = refreshEffects.indexOf(sourceName);
      expect(sourceIndex).toBeGreaterThanOrEqual(0);
      expect(refreshEffects.lastIndexOf("!nativePlayerAuthorityActiveFrame", sourceIndex))
        .toBeGreaterThanOrEqual(0);
    }
    const stellarBinding = app.slice(
      app.indexOf("const nativeStellarProjectionIdentity"),
      app.indexOf("const nativeStarMapWorkspaceReadModel"),
    );
    expect(stellarBinding).toMatch(/nativePlayerAuthorityActiveFrame\?\.sessionId[\s\S]*?: null/);
    expect(stellarBinding).toMatch(/nativeStellarProjectionIdentity[\s\S]*?createNativePlayerAuthorityStellarProjectionSource[\s\S]*?: null/);
    expect(refreshEffects).toMatch(/!nativeStellarProjectionIdentity \|\|[\s\S]*?!nativeStellarProjectionSource\) return/);

    const simulationLoop = app.slice(
      app.indexOf("let previous = performance.now();"),
      app.indexOf("// Keep the autosave timer responsive"),
    );
    const macroStop = simulationLoop.indexOf("if (nativePlayerAuthorityOwnsRuntimeRef.current)");
    expect(macroStop).toBeGreaterThanOrEqual(0);
    expect(simulationLoop.indexOf("return;", macroStop)).toBeLessThan(
      simulationLoop.indexOf("simulationWorkerRef.current"),
    );
    expect(simulationLoop.indexOf("return;", macroStop)).toBeLessThan(
      simulationLoop.indexOf("advanceSimulationBudget("),
    );

    const editGuard = app.slice(
      app.indexOf("const rejectPlayerStateEditDuringPrimarySave"),
      app.indexOf("const lifecycleExitStartedRef"),
    );
    expect(editGuard).toMatch(/nativePlayerAuthorityMacroReadOnlyRef\.current[\s\S]*?本次操作未应用[\s\S]*?return true/);
  });

  it("narrows every second authority pull to v1 before reading identity fields", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const locateProduction = app.slice(
      app.indexOf("const locateRecipeWorkspaceProduction"),
      app.indexOf("const itemReferenceActions"),
    );
    const pull = locateProduction.indexOf("getNativePlayerAuthorityState()");
    const schemaGuard = locateProduction.indexOf("clock.schemaVersion !== 1", pull);
    const identityRead = locateProduction.indexOf("clock.sessionId", pull);
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(schemaGuard).toBeGreaterThan(pull);
    expect(identityRead).toBeGreaterThan(schemaGuard);
    expect(locateProduction).not.toMatch(/nativePlayerAuthorityMacroStatus\??\.(?:sessionId|runId|macroSessionId|operationId|algorithmVersion|lastErrorCode)/);
  });

  it("renders only bounded macro scalars and no authority identity", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const display = app.slice(
      app.indexOf("const nativePlayerAuthorityMacroDisplay"),
      app.indexOf("const nativeFactoryThinViewStoreRef"),
    );
    expect(display).toMatch(/status\.phase/);
    expect(display).toMatch(/status\.simulationProgressMilliseconds[\s\S]*?status\.simulationBudgetMilliseconds/);
    expect(display).toMatch(/status\.wallProgressMilliseconds[\s\S]*?status\.wallBudgetMilliseconds/);
    expect(display).toMatch(/status\.nextDeadlineMs/);
    expect(display).toMatch(/status\.pausedReason/);
    expect(display).not.toMatch(/sessionId|runId|macroSessionId|operationId|algorithmVersion|lastErrorCode/);

    const bannerStart = app.indexOf('className="paused native-player-authority-macro-status"');
    const banner = app.slice(bannerStart, app.indexOf("</span>", bannerStart));
    expect(bannerStart).toBeGreaterThanOrEqual(0);
    expect(banner).toMatch(/data-phase=[\s\S]*?data-deadline-ms=[\s\S]*?data-paused-reason=/);
    expect(banner).toMatch(/模拟进度[\s\S]*?墙钟进度[\s\S]*?截止时钟[\s\S]*?暂停原因/);
    expect(banner).not.toMatch(/sessionId|runId|macroSessionId|operationId|algorithmVersion|lastErrorCode/);
  });

  it("keeps this as consumer/revision wiring rather than claiming a complete thin UI", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const clock = readFileSync(resolve("src/game/nativePlayerAuthorityClock.ts"), "utf8");

    expect(app).toMatch(/createWebFactoryViewportReadModel\(game/);
    expect(app).toMatch(/createWebFactoryConstructionWorkspaceReadModel\(game\)/);
    expect(clock).not.toMatch(/GameState|applyNativeCoreCommand|advanceNativeCore|commitNativeCoreOperation/);
    expect(clock).toMatch(/read-only source/i);
  });
});
