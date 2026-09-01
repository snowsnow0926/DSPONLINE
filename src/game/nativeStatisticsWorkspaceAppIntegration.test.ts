import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native statistics workspace App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const workspace = readFileSync(resolve("src/components/NativeStatisticsWorkspace.tsx"), "utf8");
  const store = readFileSync(resolve("src/game/nativeStatisticsWorkspaceStore.ts"), "utf8");

  it("keeps the legacy statistics reader unreachable after Rust player authority takes ownership", () => {
    const requestStart = app.indexOf("const requestAuthoritativeStatisticsHistory");
    const requestEnd = app.indexOf("// Production history advances", requestStart);
    const request = app.slice(requestStart, requestEnd);
    expect(request).toMatch(/if \(nativePlayerAuthorityOwnsRuntimeRef\.current\) \{[\s\S]*?identity-bound workspace store[\s\S]*?\}/);
    expect(request.indexOf("nativePlayerAuthorityOwnsRuntimeRef.current")).toBeLessThan(
      request.indexOf("readVerifiedStatisticsProjection"),
    );
    expect(request.indexOf("nativePlayerAuthorityOwnsRuntimeRef.current")).toBeLessThan(
      request.indexOf("createStatisticsHistoryReadModel(gameRef.current"),
    );
    expect(app).toMatch(/statisticsHistoryRefreshToken = game\.historyRecordedAt[\s\S]*?if \(nativePlayerAuthorityOwnsRuntime/);
  });

  it("binds the native cache to session, run, revision, and registry before rendering it", () => {
    expect(app).toMatch(/nativeStatisticsWorkspaceIdentity = useMemo[\s\S]*?displayFrame[\s\S]*?sessionId: frame\.sessionId[\s\S]*?runId: frame\.runId[\s\S]*?revision: frame\.revision[\s\S]*?registryFingerprint: recipeWorkspaceRegistryFingerprint/);
    expect(app).toMatch(/nativeStatisticsWorkspaceReadIdentity = useMemo[\s\S]*?readFrame[\s\S]*?registryFingerprint: recipeWorkspaceRegistryFingerprint/);
    expect(app).toMatch(/createNativePlayerAuthorityStatisticsWorkspaceSource\(desktopBridge, nativeStatisticsWorkspaceReadIdentity\)/);
    expect(app).toMatch(/nativeStatisticsWorkspaceStore\.refresh\([\s\S]*?nativeStatisticsWorkspaceSource,[\s\S]*?nativeStatisticsWorkspaceReadIdentity/);
    expect(store).toMatch(/sameScope\(frame, identity\)[\s\S]*?frame\.revision > identity\.revision[\s\S]*?identity\.revision < snapshot\.requestedRevision/);
    expect(store).toMatch(/sessionId: boundIdentity\.sessionId[\s\S]*?runId: boundIdentity\.runId[\s\S]*?expectedRevision: boundIdentity\.revision[\s\S]*?expectedRegistryFingerprint: boundIdentity\.registryFingerprint/);
  });

  it("keeps the mounted display lineage during a tick while withholding unsettled reads", () => {
    expect(app).toMatch(/selectNativeStatisticsWorkspaceAuthorityFrames\([\s\S]*?nativePlayerAuthorityClockSnapshot,[\s\S]*?nativePlayerAuthoritySessionId/);
    expect(store).toMatch(/displayFrame: confirmed, readFrame: null/);
    const effectStart = app.indexOf("if (!statisticsOpen || !nativePlayerAuthorityOwnsRuntime");
    const effectEnd = app.indexOf("useEffect(() => {", effectStart + 1);
    const effect = app.slice(effectStart, effectEnd);
    expect(effect).toMatch(/!nativeStatisticsWorkspaceIdentity[\s\S]*?nativeStatisticsWorkspaceStore\.close\(\)/);
    expect(effect).toMatch(/if \(!nativeStatisticsWorkspaceReadIdentity \|\| !nativeStatisticsWorkspaceSource\) return/);
    expect(effect.indexOf("nativeStatisticsWorkspaceStore.close()")).toBeLessThan(
      effect.indexOf("if (!nativeStatisticsWorkspaceReadIdentity"),
    );
    expect(app).toMatch(/key=\{nativeStatisticsWorkspaceIdentity[\s\S]*?sessionId[\s\S]*?runId[\s\S]*?registryFingerprint/);
  });

  it("renders the identity-bound native frame without feeding it legacy history or GameState", () => {
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime \? <NativeStatisticsWorkspace[\s\S]*?frame=\{nativeStatisticsWorkspaceFrame\}[\s\S]*?latestIdentity=\{nativeStatisticsWorkspaceIdentity\}[\s\S]*?status=\{nativeStatisticsWorkspaceReadStatus\}[\s\S]*?: authorityWorkspaceSync === "statistics"[\s\S]*?<StatisticsWorkspace[\s\S]*?game=\{game\}/);
    const nativeBranch = app.slice(app.indexOf("nativePlayerAuthorityOwnsRuntime ? <NativeStatisticsWorkspace"), app.indexOf(": authorityWorkspaceSync === \"statistics\"", app.indexOf("nativePlayerAuthorityOwnsRuntime ? <NativeStatisticsWorkspace")));
    expect(nativeBranch).not.toContain("statisticsHistory");
    expect(workspace).not.toMatch(/GameState|statistics\.worker|postMessage|commitGame|gameRef/);
    expect(workspace).toMatch(/data-native-statistics="history-v1"/);
    expect(workspace).toMatch(/candidateFrame\.revision <= latestIdentity\.revision/);
  });
});
