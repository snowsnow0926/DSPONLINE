import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native belt priority App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const inspector = readFileSync(resolve("src/components/NativeFactoryInspectorPanel.tsx"), "utf8");

  it("offers only the three typed priorities from the thin Rust inspector", () => {
    expect(inspector).toMatch(/data-native-belt-priority="ordinary-single-v1"/);
    expect(inspector).toMatch(/\(\[0, 1, 2\] as const\)\.map/);
    expect(inspector).toMatch(/onPriorityChange\(belt\.beltId, priority\)/);
    expect(app).toMatch(/onBeltPriorityChange=\{changeNativeOrdinaryBeltPriority\}/);
  });

  it("binds the command to the exact Rust selection without touching legacy GameState", () => {
    const start = app.indexOf("const changeNativeOrdinaryBeltPriority");
    const end = app.indexOf("const selectedBelts", start);
    const handler = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handler).toMatch(/nativeFactoryProjectionIdentityRef\.current[\s\S]*?nativePlayerAuthorityCommandBindingRef\.current/);
    expect(handler).toMatch(/selectedBeltIdsRef\.current\.length !== 1[\s\S]*?selectedBeltIdRef\.current !== beltId/);
    expect(handler).toMatch(/commitNativeProjectedCommand\(routeIdentity\.revision,[\s\S]*?createNativeProjectedBeltPriorityCommand/);
    expect(handler).not.toMatch(/setBeltPriority|commitGame|gameRef\.current/);
  });
});
