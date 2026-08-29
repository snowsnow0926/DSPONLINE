import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native construction inventory App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const dock = readFileSync(resolve("src/components/NativeConstructionDock.tsx"), "utf8");

  it("binds every page to the main-owned session, run, revision, and registry", () => {
    expect(app).toMatch(/new NativeConstructionInventoryStore\(\)/);
    expect(app).toMatch(/createNativePlayerAuthorityConstructionInventorySource\(desktopBridge, nativeFactoryInventoryIdentity\)/);
    expect(app).toMatch(/nativeConstructionInventoryStore\.refresh\([\s\S]*?nativeConstructionInventorySource,[\s\S]*?nativeFactoryInventoryIdentity/);
    expect(app).toMatch(/selectNativeConstructionInventoryFrame\(nativeConstructionInventorySnapshot, nativeFactoryInventoryIdentity\)/);
  });

  it("renders only the Rust frame and exposes no legacy construction mutation", () => {
    expect(app).toMatch(/<NativeConstructionDock[\s\S]*?frame=\{nativeConstructionInventoryFrame\}/);
    expect(dock).not.toMatch(/GameState|panelGame|commitGame|gameRef|onPlacement|onCraft|onDelete/);
    expect(dock).toMatch(/frame\?\.rows/);
    expect(dock).toMatch(/data-native-construction-read-only="true"/);
    expect(dock).toMatch(/disabled/);
  });
});
