/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIB_BYTES, cloudSaveCapacityDetails } from "../game/cloudSaveCapacity";
import { cloudSyncStatusFromUpload, writeCloudSyncStatus } from "../game/cloudSyncStatus";
import { CloudSaveStatusCenter } from "./CloudSaveStatusCenter";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cloud = {
  mode: "normal" as const,
  slot: "main" as const,
  revision: 9,
  updatedAt: 1_800_000_000_000,
  size: 97 * MIB_BYTES,
  checksum: "a".repeat(64),
  summary: null,
};

describe("CloudSaveStatusCenter", () => {
  let host: HTMLDivElement;
  let root: Root;
  const writeText = vi.fn(async (_value: string) => undefined);

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the scoped revision, last success, and readable oversized-save diagnostics", () => {
    const sizes = cloudSaveCapacityDetails(257 * MIB_BYTES, 5 * MIB_BYTES);
    writeCloudSyncStatus(cloudSyncStatusFromUpload("normal", "main", "failed", {
      cloud,
      localRevision: 12,
      lastSuccessfulSyncAt: 1_799_999_000_000,
      message: "解压后的正文超过单修订上限；旧云修订保持不变",
      errorCode: "SAVE_SIZE_TOO_LARGE",
      sizes,
    }));

    act(() => root.render(<CloudSaveStatusCenter
      userId="synthetic-user"
      mode="normal"
      slot="main"
      cloud={cloud}
      comparison="local-newer"
      onRetry={() => undefined}
      onExportLocal={() => undefined}
      onExportCloud={() => undefined}
    />));

    expect(host.textContent).toContain("普通模式 · 主存档");
    expect(host.textContent).toContain("同步失败");
    expect(host.textContent).toContain("本地修订12");
    expect(host.textContent).toContain("云端修订9");
    expect(host.textContent).not.toContain("尚未同步");
    expect(host.textContent).toContain("原始 257.00 MiB");
    expect(host.textContent).toContain("压缩 5.00 MiB");
    expect(host.textContent).toContain("超出 1.00 MiB");
    expect(host.textContent).toContain("gzip：可用");
    expect(host.textContent).toContain("分块上传：未启用");
    expect(host.textContent).toContain("存档瘦身：需要");
    expect(host.textContent).toContain("安全重试");
    expect(host.textContent).toContain("导出本地副本");
    expect(host.textContent).toContain("导出云端副本");
  });

  it("copies only redacted diagnostics for the selected mode and slot", async () => {
    const sizes = cloudSaveCapacityDetails(40 * MIB_BYTES, 4 * MIB_BYTES);
    act(() => root.render(<CloudSaveStatusCenter
      userId="private-account-id"
      mode="speedrun"
      slot="2"
      localRevision={3}
      cloud={null}
      comparison="conflict"
      errorCode="NETWORK_INTERRUPTED"
      capacity={sizes}
    />));
    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("复制脱敏诊断"));
    await act(async () => button?.click());
    expect(writeText).toHaveBeenCalledOnce();
    const copied = String(writeText.mock.calls[0][0]);
    expect(copied).toContain("模式: speedrun");
    expect(copied).toContain("槽位: 2");
    expect(copied).toContain("错误码: NETWORK_INTERRUPTED");
    expect(copied).not.toContain("private-account-id");
    expect(copied).not.toMatch(/payload|authorization|bearer|token|username|password/i);
  });

  it("offers a safe cancel action only while an upload is active", () => {
    const cancel = vi.fn();
    act(() => root.render(<CloudSaveStatusCenter
      userId="synthetic-user"
      mode="normal"
      slot="main"
      cloud={cloud}
      comparison="local-newer"
      active
      onCancel={cancel}
    />));
    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("取消"));
    expect(button).toBeTruthy();
    act(() => button?.click());
    expect(cancel).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("安全重试");
  });
});
