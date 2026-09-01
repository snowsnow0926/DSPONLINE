import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native Dyson workspace App integration", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("binds the workspace to the exact native session, revision, registry, and selected system", () => {
    expect(app).toMatch(/new NativeDysonWorkspaceStore\(\)/);
    expect(app).toMatch(/nativeDysonWorkspaceIdentity = useMemo\(\(\) => \{[\s\S]*?nativeThinWorkspaceAuthorityFrames\.displayFrame[\s\S]*?runId: frame\.runId[\s\S]*?selectedSystemId: nativeDysonEffectiveSystemId/);
    expect(app).toMatch(/nativeDysonWorkspaceReadIdentity = useMemo\(\(\) => \{[\s\S]*?nativeThinWorkspaceAuthorityFrames\.readFrame[\s\S]*?runId: frame\.runId[\s\S]*?selectedSystemId: nativeDysonEffectiveSystemId/);
    expect(app).toMatch(/createNativePlayerAuthorityDysonWorkspaceSource\(desktopBridge, nativeDysonWorkspaceReadIdentity\)/);
    expect(app).toMatch(/selectNativeDysonWorkspaceFrame\(nativeDysonWorkspaceSnapshot, nativeDysonWorkspaceIdentity\)/);
    expect(app).toMatch(/<NativeDysonPlannerWorkspace[\s\S]*?latestIdentity=\{nativeDysonWorkspaceIdentity\}/);
  });

  it("keeps the last confirmed page through an in-flight revision and clears only on scope loss", () => {
    expect(app).toMatch(/!dysonPlannerOpen \|\| !nativePlayerAuthorityBoundFrame \|\| !nativeDysonWorkspaceIdentity \|\|[\s\S]*?!nativePlayerAuthorityOwnsRuntime[\s\S]*?nativeDysonWorkspaceStore\.clear\(\)/);
    expect(app).toMatch(/if \(!nativeDysonWorkspaceReadIdentity \|\| !nativeDysonWorkspaceSource\) return/);
    expect(app).toMatch(/nativeDysonWorkspaceStore\.refresh\([\s\S]*?nativeDysonWorkspaceSource,[\s\S]*?nativeDysonWorkspaceReadIdentity/);
    expect(app).toMatch(/key=\{nativeDysonWorkspaceIdentity[\s\S]*?sessionId[\s\S]*?runId[\s\S]*?registryFingerprint/);
    expect(app).not.toMatch(/key=\{[^}]*nativeDysonWorkspaceIdentity\.revision/);
  });

  it("renders the native component before the legacy workspace and wires only projected Dyson commands", () => {
    expect(app).toMatch(/dysonPlannerOpen \? nativePlayerAuthorityBoundFrame \? \([\s\S]*?<NativeDysonPlannerWorkspace[\s\S]*?frame=\{nativeDysonWorkspaceFrame\}[\s\S]*?status=\{nativeDysonWorkspaceReadStatus\}/);
    const nativeTag = app.match(/<NativeDysonPlannerWorkspace[\s\S]*?\/>/)?.[0] ?? "";
    expect(nativeTag).toContain("onSelectSystem={setNativeDysonSelectedSystemId}");
    expect(nativeTag).toContain("onSelectLayer={onNativeDysonSelectLayer}");
    expect(nativeTag).toContain("onSelectOrbit={onNativeDysonSelectOrbit}");
    expect(nativeTag).toContain("onOrbitChange={onNativeDysonOrbitChange}");
    expect(nativeTag).toContain("onLaunchModeChange={onNativeDysonLaunchModeChange}");
    expect(nativeTag).toContain("onLaunchThrottleChange={onNativeDysonLaunchThrottleChange}");
    expect(nativeTag).toContain("onLaunchEnabledChange={onNativeDysonLaunchEnabledChange}");
    expect(nativeTag).not.toMatch(/\bgame=|onAddLayer=|commitGame/);
    expect(app).toMatch(/nativePlayerAuthorityBoundFrame \? \([\s\S]*?<NativeDysonPlannerWorkspace[\s\S]*?: authorityWorkspaceSync === "dyson"[\s\S]*?<DysonPlannerWorkspace/);
  });

  it("commits launch and orbit changes against the exact projected revision without mutating the renderer save", () => {
    const handlers = app.slice(
      app.indexOf("const onNativeDysonSelectLayer"),
      app.indexOf("const onFuelChange"),
    );
    expect(handlers).toMatch(/commitNativeProjectedCommand\(frame\.revision/);
    expect(handlers).toMatch(/createNativeProjectedDysonActiveLayerCommand\(frame, layerId\)/);
    expect(handlers).toMatch(/createNativeProjectedDysonActiveOrbitCommand\(frame, orbitId\)/);
    expect(handlers).toMatch(/createNativeProjectedDysonOrbitGeometryCommand\(frame, orbitId, changes\)/);
    expect(handlers).toMatch(/createNativeProjectedDysonLaunchModeCommand\(frame, mode\)/);
    expect(handlers).toMatch(/createNativeProjectedDysonLaunchThrottleCommand\(frame, throttle\)/);
    expect(handlers).toMatch(/createNativeProjectedDysonLaunchEnabledCommand\(frame, enabled\)/);
    expect(handlers).not.toMatch(/commitGame|gameRef|publishRuntimeGame/);
  });

  it("never derives the native selected system from a stale renderer save", () => {
    expect(app).toMatch(/nativeDysonFactorySystemId = nativeAuthoritativeFactoryWorkspaceFrame[\s\S]*?\? factoryActivePlanetNavigationRow\?\.systemId[\s\S]*?: undefined/);
    expect(app).toMatch(/nativeDysonRetainedSystemId = useMemo\(\(\) => \{[\s\S]*?frame\.sessionId === authority\.sessionId[\s\S]*?frame\.runId === authority\.runId[\s\S]*?frame\.revision <= authority\.revision[\s\S]*?frame\.registryFingerprint === recipeWorkspaceRegistryFingerprint/);
    expect(app).toMatch(/nativeDysonEffectiveSystemId = nativeDysonSelectedSystemId[\s\S]*?nativeDysonRetainedSystemId/);
    expect(app).not.toMatch(/nativeDysonEffectiveSystemId[\s\S]{0,240}game\.activePlanetId/);
  });
});
