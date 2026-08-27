// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "../desktop";
import { beginWindowsNativeSave } from "./nativeSave";

function bridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    isDesktop: true,
    setFontScale: vi.fn(),
    getReleaseInfo: vi.fn(),
    getNativePerformanceStatus: vi.fn(async () => ({
      available: true,
      state: "ready",
      message: "ready",
      nativeFormatVersion: 1,
      capabilities: ["native-save-v1"],
    })),
    beginNativeSave: vi.fn(async () => ({ transactionId: "tx-1" })),
    writeNativeSave: vi.fn(async () => ({ acceptedRecords: 1 })),
    commitNativeSave: vi.fn(async () => ({
      slot: "normal-main",
      generation: 1,
      revision: 7,
      rootHash: "a".repeat(64),
      recordCount: 1,
      changedRecords: 1,
      changedBytes: 2,
      totalUncompressedBytes: 2,
    })),
    abortNativeSave: vi.fn(async () => ({ aborted: true })),
    recoverNativeSave: vi.fn(),
    readNativeSave: vi.fn(),
    appendNativeWal: vi.fn(),
    compactNativeSave: vi.fn(),
    requestApi: vi.fn(),
    requestApiTransfer: vi.fn(),
    cancelApiRequest: vi.fn(),
    downloadAccountArchive: vi.fn(),
    cancelAccountArchiveDownload: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(),
    confirmUpdateReady: vi.fn(),
    onPrepareForUpdate: vi.fn(),
    onUpdateStatus: vi.fn(),
    ...overrides,
  } as DesktopBridge;
}

afterEach(() => {
  Reflect.deleteProperty(window, "dspDesktop");
});

describe("Windows native save transaction", () => {
  it("is absent on Web/Android fallback", async () => {
    expect(await beginWindowsNativeSave({
      slot: "normal-main",
      mode: "normal",
      stateVersion: 47,
      baseChecksum: "01234567",
      registryFingerprint: "01234567",
      revision: 7,
      savedAtMs: 1,
    })).toBeNull();
  });

  it("streams bounded records and verifies the committed revision", async () => {
    const desktop = bridge();
    Object.defineProperty(window, "dspDesktop", { configurable: true, value: desktop });
    const transaction = await beginWindowsNativeSave({
      slot: "normal-main",
      mode: "normal",
      stateVersion: 47,
      baseChecksum: "01234567",
      registryFingerprint: "01234567",
      revision: 7,
      savedAtMs: 1,
    });
    expect(transaction).not.toBeNull();
    await transaction!.write([{ key: "base", value: "{}" }]);
    expect((await transaction!.commit()).revision).toBe(7);
    expect(desktop.writeNativeSave).toHaveBeenCalledWith({ transactionId: "tx-1", records: [{ key: "base", value: "{}" }] });
  });

  it("surfaces deferred WAL maintenance without rejecting the durable checkpoint", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const desktop = bridge({
      commitNativeSave: vi.fn(async () => ({
        slot: "normal-main",
        generation: 2,
        revision: 7,
        rootHash: "b".repeat(64),
        recordCount: 1,
        changedRecords: 1,
        changedBytes: 2,
        totalUncompressedBytes: 2,
        walMaintenancePending: true,
        walBytes: 4096,
      })),
    });
    Object.defineProperty(window, "dspDesktop", { configurable: true, value: desktop });
    const transaction = await beginWindowsNativeSave({
      slot: "normal-main",
      mode: "normal",
      stateVersion: 47,
      baseChecksum: "01234567",
      registryFingerprint: "01234567",
      revision: 7,
      savedAtMs: 1,
    });

    const committed = await transaction!.commit();
    expect(committed.walMaintenancePending).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("4096 bytes"));
    warning.mockRestore();
  });

  it("fails closed when the native service is unavailable", async () => {
    Object.defineProperty(window, "dspDesktop", {
      configurable: true,
      value: bridge({
        getNativePerformanceStatus: vi.fn(async () => ({ available: false, state: "unavailable" as const, message: "host missing", capabilities: [] })),
      }),
    });
    await expect(beginWindowsNativeSave({
      slot: "normal-main",
      mode: "normal",
      stateVersion: 47,
      baseChecksum: "01234567",
      registryFingerprint: "01234567",
      revision: 7,
      savedAtMs: 1,
    })).rejects.toThrow("host missing");
  });
});
