/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge, DesktopNativePerformancePolicyStatus } from "../desktop";
import { AppLocaleProvider } from "../i18n/locale";
import {
  nativePerformancePolicyCopy,
  WindowsNativePerformancePolicySetting,
} from "./WindowsNativePerformancePolicySetting";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const balancedStatus: DesktopNativePerformancePolicyStatus = {
  schemaVersion: 1,
  requestedPolicy: { mode: "balanced" },
  effectivePolicy: { mode: "balanced", threadSetting: "auto" },
  logicalCpuCount: 12,
  restartRequired: false,
  configurationState: "loaded",
};

function installPolicyBridge(
  getNativePerformancePolicy: DesktopBridge["getNativePerformancePolicy"],
  setNativePerformancePolicy: DesktopBridge["setNativePerformancePolicy"],
) {
  Object.defineProperty(window, "dspDesktop", {
    configurable: true,
    value: {
      getReleaseInfo: vi.fn(async () => ({
        isDesktop: true as const,
        platform: "win32",
        channel: "beta" as const,
        channelLabel: "Beta",
        version: "test",
        update: { state: "development" as const, message: "test", channel: "beta" as const },
      })),
      getNativePerformancePolicy,
      setNativePerformancePolicy,
    } as Partial<DesktopBridge> as DesktopBridge,
  });
}

describe("WindowsNativePerformancePolicySetting", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    Reflect.deleteProperty(window, "dspDesktop");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Reflect.deleteProperty(window, "dspDesktop");
  });

  async function renderSetting() {
    await act(async () => {
      root.render(<AppLocaleProvider><WindowsNativePerformancePolicySetting /></AppLocaleProvider>);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
  }

  it("is completely absent and performs no bridge call outside the Windows desktop bridge", async () => {
    await renderSetting();
    expect(host.textContent).toBe("");
  });

  it("stays absent on non-Windows desktop bridges without reading or saving a policy", async () => {
    const getPolicy = vi.fn(async () => balancedStatus);
    const setPolicy = vi.fn(async () => balancedStatus);
    Object.defineProperty(window, "dspDesktop", {
      configurable: true,
      value: {
        getReleaseInfo: vi.fn(async () => ({ platform: "linux" })),
        getNativePerformancePolicy: getPolicy,
        setNativePerformancePolicy: setPolicy,
      },
    });
    await renderSetting();
    expect(host.textContent).toBe("");
    expect(getPolicy).not.toHaveBeenCalled();
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it("shows every policy choice, actual host state, logical CPUs and damaged-config fallback", async () => {
    const getPolicy = vi.fn(async () => ({
      ...balancedStatus,
      requestedPolicy: { mode: "performance" as const },
      configurationState: "invalid" as const,
    }));
    installPolicyBridge(getPolicy, vi.fn());
    await renderSetting();

    expect(getPolicy).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Windows 原生核心线程策略");
    for (const label of ["安静", "平衡", "性能", "自定义"]) expect(host.textContent).toContain(label);
    expect(host.textContent).toContain("可用逻辑 CPU12");
    expect(host.querySelector("[data-effective-thread-setting='auto']")?.textContent).toContain("auto");
    expect(host.textContent).toContain("配置损坏 · 已安全回退");
    expect(host.querySelector("[role='alert']")?.textContent).toContain("安全回退到“平衡 / auto”");
  });

  it("saves custom 8 threads while keeping the current host effective state until restart", async () => {
    const setPolicy = vi.fn(async () => ({
      ...balancedStatus,
      requestedPolicy: { mode: "custom" as const, customThreads: 8 as const },
      restartRequired: true,
      configurationState: "saved" as const,
    }));
    installPolicyBridge(vi.fn(async () => balancedStatus), setPolicy);
    await renderSetting();

    act(() => (host.querySelector("[data-policy-mode='custom']") as HTMLButtonElement).click());
    for (const threadSetting of ["auto", "1", "2", "4", "8"]) {
      expect(host.querySelector(`[data-policy-threads='${threadSetting}']`)).toBeTruthy();
    }
    act(() => (host.querySelector("[data-policy-threads='8']") as HTMLButtonElement).click());
    await act(async () => {
      (host.querySelector(".settings-native-policy-save") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    expect(setPolicy).toHaveBeenCalledWith({ mode: "custom", customThreads: 8 });
    expect(host.querySelector("[data-effective-thread-setting='auto']")?.textContent).toContain("auto");
    expect(host.textContent).toContain("下次完整重启应用生效");
    expect(host.textContent).toContain("当前原生服务不会重启");
    expect(host.textContent).toContain("不会回档");
  });

  it("keeps the displayed actual policy unchanged when persistence fails", async () => {
    const setPolicy = vi.fn(async () => { throw new Error("permission denied"); });
    installPolicyBridge(vi.fn(async () => balancedStatus), setPolicy);
    await renderSetting();

    act(() => (host.querySelector("[data-policy-mode='performance']") as HTMLButtonElement).click());
    await act(async () => {
      (host.querySelector(".settings-native-policy-save") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    expect(setPolicy).toHaveBeenCalledWith({ mode: "performance" });
    expect(host.querySelector("[data-effective-thread-setting='auto']")?.textContent).toContain("auto");
    expect(host.querySelector("[role='alert']")?.textContent).toContain("permission denied");
    expect(host.textContent).toContain("请求策略平衡");
  });

  it("ships equivalent English copy for the desktop-only panel", () => {
    const copy = nativePerformancePolicyCopy("en");
    expect(copy.modes).toEqual({ quiet: "Quiet", balanced: "Balanced", performance: "Performance", custom: "Custom" });
    expect(copy.restart).toContain("next full app restart");
    expect(copy.restart).toContain("will not roll back");
  });
});
