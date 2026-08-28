import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native command palette entity-search App integration", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const palette = readFileSync(
    fileURLToPath(new URL("../components/CommandPalette.tsx", import.meta.url)),
    "utf8",
  );

  it("binds native search to the active session, revision, fingerprint and selector", () => {
    expect(app).toMatch(/selectNativeCommandPaletteEntitySearchReadModel\([\s\S]*?enabled: Boolean\(nativePlayerAuthorityActiveFrame\)[\s\S]*?expectedRevision: factoryThinViewExpectedRevision[\s\S]*?expectedRegistryFingerprint: recipeWorkspaceRegistryFingerprint[\s\S]*?selector: commandPaletteEntitySearchSelector/);
    expect(app).toMatch(/createCommandPaletteEntitySearchSelector\([\s\S]*?commandPaletteEntitySearchRequest\.cursor[\s\S]*?recipeWorkspaceRegistryFingerprint[\s\S]*?\],/);
    expect(app).toMatch(/!commandPaletteOpen \|\| !nativePlayerAuthorityBoundFrame[\s\S]*?nativeCommandPaletteEntitySearchStore\.clear\(\)/);
    expect(app).toMatch(/nativeCommandPaletteEntitySearchStore\.refresh\([\s\S]*?factoryThinViewExpectedRevision[\s\S]*?recipeWorkspaceRegistryFingerprint[\s\S]*?commandPaletteEntitySearchSelector/);
    expect(app).toMatch(/entitySearchMode=\{nativePlayerAuthorityBoundFrame \? "native" : "web"\}[\s\S]*?nativeEntitySearch=\{nativeCommandPaletteEntitySearchReadModel\}/);
  });

  it("keeps native pending, error and stale states detached from the GameState entity scan", () => {
    expect(palette).toMatch(/const webEntities = entitySearchMode === "web" \? game\.entities : null/);
    expect(palette.match(/game\.entities/g)).toHaveLength(1);
    expect(palette).toMatch(/if \(entitySearchMode === "native"\)[\s\S]*?nativeEntitySearch\?\.query === normalizedQuery[\s\S]*?for \(const row of nativeEntitySearch\.rows\)/);
    expect(palette).toMatch(/nativeEntitySearchStatus === "unavailable"[\s\S]*?原生权威设备搜索暂不可用/);
    expect(palette).toMatch(/onFocusEntity\(row\.entityId, \{[\s\S]*?sessionId: nativeEntitySearch\.sessionId[\s\S]*?planetId: row\.planetId[\s\S]*?positionX: row\.positionX[\s\S]*?positionY: row\.positionY/);
    const nativeClickBranch = app.match(
      /if \(nativeTarget\) \{([\s\S]*?)\n    \}\n    const entity = gameRef\.current\.entities\.find/,
    )?.[1] ?? "";
    expect(nativeClickBranch).toContain("nativePlayerAuthorityClock.getSnapshot()");
    expect(nativeClickBranch).toContain("createCommandPaletteNativeEntityFocusPlan(");
    expect(nativeClickBranch).toContain("setCenter(focusPlan.centerX, focusPlan.centerY");
    expect(nativeClickBranch).not.toContain("focusEntityIds");
    expect(nativeClickBranch).not.toContain(".entities");
  });

  it("renders local catalog names and exposes bounded native pagination", () => {
    expect(palette).toMatch(/row\.buildingId[\s\S]*?getBuilding\(row\.buildingId\)\.name[\s\S]*?ITEMS\[row\.resourceId\]\.name/);
    expect(palette).toMatch(/command-palette-pagination[\s\S]*?上一页[\s\S]*?nativeEntitySearch\.nextCursor[\s\S]*?下一页/);
  });
});
