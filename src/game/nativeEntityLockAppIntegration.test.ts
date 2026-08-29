import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native entity lock App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const inspector = readFileSync(resolve("src/components/NativeFactoryInspectorPanel.tsx"), "utf8");

  it("offers lock and unlock from the thin Rust inspector", () => {
    expect(inspector).toMatch(/data-native-entity-lock="ordinary-single-v1"/);
    expect(inspector).toMatch(/onEntityLockChange\(entity\.entityId, !entity\.interactionLocked\)/);
    expect(app).toMatch(/<NativeFactoryInspectorPanel[\s\S]*?onEntityLockChange=\{\(_entityId, locked\) => void commitNativeSelectionInteractionLock\(locked\)\}/);
  });

  it("reuses the exact bounded Rust selection command without legacy mutation", () => {
    const start = app.indexOf("const commitNativeSelectionInteractionLock");
    const end = app.indexOf("const removeNativeOrdinaryBuilding", start);
    const handler = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handler).toMatch(/factoryInteractionRows\.source !== "native-authoritative"/);
    expect(handler).toMatch(/nativePlayerAuthorityCommandBindingRef\.current[\s\S]*?nativeFactoryProjectionIdentityRef\.current/);
    expect(handler).toMatch(/commitNativeProjectedCommand\([\s\S]*?createNativeProjectedInteractionLockCommandFromReadModels/);
    expect(handler).not.toMatch(/setEntitiesInteractionLocked|commitGame|gameRef\.current/);
  });
});
