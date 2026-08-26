import { describe, expect, it, vi } from "vitest";

import {
  readWindowsNativeCoreBetaEnabled,
  WINDOWS_NATIVE_CORE_BETA_KEY,
  writeWindowsNativeCoreBetaEnabled,
} from "./nativeCoreBetaSettings";

describe("Windows native core device preference", () => {
  it("is disabled unless this device explicitly opts in", () => {
    expect(readWindowsNativeCoreBetaEnabled({ getItem: () => null })).toBe(false);
    expect(readWindowsNativeCoreBetaEnabled({ getItem: () => "false" })).toBe(false);
    expect(readWindowsNativeCoreBetaEnabled({ getItem: () => "true" })).toBe(true);
  });

  it("writes only the device-local invitation flag and tolerates unavailable storage", () => {
    const setItem = vi.fn();
    writeWindowsNativeCoreBetaEnabled(true, { setItem });
    expect(setItem).toHaveBeenCalledWith(WINDOWS_NATIVE_CORE_BETA_KEY, "true");
    expect(() => writeWindowsNativeCoreBetaEnabled(false, { setItem: () => { throw new Error("denied"); } })).not.toThrow();
  });
});

