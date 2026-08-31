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
  const transformHook = readFileSync(
    fileURLToPath(new URL("./useNativeBlueprintTransformCommandTransaction.ts", import.meta.url)),
    "utf8",
  );
  const transformReconciliation = readFileSync(
    fileURLToPath(new URL("./nativeBlueprintTransformCommandReconciliation.ts", import.meta.url)),
    "utf8",
  );
  const recipeOverrideHook = readFileSync(
    fileURLToPath(new URL("./useNativeBlueprintRecipeOverrideCommandTransaction.ts", import.meta.url)),
    "utf8",
  );
  const recipeOverrideReconciliation = readFileSync(
    fileURLToPath(new URL("./nativeBlueprintRecipeOverrideCommandReconciliation.ts", import.meta.url)),
    "utf8",
  );
  const deleteHook = readFileSync(
    fileURLToPath(new URL("./useNativeBlueprintDeleteCommandTransaction.ts", import.meta.url)),
    "utf8",
  );
  const deleteReconciliation = readFileSync(
    fileURLToPath(new URL("./nativeBlueprintDeleteCommandReconciliation.ts", import.meta.url)),
    "utf8",
  );
  const queueCancelHook = readFileSync(
    fileURLToPath(new URL("./useNativeConstructionQueueCancelCommandTransaction.ts", import.meta.url)),
    "utf8",
  );
  const queueCancelReconciliation = readFileSync(
    fileURLToPath(new URL("./nativeConstructionQueueCancelCommandReconciliation.ts", import.meta.url)),
    "utf8",
  );
  const enqueueHook = readFileSync(
    fileURLToPath(new URL("./useNativeBlueprintEnqueueCommandTransaction.ts", import.meta.url)),
    "utf8",
  );
  const enqueueReconciliation = readFileSync(
    fileURLToPath(new URL("./nativeBlueprintEnqueueCommandReconciliation.ts", import.meta.url)),
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

  it("keeps an explicit header entry reachable while native authority owns the factory", () => {
    expect(app).toMatch(/<HeaderControls[\s\S]*?onOpenBlueprints=\{\(\) => \{[\s\S]*?openCommandWorkspace\("blueprints"\)/);
    expect(app).not.toContain('workspace === "blueprints" && rejectLegacyFactoryInteractionWhileNative("蓝图管理")');
    expect(app).toMatch(/headerActiveWorkspace[\s\S]*?blueprintsOpen \? "blueprints"/);
  });

  it("keeps the native editor owner mounted through authority handoff and admits legacy only after reconciliation", () => {
    expect(app).toMatch(/<NativeBlueprintWorkspace[\s\S]*?open=\{blueprintsOpen && \(nativePlayerAuthorityOwnsRuntime \|\|[\s\S]*?nativeBlueprintRenamePendingIdentity !== null \|\| nativeBlueprintRenameResolution !== null \|\|[\s\S]*?nativeBlueprintTransformPending !== null \|\| nativeBlueprintRecipeOverridePending !== null \|\|[\s\S]*?nativeBlueprintDeletePending !== null \|\|[\s\S]*?nativeConstructionQueueCancelPending !== null \|\| nativeBlueprintEnqueuePending !== null\)\}/);
    const nativeTag = app.match(/(\n\s*<NativeBlueprintWorkspace[\s\S]*?\/>)/)?.[1] ?? "";
    expect(nativeTag).toContain("status={nativeBlueprintWorkspaceSnapshot.status}");
    expect(nativeTag).toContain("frame={nativeBlueprintWorkspaceFrame}");
    expect(nativeTag).toContain("latestIdentity={nativeFactoryInventoryIdentity}");
    expect(nativeTag).toContain("onSelectBlueprint={setNativeBlueprintSelectedId}");
    expect(nativeTag).toContain("onLibraryCursorChange=");
    expect(nativeTag).toContain("onQueueCursorChange=");
    expect(nativeTag).toMatch(/nativeBlueprintRenamePendingIdentity \|\| nativeBlueprintTransformPending \|\|[\s\S]*?nativeBlueprintRecipeOverridePending \|\| nativeBlueprintDeletePending \|\|[\s\S]*?nativeConstructionQueueCancelPending \|\| nativeBlueprintEnqueuePending \|\|[\s\S]*?nativePlayerAuthorityCommandPending[\s\S]*?setNativeBlueprintQueueCursor/);
    expect(nativeTag).toContain("onSubmitRenameIntent={submitNativeBlueprintRenameIntent}");
    expect(nativeTag).toContain("onSubmitTransformIntent={submitNativeBlueprintTransformIntent}");
    expect(nativeTag).toContain("onSubmitRecipeOverrideIntent={submitNativeBlueprintRecipeOverrideIntent}");
    expect(nativeTag).toContain("onSubmitDeleteIntent={submitNativeBlueprintDeleteIntent}");
    expect(nativeTag).toContain("onSubmitQueueCancelIntent={submitNativeConstructionQueueCancelIntent}");
    expect(nativeTag).toContain("onBeginQueuePlacement={beginNativeBlueprintEnqueuePlacement}");
    expect(nativeTag).toContain("pendingIdentity={nativeBlueprintRenamePendingIdentity}");
    expect(nativeTag).toContain("transformPending={nativeBlueprintTransformPending}");
    expect(nativeTag).toContain("recipeOverridePending={nativeBlueprintRecipeOverridePending}");
    expect(nativeTag).toContain("deletePending={nativeBlueprintDeletePending}");
    expect(nativeTag).toContain("queueCancelPending={nativeConstructionQueueCancelPending}");
    expect(nativeTag).toContain("enqueuePending={nativeBlueprintEnqueuePending}");
    expect(nativeTag).toContain("resolution={nativeBlueprintRenameResolution}");
    expect(nativeTag).toContain("onConsumeRenameResolution={consumeNativeBlueprintRenameResolution}");
    expect(nativeTag).toContain("commandPending={nativePlayerAuthorityCommandPending || nativeBlueprintEnqueueContextPending}");
    expect(nativeTag).not.toMatch(/\bgame=|onDeploy=|onRemove=|onRename=|onTransform=|onFund|onCancel=|onExport=|onImport=/);
    expect(app).toMatch(/!nativePlayerAuthorityOwnsRuntime && !nativeBlueprintRenamePendingIdentity &&[\s\S]*?!nativeBlueprintTransformPending &&[\s\S]*?!nativeBlueprintRecipeOverridePending &&[\s\S]*?!nativeBlueprintDeletePending &&[\s\S]*?!nativeConstructionQueueCancelPending &&[\s\S]*?!nativeBlueprintEnqueuePending &&[\s\S]*?!nativeBlueprintRenameResolution \? <BlueprintWorkspace[\s\S]*?game=\{game\}[\s\S]*?onDeploy=\{deployBlueprint\}/);
  });

  it("keeps the native component detached from GameState and exposes only bounded semantic intents", () => {
    expect(component).not.toMatch(/\bGameState\b|\bgame\.|from\s+["']\.\.\/game\/(?:engine|types|content)["']/);
    expect(component).not.toMatch(/on(?:Capture|Import|Transform|Remove|Deploy|Place|Undo|Ghost|Fund|Cancel|Export)\b/);
    expect(component).toMatch(/onSubmitRenameIntent/);
    expect(component).toMatch(/onSubmitTransformIntent/);
    expect(component).toMatch(/onSubmitRecipeOverrideIntent/);
    expect(component).toMatch(/onSubmitDeleteIntent/);
    expect(component).toMatch(/onSubmitQueueCancelIntent/);
    expect(component).toMatch(/onBeginQueuePlacement/);
    expect(component).toMatch(/readOnly !== true/);
  });

  it("routes transform through the dedicated one-shot transaction and exact target projection", () => {
    expect(app).toMatch(/useNativeBlueprintTransformCommandTransaction\(\{[\s\S]*?authority: nativeEntityRecipeAuthorityObservation,[\s\S]*?projection: nativeBlueprintTransformBinding,[\s\S]*?frame: nativeBlueprintWorkspaceFrame,[\s\S]*?commandInFlightRef: nativePlayerAuthorityCommandInFlightRef/);
    expect(app).toMatch(/const submitNativeBlueprintTransformIntent = useCallback[\s\S]*?commitNativeBlueprintTransformCommand\(binding, rotation, mirror\)/);
    expect(transformHook).toMatch(/initialPending\.source\.applyCommand\(initialPending\.command\)/);
    expect(transformHook).toMatch(/reconcileNativeBlueprintTransformPendingCommand/);
    const reconcileBlock = transformHook.slice(
      transformHook.indexOf("const reconcileTransport"),
      transformHook.indexOf("const handleDispatchFailure"),
    );
    expect(reconcileBlock).not.toMatch(/applyCommand\(/);
    expect(transformReconciliation).toMatch(/\[\s*0,\s*100,\s*250,\s*500,\s*1_000,\s*2_000,/);
    expect(transformReconciliation).toMatch(/projection\.currentRowRevision !== pending\.currentRowRevision \+ 1/);
    expect(transformReconciliation).toMatch(/projection\.currentRotation !== pending\.targetRotation/);
    expect(transformReconciliation).toMatch(/projection\.currentMirror !== pending\.targetMirror/);
    expect(component).toMatch(/data-native-blueprint-action="rotate-transform"/);
    expect(component).toMatch(/data-native-blueprint-action="mirror-transform"/);
  });

  it("routes recipe override through one semantic marker and the matching Rust-derived group", () => {
    expect(app).toMatch(/useNativeBlueprintRecipeOverrideCommandTransaction\(\{[\s\S]*?authority: nativeEntityRecipeAuthorityObservation,[\s\S]*?frame: nativeBlueprintWorkspaceFrame,[\s\S]*?commandInFlightRef: nativePlayerAuthorityCommandInFlightRef/);
    expect(app).toMatch(/const submitNativeBlueprintRecipeOverrideIntent = useCallback[\s\S]*?nativeBlueprintRecipeOverrideBindingMatchesFrame[\s\S]*?commitNativeBlueprintRecipeOverrideCommand\(binding, targetRecipeId\)/);
    expect(recipeOverrideHook.match(/\.applyCommand\(/g)).toHaveLength(1);
    expect(recipeOverrideHook).toMatch(/reconcileNativeBlueprintRecipeOverridePendingCommand/);
    const reconcileBlock = recipeOverrideHook.slice(
      recipeOverrideHook.indexOf("const reconcileTransport"),
      recipeOverrideHook.indexOf("const handleDispatchFailure"),
    );
    expect(reconcileBlock).not.toMatch(/applyCommand\(/);
    expect(recipeOverrideReconciliation).toMatch(/\[\s*0,\s*100,\s*250,\s*500,\s*1_000,\s*2_000,/);
    expect(recipeOverrideReconciliation).toMatch(/projection\.currentRowRevision !== pending\.currentRowRevision \+ 1/);
    expect(recipeOverrideReconciliation).toMatch(/projection\.sourceRecipeId !== pending\.sourceRecipeId/);
    expect(recipeOverrideReconciliation).toMatch(/projection\.currentTargetRecipeId !== pending\.targetRecipeId/);
    expect(component).toMatch(/selectNativeBlueprintRecipeOverrideBinding\(frame, group\.sourceRecipeId\)/);
    expect(component).toMatch(/data-native-blueprint-recipe-target/);
  });

  it("routes delete through one mutation and read-only bounded reconciliation until an exact absence projection", () => {
    expect(app).toMatch(/useNativeBlueprintDeleteCommandTransaction\(\{[\s\S]*?authority: nativeEntityRecipeAuthorityObservation,[\s\S]*?frame: nativeBlueprintWorkspaceFrame,[\s\S]*?commandInFlightRef: nativePlayerAuthorityCommandInFlightRef/);
    expect(app).toMatch(/const submitNativeBlueprintDeleteIntent = useCallback[\s\S]*?commitNativeBlueprintDeleteCommand\(binding\)/);
    expect(deleteHook.match(/\.applyCommand\(/g)).toHaveLength(1);
    expect(deleteHook).toMatch(/reconcileNativeBlueprintDeletePendingCommand/);
    const reconcileBlock = deleteHook.slice(
      deleteHook.indexOf("const reconcileTransport"),
      deleteHook.indexOf("const handleDispatchFailure"),
    );
    expect(reconcileBlock).not.toMatch(/applyCommand\(/);
    expect(deleteReconciliation).toMatch(/\[\s*0,\s*100,\s*250,\s*500,\s*1_000,\s*2_000,/);
    expect(deleteReconciliation).toMatch(/frame\.revision < pending\.receipt\.revision/);
    expect(deleteReconciliation).toMatch(/frame\.libraryPage\.totalCount !== pending\.libraryTotalCount - 1/);
    expect(deleteReconciliation).not.toMatch(/queuePage\.totalCount/);
    expect(deleteReconciliation).toMatch(/frame\.selectedBlueprintId !== null/);
    expect(deleteReconciliation).toMatch(/frame\.libraryById\.has\(pending\.blueprintId\)/);
    expect(component).toMatch(/data-native-blueprint-action="delete-blueprint"/);
  });

  it("routes queue cancel through one stable-ID marker and exact absence reconciliation", () => {
    expect(app).toMatch(/useNativeConstructionQueueCancelCommandTransaction\(\{[\s\S]*?authority: nativeEntityRecipeAuthorityObservation,[\s\S]*?frame: nativeBlueprintWorkspaceFrame,[\s\S]*?membershipSource: nativeBlueprintWorkspaceSource,[\s\S]*?commandInFlightRef: nativePlayerAuthorityCommandInFlightRef/);
    expect(app).toMatch(/const submitNativeConstructionQueueCancelIntent = useCallback[\s\S]*?nativeConstructionQueueCancelBindingMatchesFrame[\s\S]*?commitNativeConstructionQueueCancelCommand\(binding\)/);
    expect(queueCancelHook.match(/\.applyCommand\(/g)).toHaveLength(1);
    expect(queueCancelHook).toMatch(/reconcileNativeConstructionQueueCancelPendingCommand/);
    const reconcileBlock = queueCancelHook.slice(
      queueCancelHook.indexOf("const reconcileTransport"),
      queueCancelHook.indexOf("const handleDispatchFailure"),
    );
    expect(reconcileBlock).not.toMatch(/applyCommand\(/);
    expect(queueCancelReconciliation).toMatch(/\[\s*0,\s*100,\s*250,\s*500,\s*1_000,\s*2_000,/);
    expect(queueCancelHook).toMatch(/readVerifiedQueueMembership\(currentPending\.queueEntryId\)/);
    expect(queueCancelReconciliation).toMatch(/pending\.membershipProof\.queueEntryId !== pending\.queueEntryId/);
    expect(queueCancelReconciliation).toMatch(/pending\.membershipProof\.revision !== authority\.revision/);
    expect(queueCancelReconciliation).not.toMatch(/queuePage\.totalCount !== pending\.queueTotalCount/);
    expect(queueCancelReconciliation).not.toMatch(/frame\.queue\.some/);
    expect(component).toMatch(/data-native-blueprint-action="cancel-queue"/);
  });

  it("routes queue-only placement through a click-time Rust context and exact presence reconciliation", () => {
    expect(app).toMatch(/useNativeBlueprintEnqueueCommandTransaction\(\{[\s\S]*?authority: nativeEntityRecipeAuthorityObservation,[\s\S]*?membershipSource: nativeBlueprintWorkspaceSource,[\s\S]*?commandInFlightRef: nativePlayerAuthorityCommandInFlightRef/);
    expect(app).toMatch(/const beginNativeBlueprintEnqueuePlacement = useCallback[\s\S]*?nativeBlueprintEnqueueSelectionBindingMatchesFrame[\s\S]*?setNativeBlueprintEnqueuePlacement\(binding\)/);
    expect(app).toMatch(/const submitNativeBlueprintEnqueueAt = useCallback[\s\S]*?readVerifiedNativeBlueprintEnqueueContext\([\s\S]*?identity,[\s\S]*?selection,[\s\S]*?commitNativeBlueprintEnqueueCommand\(context, position\)/);
    expect(app).toMatch(/nativeBlueprintEnqueueCanvasSubmitRef\.current\([\s\S]*?position,[\s\S]*?event\.clientX/);
    expect(enqueueHook.match(/\.applyCommand\(/g)).toHaveLength(1);
    expect(enqueueHook).toMatch(/reconcileNativeBlueprintEnqueuePendingCommand/);
    const reconcileBlock = enqueueHook.slice(
      enqueueHook.indexOf("const reconcileTransport"),
      enqueueHook.indexOf("const handleDispatchFailure"),
    );
    expect(reconcileBlock).not.toMatch(/applyCommand\(/);
    expect(enqueueReconciliation).toMatch(/\[\s*0,\s*100,\s*250,\s*500,\s*1_000,\s*2_000,/);
    expect(enqueueHook).toMatch(/readVerifiedQueueMembership\(currentPending\.expectedQueueId\)/);
    expect(enqueueReconciliation).toMatch(/pending\.membershipProof\.queueEntryId !== pending\.expectedQueueId/);
    expect(enqueueReconciliation).toMatch(/pending\.membershipProof\.revision !== authority\.revision/);
    expect(enqueueReconciliation).not.toMatch(/NativeBlueprintWorkspaceFrame|frame\./);
    expect(component).toMatch(/data-native-blueprint-action="begin-enqueue-placement"/);
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
    expect(app).toMatch(/reconciliationAttempts >= 8[\s\S]*?已停止轮询/);
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
