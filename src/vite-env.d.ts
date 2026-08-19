/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
declare const __APP_PLATFORM__: "web" | "desktop" | "android";
declare const __RELEASE_CHANNEL__: "stable" | "beta" | "nightly";

interface ImportMetaEnv {
  readonly VITE_ANDROID_UPDATE_MANIFEST_URL?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_PUBLIC_APP_ORIGIN?: string;
  readonly VITE_RUNTIMEWORLD_DIAGNOSTICS?: string;
}
