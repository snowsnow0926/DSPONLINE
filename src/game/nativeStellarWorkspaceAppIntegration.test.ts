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
    expect(app).toMatch(/selectNativePlayerAuthorityStellarQuantumReadModel\([\s\S]*?nativeStellarWorkspaceSnapshot,[\s\S]*?nativeStellarProjectionIdentity,[\s\S]*?DEFAULT_NATIVE_STELLAR_QUANTUM_SELECTOR/);
  });

  it("refreshes overview independently and makes scope, filter, and query latest-only through the store", () => {
    expect(app).toMatch(/refreshOverview\([\s\S]*?nativeStellarProjectionIdentity,[\s\S]*?cursor: 0, limit: NATIVE_STELLAR_PAGE_ROWS/);
    expect(app).toMatch(/refreshIndustry\([\s\S]*?nativeStellarProjectionIdentity,[\s\S]*?nativeStellarIndustrySelector/);
    expect(app).toMatch(/nativeStellarIndustrySelector,[\s\S]*?nativeStellarProjectionIdentity,[\s\S]*?nativeStellarProjectionSource,[\s\S]*?nativeStellarWorkspaceStore,[\s\S]*?starMapOpen/);
    expect(workspace).toMatch(/星际工业恒星系筛选/);
    expect(workspace).toMatch(/星际工业行星筛选/);
    expect(workspace).toMatch(/routeFilter: "issues"/);
    expect(workspace).toMatch(/query: clampNativeRouteQuery\(query\)/);
    expect(app).toMatch(/refreshQuantum\([\s\S]*?nativeStellarProjectionSource,[\s\S]*?nativeStellarProjectionIdentity,[\s\S]*?DEFAULT_NATIVE_STELLAR_QUANTUM_SELECTOR/);
  });

  it("passes only the selector-checked read model and fails closed for player authority", () => {
    expect(app).toMatch(/nativeReadModel=\{nativeStarMapWorkspaceReadModel\}/);
    expect(app).toMatch(/nativeReadStatus=\{nativeStarMapWorkspaceReadStatus\}/);
    expect(app).toMatch(/nativeAuthorityRequired=\{Boolean\(nativePlayerAuthorityBoundFrame\)\}/);
    expect(app).toMatch(/industryReadRequest=\{starMapIndustryReadRequest\}/);
    expect(workspace).toMatch(/nativeAuthorityRequired\s*\? <NativeIndustryConsole/);
    expect(workspace).toMatch(/当前不会显示或使用 JavaScript 存档数据/);
    expect(workspace).toMatch(/view === "map" \? nativeAuthorityRequired \? nativeMapUnavailableBoundary/);
    expect(app).toMatch(/nativeQuantumReadModel=\{nativeStellarQuantumReadModel\}/);
    expect(app).toMatch(/nativeQuantumReadStatus=\{nativeStellarQuantumReadStatus\}/);
    expect(app).toMatch(/onNativeQuantumItemCapacityChange=\{[\s\S]*?commitNativeProjectedCommand[\s\S]*?createNativeProjectedQuantumItemCapacityCommand/);
    expect(workspace).toMatch(/const nativeQuantumConsole = <NativeQuantumInventoryConsole/);
    expect(workspace).toMatch(/onNativeItemCapacityChange=\{onNativeQuantumItemCapacityChange\}/);
    expect(workspace).toMatch(/nativeAuthorityRequired \? nativeQuantumConsole : <QuantumInventoryConsole/);
    const nativeQuantum = workspace.slice(
      workspace.indexOf("export function NativeQuantumInventoryConsole"),
      workspace.indexOf("export function StarMapWorkspace"),
    );
    expect(nativeQuantum).not.toMatch(/\bgame\b|quantumLogisticsNetwork|getQuantumBandwidthSummary/);
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

  it("binds supported native configuration to exact projected commands while legacy edits retain commitGame", () => {
    const industryBranch = workspace.match(/const industryConsole = nativeAuthorityRequired[\s\S]*?;\n/)?.[0] ?? "";
    const nativeIndustryTag = industryBranch.match(/<NativeIndustryConsole[^>]*\/>/)?.[0] ?? "";
    expect(nativeIndustryTag).toContain("<NativeIndustryConsole");
    expect(nativeIndustryTag).toContain("onNativeRoleChange={onNativeRoleChange}");
    expect(nativeIndustryTag).toContain("onNativeStationPriorityChange={onNativeStationPriorityChange}");
    expect(nativeIndustryTag).toContain("onNativeStationLimitsChange={onNativeStationLimitsChange}");
    expect(nativeIndustryTag).not.toContain("onStationMinimumLoadChange={onStationMinimumLoadChange}");
    expect(industryBranch).toMatch(/: <IndustryConsole game=\{game\}[\s\S]*?onRoleChange=\{onRoleChange\}[\s\S]*?onStationLimitsChange=\{onStationLimitsChange\}/);
    expect(workspace).toMatch(/工业定位、优先级和库存上下限使用当前投影 revision 的直接命令；最低装载率仍只读/);
    expect(workspace).toMatch(/aria-label=\{`\$\{route\.itemLabel\}航线优先级`\}[\s\S]*?disabled=\{!onNativeStationPriorityChange\}/);
    expect(workspace).toMatch(/aria-label=\{`\$\{route\.itemLabel\}最低装载率`\}[\s\S]*?value=\{route\.minimumLoad\} disabled/);
    expect(app).toMatch(/onNativeRoleChange=\{[\s\S]*?commitNativeProjectedCommand[\s\S]*?createNativeProjectedPlanetRoleCommand/);
    expect(app).toMatch(/onNativeStationPriorityChange=\{[\s\S]*?commitNativeProjectedCommand[\s\S]*?createNativeProjectedStationPriorityCommand/);
    expect(app).toMatch(/onNativeStationLimitsChange=\{[\s\S]*?commitNativeProjectedCommand[\s\S]*?createNativeProjectedStationLimitsCommand/);
    expect(app).toMatch(/onRoleChange=\{\(planetId: PlanetId, role: PlanetIndustryRole\) => commitGame/);
    expect(app).toMatch(/onStationPriorityChange=\{[\s\S]*?=> commitGame/);
    expect(app).toMatch(/onStationMinimumLoadChange=\{[\s\S]*?=> commitGame/);
    expect(app).toMatch(/onStationLimitsChange=\{[\s\S]*?=> commitGame/);
  });
});
