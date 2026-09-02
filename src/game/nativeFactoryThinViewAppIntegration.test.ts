import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("factory thin-view App consumption", () => {
  it("renders the real canvas run-state subtree from bounded Web/native models", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const component = readFileSync(resolve("src/components/FactoryRunStatus.tsx"), "utf8");

    expect(app).toMatch(/new NativeFactoryThinViewStore\(\)/);
    expect(app).toMatch(/useSyncExternalStore\([\s\S]*?nativeFactoryThinViewStore\.subscribe/);
    expect(app).toMatch(/createWebFactoryRunStatusReadModel\(game\)/);
    expect(app).toMatch(/nativeFactoryThinViewStore\.refresh\(projectionSource,[\s\S]*?expectedRevision:\s*factoryThinViewExpectedRevision/);
    expect(app).toMatch(/selectFactoryRunStatusReadModel\([\s\S]*?nativeFactoryThinViewSnapshot/);
    expect(app).toMatch(/<FactoryRunStatus model=\{factoryRunStatusReadModel\} \/>/);
    expect(app).not.toMatch(/<span className=\{game\.paused \? "paused" : "running"\}>\{game\.paused/);

    expect(component).toMatch(/FactoryRunStatusReadModel/);
    expect(component).not.toMatch(/GameState/);
    expect(component).not.toMatch(/\.\/game\/types|\.\.\/game\/types/);
  });

  it("feeds the real blueprint construction headline from the atomic bounded frame", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const workspace = readFileSync(resolve("src/components/BlueprintWorkspace.tsx"), "utf8");
    const headline = readFileSync(resolve("src/components/BlueprintFactoryHeadline.tsx"), "utf8");

    expect(app).toMatch(/createWebFactoryConstructionHeadlineReadModel\(game\)/);
    expect(app).toMatch(/selectFactoryConstructionHeadlineReadModel\([\s\S]*?nativeFactoryThinViewSnapshot/);
    expect(app).toMatch(/<BlueprintWorkspace[\s\S]*?factoryHeadlineReadModel=\{factoryConstructionHeadlineReadModel\}/);
    expect(workspace).toMatch(/<BlueprintFactoryHeadline model=\{factoryHeadlineReadModel\} \/>/);
    expect(workspace).toMatch(/const pendingCount = constructionReadModel\.queue\.totalCount/);
    expect(workspace).not.toMatch(/<span>施工队列 <strong>\{game\.constructionQueue\.length\}/);

    expect(headline).toMatch(/FactoryConstructionHeadlineReadModel/);
    expect(headline).not.toMatch(/GameState/);
    expect(headline).not.toMatch(/\.\/game\/types|\.\.\/game\/types/);
  });

  it("feeds construction-center and pending-blueprint read-only summaries from one fail-closed atom", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const center = readFileSync(resolve("src/components/ConstructionCenterWorkspace.tsx"), "utf8");
    const blueprints = readFileSync(resolve("src/components/BlueprintWorkspace.tsx"), "utf8");

    expect(app).toMatch(/createWebFactoryConstructionWorkspaceReadModel\(game\)/);
    expect(app).toMatch(/selectFactoryConstructionWorkspaceReadModel\([\s\S]*?nativeFactoryThinViewSnapshot[\s\S]*?factoryThinViewExpectedRevision/);
    expect(app).toMatch(/<BlueprintWorkspace[\s\S]*?constructionReadModel=\{factoryConstructionWorkspaceReadModel\}/);
    expect(app).toMatch(/<ConstructionCenterWorkspace[\s\S]*?constructionReadModel=\{factoryConstructionWorkspaceReadModel\}/);

    expect(center).toMatch(/data-factory-read-model-source=\{constructionReadModel\.source\}/);
    expect(center).toMatch(/constructionReadModel\.automation\.totalCrafted/);
    expect(center).toMatch(/constructionReadModel\.automation\.jobs\.rows/);
    expect(center).toMatch(/checked=\{game\.constructionAutomation\.enabled\}/);
    expect(center).toMatch(/const target = Math\.floor\(game\.constructionAutomation\.targetStock\[definition\.id\]/);

    expect(blueprints).toMatch(/const pendingCount = constructionReadModel\.queue\.totalCount/);
    expect(blueprints).toMatch(/nativeQueueRows.*constructionReadModel\.source === "native-core"/s);
    expect(blueprints).toMatch(/data-factory-read-model-source=\{constructionReadModel\.source\}/);
    expect(blueprints).toMatch(/getConstructionQueueDetails\(game, entry\.id\)/);
    expect(blueprints).toMatch(/disabled=\{!canFundConstruction\}/);
    expect(blueprints).toMatch(/onFundQueue\(entry\.id, "construction"\)/);
    expect(blueprints).toMatch(/onCancelQueue\(entry\.id\)/);
  });

  it("feeds the visible planet navigator from the bounded atomic navigation model", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const panels = readFileSync(resolve("src/components/GamePanels.tsx"), "utf8");
    const navigator = panels.slice(
      panels.indexOf("export function PlanetNavigator"),
      panels.indexOf("type InspectorTab"),
    );

    expect(app).toMatch(/createPlanetNavigationReadModel\(game\)/);
    expect(app).toMatch(/selectFactoryPlanetNavigationReadModel\([\s\S]*?nativeFactoryThinViewSnapshot/);
    expect(app).toMatch(/<StablePlanetNavigator model=\{factoryPlanetNavigationReadModel\}/);
    expect(app).not.toMatch(/<StablePlanetNavigator game=\{/);
    expect(navigator).toMatch(/PlanetNavigationReadModel/);
    expect(navigator).toMatch(/row\.deviceCount/);
    expect(navigator).toMatch(/row\.powerFactor/);
    expect(navigator).not.toMatch(/GameState|game\./);
  });

  it("feeds the visible canvas planet headline and belt count from the same bounded row", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");

    expect(app).toMatch(/const factoryActivePlanetNavigationRow = useMemo\(/);
    expect(app).toMatch(/beltCount=\{factoryActivePlanetNavigationRow\?\.beltCount \?\? 0\}/);
    expect(app).toMatch(/<strong>\{factoryActivePlanetNavigationRow\?\.displayName[\s\S]*?factoryActivePlanetNavigationRow\?\.code/);
    expect(app).not.toMatch(/beltCount=\{game\.belts\.filter\(/);
    expect(app).not.toMatch(/<strong>\{getPlanetDisplayName\(game, game\.activePlanetId\)/);
  });

  it("does not rebuild non-canvas Web workspace models after native authority owns the exact revision", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");

    expect(app).toMatch(/selectNativeAuthoritativeFactoryWorkspaceFrame\(nativeFactoryThinViewSnapshot/);
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime\s*\?\s*null\s*:\s*createWebFactoryRunStatusReadModel\(game\)/);
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime\s*\?\s*null\s*:\s*createWebFactoryConstructionHeadlineReadModel\(game\)/);
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime\s*\?\s*null\s*:\s*createWebFactoryConstructionWorkspaceReadModel\(game\)/);
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime\s*\?\s*null\s*:\s*createPlanetNavigationReadModel\(game\)/);
    expect(app).toMatch(/nativeAuthoritativeFactoryWorkspaceFrame\?\.runStatus\s*\?\?\s*nativePendingFactoryRunStatusReadModel/);
    expect(app).toMatch(/nativeAuthoritativeFactoryWorkspaceFrame\?\.constructionWorkspace\s*\?\?\s*nativePendingFactoryConstructionWorkspaceReadModel/);
    expect(app).toMatch(/nativeAuthoritativeFactoryWorkspaceFrame\?\.planetNavigation\s*\?\?\s*nativePendingFactoryPlanetNavigationReadModel/);
    expect(app).toMatch(/nativeFactoryProjectionPending[\s\S]*?正在核对 Windows 原生星球数据/);
  });

  it("feeds SelectionToolbar counts and lock state from the bounded atomic selection", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const workspace = readFileSync(resolve("src/components/BlueprintWorkspace.tsx"), "utf8");
    const toolbar = workspace.slice(
      workspace.indexOf("export function SelectionToolbar"),
      workspace.indexOf("export function BlueprintPlacementCursor"),
    );

    expect(app).toMatch(/selectFactoryInteractionRows\([\s\S]*?nativeAuthoritativeFactoryInteractionRows[\s\S]*?createWebFactoryInteractionRows\(game/);
    expect(app).toMatch(/factoryInteractionRows\.source === "native-authoritative"[\s\S]*?factoryInteractionRows\.selectionToolbarReadModel/);
    expect(app).toMatch(/selectFactorySelectionToolbarReadModel\([\s\S]*?nativeFactoryThinViewSnapshot/);
    expect(app).toMatch(/requestedEntityIds:\s*factoryThinViewSelectedEntityIds/);
    expect(app).toMatch(/requestedBeltIds:\s*factoryThinViewSelectedBeltIds/);
    expect(app).toMatch(/<SelectionToolbar\s+model=\{factorySelectionToolbarReadModel\}/);
    expect(app).toMatch(/<SelectionToolbar[\s\S]*?unsafeActionsEnabled=\{!nativePlayerAuthorityOwnsRuntime \|\| Boolean\([\s\S]*?nativeAuthoritativeFactoryCanvasFrame/);
    expect(app).not.toMatch(/<SelectionToolbar\s+selectedCount=/);
    expect(toolbar).toMatch(/FactorySelectionToolbarReadModel/);
    expect(toolbar).toMatch(/data-factory-read-model-source=\{model\.source\}/);
    expect(toolbar).not.toMatch(/GameState|FactoryEntity|game\.entities/);

    // Upgrade and Copy now have separately bounded Rust paths and derive their
    // native scopes from the exact thin-view selection, never the hollow
    // renderer GameState.
    expect(app).toMatch(/canUpgrade=\{nativePlayerAuthorityOwnsRuntime[\s\S]*?selectedEntityIds\.length > 0[\s\S]*?: canUpgradeEntities\(game, selectedEntityIds\)\}/);
    expect(app).toMatch(/createNativeFactoryBatchCommand\(baseRevision,[\s\S]*?kind: "upgrade-buildings"/);
    expect(app).toMatch(/copyActionEnabled=\{!nativePlayerAuthorityOwnsRuntime \|\| Boolean\([\s\S]*?nativeBlueprintCaptureSelection/);
    expect(app).toMatch(/eligibleCount=\{nativePlayerAuthorityOwnsRuntime[\s\S]*?nativeBlueprintCaptureSelection\?\.entityIds\.length[\s\S]*?: blueprintEligibleIds\.length\}/);
  });

  it("submits native selection locks only from the exact bounded selection projection", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const helperStart = app.indexOf("const commitNativeSelectionInteractionLock");
    const helper = app.slice(helperStart, app.indexOf("const selectedBelts =", helperStart));
    const toolbarStart = app.indexOf("<SelectionToolbar");
    const toolbar = app.slice(toolbarStart, app.indexOf("/>", toolbarStart) + 2);
    const lockStart = toolbar.indexOf("onLock={() => {");
    const lock = toolbar.slice(lockStart, toolbar.indexOf("onUnlock=", lockStart));
    const unlock = toolbar.slice(toolbar.indexOf("onUnlock={() => {"), toolbar.indexOf("onRemove="));

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helper).toMatch(/factoryInteractionRows\.source !== "native-authoritative"/);
    expect(helper).toMatch(/factoryInteractionRows\.projectionIdentity/);
    expect(helper).toMatch(/commandSource\.sessionId !== routeIdentity\.sessionId/);
    expect(helper).toMatch(/commandSource\.runId !== routeIdentity\.runId/);
    expect(helper).toMatch(/commandSource\.baseRevision !== routeIdentity\.revision/);
    expect(helper).toMatch(/interactionIdentity\.planetId !== routeIdentity\.planetId/);
    expect(helper).toMatch(/commitNativeProjectedCommand\(\s*routeIdentity\.revision/);
    expect(helper).toMatch(/createNativeProjectedInteractionLockCommandFromReadModels\(\{[\s\S]*?commandIdentity: routeIdentity,[\s\S]*?toolbar: factorySelectionToolbarReadModel,[\s\S]*?selection: selectionProjection,[\s\S]*?targetInteractionLocked/);
    expect(helper).not.toMatch(/selectedEntities|gameRef\.current|game\.entities|setEntitiesInteractionLocked/);

    expect(lock).toMatch(/if \(nativePlayerAuthorityOwnsRuntime\)[\s\S]*?commitNativeSelectionInteractionLock\(true\);[\s\S]*?return;/);
    expect(lock).toMatch(/const ids = selectedEntities\.filter\(\(entity\) => !entity\.interactionLocked\)[\s\S]*?commitGame\(\(current\) => setEntitiesInteractionLocked\(current, ids, true\)\)/);
    expect(unlock).toMatch(/if \(nativePlayerAuthorityOwnsRuntime\)[\s\S]*?commitNativeSelectionInteractionLock\(false\);[\s\S]*?return;/);
    expect(unlock).toMatch(/const ids = selectedEntities\.filter\(\(entity\) => entity\.interactionLocked\)[\s\S]*?commitGame\(\(current\) => setEntitiesInteractionLocked\(current, ids, false\)\)/);
  });

  it("uses the native thin mobile shell and keeps the full-state inspector on the legacy branch", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const sheets = readFileSync(resolve("src/components/mobile/MobileSheets.tsx"), "utf8");
    const panels = readFileSync(resolve("src/components/mobile/MobileFactoryPanels.tsx"), "utf8");

    expect(app).toMatch(/factoryInteractionRows\.source === "native-authoritative"[\s\S]*?factoryInteractionRows\.inspectorSummaryReadModel/);
    expect(app).toMatch(/selectFactoryInspectorSummaryReadModel\([\s\S]*?nativeFactoryThinViewSnapshot/);
    expect(app).toMatch(/inspectorReadModel:\s*factoryInspectorSummaryReadModel/);
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime \? <NativeMobileGameShell[\s\S]*?frame=\{nativeAuthoritativeFactoryWorkspaceFrame\}[\s\S]*?\/> : <MobileGameShell[\s\S]*?factoryGame=\{panelGame\}/);
    expect(app).not.toMatch(/factorySelectionReadGame/);
    expect(sheets).toMatch(/readModel=\{factory\.inspectorReadModel\}/);
    expect(sheets).toMatch(/<MobileInspectorSheet game=\{factoryGame\}/);
    expect(panels).toMatch(/data-factory-read-model-source=\{displaySource\}/);
    expect(panels).toMatch(/displayEntity\.inputItems\.rows/);
    expect(panels).toMatch(/displayBelt\?\.lastFlow/);

    // These existing full-state controls remain available to Web/PWA only.
    // Native ownership returns the dedicated desktop thin shell instead.
    expect(panels).toMatch(/canUpgradeEntity\(game, entity\.id\)/);
    expect(panels).toMatch(/onUpgradeEntity\(entity\.id\)/);
    expect(panels).toMatch(/getBeltLaneAdjustmentCheck\(game, belt\.id/);
    expect(panels).toMatch(/onBeltLaneCountChange/);
  });

  it("feeds the desktop inspector display summary from the same fail-closed atomic selection", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const inspector = readFileSync(resolve("src/components/NativeFactoryInspectorPanel.tsx"), "utf8");

    expect(app).toMatch(/const factoryInspectorSummaryReadModel = useMemo\([\s\S]*?factoryInteractionRows\.source === "native-authoritative"[\s\S]*?selectFactoryInspectorSummaryReadModel\([\s\S]*?nativeFactoryThinViewSnapshot/);
    expect(app).toMatch(/requestedEntityIds:\s*factoryThinViewSelectedEntityIds/);
    expect(app).toMatch(/requestedBeltIds:\s*factoryThinViewSelectedBeltIds/);
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime \? <NativeFactoryInspectorPanel[\s\S]*?inspector=\{factoryInspectorSummaryReadModel\}/);
    expect(app).toMatch(/: <StableInspectorPanel[\s\S]*?game=\{panelGame\}[\s\S]*?readOnly=\{false\}/);
    expect(app).toMatch(/useThrottledRuntimeShellGame\([\s\S]*?!nativePlayerAuthorityOwnsRuntime,[\s\S]*?\);/);
    expect(app).toMatch(/if \(!enabled\) \{[\s\S]*?window\.clearTimeout\(timerRef\.current\)[\s\S]*?return;/);
    expect(app).not.toMatch(/factorySelectionReadGame|factoryInspectorGame/);
    expect(inspector).not.toMatch(/GameState|panelGame|gameRef|commitGame|DesktopInspectorLiveSummary/);
    expect(inspector).toMatch(/inspector\.entity[\s\S]*?<NativeEntitySummary/);
    expect(inspector).toMatch(/inspector\.belt[\s\S]*?<NativeBeltSummary/);
    expect(inspector).toMatch(/entity\.inputItems\.rows/);
    expect(inspector).toMatch(/belt\.lastFlow/);
  });

  it("derives the desktop multi-selection display from complete bounded rows only", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const inspector = readFileSync(resolve("src/components/NativeFactoryInspectorPanel.tsx"), "utf8");

    expect(app).toMatch(/factoryInteractionRows\.source === "native-authoritative"[\s\S]*?factoryInteractionRows\.multiSelectionSummaryReadModel/);
    expect(app).toMatch(/selectFactoryMultiSelectionSummaryReadModel\([\s\S]*?nativeFactoryThinViewSnapshot/);
    expect(app).toMatch(/requestTruncated:[\s\S]*?selectedEntityRows[\s\S]*?selectedBeltRows/);
    expect(app).toMatch(/<NativeFactoryInspectorPanel[\s\S]*?multiSelection=\{factoryMultiSelectionSummaryReadModel\}/);
    expect(inspector).toMatch(/multiSelection\.entityRows\.truncated[\s\S]*?multiSelection\.beltRows\.truncated/);
    expect(inspector).toMatch(/multiSelection\.entityRows\.totalCount === multiSelection\.requestedEntityCount/);
    expect(inspector).toMatch(/multiSelection\.beltRows\.totalCount === multiSelection\.requestedBeltCount/);
    expect(inspector).not.toMatch(/GameState|setEntitiesRecipe|installSprayCoaters/);
  });

  it("does not render stale full-state overlays while native authority owns runtime", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");

    expect(app).toMatch(/blueprint=\{nativePlayerAuthorityOwnsRuntime \? null : activeBlueprint\}/);
    expect(app).toMatch(/!nativePlayerAuthorityOwnsRuntime \? <SpeedrunStatusPanel game=\{game\} \/> : null/);
  });

  it("feeds the minimap only from a proven complete viewport while keeping canvas commands on GameState", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const store = readFileSync(resolve("src/game/nativeFactoryThinViewStore.ts"), "utf8");
    const minimap = readFileSync(resolve("src/components/CanvasMiniMap.tsx"), "utf8");

    expect(store).toMatch(/readCompleteViewportProjection/);
    expect(store).toMatch(/let completed = false/);
    expect(store).toMatch(/if \(!completed \|\| !first/);
    expect(app).toMatch(/createWebFactoryViewportReadModel\(game/);
    expect(app).toMatch(/selectFactoryViewportReadModel\([\s\S]*?nativeFactoryThinViewSnapshot[\s\S]*?factoryThinViewExpectedRevision/);
    expect(app).toMatch(/projectionEnabled:\s*nativeFactoryThinViewActive/);
    expect(app).toMatch(/factoryViewportProvesWholePlanet\(factoryViewportReadModel\)/);
    expect(app).toMatch(/<CanvasMiniMap[\s\S]*?nodes=\{factoryMiniMapEntities\}[\s\S]*?worldBounds=\{/);
    expect(minimap).toMatch(/data-projection-source=\{projectionSource/);
    expect(minimap).toMatch(/projectCanvasMiniMap\(nodes, currentViewport, canvasWidth, canvasHeight, worldBounds\)/);

    // A main-owned active authority may now supply the complete bounded
    // ReactFlow/Canvas display atom. Mutations remain stable-ID GameState
    // commands and Web/PWA keeps the original fallback.
    expect(app).toMatch(/selectFactoryCanvasRows\(\s*nativeAuthoritativeFactoryCanvasFrame/);
    expect(app).toMatch(/<ReactFlow\s+[\s\S]*?nodes=\{renderedFlowNodes\}[\s\S]*?edges=\{renderedFlowEdges\}/);
    expect(app).toMatch(/<CanvasBeltLayer[\s\S]*?belts=\{canvasTopology\.belts\}/);
    expect(app).toMatch(/onNodesChange=\{handleNodesChange\}/);
    expect(app).toMatch(/onConnect=\{onConnect\}/);
    expect(app).toMatch(/onNodeDragStop=\{handleFactoryNodeDragStop\}/);
  });
});
