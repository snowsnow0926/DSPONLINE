import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native ordinary building stack App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const inspector = readFileSync(resolve("src/components/NativeFactoryInspectorPanel.tsx"), "utf8");

  it("offers bounded plus/minus actions from the thin Rust inspector", () => {
    expect(inspector).toMatch(/data-native-construction-stack="ordinary-single-v1"/);
    expect(inspector).toMatch(/onStackCountChange\(entity\.entityId, entity\.machineCount - 1\)/);
    expect(inspector).toMatch(/onStackCountChange\(entity\.entityId, entity\.machineCount \+ 1\)/);
    expect(app).toMatch(/onStackCountChange=\{\(entityId, targetCount\) => void changeNativeOrdinaryBuildingStack\(entityId, targetCount\)\}/);
  });

  it("uses a fresh same-revision Rust proof and does not calculate inventory locally", () => {
    const start = app.indexOf("const changeNativeOrdinaryBuildingStack");
    const end = app.indexOf("const selectedBelts", start);
    const handler = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handler).toMatch(/nativeFactoryProjectionIdentityRef\.current[\s\S]*?nativePlayerAuthorityCommandBindingRef\.current/);
    expect(handler).toMatch(/readVerifiedNativeConstructionStackContext\([\s\S]*?entityId, targetCount/);
    expect(handler).toMatch(/context\.currentCount !== projected\.machineCount/);
    expect(handler).toMatch(/commitNativeProjectedCommand\(context\.revision,[\s\S]*?createNativeProjectedOrdinaryBuildingStackCommand\(context\)/);
    expect(handler).not.toMatch(/gameRef\.current\.(?:construction|entities)|setEntityStackTarget|commitGame/);
  });
});
