// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecoveryDataExportInput } from "../game/recoveryDataExport";
import { RecoveryDataExportButton } from "./RecoveryDataExportButton";

const { exportRecoveryData } = vi.hoisted(() => ({ exportRecoveryData: vi.fn() }));
vi.mock("../game/recoveryDataExport", () => ({ exportRecoveryData }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("RecoveryDataExportButton", () => {
  let host: HTMLDivElement;
  let root: Root;
  const props = {
    checkpointState: { version: 47, mode: "normal" },
    recovery: null,
    recoveryStatus: "保存失败，停止失败，Worker 不可用",
  } as RecoveryDataExportInput;
  beforeEach(() => {
    exportRecoveryData.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("exports independently despite failed save/stop status and only disables its own duplicate request", async () => {
    let finish!: (result: { destination: "browser"; partial: boolean }) => void;
    exportRecoveryData.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    act(() => root.render(<RecoveryDataExportButton {...props} />));
    const button = host.querySelector("button")!;
    expect(button.disabled).toBe(false);
    expect(host.textContent).toContain("诊断包不代表已结算结果");
    await act(async () => { button.click(); await vi.dynamicImportSettled(); });
    expect(exportRecoveryData).toHaveBeenCalledExactlyOnceWith(props);
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(exportRecoveryData).toHaveBeenCalledOnce();
    await act(async () => finish({ destination: "browser", partial: true }));
    expect(button.disabled).toBe(false);
    expect(host.textContent).toContain("部分本地日志无法读取，包内已注明");
  });

  it("keeps retry available and does not display private plugin/storage error contents", async () => {
    exportRecoveryData.mockRejectedValueOnce(new Error("private-save-payload-do-not-display"));
    act(() => root.render(<RecoveryDataExportButton {...props} />));
    const button = host.querySelector("button")!;
    await act(async () => { button.click(); await vi.dynamicImportSettled(); });
    expect(button.disabled).toBe(false);
    expect(host.textContent).toContain("原存档与恢复日志未改变");
    expect(host.textContent).not.toContain("private-save-payload");
    exportRecoveryData.mockResolvedValueOnce({ destination: "native", partial: false });
    await act(async () => { button.click(); await vi.dynamicImportSettled(); });
    expect(exportRecoveryData).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("已打开系统保存或分享面板");
  });
});
