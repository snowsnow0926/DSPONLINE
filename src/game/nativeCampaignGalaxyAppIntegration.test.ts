import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("native Campaign and Galaxy App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const nativeCampaign = readFileSync(resolve("src/components/NativeCampaignWorkspace.tsx"), "utf8");
  const nativeGalaxy = readFileSync(resolve("src/components/NativeGalaxyWorkspace.tsx"), "utf8");

  it("keeps both routes reachable and mounts exactly one authority-specific workspace", () => {
    expect(app).not.toMatch(/workspace === "campaign" && rejectLegacyFactoryInteractionWhileNative/);
    expect(app).not.toMatch(/workspace === "galaxy" && rejectLegacyFactoryInteractionWhileNative/);
    expect(app).not.toMatch(/const openCampaign[\s\S]{0,180}rejectLegacyFactoryInteractionWhileNative/);
    expect(app).toMatch(/galaxyOpen \? nativePlayerAuthorityOwnsRuntime \? \([\s\S]*?<NativeGalaxyWorkspace[\s\S]*?\) : \([\s\S]*?<GalaxyWorkspace/);
    expect(app).toMatch(/campaignOpen \? nativePlayerAuthorityOwnsRuntime \? \([\s\S]*?<NativeCampaignWorkspace[\s\S]*?\) : \([\s\S]*?<CampaignWorkspace/);
  });

  it("never passes GameState or primary-save callbacks into the native pages", () => {
    const galaxyStart = app.lastIndexOf("<NativeGalaxyWorkspace");
    const galaxyEnd = app.indexOf("/>", galaxyStart);
    const campaignStart = app.lastIndexOf("<NativeCampaignWorkspace");
    const campaignEnd = app.indexOf("/>", campaignStart);
    const galaxyProps = app.slice(galaxyStart, galaxyEnd);
    const campaignProps = app.slice(campaignStart, campaignEnd);
    expect(galaxyProps).not.toMatch(/\bgame=|onRestore|onImport|onOverwrite/);
    expect(campaignProps).not.toMatch(/\bgame=|onSelectTask/);
    expect(galaxyProps).toMatch(/frame=\{nativeGalaxyWorkspaceFrame\}[\s\S]*?latestIdentity=\{nativeCampaignGalaxyIdentity\}[\s\S]*?status=\{nativeGalaxyWorkspaceReadStatus\}/);
    expect(campaignProps).toMatch(/frame=\{nativeCampaignWorkspaceFrame\}[\s\S]*?latestIdentity=\{nativeCampaignGalaxyIdentity\}[\s\S]*?status=\{nativeCampaignWorkspaceReadStatus\}/);
    expect(nativeGalaxy).not.toMatch(/exportGame|inspectSave|downloadCloudSave|restoreCloudSaveRevision|uploadCloudSave/);
    expect(nativeGalaxy).not.toMatch(/>\s*(?:恢复|导入|覆盖)[^<]*<\/button>/);
  });

  it("keeps both pages on a settled external store instead of component-owned IPC reads", () => {
    expect(app).toMatch(/selectNativeCampaignGalaxyWorkspaceAuthorityFrames\([\s\S]*?nativePlayerAuthorityClockSnapshot[\s\S]*?nativePlayerAuthoritySessionId/);
    expect(app).toMatch(/if \(!campaignOpen[\s\S]*?nativeCampaignWorkspaceStore\.close\(\)[\s\S]*?nativeCampaignWorkspaceStore\.refresh/);
    expect(app).toMatch(/if \(!galaxyOpen[\s\S]*?nativeGalaxyWorkspaceStore\.close\(\)[\s\S]*?nativeGalaxyWorkspaceStore\.refresh/);
    expect(nativeCampaign).not.toMatch(/fetchProjection|currentIdentityRef|useRef/);
    expect(nativeGalaxy).not.toMatch(/fetchProjection|currentIdentityRef|useRef/);
    expect(app).toMatch(/key=\{nativeCampaignGalaxyIdentity[\s\S]*?sessionId[\s\S]*?runId[\s\S]*?registryFingerprint/);
  });

  it("does not derive account writes from the renderer shell under Rust ownership", () => {
    expect(app).toMatch(/const syncAccount = \(\) => \{[\s\S]*?if \(nativePlayerAuthorityOwnsRuntimeRef\.current\) return;[\s\S]*?recordAccountProgress/);
    expect(app).toMatch(/const createGalaxyAccount[\s\S]*?nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?createLocalAccount\(accountStateRef\.current, displayName\)/);
    expect(app).toMatch(/const switchGalaxyAccount[\s\S]*?nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?switchLocalAccount\(current, accountId\)/);
  });

  it("fences native cloud binding writes to the local account that started the request", () => {
    expect(app).toMatch(/const updateNativeGalaxyCloudBinding[\s\S]*?current\.activeAccountId !== expectedAccountId\) return false;[\s\S]*?setActiveCloudBinding\(current, cloud\)[\s\S]*?return true;/);
    expect(app).toMatch(/<NativeGalaxyWorkspace[\s\S]*?onUpdateCloudBinding=\{updateNativeGalaxyCloudBinding\}/);
    expect(nativeGalaxy).toMatch(/const submitLogin[\s\S]*?const expectedAccountId = account\.profile\.id;[\s\S]*?await loginCloudAccount[\s\S]*?onUpdateCloudBinding\(expectedAccountId,/);
    expect(nativeGalaxy).toMatch(/const submitLogout[\s\S]*?const expectedAccountId = account\.profile\.id;[\s\S]*?await logoutCloudAccount\(\);[\s\S]*?onUpdateCloudBinding\(expectedAccountId, null\)/);
  });
});
