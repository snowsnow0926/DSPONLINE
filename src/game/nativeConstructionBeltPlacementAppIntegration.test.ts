import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native ordinary belt placement App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const dock = readFileSync(resolve("src/components/NativeConstructionDock.tsx"), "utf8");
  const nodes = readFileSync(resolve("src/components/FactoryNodes.tsx"), "utf8");

  it("arms only an explicit built-in tier and leaves native cards otherwise read-only", () => {
    expect(dock).toMatch(/BELT_TIER_BY_CONSTRUCTION_ID[\s\S]*?conveyor_belt_mk1: 1[\s\S]*?conveyor_belt_mk3: 3/);
    expect(dock).toMatch(/onBeltPlacementChange\(selected \? null : beltTier\)/);
    expect(app).toMatch(/nativeBeltPlacementTier !== null[\s\S]*?getNativeCoreConstructionBeltPlacementContext/);
    expect(app).toMatch(/readOnly: nativePlayerAuthorityOwnsRuntime,[\s\S]*?beltConnectionsEnabled: nativeOrdinaryBeltConnectionEnabled/);
    expect(nodes).toMatch(/readOnly\?: boolean;[\s\S]*?beltConnectionsEnabled\?: boolean/);
    expect(nodes).toMatch(/isConnectable=\{!readOnly \|\| connectionsEnabled\}/);
  });

  it("re-reads one exact Rust capability and never predicts the belt into GameState", () => {
    const start = app.indexOf("const requestNativeOrdinaryBeltPlacement");
    const end = app.indexOf("const onConnect = useCallback", start);
    const handler = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handler).toMatch(/readVerifiedNativeConstructionBeltPlacementContext\([\s\S]*?sourceId: connection\.source![\s\S]*?tier: requestedTier,[\s\S]*?lanes/);
    expect(handler).toMatch(/isUniversalInputHandle\(connection\.targetHandle\)[\s\S]*?parseTargetPortIndex\(connection\.targetHandle\) !== undefined/);
    expect(handler).toMatch(/commitNativeProjectedCommand\(context\.revision,[\s\S]*?createNativeProjectedOrdinaryBeltPlacementCommand\(context\)/);
    expect(handler).not.toMatch(/connectBeltWithResult|commitGame|gameRef\.current\.(?:construction|entities|belts)/);
  });

  it("keeps batch and special-port behavior fail-closed", () => {
    expect(app).toMatch(/modifierContinuous[\s\S]*?Windows 原生模式当前只允许逐条拉线/);
    expect(app).toMatch(/const confirmBatchConnection[\s\S]*?nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?clearConnectionPreview\(false\)/);
    expect(dock).toMatch(/自动选级、连续批量拉线和特殊物流端口仍保持关闭/);
  });
});
