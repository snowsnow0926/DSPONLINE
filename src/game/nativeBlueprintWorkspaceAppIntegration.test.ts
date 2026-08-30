import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native blueprint workspace App integration", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const component = readFileSync(
    fileURLToPath(new URL("../components/NativeBlueprintWorkspace.tsx", import.meta.url)),
    "utf8",
  );
  const store = readFileSync(
    fileURLToPath(new URL("./nativeBlueprintWorkspaceStore.ts", import.meta.url)),
    "utf8",
  );

  it("binds every page to the active authority session, run, revision, and registry", () => {
    expect(app).toMatch(/new NativeBlueprintWorkspaceStore\(\)/);
    expect(app).toMatch(/nativeFactoryInventoryIdentity = useMemo<NativeFactoryInventoryIdentity \| null>[\s\S]*?sessionId,[\s\S]*?runId,[\s\S]*?revision: factoryThinViewExpectedRevision,[\s\S]*?registryFingerprint: recipeWorkspaceRegistryFingerprint/);
    expect(app).toMatch(/createNativePlayerAuthorityBlueprintWorkspaceSource\(desktopBridge, nativeFactoryInventoryIdentity\)/);
    expect(app).toMatch(/selectNativeBlueprintWorkspaceFrame\(nativeBlueprintWorkspaceSnapshot, nativeFactoryInventoryIdentity\)/);
  });

  it("reads only while the native-authority workspace is open and supersedes selection through the store", () => {
    expect(app).toMatch(/!blueprintsOpen \|\| !nativePlayerAuthorityOwnsRuntime \|\| !nativeFactoryInventoryIdentity \|\|[\s\S]*?!nativeBlueprintWorkspaceSource \|\| !nativePlayerAuthorityActiveFrame[\s\S]*?nativeBlueprintWorkspaceStore\.clear\(\)/);
    expect(app).toMatch(/nativeBlueprintWorkspaceStore\.refresh\([\s\S]*?nativeBlueprintWorkspaceSource,[\s\S]*?nativeFactoryInventoryIdentity,[\s\S]*?nativeBlueprintSelectedId/);
    expect(app).toMatch(/onSelectBlueprint=\{setNativeBlueprintSelectedId\}/);
  });

  it("renders the native projection under authority and retains the legacy Web branch only outside authority", () => {
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime \? <NativeBlueprintWorkspace[\s\S]*?: <BlueprintWorkspace/);
    const nativeTag = app.match(/nativePlayerAuthorityOwnsRuntime \? (<NativeBlueprintWorkspace[\s\S]*?\/>)/)?.[1] ?? "";
    expect(nativeTag).toContain("status={nativeBlueprintWorkspaceSnapshot.status}");
    expect(nativeTag).toContain("frame={nativeBlueprintWorkspaceFrame}");
    expect(nativeTag).toContain("onSelectBlueprint={setNativeBlueprintSelectedId}");
    expect(nativeTag).toContain("onLibraryCursorChange=");
    expect(nativeTag).toContain("onQueueCursorChange={setNativeBlueprintQueueCursor}");
    expect(nativeTag).not.toMatch(/\bgame=|onDeploy=|onRemove=|onRename=|onTransform=|onFund|onCancel=|onExport=|onImport=/);
    expect(app).toMatch(/: <BlueprintWorkspace[\s\S]*?game=\{game\}[\s\S]*?onDeploy=\{deployBlueprint\}/);
  });

  it("keeps the native component detached from GameState and all blueprint mutation surfaces", () => {
    expect(component).not.toMatch(/\bGameState\b|\bgame\.|from\s+["']\.\.\/game\/(?:engine|types|content)["']/);
    expect(component).not.toMatch(/on(?:Capture|Import|Rename|Transform|Delete|Remove|Deploy|Place|Undo|Ghost|Fund|Cancel|Export)\b/);
    expect(component).toMatch(/readOnly !== true/);
  });

  it("does not derive native blueprint selection or placement UI from legacy GameState", () => {
    expect(app).toMatch(/blueprintEligibleIds = useMemo\(\(\) => nativePlayerAuthorityOwnsRuntime \|\| selectedEntityIds\.length === 0/);
    expect(app).toMatch(/activeBlueprint = nativePlayerAuthorityOwnsRuntime[\s\S]*?\? null[\s\S]*?: game\.blueprints\.find/);
    expect(app).toMatch(/!nativePlayerAuthorityOwnsRuntime && blueprintPlacementId \? <section className="canvas-placement-options/);
    expect(app).toMatch(/canUpgrade=\{!nativePlayerAuthorityOwnsRuntime && canUpgradeEntities/);
    expect(app).toMatch(/canUpgradeBelts=\{!nativePlayerAuthorityOwnsRuntime && selectedBelts\.some/);
    expect(app).toMatch(/if \(!nativePlayerAuthorityOwnsRuntime\) return;[\s\S]*?setBlueprintPlacementId\(null\);[\s\S]*?setBlueprintAllowOverlap\(false\);/);
  });

  it("keeps renderer memory to one library page, one queue page, and optional detail", () => {
    expect(store).not.toMatch(/collectSection|NATIVE_BLUEPRINT_MAX_PAGES/);
    expect(store).toMatch(/Promise\.all\(\[[\s\S]*?"library"[\s\S]*?"queue"/);
    expect(store).toMatch(/readVerifiedBlueprintPage\("detail", selectedBlueprintId, 0\)/);
    expect(app).toMatch(/nativeBlueprintLibraryCursor,[\s\S]*?nativeBlueprintQueueCursor/);
  });
});
