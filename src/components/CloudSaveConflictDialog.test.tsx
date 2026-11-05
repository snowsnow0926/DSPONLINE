/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSaveConflictDialog } from "./CloudSaveConflictDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CloudSaveConflictDialog", () => {
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

  it("allows both conflict sides to be exported before choosing a winner", () => {
    const exportLocal = vi.fn();
    const exportCloud = vi.fn();
    act(() => root.render(<CloudSaveConflictDialog
      local={{ stateVersion: 46, mode: "normal", savedAt: 1, elapsedSeconds: 20, completedTechCount: 1, entityCount: 2, structurePoints: 3, activePlanetId: "home", uploadedWhiteMatrix: 0, stateChecksum: "local" }}
      cloud={{ mode: "normal", slot: "main", revision: 7, updatedAt: 2, size: 100, checksum: "cloud", summary: null }}
      slot="main"
      onUseCloud={() => undefined}
      onKeepLocal={() => undefined}
      onExportLocal={exportLocal}
      onExportCloud={exportCloud}
      onCancel={() => undefined}
    />));
    const buttons = [...document.body.querySelectorAll("button")];
    act(() => buttons.find((button) => button.textContent?.includes("导出本地副本"))?.click());
    act(() => buttons.find((button) => button.textContent?.includes("导出云端副本"))?.click());
    expect(exportLocal).toHaveBeenCalledOnce();
    expect(exportCloud).toHaveBeenCalledOnce();
  });

  it("announces a failed restore inside the active conflict and retains recovery actions", () => {
    const retry = vi.fn();
    const exportLocal = vi.fn();
    const exportCloud = vi.fn();
    act(() => root.render(<CloudSaveConflictDialog
      local={null}
      cloud={{ mode: "normal", slot: "1", revision: 7, updatedAt: 2, size: 100, checksum: "cloud", summary: null }}
      slot="1"
      feedback="当前浏览器无法保存到本机，云存档尚未恢复到本机。"
      onUseCloud={retry}
      onKeepLocal={() => undefined}
      onExportLocal={exportLocal}
      onExportCloud={exportCloud}
      onCancel={() => undefined}
    />));
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog.querySelector('[role="status"]')?.textContent).toContain("尚未恢复到本机");
    const buttons = [...dialog.querySelectorAll("button")];
    for (const label of ["使用云端版本", "导出本地副本", "导出云端副本"]) {
      const button = buttons.find((candidate) => candidate.textContent?.includes(label))!;
      expect(button.disabled).toBe(false);
      act(() => button.click());
    }
    expect(retry).toHaveBeenCalledOnce();
    expect(exportLocal).toHaveBeenCalledOnce();
    expect(exportCloud).toHaveBeenCalledOnce();
  });
});
