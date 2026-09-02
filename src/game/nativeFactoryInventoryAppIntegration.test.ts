import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native factory inventory App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const rail = readFileSync(resolve("src/components/NativeResourceRail.tsx"), "utf8");

  it("binds every page to the exact main-owned session, run, revision, and registry", () => {
    expect(app).toMatch(/new NativeFactoryInventoryStore\(\)/);
    expect(app).toMatch(/nativeFactoryInventoryIdentity = useMemo<NativeFactoryInventoryIdentity \| null>[\s\S]*?nativeThinWorkspaceAuthorityFrames\.displayFrame[\s\S]*?sessionId: frame\.sessionId,[\s\S]*?runId: frame\.runId,[\s\S]*?revision: frame\.revision/);
    expect(app).toMatch(/nativeFactoryInventoryReadIdentity = useMemo<NativeFactoryInventoryIdentity \| null>[\s\S]*?nativeThinWorkspaceAuthorityFrames\.readFrame/);
    expect(app).toMatch(/registryFingerprint: recipeWorkspaceRegistryFingerprint/);
    expect(app).toMatch(/createNativePlayerAuthorityFactoryInventorySource\(desktopBridge, nativeFactoryInventoryReadIdentity\)/);
    expect(app).toMatch(/nativeFactoryInventoryStore\.refresh\([\s\S]*?nativeFactoryInventorySource,[\s\S]*?nativeFactoryInventoryReadIdentity/);
    expect(app).toMatch(/selectNativeFactoryInventoryFrame\(nativeFactoryInventorySnapshot, nativeFactoryInventoryIdentity\)/);
    expect(app).toMatch(/if \(!nativePlayerAuthorityOwnsRuntime \|\| !nativeFactoryInventoryIdentity\) \{[\s\S]*?nativeFactoryInventoryStore\.clear\(\)[\s\S]*?if \(!nativeFactoryInventoryReadIdentity \|\| !nativeFactoryInventorySource\) return;/);
  });

  it("uses only projected rows and typed Rust-validated commands", () => {
    expect(app).toMatch(/<NativeResourceRail[\s\S]*?frame=\{nativeFactoryInventoryFrame\}[\s\S]*?onPickTray=\{takeNativeTrayItem\}[\s\S]*?onDropCargo=\{returnNativeCargo\}[\s\S]*?onSetTrayItemLimit=\{setNativeTrayItemLimit\}[\s\S]*?onSetProductionBufferLimit=\{setNativeProductionBufferLimit\}/);
    expect(app).toMatch(/commitNativeProjectedCommand\(frame\.revision,[\s\S]*?createNativeProjectedTrayTakeCommand\(frame, itemId\)/);
    expect(app).toMatch(/commitNativeProjectedCommand\(frame\.revision,[\s\S]*?createNativeProjectedCargoReturnCommand\(frame\)/);
    expect(app).toMatch(/commitNativeProjectedCommand\(frame\.revision,[\s\S]*?createNativeProjectedTrayItemLimitCommand\(frame, value\)/);
    expect(app).toMatch(/commitNativeProjectedCommand\(frame\.revision,[\s\S]*?createNativeProjectedProductionBufferLimitCommand\(frame, value\)/);
    expect(rail).not.toMatch(/GameState|panelGame|commitGame|gameRef/);
    expect(rail).toMatch(/frame\?\.rows/);
  });

  it("moves entity inventory only from the atomic canvas/inventory revision and rereads after ACK", () => {
    expect(app).toMatch(/canvas\.sessionId !== inventory\.sessionId[\s\S]*?canvas\.runId !== inventory\.runId[\s\S]*?canvas\.revision !== inventory\.revision[\s\S]*?canvas\.planetId !== inventory\.activePlanetId/);
    expect(app).toMatch(/createNativeProjectedEntityInventoryTakeCommand\(binding\.inventory, entity, "outputs", itemId\)/);
    expect(app).toMatch(/createNativeProjectedEntityInventoryTakeCommand\(binding\.inventory, entity, "inputs", itemId\)/);
    expect(app).toMatch(/createNativeProjectedEntityInventoryStowCommand\([\s\S]*?binding\.inventory,[\s\S]*?entity,[\s\S]*?sourceKind === "node" \? "outputs" : "inputs"/);
    expect(app).toMatch(/createNativeProjectedCargoToEntityInputCommand\(binding\.inventory, entity\)/);
    expect(app).toMatch(/sourceKind !== "tray" \|\| sourceId[\s\S]*?createNativeProjectedTrayToEntityInputCommand\(binding\.inventory, entity, itemId\)/);
    expect(app).toMatch(/onStowEntityInventory=\{handleDraggedItemToTray\}/);
    expect(app).toMatch(/entityDepositEnabled=\{nativeEntityInventoryDepositEnabled\}/);
    expect(app).toMatch(/Never install or predict the projected edit locally[\s\S]*?nativePlayerAuthorityClockRef\.current\?\.refresh\(\)/);
    expect(rail).toMatch(/data-native-entity-stow="same-revision-v1"/);
    expect(rail).toMatch(/application\/factory-source-kind", "tray"/);
  });

  it("makes the rail read-only while a command or projection is unsettled", () => {
    expect(app).toMatch(/nativePlayerAuthorityCommandInFlightRef\.current = true;[\s\S]*?setNativePlayerAuthorityCommandPending\(true\)/);
    expect(app).toMatch(/nativePlayerAuthorityCommandInFlightRef\.current = false;[\s\S]*?setNativePlayerAuthorityCommandPending\(false\)/);
    expect(app).toMatch(/pending=\{nativePlayerAuthorityCommandPending \|\| !nativePlayerAuthorityCommandSource \|\|[\s\S]*?!nativeFactoryInventoryWritesEnabled\}/);
    expect(app).toMatch(/nativeFactoryInventoryWritesEnabled = nativeInventoryLineageCurrent &&[\s\S]*?nativeFactoryInventoryFrame\?\.revision === nativeFactoryInventoryReadIdentity\?\.revision/);
    expect(app).toMatch(/nativeEntityInventoryProjectionBinding !== null[\s\S]*?!nativePlayerAuthorityCommandPending/);
    expect(rail).toMatch(/const disabled = pending \|\| !frame/);
    expect(rail).toMatch(/disabled=\{disabled \|\| pickDisabled && !canDragToEntity\}/);
    expect(rail).toMatch(/const canDragToEntity = entityDepositEnabled && !disabled/);
  });
});
