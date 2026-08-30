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

  it("keeps the native editor owner mounted through authority handoff and admits legacy only after reconciliation", () => {
    expect(app).toMatch(/<NativeBlueprintWorkspace[\s\S]*?open=\{blueprintsOpen && \(nativePlayerAuthorityOwnsRuntime \|\|[\s\S]*?nativeBlueprintRenamePendingIdentity !== null \|\| nativeBlueprintRenameResolution !== null\)\}/);
    const nativeTag = app.match(/(\n\s*<NativeBlueprintWorkspace[\s\S]*?\/>)/)?.[1] ?? "";
    expect(nativeTag).toContain("status={nativeBlueprintWorkspaceSnapshot.status}");
    expect(nativeTag).toContain("frame={nativeBlueprintWorkspaceFrame}");
    expect(nativeTag).toContain("latestIdentity={nativeFactoryInventoryIdentity}");
    expect(nativeTag).toContain("onSelectBlueprint={setNativeBlueprintSelectedId}");
    expect(nativeTag).toContain("onLibraryCursorChange=");
    expect(nativeTag).toContain("onQueueCursorChange=");
    expect(nativeTag).toMatch(/nativeBlueprintRenamePendingIdentity \|\| nativePlayerAuthorityCommandPending[\s\S]*?setNativeBlueprintQueueCursor/);
    expect(nativeTag).toContain("onSubmitRenameIntent={submitNativeBlueprintRenameIntent}");
    expect(nativeTag).toContain("pendingIdentity={nativeBlueprintRenamePendingIdentity}");
    expect(nativeTag).toContain("resolution={nativeBlueprintRenameResolution}");
    expect(nativeTag).toContain("onConsumeRenameResolution={consumeNativeBlueprintRenameResolution}");
    expect(nativeTag).toContain("commandPending={nativePlayerAuthorityCommandPending}");
    expect(nativeTag).not.toMatch(/\bgame=|onDeploy=|onRemove=|onRename=|onTransform=|onFund|onCancel=|onExport=|onImport=/);
    expect(app).toMatch(/!nativePlayerAuthorityOwnsRuntime && !nativeBlueprintRenamePendingIdentity &&[\s\S]*?!nativeBlueprintRenameResolution \? <BlueprintWorkspace[\s\S]*?game=\{game\}[\s\S]*?onDeploy=\{deployBlueprint\}/);
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
    expect(commandBlock).toMatch(/prepareNativeBlueprintRenameIntentCommand\([\s\S]*?identity,[\s\S]*?targetName,[\s\S]*?frame,[\s\S]*?routeIdentity,[\s\S]*?commandSource/);
    expect(commandBlock).toMatch(/commitNativeProjectedCommand\(command\.baseRevision/);
    expect(commandBlock).toMatch(/acknowledgeNativeBlueprintRename\(current, submissionId, receipt\)/);
    expect(commandBlock).toMatch(/settleNativeBlueprintRenameFailure\(current, submissionId, failure\)/);
    expect(app).toMatch(/entry\.source\.reconcileCommand\(entry\.command\)/);
    expect(app).toMatch(/outcome\.status === "committed"[\s\S]*?acknowledgeNativeBlueprintRename/);
    expect(app).toMatch(/outcome\.status === "not-committed"[\s\S]*?settleNativeBlueprintRenameFailure/);
    expect(commandBlock).toMatch(/status: "accepted",[\s\S]*?submissionId,[\s\S]*?commandRevision: command\.baseRevision/);
    expect(commandBlock).not.toMatch(/\bgameRef\b|\bgame\.|blueprintVersions|constructionQueue|entities|belts|nextId/);

    const pendingBlock = app.slice(
      app.indexOf("const nativeBlueprintWorkspaceFrameRef"),
      app.indexOf("const nativePlacementLabel"),
    );
    expect(pendingBlock).toMatch(/reconcileNativeBlueprintRename\(pending,[\s\S]*?ownsRuntime:[\s\S]*?commandPending:[\s\S]*?activeIdentity:[\s\S]*?latestIdentity:[\s\S]*?frame:/);
    expect(pendingBlock).toMatch(/reconciled\.resolution[\s\S]*?setNativeBlueprintRenameResolution/);
    expect(pendingBlock).toMatch(/reconciled\.pending\?\.phase === "conflict"/);
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
