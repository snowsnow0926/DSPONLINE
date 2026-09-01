import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native header controls App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const panels = readFileSync(resolve("src/components/GamePanels.tsx"), "utf8");
  const performanceMonitor = readFileSync(resolve("src/hooks/usePerformanceMonitor.ts"), "utf8");

  it("removes the full renderer state from the header while Rust owns the factory", () => {
    expect(app).toMatch(/<HeaderControls[\s\S]*?game=\{nativePlayerAuthorityOwnsRuntime \? null : game\}[\s\S]*?runStatus=\{factoryRunStatusReadModel\}/);
    expect(panels).toMatch(/game: GameState \| null;[\s\S]*?runStatus: FactoryRunStatusReadModel/);
    expect(panels).toMatch(/game \? <>[\s\S]*?data-native-header-status="factory-run-status-v1"/);
  });

  it("exposes the migrated Operations destination, hides uncovered legacy destinations, and exposes durable native pause", () => {
    expect(panels).toMatch(/<button[^>]*header-settings-command/);
    expect(panels).not.toMatch(/!nativeAuthority \? <button[^>]*header-settings-command/);
    expect(panels).toMatch(/<button type="button" role="menuitem" onClick=\{\(\) => runOverflowAction\(onOpenSettings\)\}/);
    expect(panels).toMatch(/!nativeAuthority \? <button[^>]*activeWorkspace === "galaxy"/);
    expect(panels).toMatch(/!nativeAuthority \? <button[^>]*activeWorkspace === "campaign"/);
    expect(app).toMatch(/pauseControlAvailable=\{!nativePlayerAuthorityOwnsRuntime \|\| \([\s\S]*?setNativePlayerAuthorityPaused[\s\S]*?schemaVersion === 1/);
    expect(panels).toMatch(/pauseControlAvailable = true[\s\S]*?disabled=\{!pauseControlAvailable\}/);
    expect(panels).not.toMatch(/disabled=\{nativeAuthority\}[\s\S]*?Windows 原生暂停命令尚未接入/);
  });

  it("uses the bounded run status for shell pause state and suspends legacy diagnostics", () => {
    expect(app).toMatch(/usePerformanceMonitor\(\s*getCurrentGame,\s*nativePlayerAuthorityOwnsRuntime/);
    expect(app).toContain("const canvasRefreshPaused = canvasWorkspacePaused || factoryRunStatusReadModel.paused;");
    expect(app).toContain('data-simulation-paused={factoryRunStatusReadModel.paused ? "true" : "false"}');
    expect(app).toContain("if (!coarsePointer || factoryRunStatusReadModel.paused)");
    expect(app).toContain('if (productionRefreshPreference !== "auto" || factoryRunStatusReadModel.paused) return;');
    expect(app).toContain("const visibleFactoryAlertProjection = !factoryAlertsEnabled || factoryRunStatusReadModel.paused");
    expect(performanceMonitor).toContain("if (!snapshot.active || suspendLegacyStateSampling) return;");
  });
});
