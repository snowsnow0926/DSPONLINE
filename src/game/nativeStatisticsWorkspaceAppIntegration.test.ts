import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native statistics workspace App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const workspace = readFileSync(resolve("src/components/NativeStatisticsWorkspace.tsx"), "utf8");

  it("never falls back to stale GameState after native history verification fails", () => {
    const requestStart = app.indexOf("const requestAuthoritativeStatisticsHistory");
    const requestEnd = app.indexOf("// Production history advances", requestStart);
    const request = app.slice(requestStart, requestEnd);
    expect(request).toMatch(/nativeProjection[\s\S]*?return \{[\s\S]*?samples: nativeProjection\.samples/);
    expect(request).toMatch(/maxElapsedSeconds: nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?Number\.MAX_SAFE_INTEGER/);
    expect(request).toMatch(/if \(nativePlayerAuthorityOwnsRuntimeRef\.current\)[\s\S]*?throw new Error/);
    expect(request.indexOf("nativePlayerAuthorityOwnsRuntimeRef.current")).toBeLessThan(request.indexOf("createStatisticsHistoryReadModel(gameRef.current"));
  });

  it("renders the bounded native history component before the legacy full-state workspace", () => {
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime \? <NativeStatisticsWorkspace[\s\S]*?samples=\{statisticsHistory \?\? \[\]\}[\s\S]*?: <StatisticsWorkspace[\s\S]*?game=\{game\}/);
    expect(app).toMatch(/statisticsHistoryRefreshToken = nativePlayerAuthorityOwnsRuntime[\s\S]*?factoryThinViewExpectedRevision[\s\S]*?: game\.historyRecordedAt/);
    expect(workspace).not.toMatch(/GameState|statistics\.worker|postMessage|commitGame|gameRef/);
    expect(workspace).toMatch(/data-native-statistics="history-v1"/);
  });
});
