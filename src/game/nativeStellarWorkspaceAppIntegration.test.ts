import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native stellar workspace App integration", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const workspace = readFileSync(
    fileURLToPath(new URL("../components/StarMapWorkspace.tsx", import.meta.url)),
    "utf8",
  );

  it("binds both bounded reads to the active authority identity", () => {
    expect(app).toMatch(/createNativePlayerAuthorityStellarProjectionSource\(desktopBridge, identity\)/);
    expect(app).toMatch(/refreshOverview\(source, identity, \{ cursor: 0, limit: 64 \}\)/);
    expect(app).toMatch(/refreshIndustry\(source, identity, \{[\s\S]*?planetLimit: 64,[\s\S]*?stationLimit: 64/);
    expect(app).toMatch(/frame\.sessionId !== nativePlayerAuthorityActiveFrame\.sessionId/);
    expect(app).toMatch(/frame\.revision !== factoryThinViewExpectedRevision/);
    expect(app).toMatch(/frame\.registryFingerprint !== recipeWorkspaceRegistryFingerprint/);
  });

  it("passes only identity-checked projections into the workspace", () => {
    expect(app).toMatch(/nativeOverviewProjection=\{nativeStarMapOverviewProjection\}/);
    expect(app).toMatch(/nativeIndustryProjection=\{nativeStellarIndustryProjection\}/);
    expect(workspace).toMatch(/nativeOverviewProjection\?: DesktopNativeCoreStarMapOverviewProjectionResult \| null/);
    expect(workspace).toMatch(/nativeIndustryProjection\?: DesktopNativeCoreStellarIndustryProjectionResult \| null/);
  });

  it("uses native rows only after a complete first page proves the whole scope", () => {
    expect(workspace).toMatch(/systems\.cursor === 0[\s\S]*?systems\.nextCursor === null[\s\S]*?systems\.rows\.length === nativeOverviewProjection\.systems\.totalCount/);
    expect(workspace).toMatch(/planets\.cursor === 0[\s\S]*?planets\.nextCursor === null[\s\S]*?planets\.rows\.length === nativeIndustryProjection\.planets\.totalCount/);
    expect(workspace).toMatch(/stations\.cursor === 0[\s\S]*?stations\.nextCursor === null[\s\S]*?stations\.rows\.length === nativeIndustryProjection\.stations\.totalCount/);
    expect(workspace).toMatch(/nativePlanetRows\.get\(planetId\)\?\.deviceCount/);
    expect(workspace).toMatch(/nativeSystemRows\.get\(system\.id\)/);
  });
});
