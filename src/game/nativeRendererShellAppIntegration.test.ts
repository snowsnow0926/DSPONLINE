import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("native renderer shell App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const runtime = readFileSync(resolve("src/FactoryRuntime.tsx"), "utf8");
  const launcher = readFileSync(resolve("src/GameLauncher.tsx"), "utf8");

  it("releases the full state only after a main-owned active authority frame exists", () => {
    expect(app).toMatch(/const nativeRendererReleasedIdentityRef = useRef<string \| null>\(null\)/);
    expect(app).toMatch(/const active = nativePlayerAuthorityActiveFrame;[\s\S]*?if \(!active\?\.sessionId \|\| !active\.runId\) return;[\s\S]*?releaseNativeRendererState\(active\.sessionId, active\.runId\)/);
    expect(app).not.toMatch(/nativePlayerAuthorityOwnsRuntime[\s\S]{0,120}releaseNativeRendererState/);
    expect(app).toMatch(/nativeAuthorityPersistenceProtectedRef\.current = true;[\s\S]*?setNativeAuthorityHandoffQuiescing\(false\)/);
  });

  it("drops every known renderer reference that can retain the handed-off factory", () => {
    const start = app.indexOf("const releaseNativeRendererState = useCallback");
    const finish = app.indexOf("useEffect(() => {", start);
    const release = app.slice(start, finish);

    expect(release).toMatch(/createNativeRendererShellState\(gameRef\.current\)/);
    for (const ref of [
      "pendingRuntimeGamePublicationRef",
      "runtimeGamePublicationInFlightRef",
      "deferredProjectionGameRef",
      "controlledReturnCommitRef",
      "pendingCanvasSnapshotPublicationRef",
      "canvasSnapshotPublicationInFlightRef",
      "pendingCanvasProjectionRef",
      "batchConnectionDraftRef",
      "batchConnectionDraftBaseRef",
      "viewportOnlyGameStateRef",
      "durableRecoveryPendingViewRef",
      "latestAuthoritativeCheckpointTransferRef",
      "lastSimulationResultRef",
    ]) {
      expect(release, ref).toContain(`${ref}.current = null`);
    }
    expect(release).toMatch(/gameHistoryRef\.current\.clear\(\)/);
    expect(release).toMatch(/simulationReplayJournalRef\.current = \[\]/);
    expect(release).toMatch(/simulationProjectionIndexRef\.current = createSimulationProjectionStateIndex\(shell\)/);
    expect(release).toMatch(/setPendingImportState\(null\)[\s\S]*?setPendingImportRaw\(null\)/);
    expect(release).toMatch(/setLoaded\(releasedLoad\)[\s\S]*?setGame\(shell\)[\s\S]*?onReleaseNativeRendererState\(releasedLoad\)/);
  });

  it("replaces the parent launch payload so React props do not retain the old save", () => {
    expect(runtime).toMatch(/onReleaseNativeRendererState: \(releasedLoad: LoadedGame\) => void/);
    expect(runtime).toMatch(/<FactoryGame[\s\S]*?onReleaseNativeRendererState=\{onReleaseNativeRendererState\}/);
    expect(launcher).toMatch(/onReleaseNativeRendererState=\{\(releasedLoad\) => setLaunch\(\(current\) => current[\s\S]*?loaded: releasedLoad/);
    expect(launcher).not.toMatch(/onReleaseNativeRendererState[\s\S]{0,160}launch\.loaded/);
  });
});
