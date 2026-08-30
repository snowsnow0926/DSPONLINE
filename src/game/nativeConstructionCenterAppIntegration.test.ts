import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(path), "utf8");

describe("native construction-center App boundary", () => {
  const app = source("src/App.tsx");
  const panels = source("src/components/GamePanels.tsx");
  const nativeWorkspace = source("src/components/NativeConstructionCenterWorkspace.tsx");
  const legacyWorkspace = source("src/components/ConstructionCenterWorkspace.tsx");

  it("opens a player-visible native branch without passing GameState or legacy callbacks", () => {
    expect(app).toMatch(/import \{ NativeConstructionCenterWorkspace \} from "\.\/components\/NativeConstructionCenterWorkspace"/);
    expect(app).toMatch(/selectNativeConstructionCenterWorkspaceFrame\(nativeAuthoritativeFactoryWorkspaceFrame\)/);
    expect(app).toMatch(/constructionCenterVisible=\{nativePlayerAuthorityOwnsRuntime \|\| game\.entities\.some/);
    expect(panels).toMatch(/const showConstructionCenter = constructionCenterVisible \?\?/);
    expect(panels).toMatch(/\{showConstructionCenter \? <button[\s\S]*?onClick=\{onOpenConstructionCenter\}/);
    expect(app).toMatch(/if \(!nativePlayerAuthorityOwnsRuntime && rejectLegacyFactoryInteractionWhileNative\("建筑制造中心"\)\) return/);

    const nativeTag = app.slice(app.indexOf("<NativeConstructionCenterWorkspace"), app.indexOf("/>", app.indexOf("<NativeConstructionCenterWorkspace")) + 2);
    expect(nativeTag).toMatch(/frame=\{nativeConstructionCenterWorkspaceFrame\}/);
    expect(nativeTag).toMatch(/readStatus=\{nativeConstructionCenterReadStatus\}/);
    expect(nativeTag).not.toMatch(/\bgame=|onEnabledChange|onQuantumSourceChange|onTargetChange|onBatchTargetChange/);

    const legacyTag = app.slice(app.indexOf("<ConstructionCenterWorkspace", app.indexOf("<NativeConstructionCenterWorkspace")));
    expect(legacyTag).toMatch(/game=\{game\}/);
    expect(legacyTag).toMatch(/onEnabledChange[\s\S]*?onQuantumSourceChange[\s\S]*?onTargetChange[\s\S]*?onBatchTargetChange/);
  });

  it("keeps the native renderer display-only and the legacy Web workspace intact", () => {
    expect(nativeWorkspace).not.toMatch(/from\s+["']\.\.\/game\/(?:engine|content|types)["']/);
    expect(nativeWorkspace).not.toMatch(/\bGameState\b|\bgame\.|getStatus\s*\(|getConstructionAutomationStatus/);
    expect(nativeWorkspace).not.toMatch(/on(?:Enabled|QuantumSource|Target|BatchTarget|Cancel|Refund|Move|Discard|Fund)\b/);
    expect(nativeWorkspace).toMatch(/原生写入尚未开放/);
    expect(nativeWorkspace).toMatch(/disabled readOnly/);
    expect(legacyWorkspace).toMatch(/game: GameState/);
    expect(legacyWorkspace).toMatch(/onEnabledChange[\s\S]*?onQuantumSourceChange[\s\S]*?onTargetChange[\s\S]*?onBatchTargetChange/);
  });

  it("reuses the exact factory Host-main-preload operation and preserves its 1 MiB boundary", () => {
    const main = source("desktop/main.cjs");
    const preload = source("desktop/preload.cjs");
    const desktop = source("src/desktop.ts");
    const boundary = source("desktop/native-renderer-boundary.cjs");
    const rust = source("native/dsp-native-core/src/factory_read_model.rs");
    expect(main).toMatch(/desktop:native-core-factory-read-model[\s\S]*?coreFactoryReadModelProjection/);
    expect(preload).toMatch(/getNativeCoreFactoryReadModel:[\s\S]*?desktop:native-core-factory-read-model/);
    expect(desktop).toMatch(/DesktopNativeCoreFactoryReadModelResult extends FactoryReadModelBundle/);
    expect(boundary).toMatch(/normalizeNativeConstructionCenterWorkspace[\s\S]*?nativeCenterWorkspace/);
    expect(rust).toMatch(/const MAX_PROJECTION_BYTES: usize = 1_048_576/);
    expect(rust).toMatch(/"nativeCenterWorkspace": native_construction_center_workspace/);
    expect(app).not.toMatch(/getNativeCoreStatus\(|exportNativeCoreV47\(/);
  });
});
