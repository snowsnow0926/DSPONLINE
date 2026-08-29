import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const app = readFileSync(resolve("src/App.tsx"), "utf8");
const galaxy = readFileSync(resolve("src/components/GalaxyWorkspace.tsx"), "utf8");

function sourceBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function block(start: string, end: string): string {
  return sourceBlock(app, start, end);
}

describe("native authority persistence App boundary", () => {
  it("treats the desktop clock bootstrap as protected before any JavaScript persistence", () => {
    const boundary = block(
      "const readNativeAuthorityPersistenceBoundary = useCallback",
      "const issueLegacyJavaScriptAuthorityLease",
    );
    expect(boundary).toMatch(/availability !== "ready"[\s\S]*?protected: true[\s\S]*?bootstrap-pending/);
    expect(boundary.indexOf('availability !== "ready"')).toBeLessThan(
      boundary.indexOf("evaluateNativeAuthorityPersistenceBoundary("),
    );
  });

  it("rejects both JavaScript checkpoint APIs before every gameRef fallback", () => {
    const simulation = block(
      "const requestAuthoritativeSimulationCheckpoint = useCallback",
      "requestAuthoritativeSimulationCheckpointRef.current",
    );
    const persistence = block(
      "const requestAuthoritativePersistenceCheckpoint = useCallback",
      "const requestAuthoritativeDeferredTopLevelProjection",
    );
    for (const source of [simulation, persistence]) {
      expect(source).toMatch(/assertJavaScriptAuthorityCheckpointAllowed\(\)/);
      expect(source.indexOf("assertJavaScriptAuthorityCheckpointAllowed()")).toBeLessThan(source.indexOf("gameRef.current"));
      expect(source).toMatch(/\.then\(\(state\) => \{[\s\S]*?assertJavaScriptAuthorityCheckpointAllowed\(\)/);
    }
  });

  it("uses only a verified Rust durable receipt for active native saves", () => {
    const verifiedPrimary = block("const saveVerifiedPrimaryCheckpoint = useCallback", "/**\n   * Direct/dev entry points");
    expect(verifiedPrimary.indexOf("readNativeAuthorityPersistenceBoundary().protected")).toBeLessThan(
      verifiedPrimary.indexOf("saveGameVerified("),
    );
    const nativeSave = block(
      "const persistNativeAuthorityCheckpoint = useCallback",
      "const persistPrimarySave = useCallback",
    );
    expect(nativeSave).toMatch(/kind === "return"[\s\S]*?已阻止返回主页/);
    expect(nativeSave).toMatch(/nativeAuthorityCheckpointInFlightRef\.current[\s\S]*?kind === "autosave" \|\| kind === "lifecycle"/);
    expect(nativeSave).toMatch(/refreshNativeAuthorityPersistenceBoundary\(\)[\s\S]*?checkpointToken/);
    expect(nativeSave).toMatch(/createAuthorityCheckpoint\(undefined, savedAt\)/);
    expect(nativeSave).toMatch(/verifyNativeAuthorityCheckpointReceipt\(token, receipt, runtime\)/);
    expect(nativeSave).toMatch(/runtime\?\.kind === "active"[\s\S]*?时钟正忙或等待恢复/);
    expect(nativeSave).toMatch(/未写入公共 JavaScript 主档或云档/);
    expect(nativeSave).not.toMatch(/saveGame(?:Verified)?\(|readLocalSavePayload|uploadCloudSave/);

    const primary = block("const persistPrimarySave = useCallback", "persistPrimarySaveRef.current");
    expect(primary.indexOf("const nativeBoundary = readNativeAuthorityPersistenceBoundary()")).toBeLessThan(
      primary.indexOf("durablePrimarySaveInFlightRef.current"),
    );
    expect(primary).toMatch(/nativeBoundary\.protected[\s\S]*?state !== undefined[\s\S]*?均未改变/);
    expect(primary).toMatch(/return persistNativeAuthorityCheckpoint\(kind\)/);
  });

  it("exports active authority directly from Rust and never reads the old local payload", () => {
    const download = block("const downloadSave = useCallback", "const importSave = useCallback");
    const nativeBranch = download.slice(
      download.indexOf("if (nativeBoundary.protected)"),
      download.indexOf("const saved = await persistPrimarySave"),
    );
    expect(nativeBranch).toMatch(/persistNativeAuthorityCheckpoint\("manual"\)/);
    expect(nativeBranch).toMatch(/exportAuthoritativeV47\(/);
    expect(nativeBranch).toMatch(/verifyNativeAuthorityArtifactLineage\([\s\S]*?exported\.artifact\.identity,[\s\S]*?latestRuntime/);
    expect(nativeBranch).toMatch(/exported\.artifact\.identity\.revision === exported\.artifact\.export\.result\.revision/);
    expect(nativeBranch).toMatch(/native-json-recovery-warning/);
    expect(nativeBranch).not.toMatch(/throw new Error\("Windows 原生导出回执不属于当前/);
    expect(nativeBranch).not.toMatch(/readLocalSavePayload|compressSaveTextToGzipBlob|exportTextFile/);
  });

  it("makes a lost live completion ACK idempotent without reopening browser authority", () => {
    const handoff = block(
      "if (request.kind === \"native-player-authority-handoff-complete-v1\")",
      "if (request.kind === \"native-player-authority-browser-fence-release-v1\")",
    );
    expect(handoff).toMatch(/current\.phase === "browser-fenced" \|\| current\.phase === "native-active"/);
    expect(handoff).toMatch(/request\.revision >= current\.checkpoint\.revision/);
    expect(handoff).toMatch(/counts\.renderer !== 0 \|\| counts\.worker !== 0/);
    expect(handoff).toMatch(/current\.phase = "native-active"/);
    expect(handoff).not.toMatch(/releaseLocalSaveNativeAuthorityHandoff/);
  });

  it("skips native cloud autosync before session, serialization, or upload", () => {
    const cloud = block("const synchronizeMainSave = async () =>", "const timer = window.setInterval(() => void synchronizeMainSave()");
    const guard = cloud.indexOf("if (nativeBoundary.protected)");
    expect(guard).toBeGreaterThanOrEqual(0);
    for (const unsafe of ["resumeCloudSession", "requestAuthoritativeSimulationCheckpoint", "serializeEnvelopeInWorker", "uploadCloudSave"]) {
      expect(cloud.indexOf(unsafe)).toBeGreaterThan(guard);
    }
    expect(cloud.slice(guard, cloud.indexOf("resumeCloudSession"))).toMatch(/state: "skipped"[\s\S]*?不上传旧 JavaScript 镜像[\s\S]*?return;/);
  });

  it("blocks every current-factory replacement before reading or mutating its target", () => {
    const cases = [
      ["const importSave = useCallback", "const cancelImport", "inspectSaveInWorker"],
      ["const confirmImport = useCallback", "const confirmImportRescue", "saveGameSnapshotVerified"],
      ["const confirmImportRescue = useCallback", "const restoreCloudSave", "repairSave"],
      ["const restoreCloudSave = useCallback", "const saveToSlot", "inspectSaveInWorker"],
      ["const loadFromSlot = useCallback", "const deleteSlot", "loadGameSlotFromPersistence"],
      ["const addSecondUnipolarVein = useCallback", "const loadSnapshot", "previewSecondUnipolarVein"],
      ["const loadSnapshot = useCallback", "const deleteSnapshot", "loadSaveSnapshotFromPersistence"],
    ] as const;
    for (const [start, end, unsafe] of cases) {
      const source = block(start, end);
      const guard = source.indexOf("readNativeAuthorityPersistenceBoundary().protected");
      expect(guard, start).toBeGreaterThanOrEqual(0);
      expect(source.indexOf(unsafe), `${start} -> ${unsafe}`).toBeGreaterThan(guard);
    }
  });

  it("rechecks authority inside restoreGame and every caller handles a rejected race", () => {
    const restore = block("const restoreGame = useCallback", "const focusEntityIds = useCallback");
    const guard = restore.indexOf("readNativeAuthorityPersistenceBoundary().protected");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(restore.indexOf("return false", guard)).toBeLessThan(restore.indexOf("onMiningStop()"));
    expect(restore.indexOf("gameRef.current = state")).toBeGreaterThan(guard);
    expect(restore).toMatch(/setViewport\([\s\S]*?return true;/);

    const callSites = app.match(/if \(!restoreGame\(/g) ?? [];
    expect(callSites).toHaveLength(5);
    expect(app.match(/(?<!if \(!)restoreGame\(/g) ?? []).toHaveLength(0);
  });

  it("blocks content-pack registry mutations before catalog or persistence changes", () => {
    for (const [start, end] of [
      ["const registerValidatedContentPack = useCallback", "const toggleRegisteredContentPack"],
      ["const toggleRegisteredContentPack = useCallback", "const removeRegisteredContentPack"],
      ["const removeRegisteredContentPack = useCallback", "const downloadModTemplate"],
    ] as const) {
      const source = block(start, end);
      const guard = source.indexOf("readNativeAuthorityPersistenceBoundary().protected");
      expect(guard).toBeGreaterThanOrEqual(0);
      expect(source.indexOf("applyRegisteredContentPacks")).toBeGreaterThan(guard);
    }
  });

  it("never writes a synchronous JS emergency mirror or claims a JS pause protects Rust", () => {
    const lifecycle = block("const saveBeforeUnload = (_event: Event)", "const saveWhenHidden");
    expect(lifecycle.indexOf("nativeAuthorityPersistenceProtectedRef.current")).toBeLessThan(lifecycle.indexOf("saveGame("));
    const memory = block("const pauseForMemoryPressure", "const allowEditsDuringSaveRef");
    expect(memory).toMatch(/nativeAuthorityPersistenceProtectedRef\.current[\s\S]*?未被 JavaScript 假暂停[\s\S]*?return;/);
    expect(memory.indexOf("nativeAuthorityPersistenceProtectedRef.current")).toBeLessThan(memory.indexOf("gameRef.current = stopped"));
  });

  it("invalidates checkpoint batches and Worker continuations across a native takeover", () => {
    const dispatch = block(
      "const dispatchSimulationCheckpoint = useCallback",
      "dispatchSimulationCheckpointRef.current",
    );
    expect(dispatch).toMatch(/legacyJavaScriptAuthorityLeaseIsCurrent\(pending\.authorityLease\)/);
    expect(dispatch.indexOf("legacyJavaScriptAuthorityLeaseIsCurrent(pending.authorityLease)")).toBeLessThan(
      dispatch.indexOf("worker.postMessage(request"),
    );
    expect(dispatch).toMatch(/nativeSaveTransaction\?\.write\(write\.records\)[\s\S]*?legacyJavaScriptAuthorityLeaseIsCurrent\(pending\.authorityLease\)[\s\S]*?commitLocalSaveInternalRecords\(write\.records\)[\s\S]*?legacyJavaScriptAuthorityLeaseIsCurrent\(pending\.authorityLease\)[\s\S]*?postMessage/);

    const worker = block(
      "worker.onmessage = async",
      "worker.onerror = () =>",
    );
    expect(worker).toMatch(/workerContinuationIsCurrent\(\)[\s\S]*?nativeSaveTransaction\?\.commit\(\)[\s\S]*?workerContinuationIsCurrent\(\)/);
    expect(worker).toMatch(/requestAuthoritativeSimulationCheckpointRef\.current\(\)[\s\S]*?workerContinuationIsCurrent\(\)/);
    expect(worker).toMatch(/commitSimulationRuntimeRecoveryCheckpointInPersistenceWorker\([\s\S]*?workerContinuationIsCurrent\(\)/);
    expect(worker).toMatch(/appendWindowsNativeWal\([\s\S]*?workerContinuationIsCurrent\(\)/);

    const cleanup = block(
      "// Invalidate the imperative identity before touching any pending",
      "}, [abortPureIdleForWorkerFailure",
    );
    expect(cleanup.indexOf("simulationWorkerRef.current = null")).toBeLessThan(cleanup.indexOf("worker.terminate()"));
    expect(cleanup.indexOf("worker.onmessage = null")).toBeLessThan(cleanup.indexOf("worker.terminate()"));
  });

  it("carries one pure-idle authority lease through nested helpers and every terminal await", () => {
    const persistTerminal = block(
      "const persistPureIdleTerminalEnvelope = useCallback",
      "const persistNativeAuthorityCheckpoint = useCallback",
    );
    expect(persistTerminal).toMatch(/finalized: PureIdleMacroFinalEnvelopeResult,[\s\S]*?authorityLease: LegacyAuthorityAsyncLeaseToken/);
    expect(persistTerminal).not.toMatch(/issueLegacyJavaScriptAuthorityLease\(/);
    for (const awaited of [
      "saveGameVerifiedFromEnvelopeTransfer",
      "initializeSimulationRuntimeRecoveryInPersistenceWorker",
      "recordPureIdleRecoveryTransition",
      "replaceSimulationAuthorityFromStateTransfer",
      "clearPureIdleRecovery",
    ]) {
      const awaitIndex = persistTerminal.indexOf(`await ${awaited}`);
      expect(awaitIndex, awaited).toBeGreaterThanOrEqual(0);
      expect(
        persistTerminal.indexOf("legacyJavaScriptAuthorityLeaseIsCurrent(authorityLease)", awaitIndex),
        `${awaited} missing post-await lease check`,
      ).toBeGreaterThan(awaitIndex);
    }

    const settleBackground = block(
      "const settlePureIdleBackgroundRecovery = useCallback",
      "const markPureIdleBackgrounded = useCallback",
    );
    expect(settleBackground).not.toMatch(/issueLegacyJavaScriptAuthorityLease\(/);
    expect(settleBackground).toMatch(/initializePureIdleMacroClient\(record, authorityLease\)/);
    expect(settleBackground).toMatch(/persistPureIdleTransition\(record,[\s\S]*?authorityLease/);
    expect(settleBackground).toMatch(/persistPureIdleWorkerFailure\(record,[\s\S]*?authorityLease/);
    expect(settleBackground).toMatch(/persistPureIdleTerminalEnvelope\(record, backgroundFinalized, authorityLease\)/);
    expect(settleBackground).toMatch(/publishPureIdleTerminalGameBehindOverlay\(authorityLease\)/);

    const stop = block("const stopPureIdle = useCallback", "const cancelPureIdleSettlement = useCallback");
    expect(stop).toMatch(/inheritedAuthorityLease\?: LegacyAuthorityAsyncLeaseToken/);
    expect(stop).toMatch(/inheritedAuthorityLease \?\? issueLegacyJavaScriptAuthorityLease\(\)/);
    expect(stop).toMatch(/settlePureIdleBackgroundRecovery\(record, authorityLease, stoppedAtMs\)/);
    expect(stop).toMatch(/initializePureIdleMacroClient\(record, authorityLease\)/);
    expect(stop).toMatch(/persistPureIdleTerminalEnvelope\(record, finalized, authorityLease\)/);

    const retry = block("const retryPureIdleRecovery = useCallback", "const continueFromPureIdleCheckpoint = useCallback");
    expect(retry).toMatch(/const authorityLease = issueLegacyJavaScriptAuthorityLease\(\)/);
    expect(retry).toMatch(/initializePureIdleMacroClient\(record, authorityLease\)/);
    expect(retry).toMatch(/stopPureIdle\(authorityLease\)/);
  });

  it("makes GalaxyWorkspace main-cloud upload read-only under native authority and fences ABA", () => {
    expect(app).toMatch(/<GalaxyWorkspace[\s\S]*?nativeAuthorityReadOnly=\{nativePlayerAuthorityOwnsRuntime\}/);

    const upload = sourceBlock(
      galaxy,
      "const saveCurrentFactoryToCloud = async () =>",
      "const updateCloudSlot =",
    );
    const issueIndex = upload.indexOf("issueCloudLegacyAuthorityLease()");
    const exportIndex = upload.indexOf("exportGame(game)");
    expect(issueIndex).toBeGreaterThanOrEqual(0);
    expect(upload.indexOf("cloudLegacyAuthorityLeaseIsCurrent(authorityLease)", issueIndex)).toBeLessThan(exportIndex);
    expect(upload.indexOf("await uploadCloudSave")).toBeGreaterThan(exportIndex);
    expect(upload).toMatch(/await uploadCloudSave[\s\S]*?cloudLegacyAuthorityLeaseIsCurrent\(authorityLease\)[\s\S]*?await refreshCloudSaveMetadata[\s\S]*?cloudLegacyAuthorityLeaseIsCurrent\(authorityLease\)[\s\S]*?markCloudSaveSynchronized/);
    expect(upload).toMatch(/onStage:[\s\S]*?cloudLegacyAuthorityLeaseIsCurrent\(authorityLease\)/);
    expect(upload).toMatch(/onDiagnostics:[\s\S]*?cloudLegacyAuthorityLeaseIsCurrent\(authorityLease\)/);

    const keepLocal = sourceBlock(
      galaxy,
      "const keepLocalConflictVersion = async () =>",
      "const submitCurrentSpeedrun = async () =>",
    );
    expect(keepLocal).toMatch(/conflict\.slot === "main" \? issueCloudLegacyAuthorityLease\(\) : null/);
    expect(keepLocal).toMatch(/signal: controller\?\.signal/);
    expect(keepLocal).toMatch(/await uploadCloudSave[\s\S]*?cloudLegacyAuthorityLeaseIsCurrent\(authorityLease\)[\s\S]*?await refreshCloudSaveMetadata[\s\S]*?cloudLegacyAuthorityLeaseIsCurrent\(authorityLease\)[\s\S]*?markCloudSaveSynchronized/);

    expect(galaxy).toMatch(/立即同步普通主存档[\s\S]*?上传当前存档/);
    expect(galaxy.match(/disabled=\{cloudBusy \|\| nativeAuthorityReadOnly\}/g) ?? []).toHaveLength(2);
    expect(galaxy).toMatch(/onRetry=\{nativeAuthorityReadOnly \? undefined/);
    expect(galaxy).toMatch(/busy=\{cloudBusy \|\| \(nativeAuthorityReadOnly && cloudConflict\.slot === "main"\)\}/);
  });
});
