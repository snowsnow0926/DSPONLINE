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
    expect(nativeTag).toContain("onQueueCursorChange=");
    expect(nativeTag).toMatch(/nativeBlueprintRenamePendingIdentity \|\| nativePlayerAuthorityCommandPending[\s\S]*?setNativeBlueprintQueueCursor/);
    expect(nativeTag).toContain("onSubmitRenameIntent={submitNativeBlueprintRenameIntent}");
    expect(nativeTag).toContain("pendingIdentity={nativeBlueprintRenamePendingIdentity}");
    expect(nativeTag).toContain("commandPending={nativePlayerAuthorityCommandPending}");
    expect(nativeTag).not.toMatch(/\bgame=|onDeploy=|onRemove=|onRename=|onTransform=|onFund|onCancel=|onExport=|onImport=/);
    expect(app).toMatch(/: <BlueprintWorkspace[\s\S]*?game=\{game\}[\s\S]*?onDeploy=\{deployBlueprint\}/);
  });

  it("keeps the native component detached from GameState and every blueprint mutation except rename", () => {
    expect(component).not.toMatch(/\bGameState\b|\bgame\.|from\s+["']\.\.\/game\/(?:engine|types|content)["']/);
    expect(component).not.toMatch(/on(?:Capture|Import|Transform|Delete|Remove|Deploy|Place|Undo|Ghost|Fund|Cancel|Export)\b/);
    expect(component).toMatch(/onSubmitRenameIntent/);
    expect(component).toMatch(/readOnly !== true/);
  });

  it("routes exactly one semantic rename marker through durable ACK and same-lineage projection confirmation", () => {
    expect(app).toMatch(/from "\.\/game\/nativeBlueprintRenameIntentCommands"/);
    const commandBlock = app.slice(
      app.indexOf("const submitNativeBlueprintRenameIntent"),
      app.indexOf("const commitNativeConstructionCenterIntent"),
    );
    expect(commandBlock).toMatch(/nativeBlueprintRenameIdentityMatchesFrame\(identity, frame\)/);
    expect(commandBlock).toMatch(/routeIdentity\.sessionId !== identity\.sessionId/);
    expect(commandBlock).toMatch(/routeIdentity\.runId !== identity\.runId/);
    expect(commandBlock).toMatch(/routeIdentity\.revision !== identity\.revision/);
    expect(commandBlock).toMatch(/routeIdentity\.registryFingerprint !== identity\.registryFingerprint/);
    expect(commandBlock).toMatch(/frame\.selectedBlueprintId !== identity\.blueprintId/);
    expect(commandBlock).toMatch(/commandSource\.baseRevision !== identity\.revision/);
    expect(commandBlock.match(/createNativeBlueprintRenameIntentCommand\(/g)).toHaveLength(1);
    expect(commandBlock).toMatch(/commitNativeProjectedCommand\(identity\.revision/);
    expect(commandBlock).not.toMatch(/\bgameRef\b|\bgame\.|blueprintVersions|constructionQueue|entities|belts|nextId/);

    const pendingBlock = app.slice(
      app.indexOf("const nativeBlueprintWorkspaceFrameRef"),
      app.indexOf("const nativePlacementLabel"),
    );
    expect(pendingBlock).toMatch(/pending\.expectedRevision !== null[\s\S]*?current!\.revision >= pending\.expectedRevision/);
    expect(pendingBlock).toMatch(/row\?\.name === pending\.targetName/);
    expect(pendingBlock).toMatch(/row\?\.revision === pending\.currentRevision \+ 1/);
    expect(pendingBlock).toMatch(/sessionId !== pending\.sessionId[\s\S]*?runId !== pending\.runId[\s\S]*?registryFingerprint !== pending\.registryFingerprint/);
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
