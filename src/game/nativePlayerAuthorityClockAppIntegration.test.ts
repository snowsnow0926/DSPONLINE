import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("main-owned authority clock App wiring", () => {
  it("binds the read-only clock to a renderer session or a trusted startup-recovered session", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");

    expect(app).toMatch(/new NativePlayerAuthorityClockController\(desktopBridge\)/);
    expect(app).toMatch(/useSyncExternalStore\([\s\S]*?nativePlayerAuthorityClock\.subscribe/);
    expect(app).toMatch(/nativeCoreProjectionSessionId = windowsNativeCoreBetaControllerRef\.current\.snapshot\(\)\.authority\.sessionId/);
    expect(app).toMatch(/current\.currentFrame === null[\s\S]*?nativePlayerAuthorityClock\.bindSession\(nativeCoreProjectionSessionId\)/);
    expect(app).toMatch(/nativePlayerAuthoritySessionId = nativePlayerAuthorityClockSnapshot\.currentFrame\?\.schemaVersion === 2 &&[\s\S]*?nativePlayerAuthorityClockSnapshot\.expectedSessionId === null[\s\S]*?\? null[\s\S]*?: nativePlayerAuthorityClockSnapshot\.expectedSessionId \?\? nativeCoreProjectionSessionId/);
    expect(app).toMatch(/selectActiveNativePlayerAuthorityFrame\([\s\S]*?nativePlayerAuthoritySessionId/);
    expect(app).toMatch(/selectBoundNativePlayerAuthorityFrame\([\s\S]*?nativePlayerAuthoritySessionId/);
    expect(app).toMatch(/selectNativePlayerAuthorityMacroStatus\([\s\S]*?nativePlayerAuthorityClockSnapshot,[\s\S]*?nativePlayerAuthoritySessionId/);
  });

  it("fails closed before the first main-owned authority pull", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    expect(app).toMatch(/nativePlayerAuthorityBootstrapPending = nativePlayerAuthorityClockSupported &&[\s\S]*?availability !== "ready"/);
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime = nativePlayerAuthorityBootstrapPending \|\|/);

    const workerComment = app.indexOf("Main/Rust is now the only mutable runtime");
    const workerGuard = app.lastIndexOf("if (nativePlayerAuthorityOwnsRuntime)", workerComment);
    const workerCreation = app.indexOf("new Worker(", workerComment);
    expect(workerComment).toBeGreaterThanOrEqual(0);
    expect(workerGuard).toBeGreaterThanOrEqual(0);
    expect(workerCreation).toBeGreaterThan(workerGuard);

    const recovery = app.slice(
      app.indexOf("if (nativePlayerAuthorityOwnsRuntime) {\n      setPureIdleRecoveryContinueState"),
      app.indexOf("const backgroundRecovery = await settlePureIdleBackgroundRecovery"),
    );
    expect(recovery.indexOf("if (nativePlayerAuthorityOwnsRuntime)")).toBeLessThan(
      recovery.indexOf("claimPureIdleRecovery("),
    );
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
    expect(app).toMatch(/nativeThinWorkspaceAuthorityFrames = useMemo\([\s\S]*?selectNativePlayerAuthorityWorkspaceFrames/);
    expect(app).toMatch(/nativeTechnologyWorkspaceReadIdentity = useMemo<NativeTechnologyWorkspaceIdentity \| null>[\s\S]*?nativeThinWorkspaceAuthorityFrames\.readFrame/);
    expect(app).toMatch(/nativeTechnologyWorkspaceSource = useMemo\(\(\) => nativeTechnologyWorkspaceReadIdentity[\s\S]*?\? createNativePlayerAuthorityTechnologyProjectionSource/);
    expect(refreshEffects).toMatch(/if \(!nativeTechnologyWorkspaceReadIdentity \|\| !nativeTechnologyWorkspaceSource\) return/);
    expect(app).toMatch(/nativeRecipeWorkspaceReadIdentity = useMemo<NativeRecipeWorkspaceIdentity \| null>[\s\S]*?nativeThinWorkspaceAuthorityFrames\.readFrame/);
    expect(app).toMatch(/nativeRecipeWorkspaceSource = useMemo\(\(\) => nativeRecipeWorkspaceReadIdentity[\s\S]*?\? createNativePlayerAuthorityRecipeWorkspaceProjectionSource/);
    expect(refreshEffects).toMatch(/if \(!nativeRecipeWorkspaceReadIdentity \|\| !nativeRecipeWorkspaceSource\) return/);
    expect(app).toMatch(/nativeCommandPaletteEntitySearchReadIdentity = useMemo<NativeCommandPaletteEntitySearchIdentity \| null>[\s\S]*?nativeThinWorkspaceAuthorityFrames\.readFrame/);
    expect(app).toMatch(/nativeCommandPaletteEntitySearchSource = useMemo\([\s\S]*?nativeCommandPaletteEntitySearchReadIdentity[\s\S]*?\? createNativePlayerAuthorityCommandPaletteEntitySearchSource/);
    expect(refreshEffects).toMatch(/if \(!nativeCommandPaletteEntitySearchReadIdentity \|\| !nativeCommandPaletteEntitySearchSource\) return/);
    const stellarBinding = app.slice(
      app.indexOf("const nativeStellarProjectionIdentity"),
      app.indexOf("const nativeStarMapWorkspaceReadModel"),
    );
    expect(stellarBinding).toMatch(/nativeStellarProjectionIdentity[\s\S]*?nativeThinWorkspaceAuthorityFrames\.displayFrame/);
    expect(stellarBinding).toMatch(/nativeStellarProjectionReadIdentity[\s\S]*?nativeThinWorkspaceAuthorityFrames\.readFrame/);
    expect(stellarBinding).toMatch(/nativeStellarProjectionSource = useMemo\(\(\) => nativeStellarProjectionReadIdentity[\s\S]*?createNativePlayerAuthorityStellarProjectionSource[\s\S]*?: null/);
    expect(stellarBinding).toMatch(/nativeStarMapCatalogSource = useMemo\(\(\) => nativeStellarProjectionReadIdentity[\s\S]*?createNativePlayerAuthorityStarMapCatalogSource[\s\S]*?: null/);
    expect(refreshEffects).toMatch(/!starMapOpen \|\| !nativePlayerAuthorityBoundFrame \|\| !nativeStellarProjectionIdentity\)[\s\S]*?nativeStarMapCatalogStore\.clear\(\)/);
    expect(refreshEffects).toMatch(/if \(!nativeStellarProjectionReadIdentity \|\| !nativeStarMapCatalogSource\) return/);
    expect(refreshEffects).toMatch(/!nativeStellarProjectionReadIdentity \|\| !nativeStellarProjectionSource\) return/);

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

  it("keeps cloud public-status refresh from becoming a second player-state writer", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const refresh = app.slice(
      app.indexOf("const response = await fetchCloudPublicStatus()"),
      app.indexOf("const publishCanvasSnapshot"),
    );
    const guard = refresh.indexOf("if (nativePlayerAuthorityOwnsRuntimeRef.current)");
    const stationMutation = refresh.indexOf("synchronizeStationContracts(");
    const galacticMutation = refresh.indexOf("synchronizeGalacticActivity(");
    const rendererInstall = refresh.indexOf("gameRef.current = next");

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(refresh.indexOf("return;", guard)).toBeLessThan(stationMutation);
    expect(guard).toBeLessThan(stationMutation);
    expect(guard).toBeLessThan(galacticMutation);
    expect(guard).toBeLessThan(rendererInstall);
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
