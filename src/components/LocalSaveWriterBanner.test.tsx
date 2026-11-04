/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ backend: "memory", role: "primary", locale: "zh-CN" }));
vi.mock("../i18n/locale", () => ({ useAppLocale: () => ({ locale: fixture.locale }) }));
vi.mock("./GameDialogProvider", () => ({ useGameDialog: () => ({ confirm: vi.fn() }) }));
vi.mock("../game/localSaveTakeover", () => ({ requestCurrentTabTakeover: vi.fn() }));
vi.mock("../game/localSaveStore", () => {
  const status = () => ({ role: fixture.role, writerId: "fixture-writer", fencingToken: 1, leaseExpiresAt: 123, reason: "fixture" });
  return {
    getLocalSaveBackend: () => fixture.backend,
    getLocalSaveWriterStatus: status,
    subscribeLocalSaveWriterStatus: (listener: (value: ReturnType<typeof status>) => void) => { listener(status()); return () => undefined; },
    getLocalSaveConflicts: async () => [],
    resolveLocalSaveConflictDetailed: vi.fn(),
  };
});
import { LocalSaveWriterBanner } from "./LocalSaveWriterBanner";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("local save storage feedback", () => {
  let host: HTMLDivElement; let root: Root;
  beforeEach(() => {
    vi.stubGlobal("__APP_PLATFORM__", "web");
    fixture.backend = "memory"; fixture.role = "primary"; fixture.locale = "zh-CN";
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const render = () => act(async () => { root.render(<LocalSaveWriterBanner />); });

  it("warns about a temporary primary without offering a destructive reload or takeover", async () => {
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("当前为临时运行");
    expect(host.textContent).toContain("刷新或关闭页面会丢失本次进度");
    expect(host.textContent).toContain("导出当前进度");
    expect(host.querySelector("button")).toBeNull();
  });
  it("explains temporary progress in English", async () => {
    fixture.locale = "en"; await render();
    expect(host.textContent).toContain("This session is temporary");
    expect(host.textContent).toContain("cannot save locally");
  });
  it.each(["indexeddb", "local-storage"])("keeps a healthy %s primary free of temporary warnings", async (backend) => {
    fixture.backend = backend; await render(); expect(host.firstChild).toBeNull();
  });
  it("does not flash a warning before initialization finishes", async () => {
    fixture.role = "initializing"; await render(); expect(host.firstChild).toBeNull();
  });
  it("does not label a native primary as a temporary web session", async () => {
    vi.stubGlobal("__APP_PLATFORM__", "desktop"); await render(); expect(host.firstChild).toBeNull();
  });
  it("preserves the secondary writer's read-only and takeover feedback", async () => {
    fixture.role = "secondary"; await render();
    expect(host.textContent).toContain("本页面为只读");
    expect(host.querySelector("button")?.textContent).toContain("强制接管本页");
    expect(host.querySelector(".local-save-writer-banner--temporary")).toBeNull();
  });
  it("preserves the unavailable connection's reload feedback", async () => {
    fixture.role = "unavailable"; await render();
    expect(host.textContent).toContain("本地存档连接已更新");
    expect(host.querySelector("button")?.textContent).toContain("刷新页面");
  });
  it("keeps conflict resolution higher priority than a temporary warning", async () => {
    fixture.role = "conflict"; await render();
    expect(host.textContent).toContain("已阻止跨标签页覆盖");
    expect(host.querySelector(".local-save-writer-banner--temporary")).toBeNull();
  });
});
