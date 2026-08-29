import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native-authoritative main canvas wiring", () => {
  it("binds one complete viewport atom to the active authority session and revision", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const store = readFileSync(resolve("src/game/nativeFactoryThinViewStore.ts"), "utf8");
    const selector = readFileSync(resolve("src/game/nativeFactoryCanvasFrame.ts"), "utf8");

    expect(app).toMatch(/selectNativeAuthoritativeFactoryCanvasFrame\(nativeFactoryThinViewSnapshot/);
    expect(app).toMatch(/enabled:\s*nativeFactoryThinViewMode === "native-authoritative"/);
    expect(app).toMatch(/sessionId:\s*nativePlayerAuthorityActiveFrame\?\.sessionId \?\? null/);
    expect(app).toMatch(/expectedRevision:\s*factoryThinViewExpectedRevision/);
    expect(app).toMatch(/authoritySessionId:\s*nativeFactoryThinViewMode === "native-authoritative"/);
    expect(store).toMatch(/authoritySessionId:\s*request\.authoritySessionId \?\? null/);
    expect(selector).toMatch(/frame\.authoritySessionId !== binding\.sessionId/);
    expect(selector).toMatch(/viewport\.nextEntityCursor !== null[\s\S]*?viewport\.nextBeltCursor !== null/);
  });

  it("selects native viewport rows before invoking the Web full-array fallback", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const canvasRows = app.slice(
      app.indexOf("const factoryCanvasRows = useMemo"),
      app.indexOf("const automaticDenseCanvasMode"),
    );

    expect(canvasRows).toMatch(/selectFactoryCanvasRows\([\s\S]*?nativeAuthoritativeFactoryCanvasFrame/);
    expect(canvasRows).toMatch(/\(\) => \{[\s\S]*?canvasGame\.entities\.filter[\s\S]*?canvasGame\.belts\.filter/);
    expect(canvasRows).toMatch(/const activePlanetEntities = factoryCanvasRows\.entities/);
    expect(canvasRows).toMatch(/const activePlanetBelts = factoryCanvasRows\.belts/);
    expect(app).toMatch(/reconcileFactoryCanvasTopology\([\s\S]*?activePlanetEntities,[\s\S]*?activePlanetBelts/);
    expect(app).toMatch(/<CanvasBeltLayer[\s\S]*?belts=\{canvasTopology\.belts\}/);
    expect(app).toMatch(/data-factory-canvas-source=\{factoryCanvasRows\.source\}/);
  });

  it("keeps selection and drag commands on stable IDs without rescanning full GameState rows", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const selector = readFileSync(resolve("src/game/nativeFactoryCanvasFrame.ts"), "utf8");
    const selection = app.slice(
      app.indexOf("const onSelectionChange"),
      app.indexOf("const onNodeClick"),
    );
    const drag = app.slice(
      app.indexOf("const handleFactoryNodeDragStart"),
      app.indexOf("const handleFactoryNodeDragStop"),
    );

    expect(selection).toMatch(/collectCanvasSelectionBeltIds\([\s\S]*?activePlanetBeltsRef\.current/);
    expect(selection).not.toMatch(/\}, \[activePlanetBelts,/);
    expect(selection).toMatch(/selectedBeltIdsRef\.current\.length > 0/);
    expect(selection).not.toMatch(/gameRef\.current\.belts/);
    expect(drag).toMatch(/collectCanvasDragMembers\(activeEntityById, selectedIds\)/);
    expect(drag).not.toMatch(/gameRef\.current\.entities/);
    expect(app).toMatch(/commitGame\(\(current\) => moveEntities\(current, positions\)\)/);
    expect(selector).not.toMatch(/DesktopBridge|applyNativeCoreCommand|advanceNativeCore|commitNativeCoreOperation/);
  });
});
