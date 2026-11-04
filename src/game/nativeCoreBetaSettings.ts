export const WINDOWS_NATIVE_CORE_BETA_KEY = "dsp-idle-network.windows-native-core-shadow-beta.v1";

/** Device-only invitation Beta flag. It is never serialized into GameState. */
export function readWindowsNativeCoreBetaEnabled(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const target = storage === undefined ? (typeof window === "undefined" ? null : window.localStorage) : storage;
    return target?.getItem(WINDOWS_NATIVE_CORE_BETA_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeWindowsNativeCoreBetaEnabled(
  enabled: boolean,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (typeof window === "undefined" ? null : window.localStorage) : storage;
    target?.setItem(WINDOWS_NATIVE_CORE_BETA_KEY, String(enabled));
  } catch {
    // Local preferences are optional. A failed write must not affect the save.
  }
}

