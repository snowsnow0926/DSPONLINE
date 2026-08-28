import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native stellar workspace App integration", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const workspace = readFileSync(
    fileURLToPath(new URL("../components/StarMapWorkspace.tsx", import.meta.url)),
    "utf8",
  );

  it("selects the complete v2 workspace model for the exact authority identity and selector", () => {
    expect(app).toMatch(/selectNativeStarMapWorkspaceReadModel\([\s\S]*?nativeStellarWorkspaceSnapshot,[\s\S]*?nativeStellarProjectionIdentity,[\s\S]*?nativeStellarIndustrySelector/);
    expect(app).toMatch(/nativeStellarIndustrySelector = useMemo<NativeStellarIndustrySelector>[\s\S]*?planetCursor: 0,[\s\S]*?stationCursor: 0,[\s\S]*?routeCursor: 0,[\s\S]*?routeFilter/);
    expect(app).toMatch(/createNativePlayerAuthorityStellarProjectionSource\(desktopBridge, nativeStellarProjectionIdentity\)/);
    expect(app).not.toMatch(/const nativeStarMapOverviewProjection = useMemo/);
    expect(app).not.toMatch(/const nativeStellarIndustryProjection = useMemo/);
  });

  it("refreshes overview independently and makes scope, filter, and query latest-only through the store", () => {
    expect(app).toMatch(/refreshOverview\([\s\S]*?nativeStellarProjectionIdentity,[\s\S]*?cursor: 0, limit: NATIVE_STELLAR_PAGE_ROWS/);
    expect(app).toMatch(/refreshIndustry\([\s\S]*?nativeStellarProjectionIdentity,[\s\S]*?nativeStellarIndustrySelector/);
    expect(app).toMatch(/nativeStellarIndustrySelector,[\s\S]*?nativeStellarProjectionIdentity,[\s\S]*?nativeStellarProjectionSource,[\s\S]*?nativeStellarWorkspaceStore,[\s\S]*?starMapOpen/);
    expect(workspace).toMatch(/星际工业恒星系筛选/);
    expect(workspace).toMatch(/星际工业行星筛选/);
    expect(workspace).toMatch(/routeFilter: "issues"/);
    expect(workspace).toMatch(/query: clampNativeRouteQuery\(query\)/);
  });

  it("passes only the selector-checked read model and fails closed for player authority", () => {
    expect(app).toMatch(/nativeReadModel=\{nativeStarMapWorkspaceReadModel\}/);
    expect(app).toMatch(/nativeReadStatus=\{nativeStarMapWorkspaceReadStatus\}/);
    expect(app).toMatch(/nativeAuthorityRequired=\{Boolean\(nativePlayerAuthorityBoundFrame\)\}/);
    expect(app).toMatch(/industryReadRequest=\{starMapIndustryReadRequest\}/);
    expect(workspace).toMatch(/nativeAuthorityRequired\s*\? <NativeIndustryConsole/);
    expect(workspace).toMatch(/玩家权威模式不会回退 JavaScript 存档/);
    expect(workspace).toMatch(/nativeAuthorityRequired && !nativeReadModel/);
  });

  it("renders native routes and indexes without reconstructing authority routes from GameState", () => {
    expect(workspace).toMatch(/readModel\?\.routes\.flatMap/);
    expect(workspace).toMatch(/readModel\.routeRowsById\.get\(route\.id\)/);
    expect(workspace).toMatch(/readModel\.routeRowsByTargetStationId\.get\(station\.stationId\)/);
    expect(workspace).toMatch(/readModel\.stationRowsById\.get\(route\.targetStationId\)/);
    expect(workspace).toMatch(/readModel\?\.planetRowsById\.get\(selector\.planetId\)/);
    expect(workspace).toMatch(/readModel\?\.systemRowsById\.get\(selector\.systemId\)/);
    expect(workspace).toMatch(/nativeAuthorityRequired[\s\S]*?<NativeIndustryConsole[\s\S]*?: <IndustryConsole game=\{game\}/);
    expect(workspace).toMatch(/function IndustryConsole[\s\S]*?getStellarRouteSnapshots\(game\)/);
  });

  it("keeps stellar edits on the existing commitGame command path", () => {
    expect(app).toMatch(/onRoleChange=\{\(planetId: PlanetId, role: PlanetIndustryRole\) => commitGame/);
    expect(app).toMatch(/onStationPriorityChange=\{[\s\S]*?=> commitGame/);
    expect(app).toMatch(/onStationMinimumLoadChange=\{[\s\S]*?=> commitGame/);
    expect(app).toMatch(/onStationLimitsChange=\{[\s\S]*?=> commitGame/);
  });
});
