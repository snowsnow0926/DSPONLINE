import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native time-warp and ejector thin-inspector integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const inspector = readFileSync(
    resolve("src/components/NativeFactoryInspectorPanel.tsx"),
    "utf8",
  );
  const helper = readFileSync(
    resolve("src/game/nativeProjectedTimeWarpEjectorCommands.ts"),
    "utf8",
  );

  it("forms controller and ejector atoms only from matching native revision identities", () => {
    const start = app.indexOf("const nativeTimeWarpControllerProjectionBinding");
    const end = app.indexOf("const factorySelectionToolbarReadModel", start);
    const bindings = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(bindings).toMatch(/workspace\.sessionId !== configuration\.sessionId/);
    expect(bindings).toMatch(/workspace\.revision !== configuration\.revision/);
    expect(bindings).toMatch(/stellarIdentity\.sessionId !== configuration\.sessionId/);
    expect(bindings).toMatch(/stellarIdentity\.revision !== configuration\.revision/);
    expect(bindings).toMatch(/activePlanet\.planetId !== configuration\.activePlanetId/);
    expect(bindings).toMatch(/readNativeProjectedEjectorOrbitFrame\([\s\S]*?desktopBridge,[\s\S]*?nativeEjectorOrbitProjectionIdentity/);
    expect(bindings).toMatch(/let current = true[\s\S]*?if \(current\) setNativeEjectorOrbitFrame\(frame\)/);
    expect(bindings).not.toMatch(/gameRef|game\.entities|dysonEngineering\.orbitsBySystem/);
  });

  it("rechecks selection drift and submits only minimal semantic or leaf commands", () => {
    const start = app.indexOf("const changeNativeTimeWarpEnabled");
    const end = app.indexOf("const selectedBelts", start);
    const handlers = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handlers).toMatch(/nativeFactoryProjectionIdentityRef\.current/);
    expect(handlers).toMatch(/nativePlayerAuthorityCommandBindingRef\.current\?\.source/);
    expect(handlers).toMatch(/selectedEntityIdsRef\.current\.length !== 1[\s\S]*?selectedBeltIdsRef\.current\.length !== 0/);
    expect(handlers).toMatch(/commandSource\.baseRevision !== binding\.revision/);
    expect(handlers).toMatch(/handleTimeWarpEnabledChange\(enabled\)/);
    expect(handlers).toMatch(/createNativeProjectedTimeWarpRequestedMultiplierCommand\(binding, requestedMultiplier\)/);
    expect(handlers).toMatch(/frame\.activeSystemId !== identity\.activeSystemId/);
    expect(handlers).toMatch(/createNativeProjectedEjectorOrbitCommand\(frame, orbitId\)/);
    expect(handlers).toMatch(/durable revision \$\{receipt\.revision\}/);
    expect(handlers).not.toMatch(/commitGame|gameRef\.current|setEjectorTargetOrbit|setTimeWarpRequestedMultiplier/);

    expect(helper).toMatch(/path: \["timeWarp", "intent"\]/);
    expect(helper).toMatch(/changedEntities = \[\{[\s\S]*?path: \["targetDysonOrbitId"\]/);
    expect(helper).not.toMatch(/path: \["timeWarp", "effectiveMultiplier"\]/);
    expect(helper).not.toMatch(/path: \["timeWarp", "requiredPowerKw"\]/);
  });

  it("renders Rust-only controls while the ordinary Web handlers remain unchanged", () => {
    expect(inspector).toMatch(/data-native-time-warp-controller="semantic-intent-v1"/);
    expect(inspector).toMatch(/data-native-ejector-orbit="entity-leaf-v1"/);
    expect(app).toMatch(/timeWarpController=\{nativeTimeWarpControllerProjectionBinding\}/);
    expect(app).toMatch(/ejectorOrbitFrame=\{nativeEjectorOrbitFrame\}/);
    expect(app).toMatch(/onEjectorOrbitChange=\{changeNativeEjectorOrbit\}/);
    expect(app).toMatch(/onEjectorOrbitChange=\{\(entityId, orbitId\) => \{[\s\S]*?setEjectorTargetOrbit\(current, entityId, orbitId\)/);
    expect(app).toMatch(/onTimeWarpRequestedMultiplierChange=\{\(multiplier\) => commitGame\(\(current\) => setTimeWarpRequestedMultiplier\(current, multiplier\)\)\}/);
  });
});
