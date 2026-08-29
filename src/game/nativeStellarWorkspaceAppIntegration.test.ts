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
    expect(app).toMatch(/selectNativeStarMapCatalogFrame\(nativeStarMapCatalogSnapshot, nativeStellarProjectionIdentity\)/);
    expect(app).toMatch(/createNativePlayerAuthorityStarMapCatalogSource\(desktopBridge, nativeStellarProjectionIdentity\)/);
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
    expect(app).toMatch(/nativeStarMapCatalogStore\.refresh\([\s\S]*?nativeStarMapCatalogSource,[\s\S]*?nativeStellarProjectionIdentity/);
  });

  it("passes only the selector-checked read model and fails closed for player authority", () => {
    expect(app).toMatch(/const NativeStarMapWorkspace = lazy/);
    expect(app).toMatch(/starMapOpen \? nativePlayerAuthorityOwnsRuntime \? \([\s\S]*?<NativeStarMapWorkspace/);
    expect(app).toMatch(/readModel=\{nativeStarMapWorkspaceReadModel\}/);
    expect(app).toMatch(/readStatus=\{nativeStarMapWorkspaceReadStatus\}/);
    expect(app).toMatch(/mapCatalogFrame=\{nativeStarMapCatalogFrame\}/);
    expect(app).toMatch(/mapCatalogStatus=\{nativeStarMapCatalogStatus\}/);
    expect(app).toMatch(/industryReadRequest=\{starMapIndustryReadRequest\}/);
    expect(workspace).toMatch(/当前不会读取或显示 JavaScript 存档中的旧星图数据/);
    expect(app).toMatch(/quantumReadModel=\{nativeStellarQuantumReadModel\}/);
    expect(app).toMatch(/quantumReadStatus=\{nativeStellarQuantumReadStatus\}/);
    expect(app).toMatch(/onNativeQuantumItemCapacityChange=\{[\s\S]*?commitNativeProjectedCommand[\s\S]*?createNativeProjectedQuantumItemCapacityCommand/);
    expect(workspace).toMatch(/<NativeQuantumInventoryConsole readModel=\{quantumReadModel\}[\s\S]*?onNativeItemCapacityChange=\{onNativeQuantumItemCapacityChange\}/);
    const nativeQuantum = workspace.slice(
      workspace.indexOf("export function NativeQuantumInventoryConsole"),
      workspace.indexOf("export function NativeStarMapCatalogConsole"),
    );
    expect(nativeQuantum).not.toMatch(/\bgame\b|quantumLogisticsNetwork|getQuantumBandwidthSummary/);
    const nativeMap = workspace.slice(
      workspace.indexOf("export function NativeStarMapCatalogConsole"),
      workspace.indexOf("export function NativeStarMapWorkspace"),
    );
    expect(nativeMap).not.toMatch(/\bgame\b|getPlanetIndustrialProfile|isPlanetColonized|canColonizePlanet|canExploreStarSystem/);
    const nativeWorkspace = workspace.slice(
      workspace.indexOf("export function NativeStarMapWorkspace"),
      workspace.indexOf("export function StarMapWorkspace"),
    );
    expect(nativeWorkspace).not.toMatch(/\bgame\b|GameState|nativeAuthorityRequired/);
    expect(nativeWorkspace).toMatch(/view === "map" \? <NativeStarMapCatalogConsole/);
    expect(nativeWorkspace).toMatch(/view === "industry" \? <NativeIndustryConsole/);
  });

  it("renders native routes and indexes without reconstructing authority routes from GameState", () => {
    expect(workspace).toMatch(/readModel\?\.routes\.flatMap/);
    expect(workspace).toMatch(/readModel\.routeRowsById\.get\(route\.id\)/);
    expect(workspace).toMatch(/readModel\.routeRowsByTargetStationId\.get\(station\.stationId\)/);
    expect(workspace).toMatch(/readModel\.stationRowsById\.get\(route\.targetStationId\)/);
    expect(workspace).toMatch(/readModel\?\.planetRowsById\.get\(selector\.planetId\)/);
    expect(workspace).toMatch(/readModel\?\.systemRowsById\.get\(selector\.systemId\)/);
    expect(workspace).toMatch(/export function NativeStarMapWorkspace[\s\S]*?<NativeIndustryConsole/);
    expect(workspace).toMatch(/function IndustryConsole[\s\S]*?getStellarRouteSnapshots\(game\)/);
  });

  it("binds supported native configuration to exact projected commands while legacy edits retain commitGame", () => {
    const nativeWorkspace = workspace.slice(
      workspace.indexOf("export function NativeStarMapWorkspace"),
      workspace.indexOf("export function StarMapWorkspace"),
    );
    const nativeIndustryTag = nativeWorkspace.match(/<NativeIndustryConsole[^>]*\/>/)?.[0] ?? "";
    expect(nativeIndustryTag).toContain("<NativeIndustryConsole");
    expect(nativeIndustryTag).toContain("onNativeRoleChange={onNativeRoleChange}");
    expect(nativeIndustryTag).toContain("onNativeStationPriorityChange={onNativeStationPriorityChange}");
    expect(nativeIndustryTag).toContain("onNativeStationLimitsChange={onNativeStationLimitsChange}");
    expect(nativeIndustryTag).not.toContain("onTravel={onTravel}");
    expect(nativeIndustryTag).not.toContain("onStationMinimumLoadChange={onStationMinimumLoadChange}");
    expect(workspace).toMatch(/: <IndustryConsole game=\{game\}[\s\S]*?onRoleChange=\{onRoleChange\}[\s\S]*?onStationLimitsChange=\{onStationLimitsChange\}/);
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
