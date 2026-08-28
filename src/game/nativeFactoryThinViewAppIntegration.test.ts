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
    expect(app).toMatch(/nativeFactoryThinViewStore\.refresh\(controller,[\s\S]*?expectedRevision:\s*factoryThinViewExpectedRevision/);
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
    expect(workspace).toMatch(/const pendingCount = factoryHeadlineReadModel\.constructionQueueCount/);
    expect(workspace).not.toMatch(/<span>施工队列 <strong>\{game\.constructionQueue\.length\}/);

    expect(headline).toMatch(/FactoryConstructionHeadlineReadModel/);
    expect(headline).not.toMatch(/GameState/);
    expect(headline).not.toMatch(/\.\/game\/types|\.\.\/game\/types/);
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

  it("feeds SelectionToolbar counts and lock state from the bounded atomic selection", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const workspace = readFileSync(resolve("src/components/BlueprintWorkspace.tsx"), "utf8");
    const toolbar = workspace.slice(
      workspace.indexOf("export function SelectionToolbar"),
      workspace.indexOf("export function BlueprintPlacementCursor"),
    );

    expect(app).toMatch(/createWebFactorySelectionToolbarReadModel\(game, selectedEntityIds, selectedBeltIds\)/);
    expect(app).toMatch(/selectFactorySelectionToolbarReadModel\([\s\S]*?nativeFactoryThinViewSnapshot/);
    expect(app).toMatch(/requestedEntityIds:\s*factoryThinViewSelectedEntityIds/);
    expect(app).toMatch(/requestedBeltIds:\s*factoryThinViewSelectedBeltIds/);
    expect(app).toMatch(/<SelectionToolbar\s+model=\{factorySelectionToolbarReadModel\}/);
    expect(app).not.toMatch(/<SelectionToolbar\s+selectedCount=/);
    expect(toolbar).toMatch(/FactorySelectionToolbarReadModel/);
    expect(toolbar).toMatch(/data-factory-read-model-source=\{model\.source\}/);
    expect(toolbar).not.toMatch(/GameState|FactoryEntity|game\.entities/);

    // Read-only native coverage does not grant command authority.
    expect(app).toMatch(/canUpgrade=\{canUpgradeEntities\(game, selectedEntityIds\)\}/);
    expect(app).toMatch(/eligibleCount=\{blueprintEligibleIds\.length\}/);
    expect(app).toMatch(/onLock=\{\(\) => \{[\s\S]*?commitGame\(\(current\) => setEntitiesInteractionLocked/);
  });

  it("feeds compact mobile inspector live fields without moving command authority", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const sheets = readFileSync(resolve("src/components/mobile/MobileSheets.tsx"), "utf8");
    const panels = readFileSync(resolve("src/components/mobile/MobileFactoryPanels.tsx"), "utf8");

    expect(app).toMatch(/createWebFactoryInspectorSummaryReadModel\(game, selectedEntity, selectedBelt\)/);
    expect(app).toMatch(/selectFactoryInspectorSummaryReadModel\([\s\S]*?nativeFactoryThinViewSnapshot/);
    expect(app).toMatch(/inspectorReadModel:\s*factoryInspectorSummaryReadModel/);
    expect(sheets).toMatch(/readModel=\{factory\.inspectorReadModel\}/);
    expect(panels).toMatch(/data-factory-read-model-source=\{displaySource\}/);
    expect(panels).toMatch(/displayEntity\.inputItems\.rows/);
    expect(panels).toMatch(/displayBelt\?\.lastFlow/);

    // The read model supplies display-only fields. Mutations and eligibility
    // still use the full GameState entity/belt and the original callbacks.
    expect(panels).toMatch(/canUpgradeEntity\(game, entity\.id\)/);
    expect(panels).toMatch(/onUpgradeEntity\(entity\.id\)/);
    expect(panels).toMatch(/getBeltLaneAdjustmentCheck\(game, belt\.id/);
    expect(panels).toMatch(/onBeltLaneCountChange/);
  });
});
