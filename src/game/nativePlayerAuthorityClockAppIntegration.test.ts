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

  it("keeps this as consumer/revision wiring rather than claiming a complete thin UI", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const clock = readFileSync(resolve("src/game/nativePlayerAuthorityClock.ts"), "utf8");

    expect(app).toMatch(/createWebFactoryViewportReadModel\(game/);
    expect(app).toMatch(/createWebFactoryConstructionWorkspaceReadModel\(game\)/);
    expect(clock).not.toMatch(/GameState|applyNativeCoreCommand|advanceNativeCore|commitNativeCoreOperation/);
    expect(clock).toMatch(/read-only source/i);
  });
});
