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
  const queueFundHook = readFileSync(
    fileURLToPath(new URL("./useNativeConstructionQueueFundCommandTransaction.ts", import.meta.url)),
    "utf8",
  );
  const queueFundReconciliation = readFileSync(
    fileURLToPath(new URL("./nativeConstructionQueueFundCommandReconciliation.ts", import.meta.url)),
    "utf8",
  );
  const queueDeployHook = readFileSync(
    fileURLToPath(new URL("./useNativeConstructionQueueDeployCommandTransaction.ts", import.meta.url)),
    "utf8",
  );
  const queueDeployReconciliation = readFileSync(
    fileURLToPath(new URL("./nativeConstructionQueueDeployCommandReconciliation.ts", import.meta.url)),
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
  const directDeployHook = readFileSync(
    fileURLToPath(new URL("./useNativeBlueprintDirectDeployCommandTransaction.ts", import.meta.url)),
    "utf8",
  );
  const directDeployReconciliation = readFileSync(
    fileURLToPath(new URL("./nativeBlueprintDirectDeployCommandReconciliation.ts", import.meta.url)),
    "utf8",
  );
  const captureHook = readFileSync(
    fileURLToPath(new URL("./useNativeBlueprintCaptureCommandTransaction.ts", import.meta.url)),
    "utf8",
  );
  const captureReconciliation = readFileSync(
    fileURLToPath(new URL("./nativeBlueprintCaptureCommandReconciliation.ts", import.meta.url)),
    "utf8",
  );
  const importHook = readFileSync(
    fileURLToPath(new URL("./useNativeBlueprintImportCommandTransaction.ts", import.meta.url)),
    "utf8",
  );
  const importReconciliation = readFileSync(
    fileURLToPath(new URL("./nativeBlueprintImportCommandReconciliation.ts", import.meta.url)),
    "utf8",
  );
  const exportContext = readFileSync(
    fileURLToPath(new URL("./nativeBlueprintExportContext.ts", import.meta.url)),
    "utf8",
  );

  it("binds every page to the active authority session, run, revision, and registry", () => {
    expect(app).toMatch(/new NativeBlueprintWorkspaceStore\(\)/);
    expect(app).toMatch(/nativeFactoryInventoryIdentity = useMemo<NativeFactoryInventoryIdentity \| null>[\s\S]*?nativeThinWorkspaceAuthorityFrames\.displayFrame[\s\S]*?sessionId: frame\.sessionId,[\s\S]*?runId: frame\.runId,[\s\S]*?revision: frame\.revision,[\s\S]*?registryFingerprint: recipeWorkspaceRegistryFingerprint/);
    expect(app).toMatch(/nativeFactoryInventoryReadIdentity = useMemo<NativeFactoryInventoryIdentity \| null>[\s\S]*?nativeThinWorkspaceAuthorityFrames\.readFrame/);
    expect(app).toMatch(/createNativePlayerAuthorityBlueprintWorkspaceSource\(desktopBridge, nativeFactoryInventoryReadIdentity\)/);
    expect(app).toMatch(/selectNativeBlueprintWorkspaceFrame\([\s\S]*?nativeBlueprintWorkspaceSnapshot,[\s\S]*?nativeFactoryInventoryIdentity,[\s\S]*?nativeBlueprintSelectedId,[\s\S]*?nativeBlueprintLibraryCursor,[\s\S]*?nativeBlueprintQueueCursor/);
    expect(app).toMatch(/nativeBlueprintWorkspaceWritesEnabled = nativeInventoryLineageCurrent &&[\s\S]*?nativeBlueprintWorkspaceFrame\?\.revision === nativeFactoryInventoryReadIdentity\?\.revision/);
  });

  it("reads only while the native-authority workspace is open and supersedes selection through the store", () => {
    expect(app).toMatch(/!blueprintsOpen \|\| !nativePlayerAuthorityOwnsRuntime \|\| !nativeFactoryInventoryIdentity\) \{[\s\S]*?nativeBlueprintWorkspaceStore\.clear\(\)/);
    expect(app).toMatch(/if \(!nativeFactoryInventoryReadIdentity \|\| !nativeBlueprintWorkspaceSource\) return;/);
    expect(app).toMatch(/nativeBlueprintWorkspaceStore\.refresh\([\s\S]*?nativeBlueprintWorkspaceSource,[\s\S]*?nativeFactoryInventoryReadIdentity,[\s\S]*?nativeBlueprintSelectedId/);
    expect(app).toMatch(/onSelectBlueprint=\{setNativeBlueprintSelectedId\}/);
  });

  it("keeps an explicit header entry reachable while native authority owns the factory", () => {
    expect(app).toMatch(/<HeaderControls[\s\S]*?onOpenBlueprints=\{\(\) => \{[\s\S]*?openCommandWorkspace\("blueprints"\)/);
    expect(app).not.toContain('workspace === "blueprints" && rejectLegacyFactoryInteractionWhileNative("蓝图管理")');
    expect(app).toMatch(/headerActiveWorkspace[\s\S]*?blueprintsOpen \? "blueprints"/);
  });

  it("keeps the native editor owner mounted through authority handoff and admits legacy only after reconciliation", () => {
    expect(app).toMatch(/<NativeBlueprintWorkspace[\s\S]*?open=\{blueprintsOpen && \(nativePlayerAuthorityOwnsRuntime \|\|[\s\S]*?nativeBlueprintRenamePendingIdentity !== null \|\| nativeBlueprintRenameResolution !== null \|\|[\s\S]*?nativeBlueprintTransformPending !== null \|\| nativeBlueprintRecipeOverridePending !== null \|\|[\s\S]*?nativeBlueprintDeletePending !== null \|\|[\s\S]*?nativeConstructionQueueCancelPending !== null \|\| nativeConstructionQueueFundPending !== null \|\|[\s\S]*?nativeConstructionQueueDeployPending !== null \|\|[\s\S]*?nativeBlueprintEnqueuePending !== null \|\| nativeBlueprintDirectDeployPending !== null \|\|[\s\S]*?nativeBlueprintImportPending !== null \|\| nativeBlueprintExportContextPending\)\}/);
    const nativeTag = app.match(/(\n\s*<NativeBlueprintWorkspace[\s\S]*?\/>)/)?.[1] ?? "";
    expect(nativeTag).toContain("status={nativeBlueprintWorkspaceSnapshot.status}");
    expect(nativeTag).toContain("frame={nativeBlueprintWorkspaceFrame}");
    expect(nativeTag).toContain("latestIdentity={nativeFactoryInventoryIdentity}");
    expect(nativeTag).toContain("onSelectBlueprint={setNativeBlueprintSelectedId}");
    expect(nativeTag).toContain("onLibraryCursorChange=");
    expect(nativeTag).toContain("onQueueCursorChange=");
    expect(nativeTag).toMatch(/nativeBlueprintRenamePendingIdentity \|\| nativeBlueprintTransformPending \|\|[\s\S]*?nativeBlueprintRecipeOverridePending \|\| nativeBlueprintDeletePending \|\|[\s\S]*?nativeConstructionQueueCancelPending \|\| nativeConstructionQueueFundPending \|\|[\s\S]*?nativeConstructionQueueDeployPending \|\|[\s\S]*?nativeBlueprintEnqueuePending \|\| nativeBlueprintDirectDeployPending \|\|[\s\S]*?nativeBlueprintImportPending \|\|[\s\S]*?nativePlayerAuthorityCommandPending[\s\S]*?setNativeBlueprintQueueCursor/);
    expect(nativeTag).toContain("onSubmitRenameIntent={submitNativeBlueprintRenameIntent}");
    expect(nativeTag).toContain("onSubmitTransformIntent={submitNativeBlueprintTransformIntent}");
    expect(nativeTag).toContain("onSubmitRecipeOverrideIntent={submitNativeBlueprintRecipeOverrideIntent}");
    expect(nativeTag).toContain("onSubmitDeleteIntent={submitNativeBlueprintDeleteIntent}");
    expect(nativeTag).toContain("onSubmitQueueCancelIntent={submitNativeConstructionQueueCancelIntent}");
    expect(nativeTag).toContain("onSubmitQueueFundIntent={submitNativeConstructionQueueFundIntent}");
    expect(nativeTag).toContain("onSubmitQueueDeployIntent={submitNativeConstructionQueueDeployIntent}");
    expect(nativeTag).toContain("onBeginQueuePlacement={beginNativeBlueprintEnqueuePlacement}");
    expect(nativeTag).toContain("onBeginDirectPlacement={beginNativeBlueprintDirectDeployPlacement}");
    expect(nativeTag).toContain("pendingIdentity={nativeBlueprintRenamePendingIdentity}");
    expect(nativeTag).toContain("transformPending={nativeBlueprintTransformPending}");
    expect(nativeTag).toContain("recipeOverridePending={nativeBlueprintRecipeOverridePending}");
    expect(nativeTag).toContain("deletePending={nativeBlueprintDeletePending}");
    expect(nativeTag).toContain("queueCancelPending={nativeConstructionQueueCancelPending}");
    expect(nativeTag).toContain("queueFundPending={nativeConstructionQueueFundPending}");
    expect(nativeTag).toContain("queueDeployPending={nativeConstructionQueueDeployPending}");
    expect(nativeTag).toContain("enqueuePending={nativeBlueprintEnqueuePending}");
    expect(nativeTag).toContain("directDeployPending={nativeBlueprintDirectDeployPending}");
    expect(nativeTag).toContain("importPending={nativeBlueprintImportPending}");
    expect(nativeTag).toContain("importConfirmation={nativeBlueprintImportConfirmation}");
    expect(nativeTag).toContain("onSubmitImportRaw={submitNativeBlueprintImportRaw}");
    expect(nativeTag).toContain("onExportBlueprint={exportNativeBlueprint}");
    expect(nativeTag).toContain("resolution={nativeBlueprintRenameResolution}");
    expect(nativeTag).toContain("onConsumeRenameResolution={consumeNativeBlueprintRenameResolution}");
    expect(nativeTag).toMatch(/commandPending=\{nativePlayerAuthorityCommandPending \|\| nativeBlueprintEnqueueContextPending \|\|[\s\S]*?nativeBlueprintDirectDeployContextPending \|\| nativeBlueprintImportContextPending \|\|[\s\S]*?nativeBlueprintExportContextPending \|\| !nativeBlueprintWorkspaceWritesEnabled\}/);
    expect(nativeTag).not.toMatch(/\bgame=|onDeploy=|onRemove=|onRename=|onTransform=|onFund|onCancel=|onExport=|onImport=/);
    expect(app).toMatch(/!nativePlayerAuthorityOwnsRuntime && !nativeBlueprintRenamePendingIdentity &&[\s\S]*?!nativeBlueprintTransformPending &&[\s\S]*?!nativeBlueprintRecipeOverridePending &&[\s\S]*?!nativeBlueprintDeletePending &&[\s\S]*?!nativeConstructionQueueCancelPending &&[\s\S]*?!nativeConstructionQueueFundPending &&[\s\S]*?!nativeConstructionQueueDeployPending &&[\s\S]*?!nativeBlueprintEnqueuePending &&[\s\S]*?!nativeBlueprintDirectDeployPending &&[\s\S]*?!nativeBlueprintImportPending &&[\s\S]*?!nativeBlueprintExportContextPending &&[\s\S]*?!nativeBlueprintRenameResolution \? <BlueprintWorkspace[\s\S]*?game=\{game\}[\s\S]*?onDeploy=\{deployBlueprint\}/);
  });

  it("keeps the native component detached from GameState and exposes only bounded semantic intents", () => {
    expect(component).not.toMatch(/\bGameState\b|\bgame\.|from\s+["']\.\.\/game\/(?:engine|types|content)["']/);
    expect(component).not.toMatch(/on(?:Capture|Import|Transform|Remove|Deploy|Place|Undo|Ghost|Fund|Cancel|Export)\b/);
    expect(component).toMatch(/onSubmitRenameIntent/);
    expect(component).toMatch(/onSubmitTransformIntent/);
    expect(component).toMatch(/onSubmitRecipeOverrideIntent/);
    expect(component).toMatch(/onSubmitDeleteIntent/);
    expect(component).toMatch(/onSubmitQueueCancelIntent/);
    expect(component).toMatch(/onSubmitQueueFundIntent/);
    expect(component).toMatch(/onSubmitQueueDeployIntent/);
    expect(component).toMatch(/onBeginQueuePlacement/);
    expect(component).toMatch(/onBeginDirectPlacement/);
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

  it("routes queue funding through one semantic marker and a later exact row projection", () => {
    expect(app).toMatch(/useNativeConstructionQueueFundCommandTransaction\(\{[\s\S]*?authority: nativeEntityRecipeAuthorityObservation,[\s\S]*?frame: nativeBlueprintWorkspaceFrame,[\s\S]*?commandInFlightRef: nativePlayerAuthorityCommandInFlightRef/);
    expect(app).toMatch(/const submitNativeConstructionQueueFundIntent = useCallback[\s\S]*?nativeConstructionQueueFundBindingMatchesFrame[\s\S]*?commitNativeConstructionQueueFundCommand\(binding, scope\)/);
    expect(queueFundHook.match(/\.applyCommand\(/g)).toHaveLength(1);
    expect(queueFundHook).toMatch(/reconcileNativeConstructionQueueFundPendingCommand/);
    const reconcileBlock = queueFundHook.slice(
      queueFundHook.indexOf("const reconcileTransport"),
      queueFundHook.indexOf("const handleDispatchFailure"),
    );
    expect(reconcileBlock).not.toMatch(/applyCommand\(/);
    expect(queueFundReconciliation).toMatch(/\[\s*0,\s*100,\s*250,\s*500,\s*1_000,\s*2_000,/);
    expect(queueFundReconciliation).toMatch(/authority\.revision < pending\.receipt\.revision/);
    expect(queueFundReconciliation).toMatch(/frame\.revision !== authority\.revision/);
    expect(queueFundReconciliation).toMatch(/row\.reservedConstructionTotal === pending\.initialReservedConstructionTotal/);
    expect(queueFundReconciliation).toMatch(/row\.reservedFleetTotal === pending\.initialReservedFleetTotal/);
    expect(component).toMatch(/data-native-blueprint-action="fund-queue-all"/);
  });

  it("routes Rust-actionable queue deployment through one marker and exact absence proof", () => {
    expect(app).toMatch(/useNativeConstructionQueueDeployCommandTransaction\(\{[\s\S]*?authority: nativeEntityRecipeAuthorityObservation,[\s\S]*?frame: nativeBlueprintWorkspaceFrame,[\s\S]*?membershipSource: nativeBlueprintWorkspaceSource,[\s\S]*?commandInFlightRef: nativePlayerAuthorityCommandInFlightRef/);
    expect(app).toMatch(/const submitNativeConstructionQueueDeployIntent = useCallback[\s\S]*?nativeConstructionQueueDeployBindingMatchesFrame[\s\S]*?commitNativeConstructionQueueDeployCommand\(binding\)/);
    expect(queueDeployHook.match(/\.applyCommand\(/g)).toHaveLength(1);
    expect(queueDeployHook).toMatch(/reconcileNativeConstructionQueueDeployPendingCommand/);
    const reconcileBlock = queueDeployHook.slice(
      queueDeployHook.indexOf("const reconcileTransport"),
      queueDeployHook.indexOf("const handleDispatchFailure"),
    );
    expect(reconcileBlock).not.toMatch(/applyCommand\(/);
    expect(queueDeployReconciliation).toMatch(/\[\s*0,\s*100,\s*250,\s*500,\s*1_000,\s*2_000,/);
    expect(queueDeployHook).toMatch(/readVerifiedQueueMembership\(currentPending\.queueEntryId\)/);
    expect(queueDeployReconciliation).toMatch(/marker\.value\.kind !== "deploy"/);
    expect(queueDeployReconciliation).toMatch(/receipt\.changedEntityIds\.length !== 0/);
    expect(queueDeployReconciliation).toMatch(/pending\.membershipProof\.queueEntryId !== pending\.queueEntryId/);
    expect(queueDeployReconciliation).toMatch(/pending\.membershipProof\.revision !== authority\.revision/);
    expect(queueDeployReconciliation).not.toMatch(/NativeBlueprintWorkspaceFrame|frame\./);
    expect(component).toMatch(/selectNativeConstructionQueueDeployBinding\(readyFrame, entry\.id\)/);
    expect(component).toMatch(/data-native-blueprint-action="deploy-queue"/);
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

  it("routes direct placement through one click-time Rust proof and same-lineage topology confirmation", () => {
    expect(app).toMatch(/useNativeBlueprintDirectDeployCommandTransaction\(\{[\s\S]*?authority: nativeEntityRecipeAuthorityObservation,[\s\S]*?topology: nativeBlueprintDirectDeployTopologyObservation,[\s\S]*?commandInFlightRef: nativePlayerAuthorityCommandInFlightRef/);
    expect(app).toMatch(/const beginNativeBlueprintDirectDeployPlacement = useCallback[\s\S]*?nativeBlueprintDirectDeploySelectionBindingMatchesFrame[\s\S]*?enterNativeBlueprintDirectDeployPlacement\(binding\)/);
    expect(app).toMatch(/const submitNativeBlueprintDirectDeployAt = useCallback[\s\S]*?readVerifiedNativeBlueprintDirectDeployContext\([\s\S]*?identity,[\s\S]*?selection,[\s\S]*?position,[\s\S]*?commitNativeBlueprintDirectDeployCommand\(context\)/);
    expect(app).toMatch(/nativeBlueprintDirectDeployCanvasSubmitRef\.current\([\s\S]*?position,[\s\S]*?event\.clientX/);
    expect(app).toMatch(/cancelNativeBlueprintDirectDeployPlacement\(\)[\s\S]*?nativeFactoryProjectionPlanetId/);
    expect(directDeployHook.match(/\.applyCommand\(/g)).toHaveLength(1);
    expect(directDeployHook).toMatch(/reconcileNativeBlueprintDirectDeployPendingCommand/);
    const reconcileBlock = directDeployHook.slice(
      directDeployHook.indexOf("const reconcileTransport"),
      directDeployHook.indexOf("const handleDispatchFailure"),
    );
    expect(reconcileBlock).not.toMatch(/applyCommand\(/);
    expect(directDeployReconciliation).toMatch(/\[\s*0,\s*100,\s*250,\s*500,\s*1_000,\s*2_000,/);
    expect(directDeployReconciliation).toMatch(/topology\.revision < pending\.receipt\.revision/);
    expect(directDeployReconciliation).not.toMatch(/topology\.activePlanetId !== pending\.activePlanetId/);
    expect(directDeployReconciliation).toMatch(/topology\.registryFingerprint !== pending\.registryFingerprint/);
    expect(component).toMatch(/data-native-blueprint-action="begin-direct-deploy-placement"/);
  });

  it("captures a native selection through Rust without invoking legacy createBlueprint or commitGame", () => {
    expect(app).toMatch(/useNativeBlueprintCaptureCommandTransaction\(\{[\s\S]*?authority: nativeEntityRecipeAuthorityObservation,[\s\S]*?membershipSource: nativeBlueprintWorkspaceSource,[\s\S]*?onConfirmed: enterNativeBlueprintDirectDeployPlacement/);
    const nativeCaptureBlock = app.slice(
      app.indexOf("const captureNativeSelectionAsBlueprint"),
      app.indexOf("const copySelectionAsBlueprint"),
    );
    expect(nativeCaptureBlock).toMatch(/readVerifiedNativeBlueprintCaptureContext\([\s\S]*?desktopBridge,[\s\S]*?identity,[\s\S]*?selection/);
    expect(nativeCaptureBlock).toMatch(/if \(!context\.support\.supported\)[\s\S]*?return;/);
    expect(nativeCaptureBlock).toMatch(/commitNativeBlueprintCaptureCommand\(context\)/);
    expect(nativeCaptureBlock).not.toMatch(/\bcreateBlueprint\b|\bcommitGame\b|\bgameRef\b|\bnextId\b/);

    const copyDispatchBlock = app.slice(
      app.indexOf("const copySelectionAsBlueprint"),
      app.indexOf("const deployBlueprint"),
    );
    expect(copyDispatchBlock).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?captureNativeSelectionAsBlueprint\(\);[\s\S]*?return;[\s\S]*?copyEntitiesAsBlueprint\(selectedEntityIds\)/);
    expect(captureHook.match(/\.applyCommand\(/g)).toHaveLength(1);
    expect(captureHook).toMatch(/reconcileNativeBlueprintCapturePendingCommand/);
    const reconcileBlock = captureHook.slice(
      captureHook.indexOf("const reconcileTransport"),
      captureHook.indexOf("const handleDispatchFailure"),
    );
    expect(reconcileBlock).not.toMatch(/applyCommand\(/);
    expect(captureReconciliation).toMatch(/\[\s*0,\s*100,\s*250,\s*500,\s*1_000,\s*2_000,/);
    expect(captureHook).toMatch(/readVerifiedLibraryMembership/);
    expect(captureReconciliation).toMatch(/pending\.membershipProof\.blueprintId !== pending\.expectedBlueprintId/);
    expect(captureReconciliation).toMatch(/pending\.membershipProof\.revision !== authority\.revision/);

    const legacyCaptureBlock = app.slice(
      app.indexOf("const copyEntitiesAsBlueprint"),
      app.indexOf("const captureNativeSelectionAsBlueprint"),
    );
    expect(legacyCaptureBlock).toMatch(/createBlueprint\(before, eligibleIds\)/);
    expect(legacyCaptureBlock).toMatch(/if \(!commitGame\(\(\) => next\)\) \{[\s\S]*?playTone\("alert"\);[\s\S]*?return;[\s\S]*?setBlueprintPlacementId\(blueprintId\)/);
  });

  it("opens post-capture direct placement without weakening the public workspace entry guard", () => {
    const internalEntryStart = app.indexOf("const enterNativeBlueprintDirectDeployPlacement");
    const internalEntry = app.slice(
      internalEntryStart,
      app.indexOf("useNativeBlueprintDirectDeployCommandTransaction", internalEntryStart),
    );
    expect(internalEntry).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current/);
    expect(internalEntry).toMatch(/currentIdentity\.sessionId !== binding\.sessionId/);
    expect(internalEntry).toMatch(/currentIdentity\.registryFingerprint !== binding\.registryFingerprint/);
    expect(internalEntry).not.toMatch(/blueprintsOpenRef\.current|nativeBlueprintDirectDeploySelectionBindingMatchesFrame/);

    const publicEntryStart = app.indexOf("const beginNativeBlueprintDirectDeployPlacement");
    const publicEntry = app.slice(
      publicEntryStart,
      app.indexOf("useNativeBlueprintCaptureCommandTransaction", publicEntryStart),
    );
    expect(publicEntry).toMatch(/!blueprintsOpenRef\.current/);
    expect(publicEntry).toMatch(/nativeBlueprintDirectDeploySelectionBindingMatchesFrame/);
    expect(publicEntry).toMatch(/return enterNativeBlueprintDirectDeployPlacement\(binding\)/);
  });

  it("imports through one opaque Rust marker and exports only the Rust-provided verified exchange", () => {
    const importStart = app.indexOf("const submitNativeBlueprintImportRaw");
    const importBlock = app.slice(importStart, app.indexOf("const exportNativeBlueprint", importStart));
    expect(importBlock).toMatch(/readVerifiedNativeBlueprintImportContext\(desktopBridge, identity, raw\)/);
    expect(importBlock).toMatch(/commitNativeBlueprintImportCommand\(context\)/);
    expect(importBlock).toMatch(/const expectedBlueprintId = context\.preparedIntent\?\.blueprint\.id[\s\S]*?setNativeBlueprintImportConfirmation\(null\)[\s\S]*?sessionId: context\.sessionId,[\s\S]*?runId: context\.runId,[\s\S]*?registryFingerprint: context\.registryFingerprint,[\s\S]*?commandRevision: context\.revision,[\s\S]*?blueprintId: expectedBlueprintId/);
    expect(importBlock).not.toMatch(/parseBlueprintExchange|importBlueprintExchange|commitGame|nextId|gameRef/);
    expect(app).toMatch(/useState<NativeBlueprintImportConfirmation \| null>\(null\)/);
    expect(app).toMatch(/const confirmNativeBlueprintImport[\s\S]*?setNativeBlueprintImportConfirmation\(confirmation\)/);
    expect(importHook).toMatch(/previousRevision: receipt\.previousRevision,[\s\S]*?ackRevision: receipt\.revision/);
    expect(importHook.match(/\.applyCommand\(/g)).toHaveLength(1);
    expect(importHook).toMatch(/reconcileNativeBlueprintImportPendingCommand/);
    const reconcileBlock = importHook.slice(
      importHook.indexOf("const reconcileTransport"),
      importHook.indexOf("const handleDispatchFailure"),
    );
    expect(reconcileBlock).not.toMatch(/applyCommand\(/);
    expect(importReconciliation).toMatch(/\[\s*0,\s*100,\s*250,\s*500,\s*1_000,\s*2_000,/);
    expect(importHook).toMatch(/const readMembership = source\.readVerifiedLibraryMembership/);
    expect(importHook).toMatch(/readMembership\(currentPending\.expectedBlueprintId\)/);
    expect(component).toMatch(/importPending !== null \|\| !importConfirmation \|\| !readyFrame/);
    expect(component).toMatch(/confirmation\.previousRevision !== accepted\.commandRevision/);
    expect(component).toMatch(/frame\.sessionId !== accepted\.sessionId \|\| frame\.runId !== accepted\.runId/);
    expect(component).toMatch(/frame\.registryFingerprint !== accepted\.registryFingerprint/);
    expect(component).toMatch(/frame\.revision < confirmation\.ackRevision/);
    expect(component).toMatch(/frame\.libraryById\.get\(accepted\.blueprintId\)/);

    const exportStart = app.indexOf("const exportNativeBlueprint");
    const exportBlock = app.slice(exportStart, app.indexOf("const copySelectionAsBlueprint", exportStart));
    expect(exportBlock).toMatch(/readVerifiedNativeBlueprintExportContext\(desktopBridge, binding\)/);
    expect(exportBlock).toMatch(/contents: context\.rawExchange/);
    expect(exportBlock).toMatch(/await exportTextFile/);
    expect(exportBlock).not.toMatch(/serializeBlueprintExchange|parseBlueprintExchange|commitGame|applyCommand|gameRef/);
    expect(exportContext).not.toMatch(/JSON\.parse|parseBlueprintExchange|serializeBlueprintExchange/);
    expect(component).toMatch(/data-native-blueprint-action="submit-import-raw"/);
    expect(component).toMatch(/data-native-blueprint-action="export-blueprint"/);
  });

  it("reports Web fallback import success only after discriminated admission is committed", () => {
    const importStart = app.indexOf("const importBlueprint = useCallback");
    const importBlock = app.slice(importStart, app.indexOf("useEffect(() =>", importStart));
    expect(importBlock).toMatch(/const committed = commitGame\(\(current\) => \{[\s\S]*?const imported = importBlueprintExchange\(current, result\.blueprint!\)/);
    expect(importBlock).toMatch(/if \(!imported\.ok\) \{[\s\S]*?failureReason = imported\.reason;[\s\S]*?return current;/);
    expect(importBlock).toMatch(/importedBlueprintId = imported\.blueprintId;[\s\S]*?return imported\.state;/);
    expect(importBlock).toMatch(/if \(!committed \|\| !importedBlueprintId\) \{[\s\S]*?return \{ success: false, message \};[\s\S]*?const message = `已导入蓝图/);
  });

  it("never reports legacy blueprint placement success after commitGame rejects the mutation", () => {
    const placementStart = app.indexOf("if (blueprintPlacementId) {");
    const placementBlock = app.slice(placementStart, app.indexOf("if (!selectionMode", placementStart));
    expect(placementBlock).toMatch(/const committed = commitGame\(\(current\) => \{[\s\S]*?return next;[\s\S]*?\}\);/);
    expect(placementBlock).toMatch(/if \(compatible && !committed\) \{[\s\S]*?存档未改变[\s\S]*?playTone\("alert"\);[\s\S]*?return;[\s\S]*?if \(deployable\) playTone\("place"\)/);
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
    expect(app).toMatch(/const nativeBlueprintCaptureSelection = useMemo<NativeBlueprintCaptureSelectionBinding \| null>[\s\S]*?selectedEntityIds\.length < 1 \|\| selectedEntityIds\.length > 512[\s\S]*?entityIds: Object\.freeze\(\[\.\.\.selectedEntityIds\]\)/);
    const toolbar = app.slice(
      app.lastIndexOf("<SelectionToolbar"),
      app.indexOf("</SelectionToolbar>", app.lastIndexOf("<SelectionToolbar")),
    );
    expect(toolbar).toMatch(/unsafeActionsEnabled=\{!nativePlayerAuthorityOwnsRuntime\}/);
    expect(toolbar).toMatch(/copyActionEnabled=\{!nativePlayerAuthorityOwnsRuntime \|\| Boolean\([\s\S]*?nativeBlueprintCaptureSelection/);
    expect(toolbar).toMatch(/eligibleCount=\{nativePlayerAuthorityOwnsRuntime[\s\S]*?nativeBlueprintCaptureSelection\?\.entityIds\.length/);
  });

  it("keeps renderer memory to one library page, one queue page, and optional detail", () => {
    expect(store).not.toMatch(/collectSection|NATIVE_BLUEPRINT_MAX_PAGES/);
    expect(store).toMatch(/Promise\.all\(\[[\s\S]*?"library"[\s\S]*?"queue"/);
    expect(store).toMatch(/readVerifiedBlueprintPage\("detail", selectedBlueprintId, 0\)/);
    expect(app).toMatch(/nativeBlueprintLibraryCursor,[\s\S]*?nativeBlueprintQueueCursor/);
  });
});
