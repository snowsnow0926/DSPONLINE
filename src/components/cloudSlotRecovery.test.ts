import { beforeEach, describe, expect, it, vi } from "vitest";
import { preserveCloudRestoreSlot } from "./cloudSaveRecovery";

const fixture = vi.hoisted(() => ({
  read: vi.fn(), catalog: vi.fn(), inspect: vi.fn(), snapshot: vi.fn(),
}));
vi.mock("../game/localSaveStore", () => ({ readLocalSavePayload: fixture.read, getLocalSaveCatalog: fixture.catalog }));
vi.mock("../game/storage", () => ({ inspectSave: fixture.inspect, saveGameSnapshotVerified: fixture.snapshot }));

describe("cloud manual slot recovery admission", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fixture.read.mockResolvedValue(null);
    fixture.catalog.mockReturnValue(null);
    fixture.snapshot.mockResolvedValue({ id: "verified-recovery" });
    fixture.inspect.mockReturnValue({ valid: true, state: { tray: { iron_ore: 88 } }, mode: "normal", slot: 1 });
  });

  it("allows a genuinely empty slot but requires the original record for a conflict", async () => {
    expect(await preserveCloudRestoreSlot("normal", 1)).toBe(true);
    expect(await preserveCloudRestoreSlot("normal", 1, true)).toBe(false);
    expect(fixture.snapshot).not.toHaveBeenCalled();
  });

  it("retains an occupied durable slot when its validated payload cannot be read", async () => {
    fixture.catalog.mockReturnValue({ integrity: "invalid" });
    expect(await preserveCloudRestoreSlot("normal", 1)).toBe(false);
    expect(fixture.snapshot).not.toHaveBeenCalled();
  });

  it("does not replace an invalid, wrong-mode or wrong-slot record", async () => {
    fixture.read.mockResolvedValue('{"slot":1}');
    fixture.inspect.mockReturnValueOnce({ valid: false, state: {} });
    expect(await preserveCloudRestoreSlot("normal", 1)).toBe(false);
    fixture.inspect.mockReturnValueOnce({ valid: true, state: {}, mode: "speedrun", slot: 1 });
    expect(await preserveCloudRestoreSlot("normal", 1)).toBe(false);
    fixture.inspect.mockReturnValueOnce({ valid: true, state: {}, mode: "normal", slot: 2 });
    expect(await preserveCloudRestoreSlot("normal", 1)).toBe(false);
    expect(fixture.snapshot).not.toHaveBeenCalled();
  });

  it("requires a verified snapshot of the original slot state", async () => {
    fixture.read.mockResolvedValue('{"slot":1}');
    fixture.snapshot.mockResolvedValueOnce(null);
    expect(await preserveCloudRestoreSlot("normal", 1)).toBe(false);
    expect(await preserveCloudRestoreSlot("normal", 1)).toBe(true);
    expect(fixture.snapshot).toHaveBeenLastCalledWith({ tray: { iron_ore: 88 } }, "恢复云端槽位 1 前");
  });

  it("preserves old envelopes without a slot marker in their own mode namespace", async () => {
    fixture.read.mockResolvedValue('{}');
    fixture.inspect.mockReturnValue({ valid: true, state: { tray: { iron_ore: 88 } }, mode: "speedrun", slot: "main" });
    expect(await preserveCloudRestoreSlot("speedrun", 2)).toBe(true);
    expect(fixture.read).toHaveBeenCalledWith("dsp-idle-network.slot.speedrun.2");
    expect(fixture.snapshot).toHaveBeenCalledWith({ tray: { iron_ore: 88 } }, "恢复云端槽位 2 前");
  });
});
