import { getDesktopBridge } from "./desktop";

export type NativeAppPlatform = "web" | "desktop" | "android";

export const NATIVE_APP_STATE_EVENT = "dsp-native-app-state";
export const NATIVE_BACK_EVENT = "dsp-native-back";

export function getAppPlatform(): NativeAppPlatform {
  if (getDesktopBridge()) return "desktop";
  return __APP_PLATFORM__ === "android" ? "android" : "web";
}

export function isNativeApp(): boolean {
  return getAppPlatform() !== "web";
}

export function isSecureCloudClient(): boolean {
  if (isNativeApp()) return true;
  return typeof window !== "undefined"
    && (window.isSecureContext || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
}
