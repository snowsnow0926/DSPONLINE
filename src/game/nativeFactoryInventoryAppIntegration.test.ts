import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native factory inventory App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const rail = readFileSync(resolve("src/components/NativeResourceRail.tsx"), "utf8");

  it("binds every page to the exact main-owned session, run, revision, and registry", () => {
    expect(app).toMatch(/new NativeFactoryInventoryStore\(\)/);
    expect(app).toMatch(/sessionId: nativePlayerAuthorityActiveFrame\.sessionId|const sessionId = nativePlayerAuthorityActiveFrame\?\.sessionId/);
    expect(app).toMatch(/const runId = nativePlayerAuthorityActiveFrame\?\.runId/);
    expect(app).toMatch(/revision: factoryThinViewExpectedRevision/);
    expect(app).toMatch(/registryFingerprint: recipeWorkspaceRegistryFingerprint/);
    expect(app).toMatch(/createNativePlayerAuthorityFactoryInventorySource\(desktopBridge, nativeFactoryInventoryIdentity\)/);
    expect(app).toMatch(/nativeFactoryInventoryStore\.refresh\([\s\S]*?nativeFactoryInventorySource,[\s\S]*?nativeFactoryInventoryIdentity/);
    expect(app).toMatch(/selectNativeFactoryInventoryFrame\(nativeFactoryInventorySnapshot, nativeFactoryInventoryIdentity\)/);
  });

  it("uses only projected rows and typed Rust-validated commands", () => {
    expect(app).toMatch(/<NativeResourceRail[\s\S]*?frame=\{nativeFactoryInventoryFrame\}[\s\S]*?onPickTray=\{takeNativeTrayItem\}[\s\S]*?onDropCargo=\{returnNativeCargo\}[\s\S]*?onSetTrayItemLimit=\{setNativeTrayItemLimit\}/);
    expect(app).toMatch(/commitNativeProjectedCommand\(frame\.revision,[\s\S]*?createNativeProjectedTrayTakeCommand\(frame, itemId\)/);
    expect(app).toMatch(/commitNativeProjectedCommand\(frame\.revision,[\s\S]*?createNativeProjectedCargoReturnCommand\(frame\)/);
    expect(app).toMatch(/commitNativeProjectedCommand\(frame\.revision,[\s\S]*?createNativeProjectedTrayItemLimitCommand\(frame, value\)/);
    expect(rail).not.toMatch(/GameState|panelGame|commitGame|gameRef/);
    expect(rail).toMatch(/frame\?\.rows/);
  });

  it("makes the rail read-only while a command or projection is unsettled", () => {
    expect(app).toMatch(/nativePlayerAuthorityCommandInFlightRef\.current = true;[\s\S]*?setNativePlayerAuthorityCommandPending\(true\)/);
    expect(app).toMatch(/nativePlayerAuthorityCommandInFlightRef\.current = false;[\s\S]*?setNativePlayerAuthorityCommandPending\(false\)/);
    expect(app).toMatch(/pending=\{nativePlayerAuthorityCommandPending \|\| !nativePlayerAuthorityCommandSource\}/);
    expect(rail).toMatch(/const disabled = pending \|\| !frame/);
    expect(rail).toMatch(/disabled=\{disabled \|\| mixedCargo \|\| fullCargo\}/);
  });
});
