import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(path), "utf8");

describe("native construction-center App boundary", () => {
  const app = source("src/App.tsx");
  const panels = source("src/components/GamePanels.tsx");
  const nativeWorkspace = source("src/components/NativeConstructionCenterWorkspace.tsx");
  const legacyWorkspace = source("src/components/ConstructionCenterWorkspace.tsx");

  it("opens a player-visible native branch with only identity-bound intent callbacks", () => {
    expect(app).toMatch(/import \{ NativeConstructionCenterWorkspace \} from "\.\/components\/NativeConstructionCenterWorkspace"/);
    expect(app).toMatch(/selectNativeConstructionCenterWorkspaceFrame\(nativeAuthoritativeFactoryWorkspaceFrame\)/);
    expect(app).toMatch(/nativeConstructionCenterLatestIdentity[\s\S]*?nativeFactoryInventoryIdentity[\s\S]*?nativeFactoryProjectionPlanetId/);
    expect(app).toMatch(/constructionCenterVisible=\{nativePlayerAuthorityOwnsRuntime \|\| game\.entities\.some/);
    expect(panels).toMatch(/const showConstructionCenter = constructionCenterVisible \?\?/);
    expect(panels).toMatch(/\{showConstructionCenter \? <button[\s\S]*?onClick=\{onOpenConstructionCenter\}/);
    expect(app).toMatch(/if \(!nativePlayerAuthorityOwnsRuntime && rejectLegacyFactoryInteractionWhileNative\("建筑制造中心"\)\) return/);

    const nativeTag = app.slice(app.indexOf("<NativeConstructionCenterWorkspace"), app.indexOf("/>", app.indexOf("<NativeConstructionCenterWorkspace")) + 2);
    expect(nativeTag).toMatch(/latestIdentity=\{nativeConstructionCenterLatestIdentity\}/);
    expect(nativeTag).toMatch(/frame=\{nativeConstructionCenterWorkspaceFrame\}/);
    expect(nativeTag).toMatch(/readStatus=\{nativeConstructionCenterReadStatus\}/);
    expect(nativeTag).toMatch(/pendingIdentity=\{nativeConstructionCenterUiPendingIdentity\}/);
    expect(nativeTag).toMatch(/onSubmitEnabledIntent=\{submitNativeConstructionCenterEnabledIntent\}/);
    expect(nativeTag).toMatch(/onSubmitQuantumSupplyIntent=\{submitNativeConstructionCenterQuantumSupplyIntent\}/);
    expect(nativeTag).toMatch(/onSubmitBatchBuildingTargetStockIntent=\{submitNativeConstructionCenterBatchBuildingTargetStockIntent\}/);
    expect(nativeTag).toMatch(/onSubmitTargetStockIntent=\{submitNativeConstructionCenterTargetStockIntent\}/);
    expect(nativeTag).not.toMatch(/\bgame=|onEnabledChange|onQuantumSourceChange|onTargetChange|onBatchTargetChange/);

    const legacyTag = app.slice(app.indexOf("<ConstructionCenterWorkspace", app.indexOf("<NativeConstructionCenterWorkspace")));
    expect(legacyTag).toMatch(/game=\{game\}/);
    expect(legacyTag).toMatch(/onEnabledChange[\s\S]*?onQuantumSourceChange[\s\S]*?onTargetChange[\s\S]*?onBatchTargetChange/);
  });

  it("keeps native controls projection-only and the legacy Web workspace intact", () => {
    expect(nativeWorkspace).not.toMatch(/from\s+["']\.\.\/game\/(?:engine|content|types)["']/);
    expect(nativeWorkspace).not.toMatch(/\bGameState\b|\bgame\.|getStatus\s*\(|getConstructionAutomationStatus/);
    expect(nativeWorkspace).not.toMatch(/nativeConstructionAutomationIntentCommands/);
    expect(nativeWorkspace).not.toMatch(/on(?:Enabled|QuantumSource|Target|BatchTarget|Cancel|Refund|Move|Discard|Fund)\b/);
    expect(nativeWorkspace).toMatch(/onSubmitEnabledIntent[\s\S]*?onSubmitQuantumSupplyIntent[\s\S]*?onSubmitBatchBuildingTargetStockIntent[\s\S]*?onSubmitTargetStockIntent/);
    expect(nativeWorkspace).toMatch(/等待 main-owned durable ACK；界面不会乐观改写/);
    expect(nativeWorkspace).toMatch(/workspace\?\.writeAvailable !== true/);
    expect(nativeWorkspace).toMatch(/Rust 尚未证明制造协议科技与可用制造中心/);
    expect(nativeWorkspace).toMatch(/确认降低[\s\S]*?取消同目标在途任务并按守恒规则退款/);
    expect(nativeWorkspace).toMatch(/一条原子 Rust 意图统一修改/);
    expect(nativeWorkspace).toMatch(/不会取消或退款现有任务/);
    expect(nativeWorkspace).toMatch(/应用全部<\/button>/);
    expect(legacyWorkspace).toMatch(/game: GameState/);
    expect(legacyWorkspace).toMatch(/onEnabledChange[\s\S]*?onQuantumSourceChange[\s\S]*?onTargetChange[\s\S]*?onBatchTargetChange/);
  });

  it("routes exactly four semantic helpers through the durable single-flight broker", () => {
    expect(app).toMatch(/from "\.\/game\/nativeConstructionAutomationIntentCommands"/);
    const commandBlock = app.slice(
      app.indexOf("const commitNativeConstructionCenterIntent"),
      app.indexOf("const takeNativeTrayItem"),
    );
    expect(commandBlock).toMatch(/commitNativeProjectedCommand\(identity\.revision/);
    expect(commandBlock).toMatch(/nativePlayerAuthorityCommandInFlightRef\.current \|\| nativeConstructionCenterPendingIdentityRef\.current/);
    expect(commandBlock).toMatch(/nativeConstructionCenterIdentityMatchesFrame\(identity, frame\)/);
    expect(commandBlock).toMatch(/routeIdentity\.revision !== identity\.revision/);
    expect(commandBlock).toMatch(/commandSource\.baseRevision !== identity\.revision/);
    expect(commandBlock.match(/createNativeConstructionAutomationEnabledIntentCommand\(/g)).toHaveLength(1);
    expect(commandBlock.match(/createNativeConstructionAutomationQuantumSupplyIntentCommand\(/g)).toHaveLength(1);
    expect(commandBlock.match(/createNativeConstructionAutomationTargetStockIntentCommand\(/g)).toHaveLength(1);
    expect(commandBlock.match(/createNativeConstructionAutomationBatchBuildingTargetStockIntentCommand\(/g)).toHaveLength(1);
    expect(commandBlock).not.toMatch(/topLevelChanges|changedEntities|changedBelts|\bgameRef\b|\bgame\.|workspace\.(?:jobs|materials|quantumBuffer|destroyedByproducts)|portableFleet|constructionQueue/);
    expect(commandBlock).toMatch(/lowering[\s\S]*?confirmedDecreaseFrom !== row\.target/);
    expect(commandBlock).toMatch(/submission\.confirmedAffectedCount !== affectedRows\.length/);
    expect(commandBlock).toMatch(/submission\.confirmedChangedCount !== changedRows\.length/);
    expect(commandBlock).toMatch(/submission\.confirmedLoweredCount !== loweredCount/);
    expect(commandBlock.match(/!frame\.workspace\.writeAvailable/g)).toHaveLength(4);
    for (const [start, end] of [
      ["const submitNativeConstructionCenterEnabledIntent", "const submitNativeConstructionCenterQuantumSupplyIntent"],
      ["const submitNativeConstructionCenterQuantumSupplyIntent", "const submitNativeConstructionCenterTargetStockIntent"],
      ["const submitNativeConstructionCenterTargetStockIntent", "const submitNativeConstructionCenterBatchBuildingTargetStockIntent"],
      ["const submitNativeConstructionCenterBatchBuildingTargetStockIntent", "const takeNativeTrayItem"],
    ] as const) {
      const callback = app.slice(app.indexOf(start), app.indexOf(end));
      expect(callback.indexOf("!frame.workspace.writeAvailable"), start).toBeGreaterThanOrEqual(0);
      expect(callback.indexOf("!frame.workspace.writeAvailable"), start)
        .toBeLessThan(callback.indexOf("commitNativeConstructionCenterIntent("));
    }

    const pendingBlock = app.slice(
      app.indexOf("const nativeConstructionCenterWorkspaceFrame ="),
      app.indexOf("const nativePlayerAuthorityMacroControllerRef"),
    );
    expect(pendingBlock).toMatch(/pending\.expectedRevision !== null[\s\S]*?current!\.revision >= pending\.expectedRevision/);
    expect(pendingBlock).toMatch(/!nativePlayerAuthorityOwnsRuntime \|\| activeFrameDrifted/);
    expect(pendingBlock).not.toMatch(/!constructionCenterOpen \|\|/);
    expect(pendingBlock).toMatch(/projectionIdentityDrifted[\s\S]*?nativeFactoryProjectionPlanetId !== pending\.activePlanetId/);
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
