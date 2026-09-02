import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native ordinary belt placement App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const dock = readFileSync(resolve("src/components/NativeConstructionDock.tsx"), "utf8");
  const nodes = readFileSync(resolve("src/components/FactoryNodes.tsx"), "utf8");

  it("arms only an explicit registered tier and leaves native cards otherwise read-only", () => {
    expect(dock).toMatch(/getBeltTiers\(\)\.find\(\(tier\) => getBeltConstructionId\(tier\) === buildingId\)/);
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

  it("commits continuous native belts as one bounded Rust batch", () => {
    const start = app.indexOf("const confirmBatchConnection");
    const block = app.slice(start, app.indexOf("useEffect(() => { confirmBatchConnectionRef", start));
    expect(start).toBeGreaterThan(0);
    expect(block).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?commitNativeProjectedCommand\(frame\.revision/);
    expect(block).toMatch(/createNativeFactoryBeltBatchCommand\(baseRevision, selections\.map/);
    expect(block).toMatch(/sourceId:[\s\S]*?targetId:[\s\S]*?itemId:[\s\S]*?tier:[\s\S]*?lanes:/);
    expect(block).toMatch(/clearConnectionPreview\(false\)/);
    expect(dock).toMatch(/连续批量拉线和特殊物流端口使用独立原子命令/);
  });
});
