export const WINDOWS_NATIVE_CORE_BETA_KEY = "dsp-idle-network.windows-native-core-shadow-beta.v1";

/** Device-only invitation Beta flag. It is never serialized into GameState. */
export function readWindowsNativeCoreBetaEnabled(storage: Pick<Storage, "getItem"> | null =
  typeof window === "undefined" ? null : window.localStorage): boolean {
  try {
    return storage?.getItem(WINDOWS_NATIVE_CORE_BETA_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeWindowsNativeCoreBetaEnabled(
  enabled: boolean,
  storage: Pick<Storage, "setItem"> | null = typeof window === "undefined" ? null : window.localStorage,
): void {
  try {
    storage?.setItem(WINDOWS_NATIVE_CORE_BETA_KEY, String(enabled));
  } catch {
    // Local preferences are optional. A failed write must not affect the save.
  }
}

