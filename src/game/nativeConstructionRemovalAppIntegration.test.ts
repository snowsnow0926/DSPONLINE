import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native ordinary construction removal App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const inspector = readFileSync(resolve("src/components/NativeFactoryInspectorPanel.tsx"), "utf8");
  const boundary = readFileSync(resolve("src/game/nativeConstructionRemoval.ts"), "utf8");

  it("requests a fresh Rust capability only after the destructive confirmation", () => {
    const handlerStart = app.indexOf("const removeNativeOrdinaryBuilding");
    const handlerEnd = app.indexOf("const selectedBelts", handlerStart);
    const handler = app.slice(handlerStart, handlerEnd);
    expect(handlerStart).toBeGreaterThan(0);
    expect(handler).toMatch(/gameDialog\.confirm\([\s\S]*?readVerifiedNativeConstructionRemovalContext/);
    expect(handler).toMatch(/nativeFactoryProjectionIdentityRef\.current[\s\S]*?nativePlayerAuthorityCommandBindingRef\.current/);
    expect(handler).toMatch(/context\.activePlanetId !== routeIdentity\.planetId/);
    expect(handler).toMatch(/commitNativeProjectedCommand\(context\.revision,[\s\S]*?createNativeProjectedOrdinaryBuildingRemovalCommand/);
  });

  it("exposes only the guarded whole-building action in the native inspector", () => {
    expect(app).toMatch(/<NativeFactoryInspectorPanel[\s\S]*?pending=\{nativeRemovalContextPending \|\| nativePlayerAuthorityCommandPending\}/);
    expect(app).toMatch(/onRemoveEntity=\{\(entityId\) => void removeNativeOrdinaryBuilding\(entityId\)\}/);
    expect(inspector).toMatch(/data-native-construction-removal="ordinary-complete-v1"/);
    expect(inspector).toMatch(/disabled=\{pending \|\| entity\.interactionLocked/);
    expect(inspector).toMatch(/onClick=\{\(\) => onRemoveEntity\(entity\.entityId\)\}/);
  });

  it("builds the refund/removal command without reading GameState", () => {
    expect(boundary).not.toMatch(/GameState|removeEntity\(|gameRef|commitGame/);
    expect(boundary).toMatch(/path: \["construction", context\.buildingId\]/);
    expect(boundary).toMatch(/removedEntityIds: \[context\.entityId\]/);
    expect(boundary).toMatch(/changedBelts: \[\][\s\S]*?addedBelts: \[\][\s\S]*?removedBeltIds: \[\]/);
  });
});
