/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopNativeCoreCampaignWorkspaceProjectionRequest,
  DesktopNativeCoreCampaignWorkspaceProjectionResult,
  DesktopNativeCoreGalaxyAccountWorkspaceProjectionRequest,
  DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult,
} from "../desktop";
import { CAMPAIGN_CHAPTERS, CAMPAIGN_TASKS } from "../game/campaign";
import type { AccountState } from "../game/account";
import type { CloudSession } from "../game/cloud";
import { NativeCampaignWorkspace } from "./NativeCampaignWorkspace";
import { NativeGalaxyWorkspace } from "./NativeGalaxyWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cloudMocks = vi.hoisted(() => ({
  loginCloudAccount: vi.fn(),
  logoutCloudAccount: vi.fn(),
  resumeCloudSession: vi.fn(),
}));

vi.mock("../game/cloud", async (importOriginal) => ({
  ...await importOriginal<typeof import("../game/cloud")>(),
  ...cloudMocks,
}));

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

const secondAccountState: AccountState = {
  ...accountState,
  activeAccountId: "acct_test_b",
  accounts: {
    ...accountState.accounts,
    acct_test_b: {
      profile: { id: "acct_test_b", displayName: "第二工程师", avatar: "B", privacy: "private", createdAt: 2, updatedAt: 2, cloudUserId: null, cloudEmail: null, cloudBoundAt: null },
      ledger: { ...accountState.accounts.acct_test_a.ledger },
    },
  },
};

const cloudUser = {
  id: "user_CloudRace",
  username: "cloud-race",
  email: "cloud-race@example.com",
  displayName: "云端工程师",
  createdAt: 1,
  emailVerified: true,
  emailVerifiedAt: 1,
  passwordChangedAt: 1,
  leaderboardVisible: true,
};

function authenticatedCloudSession(): CloudSession {
  return {
    status: "authenticated",
    user: cloudUser,
    cloudSave: null,
    mode: "normal",
    mailAvailable: false,
    message: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("HTML input setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("native Campaign and Galaxy thin workspaces", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    cloudMocks.loginCloudAccount.mockReset();
    cloudMocks.logoutCloudAccount.mockReset();
    cloudMocks.resumeCloudSession.mockReset();
    cloudMocks.resumeCloudSession.mockResolvedValue({ status: "anonymous", user: null, cloudSave: null, mode: "normal", mailAvailable: false, message: null });
    cloudMocks.logoutCloudAccount.mockResolvedValue(undefined);
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

  it("keeps the same focused campaign control mounted across a pending same-lineage revision", async () => {
    const pending = deferred<DesktopNativeCoreCampaignWorkspaceProjectionResult>();
    const fetchProjection = vi.fn((request: DesktopNativeCoreCampaignWorkspaceProjectionRequest) => request.expectedRevision === 13
      ? pending.promise
      : Promise.resolve(campaignProjection()));
    await act(async () => {
      root.render(<NativeCampaignWorkspace open identity={identity} fetchProjection={fetchProjection} onClose={() => undefined} onNavigate={() => undefined} />);
      await Promise.resolve();
    });
    const locate = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("定位目标"))!;
    locate.focus();
    const nextIdentity = { ...identity, expectedRevision: 13 };
    await act(async () => {
      root.render(<NativeCampaignWorkspace open identity={nextIdentity} fetchProjection={fetchProjection} onClose={() => undefined} onNavigate={() => undefined} />);
      await Promise.resolve();
    });
    expect([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("定位目标"))).toBe(locate);
    expect(document.activeElement).toBe(locate);
    expect(host.textContent).toContain("当前保持显示已验证的 revision 12");

    await act(async () => pending.resolve({ ...campaignProjection(), revision: 13 }));
    expect([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("定位目标"))).toBe(locate);
    expect(document.activeElement).toBe(locate);
    expect(host.textContent).toContain("REV 13");
  });

  it("renders Rust game summary beside account-only controls and no main-save action", async () => {
    await act(async () => {
      root.render(<NativeGalaxyWorkspace open accountState={accountState} identity={identity} fetchProjection={async () => galaxyProjection()} onClose={() => undefined} onUpdateProfile={() => undefined} onUpdateCloudBinding={() => true} onCreateAccount={() => undefined} onSwitchAccount={() => undefined} />);
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
      root.render(<NativeGalaxyWorkspace open accountState={accountState} identity={identity} fetchProjection={async () => ({ ...galaxyProjection(), revision: 11 })} onClose={() => undefined} onUpdateProfile={() => undefined} onUpdateCloudBinding={() => true} onCreateAccount={() => undefined} onSwitchAccount={() => undefined} />);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("安全关闭");
    expect(host.textContent).not.toContain("测试工程师");
  });

  it("removes previously valid Galaxy account controls synchronously across a run replacement", async () => {
    await act(async () => {
      root.render(<NativeGalaxyWorkspace open accountState={accountState} identity={identity} fetchProjection={async () => galaxyProjection()} onClose={() => undefined} onUpdateProfile={() => undefined} onUpdateCloudBinding={() => true} onCreateAccount={() => undefined} onSwitchAccount={() => undefined} />);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("测试工程师");
    const driftedIdentity = { ...identity, runId: "run-replaced" };
    await act(async () => {
      root.render(<NativeGalaxyWorkspace open accountState={accountState} identity={driftedIdentity} fetchProjection={() => new Promise(() => undefined)} onClose={() => undefined} onUpdateProfile={() => undefined} onUpdateCloudBinding={() => true} onCreateAccount={() => undefined} onSwitchAccount={() => undefined} />);
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("测试工程师");
  });

  it("preserves the focused account draft while a newer same-lineage Galaxy projection is pending", async () => {
    const pending = deferred<DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult>();
    const fetchProjection = vi.fn((request: DesktopNativeCoreGalaxyAccountWorkspaceProjectionRequest) => request.expectedRevision === 13
      ? pending.promise
      : Promise.resolve(galaxyProjection()));
    const render = (currentIdentity: DesktopNativeCoreGalaxyAccountWorkspaceProjectionRequest) => root.render(<NativeGalaxyWorkspace
      open focusTab="account" accountState={accountState} identity={currentIdentity} fetchProjection={fetchProjection}
      onClose={() => undefined} onUpdateProfile={() => undefined} onUpdateCloudBinding={() => true}
      onCreateAccount={() => undefined} onSwitchAccount={() => undefined}
    />);
    await act(async () => { render(identity); await Promise.resolve(); });
    const draft = host.querySelector<HTMLInputElement>(".galaxy-name-field input")!;
    draft.focus();
    await act(async () => setInputValue(draft, "未提交的名字"));

    const nextIdentity = { ...identity, expectedRevision: 13 };
    await act(async () => { render(nextIdentity); await Promise.resolve(); });
    expect(host.querySelector<HTMLInputElement>(".galaxy-name-field input")).toBe(draft);
    expect(document.activeElement).toBe(draft);
    expect(draft.value).toBe("未提交的名字");
    expect(host.textContent).toContain("当前保持显示已验证的 revision 12");

    await act(async () => pending.resolve({ ...galaxyProjection(), revision: 13 }));
    expect(host.querySelector<HTMLInputElement>(".galaxy-name-field input")).toBe(draft);
    expect(document.activeElement).toBe(draft);
    expect(draft.value).toBe("未提交的名字");
    expect(host.textContent).toContain("REV 13");
  });

  it("keeps a completed cloud login session but refuses to bind a newly active local account", async () => {
    const pendingLogin = deferred<CloudSession>();
    cloudMocks.loginCloudAccount.mockReturnValue(pendingLogin.promise);
    let activeAccountId = accountState.activeAccountId;
    const onUpdateCloudBinding = vi.fn((expectedAccountId: string) => expectedAccountId === activeAccountId);
    const fetchProjection = async () => galaxyProjection();
    const render = (state: AccountState) => root.render(
      <NativeGalaxyWorkspace
        open
        focusTab="cloud"
        accountState={state}
        identity={identity}
        fetchProjection={fetchProjection}
        onClose={() => undefined}
        onUpdateProfile={() => undefined}
        onUpdateCloudBinding={onUpdateCloudBinding}
        onCreateAccount={() => undefined}
        onSwitchAccount={() => undefined}
      />,
    );
    await act(async () => {
      render(accountState);
      await Promise.resolve();
      await Promise.resolve();
    });
    const identifier = host.querySelector<HTMLInputElement>('input[autocomplete="username"]')!;
    const password = host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
    await act(async () => {
      setInputValue(identifier, "cloud-race");
      setInputValue(password, "secret");
    });
    const login = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("登录并绑定"))!;
    act(() => login.click());
    expect(cloudMocks.loginCloudAccount).toHaveBeenCalledWith("cloud-race", "secret");

    activeAccountId = secondAccountState.activeAccountId;
    await act(async () => {
      render(secondAccountState);
      pendingLogin.resolve(authenticatedCloudSession());
      await pendingLogin.promise;
      await Promise.resolve();
    });
    expect(onUpdateCloudBinding).toHaveBeenCalledWith(accountState.activeAccountId, {
      id: cloudUser.id,
      email: cloudUser.email,
    });
    expect(onUpdateCloudBinding).not.toHaveBeenCalledWith(secondAccountState.activeAccountId, expect.anything());
    expect(host.textContent).toContain("本地身份在请求期间切换");
    expect(host.textContent).toContain("云会话已登录，但未绑定当前本地身份");
  });

  it("keeps logout global but refuses to clear the newly active local account binding", async () => {
    const pendingLogout = deferred<void>();
    cloudMocks.resumeCloudSession.mockResolvedValue(authenticatedCloudSession());
    cloudMocks.logoutCloudAccount.mockReturnValue(pendingLogout.promise);
    const boundAccountState: AccountState = {
      ...accountState,
      accounts: {
        ...accountState.accounts,
        acct_test_a: {
          ...accountState.accounts.acct_test_a,
          profile: {
            ...accountState.accounts.acct_test_a.profile,
            cloudUserId: cloudUser.id,
            cloudEmail: cloudUser.email,
            cloudBoundAt: 1,
          },
        },
      },
    };
    let activeAccountId = boundAccountState.activeAccountId;
    const onUpdateCloudBinding = vi.fn((expectedAccountId: string) => expectedAccountId === activeAccountId);
    const fetchProjection = async () => galaxyProjection();
    const render = (state: AccountState) => root.render(
      <NativeGalaxyWorkspace
        open
        focusTab="cloud"
        accountState={state}
        identity={identity}
        fetchProjection={fetchProjection}
        onClose={() => undefined}
        onUpdateProfile={() => undefined}
        onUpdateCloudBinding={onUpdateCloudBinding}
        onCreateAccount={() => undefined}
        onSwitchAccount={() => undefined}
      />,
    );
    await act(async () => {
      render(boundAccountState);
      await Promise.resolve();
      await Promise.resolve();
    });
    const logout = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("退出并解绑"))!;
    act(() => logout.click());
    expect(cloudMocks.logoutCloudAccount).toHaveBeenCalledTimes(1);

    activeAccountId = secondAccountState.activeAccountId;
    await act(async () => {
      render(secondAccountState);
      pendingLogout.resolve();
      await pendingLogout.promise;
      await Promise.resolve();
    });
    expect(onUpdateCloudBinding).toHaveBeenCalledWith(boundAccountState.activeAccountId, null);
    expect(onUpdateCloudBinding).not.toHaveBeenCalledWith(secondAccountState.activeAccountId, null);
    expect(host.textContent).toContain("云账号已退出，但本地身份在请求期间切换");
  });
});
