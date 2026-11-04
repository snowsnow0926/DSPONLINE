import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFLINE_SETTLEMENT_PREFERENCE_KEY, readOfflineSettlementPreference, writeOfflineSettlementPreference } from "./offlineSettlementStrategy";

afterEach(() => vi.unstubAllGlobals());

describe("offline device preference storage failures", () => {
  it("keeps the player choice when obtaining localStorage itself is denied", () => {
    const getStorage = vi.fn(() => { throw new DOMException("Storage access denied", "SecurityError"); });
    vi.stubGlobal("window", Object.defineProperty({}, "localStorage", { get: getStorage }));
    expect(() => readOfflineSettlementPreference()).not.toThrow();
    expect(readOfflineSettlementPreference()).toBe("ask");
    expect(() => writeOfflineSettlementPreference("exact")).not.toThrow();
  });

  it("uses an explicit reader without touching unavailable browser storage", () => {
    const getStorage = vi.fn(() => { throw new Error("unavailable browser storage"); });
    vi.stubGlobal("window", Object.defineProperty({}, "localStorage", { get: getStorage }));
    const getItem = vi.fn((key: string) => key === OFFLINE_SETTLEMENT_PREFERENCE_KEY ? "skip" : "false");
    expect(readOfflineSettlementPreference({ getItem })).toBe("skip");
    expect(getStorage).not.toHaveBeenCalled();
    expect(getItem.mock.calls).toEqual([[OFFLINE_SETTLEMENT_PREFERENCE_KEY]]);
  });

  it("asks rather than skipping when the available storage reader rejects", () => {
    const getItem = vi.fn(() => { throw new Error("read denied"); });
    expect(readOfflineSettlementPreference({ getItem })).toBe("ask");
  });

  it("retains the legacy exact choice without writing or deleting saved data", () => {
    const getItem = vi.fn((key: string) => key === "dsp-idle-network.experimental-approximate-offline.v1" ? "false" : null);
    const setItem = vi.fn(); const removeItem = vi.fn(); const clear = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem, setItem, removeItem, clear } });
    expect(readOfflineSettlementPreference()).toBe("exact");
    expect(setItem).not.toHaveBeenCalled(); expect(removeItem).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
  });

  it("keeps the no-browser fallback explicit", () => {
    vi.stubGlobal("window", undefined);
    expect(readOfflineSettlementPreference()).toBe("ask");
  });
});
