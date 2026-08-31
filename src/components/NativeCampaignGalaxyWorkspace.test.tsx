/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopNativeCoreCampaignWorkspaceProjectionResult,
  DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult,
} from "../desktop";
import { CAMPAIGN_CHAPTERS, CAMPAIGN_TASKS } from "../game/campaign";
import type { AccountState } from "../game/account";
import { NativeCampaignWorkspace } from "./NativeCampaignWorkspace";
import { NativeGalaxyWorkspace } from "./NativeGalaxyWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const identity = Object.freeze({
  sessionId: "core-main",
  runId: "run-current",
  expectedRevision: 12,
  expectedRegistryFingerprint: "builtin:test",
});

function campaignProjection(): DesktopNativeCoreCampaignWorkspaceProjectionResult {
  return {
    schemaVersion: 1,
    projectionType: "campaign-workspace-v1",
    source: "native-core",
    stateVersion: 47,
    sessionId: identity.sessionId,
    runId: identity.runId,
    revision: identity.expectedRevision,
    registryFingerprint: identity.expectedRegistryFingerprint,
    truncated: false,
    limits: { chapters: 16, tasks: 64, payloadBytes: 262144 },
    counts: { chapters: CAMPAIGN_CHAPTERS.length, tasks: CAMPAIGN_TASKS.length, completedTasks: 0 },
    activeChapterId: "foundation",
    activeTaskId: "mine_first_ore",
    chapters: CAMPAIGN_CHAPTERS.map((chapter) => ({
      id: chapter.id,
      completedCount: 0,
      totalCount: chapter.taskIds.length,
      complete: false,
      tasks: chapter.taskIds.map((taskId) => {
        const definition = CAMPAIGN_TASKS.find((task) => task.id === taskId)!;
        const target = "target" in definition.metric ? definition.metric.target : 1;
        return {
          id: taskId,
          track: definition.track,
          status: taskId === "mine_first_ore" ? "active" as const : "available" as const,
          progress: { current: 0, target },
          locator: taskId === "mine_first_ore" ? { kind: "item" as const, targetId: "iron_ore" } : null,
        };
      }),
    })),
  };
}

function galaxyProjection(): DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult {
  return {
    schemaVersion: 1,
    projectionType: "galaxy-account-workspace-v1",
    source: "native-core",
    stateVersion: 47,
    sessionId: identity.sessionId,
    runId: identity.runId,
    revision: identity.expectedRevision,
    registryFingerprint: identity.expectedRegistryFingerprint,
    truncated: false,
    limits: { payloadBytes: 65536, decimalDigits: 256 },
    game: { mode: "normal", elapsedSeconds: "3600", difficulty: "standard" },
    production: { totalProduced: "1000000", universeMatrixProduced: "5", generationKw: "100", throughputPerMinute: "200" },
    progress: { campaignCompleted: 1, campaignTotal: CAMPAIGN_TASKS.length, researchCompleted: 2, exploredSystems: 1, colonizedPlanets: 1, galacticScore: "3" },
    dyson: { powerKw: "4", structurePoints: "5", rocketsLaunched: "6", sailsLaunched: "7" },
    cloudCompatibility: { gameStateVersion: 47, envelopeVersion: 2, cloudSchemaVersion: 8, exportSupported: true, restoreIntoActiveAuthority: false, importIntoActiveAuthority: false, overwriteActiveAuthority: false },
  };
}

const accountState: AccountState = {
  version: 2,
  activeAccountId: "acct_test_a",
  accounts: {
    acct_test_a: {
      profile: { id: "acct_test_a", displayName: "测试工程师", avatar: "A", privacy: "public", createdAt: 1, updatedAt: 1, cloudUserId: null, cloudEmail: null, cloudBoundAt: null },
      ledger: { energyGeneratedMj: 0, uploadedWhiteMatrix: 0, peakGenerationKw: 0, peakThroughputPerMinute: 0, peakActualThroughputPerMinute: 0, peakDysonPowerKw: 0, exploredSystems: 0, colonizedPlanets: 0, lastGameElapsedSeconds: 0, lastWhiteMatrixTotal: 0, lastSyncedAt: 0 },
    },
  },
};

describe("native Campaign and Galaxy thin workspaces", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders the complete static campaign catalog and emits only a UI locator", async () => {
    const onNavigate = vi.fn();
    await act(async () => {
      root.render(<NativeCampaignWorkspace open identity={identity} fetchProjection={async () => campaignProjection()} onClose={() => undefined} onNavigate={onNavigate} />);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("采集第一份矿石");
    expect(host.textContent).toContain(`${CAMPAIGN_TASKS.length}`);
    const locate = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("定位目标"))!;
    act(() => locate.click());
    expect(onNavigate).toHaveBeenCalledWith({ kind: "item", targetId: "iron_ore" }, "mine_first_ore");
  });

  it("fails the entire campaign page closed on truncation or same-revision old run", async () => {
    for (const projection of [
      { ...campaignProjection(), truncated: true },
      { ...campaignProjection(), runId: "run-old" },
    ]) {
      await act(async () => {
        root.render(<NativeCampaignWorkspace open identity={identity} fetchProjection={async () => projection as DesktopNativeCoreCampaignWorkspaceProjectionResult} onClose={() => undefined} onNavigate={() => undefined} />);
        await Promise.resolve();
      });
      expect(host.textContent).toContain("安全关闭");
      expect(host.textContent).not.toContain("采集第一份矿石");
    }
  });

  it("removes a previously valid campaign projection as soon as its requested lineage changes", async () => {
    await act(async () => {
      root.render(<NativeCampaignWorkspace open identity={identity} fetchProjection={async () => campaignProjection()} onClose={() => undefined} onNavigate={() => undefined} />);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("采集第一份矿石");
    const driftedIdentity = { ...identity, runId: "run-replaced" };
    await act(async () => {
      root.render(<NativeCampaignWorkspace open identity={driftedIdentity} fetchProjection={() => new Promise(() => undefined)} onClose={() => undefined} onNavigate={() => undefined} />);
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("采集第一份矿石");
  });

  it("renders Rust game summary beside account-only controls and no main-save action", async () => {
    await act(async () => {
      root.render(<NativeGalaxyWorkspace open accountState={accountState} identity={identity} fetchProjection={async () => galaxyProjection()} onClose={() => undefined} onUpdateProfile={() => undefined} onUpdateCloudBinding={() => undefined} onCreateAccount={() => undefined} onSwitchAccount={() => undefined} />);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Rust 游戏摘要");
    expect(host.textContent).toContain("1,000,000");
    const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent ?? "").join("\n");
    expect(buttons).not.toMatch(/恢复|导入|覆盖/);
    act(() => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("本地身份"))!.click());
    expect(host.textContent).toContain("测试工程师");
  });

  it("does not expose account controls when the Galaxy lineage drifts", async () => {
    await act(async () => {
      root.render(<NativeGalaxyWorkspace open accountState={accountState} identity={identity} fetchProjection={async () => ({ ...galaxyProjection(), revision: 11 })} onClose={() => undefined} onUpdateProfile={() => undefined} onUpdateCloudBinding={() => undefined} onCreateAccount={() => undefined} onSwitchAccount={() => undefined} />);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("安全关闭");
    expect(host.textContent).not.toContain("测试工程师");
  });

  it("removes previously valid Galaxy account controls synchronously across a run replacement", async () => {
    await act(async () => {
      root.render(<NativeGalaxyWorkspace open accountState={accountState} identity={identity} fetchProjection={async () => galaxyProjection()} onClose={() => undefined} onUpdateProfile={() => undefined} onUpdateCloudBinding={() => undefined} onCreateAccount={() => undefined} onSwitchAccount={() => undefined} />);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("测试工程师");
    const driftedIdentity = { ...identity, runId: "run-replaced" };
    await act(async () => {
      root.render(<NativeGalaxyWorkspace open accountState={accountState} identity={driftedIdentity} fetchProjection={() => new Promise(() => undefined)} onClose={() => undefined} onUpdateProfile={() => undefined} onUpdateCloudBinding={() => undefined} onCreateAccount={() => undefined} onSwitchAccount={() => undefined} />);
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("测试工程师");
  });
});
