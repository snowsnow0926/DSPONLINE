import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native black-hole inspector integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const inspector = readFileSync(resolve("src/components/NativeFactoryInspectorPanel.tsx"), "utf8");

  it("binds the control to one exact Rust projection and durable receipt", () => {
    const start = app.indexOf("const changeNativeBlackHolePaused");
    const end = app.indexOf("const selectedBelts", start);
    const handler = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handler).toMatch(/nativeEntityConfigurationProjectionBinding/);
    expect(handler).toMatch(/binding\.entity\.buildingId !== "micro_black_hole_connector"/);
    expect(handler).toMatch(/binding\.sessionId !== routeIdentity\.sessionId[\s\S]*?binding\.revision !== routeIdentity\.revision/);
    expect(handler).toMatch(/commandSource\.baseRevision !== binding\.revision/);
    expect(handler).toMatch(/selectedEntityIdsRef\.current\.length !== 1[\s\S]*?selectedBeltIdsRef\.current\.length !== 0/);
    expect(handler).toMatch(/createNativeProjectedBlackHolePausedCommand\(\{[\s\S]*?baseRevision,[\s\S]*?entityId,[\s\S]*?paused,[\s\S]*?confirmActivation/);
    expect(handler).toMatch(/\(receipt\) => setNotice\([\s\S]*?receipt\.revision/);
    expect(handler).not.toMatch(/commitGame|gameRef\.current|setBlackHolePaused|blackHolePorts|totalDestroyed/);
  });

  it("renders the established double-confirm control only from the pinned native entity", () => {
    expect(inspector).toMatch(/data-native-black-hole-paused="micro-black-hole-v1"/);
    expect(inspector).toMatch(/configuration\?\.entity\.buildingId === "micro_black_hole_connector"/);
    expect(inspector).toMatch(/typeof configuration\.entity\.blackHolePaused === "boolean"/);
    expect(inspector).toMatch(/typeof configuration\.entity\.blackHoleActivationConfirmed === "boolean"/);
    expect(app).toMatch(/继续确认[\s\S]*?确认启动/);
    expect(inspector).toMatch(/onBlackHolePausedChange\(entity\.entityId, false\)/);
    expect(app).toMatch(/onBlackHolePausedChange=\{changeNativeBlackHolePaused\}/);
  });

  it("keeps the ordinary Web inspector on the JavaScript engine command", () => {
    expect(app).toMatch(/onBlackHolePausedChange=\{changeNativeBlackHolePaused\}/);
    expect(app).toMatch(/onBlackHolePausedChange=\{\(entityId, paused, confirmActivation\) => \{[\s\S]*?setBlackHolePaused\(current, entityId, paused, confirmActivation\)/);
  });
});
