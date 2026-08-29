import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native ordinary belt removal App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const inspector = readFileSync(resolve("src/components/NativeFactoryInspectorPanel.tsx"), "utf8");

  it("exposes only one guarded ordinary-line removal action", () => {
    expect(inspector).toMatch(/data-native-belt-removal="ordinary-single-v1"/);
    expect(inspector).toMatch(/onRemove\(belt\.beltId\)/);
    expect(app).toMatch(/onRemoveBelt=\{\(beltId\) => void removeNativeOrdinaryBelt\(beltId\)\}/);
  });

  it("re-reads the Rust refund capability and never removes from legacy GameState", () => {
    const start = app.indexOf("const removeNativeOrdinaryBelt");
    const end = app.indexOf("const changeNativeOrdinaryBeltPriority", start);
    const handler = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handler).toMatch(/gameDialog\.confirm[\s\S]*?确认安全拆线/);
    expect(handler).toMatch(/readVerifiedNativeConstructionBeltRemovalContext\([\s\S]*?\{ beltId \}/);
    expect(handler).toMatch(/context\.sourceId !== projected\.sourceEntityId[\s\S]*?context\.lanes !== projected\.lanes/);
    expect(handler).toMatch(/commitNativeProjectedCommand\(context\.revision,[\s\S]*?createNativeProjectedOrdinaryBeltRemovalCommand\(context\)/);
    expect(handler).not.toMatch(/removeBelt\(|commitGame|gameRef\.current/);
  });
});
