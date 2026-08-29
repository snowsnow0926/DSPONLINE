import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("native ordinary belt lane App integration", () => {
  it("uses only the same-revision Rust context and durable command", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const inspector = readFileSync(resolve("src/components/NativeFactoryInspectorPanel.tsx"), "utf8");
    expect(inspector).toMatch(/data-native-belt-lanes="ordinary-single-v1"/);
    expect(app).toMatch(/onBeltLaneCountChange=\{\(beltId, targetLanes\) => void changeNativeOrdinaryBeltLanes/);
    const start = app.indexOf("const changeNativeOrdinaryBeltLanes");
    const end = app.indexOf("const changeNativeOrdinaryBeltPriority", start);
    const handler = app.slice(start, end);
    expect(handler).toMatch(/readVerifiedNativeConstructionBeltLaneContext/);
    expect(handler).toMatch(/createNativeProjectedOrdinaryBeltLaneCommand/);
    expect(handler).toMatch(/commitNativeProjectedCommand/);
    expect(handler).not.toMatch(/setBeltLaneCount|commitGame|gameRef\.current/);
  });
});
