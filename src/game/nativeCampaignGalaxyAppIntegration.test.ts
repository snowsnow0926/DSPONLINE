import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("native Campaign and Galaxy App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const nativeGalaxy = readFileSync(resolve("src/components/NativeGalaxyWorkspace.tsx"), "utf8");

  it("keeps both routes reachable and mounts exactly one authority-specific workspace", () => {
    expect(app).not.toMatch(/workspace === "campaign" && rejectLegacyFactoryInteractionWhileNative/);
    expect(app).not.toMatch(/workspace === "galaxy" && rejectLegacyFactoryInteractionWhileNative/);
    expect(app).not.toMatch(/const openCampaign[\s\S]{0,180}rejectLegacyFactoryInteractionWhileNative/);
    expect(app).toMatch(/galaxyOpen \? nativePlayerAuthorityOwnsRuntime \? \([\s\S]*?<NativeGalaxyWorkspace[\s\S]*?\) : \([\s\S]*?<GalaxyWorkspace/);
    expect(app).toMatch(/campaignOpen \? nativePlayerAuthorityOwnsRuntime \? \([\s\S]*?<NativeCampaignWorkspace[\s\S]*?\) : \([\s\S]*?<CampaignWorkspace/);
  });

  it("never passes GameState or primary-save callbacks into the native pages", () => {
    const galaxyStart = app.indexOf("<NativeGalaxyWorkspace");
    const galaxyEnd = app.indexOf("/>", galaxyStart);
    const campaignStart = app.indexOf("<NativeCampaignWorkspace");
    const campaignEnd = app.indexOf("/>", campaignStart);
    const galaxyProps = app.slice(galaxyStart, galaxyEnd);
    const campaignProps = app.slice(campaignStart, campaignEnd);
    expect(galaxyProps).not.toMatch(/\bgame=|onRestore|onImport|onOverwrite/);
    expect(campaignProps).not.toMatch(/\bgame=|onSelectTask/);
    expect(nativeGalaxy).not.toMatch(/exportGame|inspectSave|downloadCloudSave|restoreCloudSaveRevision|uploadCloudSave/);
    expect(nativeGalaxy).not.toMatch(/>\s*(?:恢复|导入|覆盖)[^<]*<\/button>/);
  });

  it("does not derive account writes from the renderer shell under Rust ownership", () => {
    expect(app).toMatch(/const syncAccount = \(\) => \{[\s\S]*?if \(nativePlayerAuthorityOwnsRuntimeRef\.current\) return;[\s\S]*?recordAccountProgress/);
    expect(app).toMatch(/const createGalaxyAccount[\s\S]*?nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?createLocalAccount\(accountStateRef\.current, displayName\)/);
    expect(app).toMatch(/const switchGalaxyAccount[\s\S]*?nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?switchLocalAccount\(current, accountId\)/);
  });
});
