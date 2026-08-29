import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native planet navigation App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");

  it("routes every native factory projection with independently discovered Rust authority", () => {
    expect(app).toMatch(/import \{ createNativeProjectedActivePlanetCommand \}/);
    expect(app).toMatch(/import \{ NativePlanetNavigationDiscoveryStore \}/);
    expect(app).toMatch(/nativePlanetNavigationDiscoveryStore\.refresh\(source, \{[\s\S]*?sessionId: nativePlayerAuthorityActiveFrame\.sessionId,[\s\S]*?expectedRevision: factoryThinViewExpectedRevision/);
    expect(app).toMatch(/nativePlanetNavigationDiscoveryFrame !== null[\s\S]*?nativePlanetNavigationDiscoveryFrame\.sessionId === nativePlayerAuthorityActiveFrame\?\.sessionId[\s\S]*?nativePlanetNavigationDiscoveryFrame\.revision === factoryThinViewExpectedRevision/);
    expect(app).toMatch(/nativeFactoryProjectionRouteReady = nativeFactoryThinViewMode !== "native-authoritative"/);
    expect(app).toMatch(/nativeFactoryDiscoveredProjectionRoute = retainNativePlanetRouteIdentity\([\s\S]*?nativePlayerAuthorityActiveFrame\?\.sessionId,[\s\S]*?nativeFactoryExactProjectionRoute,[\s\S]*?nativeFactoryConfirmedProjectionRoute/);
    expect(app).toMatch(/nativeFactoryThinViewMode === "native-authoritative" && !nativeFactoryProjectionRouteReady[\s\S]*?nativeFactoryThinViewStore\.clear\(\)/);

    const projectionBlock = app.slice(
      app.indexOf("const factoryThinViewRelatedEntityIds"),
      app.indexOf("const nativePlayerAuthorityMacroControllerRef"),
    );
    expect(projectionBlock.match(/nativeFactoryProjectionPlanetId/g)?.length).toBeGreaterThanOrEqual(8);
    expect(projectionBlock).not.toMatch(/planetId: game\.activePlanetId|activePlanetId: game\.activePlanetId/);

    const refreshBlock = app.slice(
      app.indexOf("void nativeFactoryThinViewStore.refresh"),
      app.indexOf("useEffect(() => {", app.indexOf("void nativeFactoryThinViewStore.refresh") + 1),
    );
    expect(refreshBlock).toMatch(/planetId: nativeFactoryProjectionPlanetId/);
  });

  it("submits only the same-revision Rust travel intent and never predicts gameplay state", () => {
    const start = app.indexOf("const onPlanetChange = useCallback");
    const block = app.slice(start, app.indexOf("const onExploreSystem", start));
    const nativeBranch = block.slice(
      block.indexOf("if (nativePlayerAuthorityOwnsRuntimeRef.current)"),
      block.indexOf("const current = gameRef.current"),
    );

    expect(nativeBranch).toMatch(/const frame = nativeAuthoritativeFactoryWorkspaceFrame/);
    expect(nativeBranch).toMatch(/if \(pendingNativePlanetChange\)[\s\S]*?重复切换未应用/);
    expect(nativeBranch).toMatch(/frame\.planetNavigation\.activePlanetId/);
    expect(nativeBranch).toMatch(/commitNativeProjectedCommand\([\s\S]*?frame\.revision/);
    expect(nativeBranch).toMatch(/createNativeProjectedActivePlanetCommand\(frame, planetId\)/);
    expect(nativeBranch).toMatch(/setPendingNativePlanetChange\(\{[\s\S]*?acceptedRevision: receipt\.revision/);
    expect(nativeBranch).not.toMatch(/setNativeFactoryPlanetRoute/);
    expect(nativeBranch).not.toMatch(/setActivePlanet|commitGame\(|publishRuntimeGame|gameRef\.current\s*=/);
    expect(nativeBranch).not.toMatch(/gameRef\.current\.(?:cargo|tray|planetTrays|metrics|entities|belts)/);
  });

  it("changes the visible planet only after a newer native projection confirms it", () => {
    const finish = app.indexOf("const finishPlanetViewChange = useCallback");
    const verification = app.slice(finish, app.indexOf("const onPlanetChange", finish));

    expect(verification).toMatch(/evaluateNativePlanetTransition\([\s\S]*?pending,[\s\S]*?sessionId: frame\.sessionId,[\s\S]*?revision: frame\.revision,[\s\S]*?activePlanetId: frame\.planetNavigation\.activePlanetId,[\s\S]*?targetRowActive: target\?\.active === true/);
    expect(verification).toMatch(/decision === "idle" \|\| decision === "waiting"/);
    expect(verification).toMatch(/decision !== "ready"/);
    expect(verification).toMatch(/setPendingNativePlanetChange\(null\)[\s\S]*?persistPlanetViewport[\s\S]*?finishPlanetViewChange/);
  });

  it("boots a changed native planet without stale selections or connection pins", () => {
    expect(app).toMatch(/nativeFactoryUnpinnedBootstrap = nativePlanetRouteRequiresBootstrap\([\s\S]*?nativeFactoryThinViewMode === "native-authoritative"/);
    expect(app).toMatch(/factoryThinViewAllSelectedEntityIds = useMemo\([\s\S]*?nativeFactoryUnpinnedBootstrap \? \[\]/);
    expect(app).toMatch(/factoryThinViewAllSelectedBeltIds = useMemo\([\s\S]*?nativeFactoryUnpinnedBootstrap[\s\S]*?\? \[\]/);
    expect(app).toMatch(/factoryInteractionConnectionEntityIds = useMemo\([\s\S]*?nativeFactoryUnpinnedBootstrap[\s\S]*?\? \[\]/);
    expect(app).toMatch(/const abortCanvasGestureLifecycle = useCallback[\s\S]*?factoryGestureEpochRef\.current \+= 1[\s\S]*?canvasPointerMotionRef\.current = stopCanvasPointerMotionSession[\s\S]*?capturedPointerIds[\s\S]*?activeCanvasTouchesRef\.current\.clear\(\)[\s\S]*?canvasMultiTouchRef\.current = null[\s\S]*?nodeDragActiveRef\.current = false[\s\S]*?nodeDragGestureEpochRef\.current = null[\s\S]*?multiDragStartRef\.current = null[\s\S]*?connectionHandleSpatialIndexRef\.current = null[\s\S]*?suppressConnectionClickRef\.current = false[\s\S]*?selectionModeRef\.current = false/);
    expect(app).toMatch(/const resetPlanetScopedFactoryUi = useCallback[\s\S]*?abortCanvasGestureLifecycle\(\)[\s\S]*?onMiningStop\(\)[\s\S]*?flowStore\.getState\(\)\.cancelConnection\(\)[\s\S]*?clickConnectionPreviewRef\.current = null[\s\S]*?setPlacement\(null\)[\s\S]*?setRegionMode\(false\)/);
    expect(app).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]*?nativeFactoryRouteUnsafe[\s\S]*?abortCanvasGestureLifecycle\(\)/);
    expect(app).not.toMatch(/useLayoutEffect\(\(\) => \{\s*if \(nativeFactoryProjectionPending\) abortCanvasGestureLifecycle/);
    expect(app).toMatch(/if \(canvasWorkspaceHidden \|\| nativeFactoryRouteUnsafe\) stopCanvasPointerMotion\(\)/);
    expect(app).toMatch(/useLongPress<HTMLElement>\(\{[\s\S]*?disabled: nativeFactoryRouteUnsafe,[\s\S]*?resetKey: factoryGestureRouteKey/);
    expect(app).not.toMatch(/resetKey:[^\n]*(?:factoryThinViewExpectedRevision|acceptedRevision)/);
    expect(app).toMatch(/onPointerUpCapture=\{\(event\) => \{[\s\S]*?longPressBindings\.onPointerUpCapture[\s\S]*?stopCanvasPointerMotion\(\)[\s\S]*?nativeFactoryProjectionPending/);
    expect(app).toMatch(/workspace\.sessionId !== canvas\.sessionId[\s\S]*?workspace\.revision !== canvas\.revision[\s\S]*?nativeFactoryUnpinnedBootstrap\) resetPlanetScopedFactoryUi\(\)[\s\S]*?setNativeFactoryConfirmedProjectionRoute/);
  });

  it("fails closed instead of showing or mutating the old planet through uncovered UI", () => {
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime \? <aside[\s\S]*?data-native-authority-unavailable="tray-cargo-v1"[\s\S]*?: <StableResourceRail/);
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime \? <section[\s\S]*?data-native-authority-unavailable="construction-inventory-v1"[\s\S]*?: <StableConstructionDock/);
    expect(app).toMatch(/enabled=\{nextMobileShell && !nativePlayerAuthorityOwnsRuntime\}/);
    expect(app).toMatch(/native-mobile-shell-unavailable[\s\S]*?为避免显示旧星球数据/);

    const rejection = app.slice(
      app.indexOf("const rejectLegacyFactoryInteractionWhileNative"),
      app.indexOf("useEffect(() => {", app.indexOf("const rejectLegacyFactoryInteractionWhileNative")),
    );
    expect(rejection).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?本次操作未应用，也不会读取旧星球数据/);
    for (const label of ["建筑放置与扩建", "建筑拖放", "建筑位置编辑", "生产区域编辑", "蓝图部署", "蓝图复制", "蓝图管理", "基础制造", "建筑回收"]) {
      expect(app, label).toContain(`rejectLegacyFactoryInteractionWhileNative("${label}")`);
    }
    expect(app).toMatch(/const draggable = !nativePlayerAuthorityOwnsRuntime && !placement/);
    expect(app).toMatch(/const factoryCanvasRegions = useMemo\([\s\S]*?nativePlayerAuthorityOwnsRuntime[\s\S]*?\? \[\]/);
    expect(app).toMatch(/factoryGestureSurfaceKey = `\$\{factoryGestureRouteKey\}:\$\{nativeFactoryRouteUnsafe/);
    expect(app).toMatch(/key=\{`regions:\$\{factoryGestureSurfaceKey\}`\}/);
    expect(app).toMatch(/key=\{`minimap:\$\{factoryGestureSurfaceKey\}`\}/);
    expect(app).toMatch(/!nativePlayerAuthorityOwnsRuntime \? <CanvasSelectionTools/);
    expect(app).toMatch(/!nativePlayerAuthorityOwnsRuntime \? <SelectionToolbar/);
    expect(app).toMatch(/!nativePlayerAuthorityOwnsRuntime \? <BlueprintWorkspace/);
    expect(app).toMatch(/!nativePlayerAuthorityOwnsRuntime \? <RuntimeRenderProfile id="onboarding">/);
    expect(app).toMatch(/<StableInspectorPanel[\s\S]*?readOnly=\{nativePlayerAuthorityOwnsRuntime\}/);
  });

  it("shows an inert native loading state instead of stale Web models between revisions", () => {
    expect(app).toMatch(/nativeFactoryProjectionPending = nativePlayerAuthorityOwnsRuntime/);
    expect(app).toMatch(/nativeFactoryRouteUnsafe = nativePlayerAuthorityOwnsRuntime &&[\s\S]*?nativeFactoryUnpinnedBootstrap \|\| pendingNativePlanetChange !== null/);
    expect(app).toMatch(/nativeFactoryProjectionPending = nativePlayerAuthorityOwnsRuntime &&[\s\S]*?nativeFactoryRouteUnsafe/);
    for (const factory of [
      "createWebFactoryRunStatusReadModel",
      "createWebFactoryConstructionHeadlineReadModel",
      "createWebFactoryConstructionWorkspaceReadModel",
      "createPlanetNavigationReadModel",
      "createWebFactoryViewportReadModel",
    ]) {
      expect(app).toMatch(new RegExp(`nativePlayerAuthorityOwnsRuntime \\? null : ${factory}\\(game`));
    }
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime && !nativeAuthoritativeFactoryCanvasFrame[\s\S]*?entities: \[\][\s\S]*?belts: \[\]/);
    expect(app).toMatch(/data-native-projection-pending=\{nativeFactoryProjectionPending/);
    expect(app).toMatch(/aria-busy=\{nativeFactoryProjectionPending\}/);
  });

  it("persists viewports and validates connections only against a confirmed native planet", () => {
    const moveStart = app.indexOf("const handleFactoryFlowMove = useCallback");
    const moveBlock = app.slice(moveStart, app.indexOf("const canvasFlowPresentationToken", moveStart));
    expect(moveBlock).toMatch(/factoryConfirmedActivePlanetId[\s\S]*?persistPlanetViewport\(factoryConfirmedActivePlanetId, viewport\)/);
    expect(moveBlock).not.toMatch(/persistPlanetViewport\(gameRef\.current\.activePlanetId/);

    const connectionStart = app.indexOf("const getFactoryConnectionReadState = useCallback");
    const connectionBlock = app.slice(connectionStart, app.indexOf("const isValidConnection", connectionStart));
    expect(connectionBlock).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?!frame/);
    expect(connectionBlock).toMatch(/planetId: frame\?\.planetId \?\?/);
    expect(connectionBlock).not.toMatch(/planetId: game\.activePlanetId/);
  });

  it("fails closed when locator actions cannot prove the visible native planet", () => {
    const start = app.indexOf("const readConfirmedFactoryPlanetId = useCallback");
    const block = app.slice(start, app.indexOf("const saveSummaryRefreshIdRef", start));

    expect(block).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?nativeAuthoritativeFactoryCanvasFrameRef\.current\?\.planetId \?\? null/);
    expect(block).toMatch(/const ensureFactoryPlanetVisible = useCallback[\s\S]*?activePlanetId === null[\s\S]*?activePlanetId === planetId \|\| onPlanetChange\(planetId\)/);
    expect(block).toMatch(/const focusEntityIds = useCallback[\s\S]*?nativeAuthoritativeFactoryCanvasFrameRef\.current[\s\S]*?nativeFrame\?\.entities \?\? gameRef\.current\.entities/);
    for (const callbackName of [
      "locateBatchConnectionTarget",
      "focusPlacedEntity",
      "locateProductionLine",
      "openCanvasBookmark",
      "selectAlert",
      "focusStellarStation",
    ]) {
      const callbackStart = block.indexOf(`const ${callbackName}`);
      expect(callbackStart, callbackName).toBeGreaterThanOrEqual(0);
      const callbackEnd = block.indexOf("\n  const ", callbackStart + 8);
      expect(block.slice(callbackStart, callbackEnd < 0 ? undefined : callbackEnd), callbackName)
        .toMatch(/ensureFactoryPlanetVisible/);
    }
  });

  it("does not report a queued native switch as already visible", () => {
    const start = app.indexOf("const onPlanetChange = useCallback");
    const block = app.slice(start, app.indexOf("const current = gameRef.current", start));
    expect(block).toMatch(/commitNativeProjectedCommand\([\s\S]*?return false;/);
    expect(block).toMatch(/`true` means the requested planet is already visible/);
  });

  it("runs post-commit routing only after the verified authority receipt", () => {
    const start = app.indexOf("const commitNativeProjectedCommand = useCallback");
    const block = app.slice(start, app.indexOf("useEffect(() => {", start));

    expect(block).toMatch(/binding\.source\.applyCommand\(command\)\.then\(\(receipt\) => \{/);
    expect(block).toMatch(/invalidateFactoryAlertProjection\(\);[\s\S]*?afterCommitted\?\.\(receipt\)/);
    expect(block.indexOf("afterCommitted?.(receipt)")).toBeGreaterThan(block.indexOf("applyCommand(command).then"));
    expect(block).toMatch(/\.finally\(async \(\) => \{[\s\S]*?try \{[\s\S]*?await nativePlayerAuthorityClockRef\.current\?\.refresh\(\)[\s\S]*?\} finally \{[\s\S]*?nativePlayerAuthorityCommandInFlightRef\.current = false/);
  });
});
