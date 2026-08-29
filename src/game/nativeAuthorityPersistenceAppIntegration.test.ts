import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const app = readFileSync(resolve("src/App.tsx"), "utf8");

function block(start: string, end: string): string {
  const startIndex = app.indexOf(start);
  const endIndex = app.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex);
  return app.slice(startIndex, endIndex);
}

describe("native authority persistence App boundary", () => {
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
    expect(nativeBranch).toMatch(/latestRuntime\.revision !== exported\.result\.revision/);
    expect(nativeBranch).not.toMatch(/readLocalSavePayload|compressSaveTextToGzipBlob|exportTextFile/);
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
});
