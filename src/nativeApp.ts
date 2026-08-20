import { getDesktopBridge, type DesktopUpdateStatus } from "./desktop";
import {
  getAppPlatform,
  NATIVE_APP_STATE_EVENT,
  NATIVE_BACK_EVENT,
  type NativeAppPlatform,
} from "./nativeAppBoundary";

export {
  getAppPlatform,
  isNativeApp,
  isSecureCloudClient,
  NATIVE_APP_STATE_EVENT,
  NATIVE_BACK_EVENT,
} from "./nativeAppBoundary";
export type { NativeAppPlatform } from "./nativeAppBoundary";

export type NativeUpdateState = DesktopUpdateStatus["state"] | "opening-download";

export interface NativeUpdateStatus {
  state: NativeUpdateState;
  message: string;
  channel: "stable" | "beta" | "nightly";
  version?: string;
  versionCode?: number;
  progress?: number;
  required?: boolean;
  downloadSize?: number;
  sha256?: string;
  releaseNotes?: string[];
}

export interface NativeReleaseInfo {
  platform: Exclude<NativeAppPlatform, "web">;
  platformLabel: string;
  channel: "stable" | "beta" | "nightly";
  channelLabel: string;
  version: string;
  build: string;
  update: NativeUpdateStatus;
}

export interface AndroidUpdateManifest {
  schemaVersion: 1;
  packageId: "cn.dsponline.network";
  channel: "stable" | "beta" | "nightly";
  versionName: string;
  versionCode: number;
  minimumSupportedVersionCode: number;
  publishedAt: string;
  apk: {
    url: string;
    sha256: string;
    size: number;
  };
  notes: string[];
}

const channelLabels = { stable: "稳定版", beta: "Beta", nightly: "Nightly" } as const;
const updateListeners = new Set<(status: NativeUpdateStatus) => void>();
let androidReleaseInfo: NativeReleaseInfo | null = null;
let androidManifest: AndroidUpdateManifest | null = null;
let initialization: Promise<void> | null = null;

function publishAndroidUpdate(update: NativeUpdateStatus): NativeUpdateStatus {
  if (androidReleaseInfo) androidReleaseInfo = { ...androidReleaseInfo, update };
  updateListeners.forEach((listener) => listener(update));
  return update;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}无效`);
  return value.trim();
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label}无效`);
  return Number(value);
}

export function parseAndroidUpdateManifest(raw: unknown, manifestUrl: string, expectedChannel = __RELEASE_CHANNEL__): AndroidUpdateManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Android 更新清单格式无效");
  const value = raw as Record<string, unknown>;
  const channel = value.channel;
  if (value.schemaVersion !== 1 || value.packageId !== "cn.dsponline.network") throw new Error("Android 更新清单身份无效");
  if (channel !== expectedChannel || (channel !== "stable" && channel !== "beta" && channel !== "nightly")) throw new Error("Android 更新通道不匹配");
  const versionName = requiredString(value.versionName, "版本名称");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(versionName)) throw new Error("版本名称格式无效");
  const versionCode = requiredPositiveInteger(value.versionCode, "版本代码");
  const minimumSupportedVersionCode = requiredPositiveInteger(value.minimumSupportedVersionCode, "最低版本代码");
  if (minimumSupportedVersionCode > versionCode) throw new Error("最低版本不能高于发布版本");
  const publishedAt = requiredString(value.publishedAt, "发布时间");
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error("发布时间无效");
  const apk = value.apk as Record<string, unknown> | null;
  if (!apk || typeof apk !== "object" || Array.isArray(apk)) throw new Error("APK 信息无效");
  const manifest = new URL(manifestUrl);
  const apkUrl = new URL(requiredString(apk.url, "APK 地址"), manifest);
  if (manifest.protocol !== "https:" || apkUrl.protocol !== "https:" || apkUrl.origin !== manifest.origin || !apkUrl.pathname.startsWith("/downloads/android/")) {
    throw new Error("APK 下载地址未获授权");
  }
  const sha256 = requiredString(apk.sha256, "APK 校验值").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("APK 校验值无效");
  const size = requiredPositiveInteger(apk.size, "APK 大小");
  const notes = Array.isArray(value.notes)
    ? value.notes.filter((note): note is string => typeof note === "string" && Boolean(note.trim())).slice(0, 12).map((note) => note.trim().slice(0, 240))
    : [];
  return {
    schemaVersion: 1,
    packageId: "cn.dsponline.network",
    channel,
    versionName,
    versionCode,
    minimumSupportedVersionCode,
    publishedAt: new Date(publishedAt).toISOString(),
    apk: { url: apkUrl.toString(), sha256, size },
    notes,
  };
}

export function resolveAndroidUpdateManifestUrl(configured: string | undefined): string {
  if (!configured?.trim()) throw new Error("此构建未配置更新源");
  const target = new URL(configured.trim());
  if (target.protocol !== "https:") throw new Error("Android 更新源必须使用 HTTPS");
  return target.toString();
}

function androidManifestUrl(): string {
  return resolveAndroidUpdateManifestUrl(import.meta.env.VITE_ANDROID_UPDATE_MANIFEST_URL);
}

export function resolveNativePublicOrigin(configured: string | undefined): string | null {
  if (!configured?.trim()) return null;
  const target = new URL(configured.trim());
  if (target.protocol !== "https:" || target.pathname !== "/" || target.search || target.hash) {
    throw new Error("原生应用公开入口必须是 HTTPS origin");
  }
  return target.origin;
}

async function readAndroidAppInfo(): Promise<NativeReleaseInfo> {
  if (androidReleaseInfo) return androidReleaseInfo;
  let version = __APP_VERSION__;
  let build = "preview";
  try {
    const [{ Capacitor }, { App }] = await Promise.all([import("@capacitor/core"), import("@capacitor/app")]);
    if (Capacitor.isNativePlatform()) {
      const info = await App.getInfo();
      version = info.version;
      build = info.build;
    }
  } catch {
    // Browser previews use compile-time release metadata.
  }
  androidReleaseInfo = {
    platform: "android",
    platformLabel: "Android 应用",
    channel: __RELEASE_CHANNEL__,
    channelLabel: channelLabels[__RELEASE_CHANNEL__],
    version,
    build,
    update: { state: "idle", message: "尚未检查", channel: __RELEASE_CHANNEL__ },
  };
  return androidReleaseInfo;
}

export async function getNativeReleaseInfo(): Promise<NativeReleaseInfo | null> {
  const desktop = getDesktopBridge();
  if (desktop) {
    const info = await desktop.getReleaseInfo();
    return {
      platform: "desktop",
      platformLabel: "桌面应用",
      channel: info.channel,
      channelLabel: info.channelLabel,
      version: info.version,
      build: info.platform,
      update: info.update,
    };
  }
  if (__APP_PLATFORM__ !== "android") return null;
  return readAndroidAppInfo();
}

export function subscribeNativeUpdate(listener: (status: NativeUpdateStatus) => void): () => void {
  const desktop = getDesktopBridge();
  if (desktop) return desktop.onUpdateStatus(listener);
  if (__APP_PLATFORM__ !== "android") return () => undefined;
  updateListeners.add(listener);
  if (androidReleaseInfo) listener(androidReleaseInfo.update);
  return () => updateListeners.delete(listener);
}

export async function checkNativeUpdate(): Promise<NativeUpdateStatus | null> {
  const desktop = getDesktopBridge();
  if (desktop) return desktop.checkForUpdates();
  if (__APP_PLATFORM__ !== "android") return null;
  const release = await readAndroidAppInfo();
  publishAndroidUpdate({ state: "checking", message: "正在检查更新", channel: release.channel });
  try {
    const manifestUrl = androidManifestUrl();
    let status = 0;
    let data: unknown;
    const { Capacitor, CapacitorHttp } = await import("@capacitor/core");
    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.get({ url: manifestUrl, headers: { "cache-control": "no-cache" }, connectTimeout: 8_000, readTimeout: 8_000, responseType: "json" });
      status = response.status;
      data = response.data;
    } else {
      const response = await fetch(manifestUrl, { cache: "no-store" });
      status = response.status;
      data = await response.json().catch(() => null);
    }
    if (status < 200 || status >= 300) throw new Error(status === 404 ? "更新服务尚未发布" : `更新服务返回 ${status}`);
    const manifest = parseAndroidUpdateManifest(data, manifestUrl, release.channel);
    androidManifest = manifest;
    const installedCode = Number.parseInt(release.build, 10) || 0;
    if (manifest.versionCode <= installedCode) {
      return publishAndroidUpdate({ state: "up-to-date", message: "已是最新版本", channel: release.channel, version: release.version, versionCode: installedCode });
    }
    return publishAndroidUpdate({
      state: "available",
      message: `发现版本 ${manifest.versionName}`,
      channel: release.channel,
      version: manifest.versionName,
      versionCode: manifest.versionCode,
      required: installedCode < manifest.minimumSupportedVersionCode,
      downloadSize: manifest.apk.size,
      sha256: manifest.apk.sha256,
      releaseNotes: manifest.notes,
    });
  } catch (error) {
    androidManifest = null;
    return publishAndroidUpdate({ state: "error", message: error instanceof Error ? error.message : "更新检查失败", channel: release.channel });
  }
}

export async function downloadNativeUpdate(): Promise<NativeUpdateStatus | null> {
  const desktop = getDesktopBridge();
  if (desktop) return desktop.downloadUpdate();
  if (__APP_PLATFORM__ !== "android") return null;
  const release = await readAndroidAppInfo();
  if (!androidManifest) return publishAndroidUpdate({ state: "error", message: "请先检查更新", channel: release.channel });
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url: androidManifest.apk.url, toolbarColor: "#111614", presentationStyle: "fullscreen" });
    return publishAndroidUpdate({
      ...release.update,
      state: "opening-download",
      message: "已打开系统下载页；安装时 Android 会校验应用签名",
      channel: release.channel,
    });
  } catch (error) {
    return publishAndroidUpdate({ state: "error", message: error instanceof Error ? error.message : "无法打开下载页", channel: release.channel });
  }
}

export async function installNativeUpdate(): Promise<{ accepted: boolean }> {
  const desktop = getDesktopBridge();
  if (desktop) return desktop.installUpdate();
  if (__APP_PLATFORM__ === "android" && androidManifest) {
    await downloadNativeUpdate();
    return { accepted: true };
  }
  return { accepted: false };
}

function dispatchAppState(isActive: boolean): void {
  window.dispatchEvent(new CustomEvent(NATIVE_APP_STATE_EVENT, { detail: { isActive } }));
}

export function initializeNativeRuntime(): Promise<void> {
  document.documentElement.dataset.appPlatform = getAppPlatform();
  if (__APP_PLATFORM__ !== "android") return Promise.resolve();
  if (initialization) return initialization;
  initialization = (async () => {
    const [{ Capacitor }, { App }, { Network }, { StatusBar, Style }] = await Promise.all([
      import("@capacitor/core"),
      import("@capacitor/app"),
      import("@capacitor/network"),
      import("@capacitor/status-bar"),
    ]);
    if (!Capacitor.isNativePlatform()) return;
    document.documentElement.dataset.nativeRuntime = "true";
    await StatusBar.setOverlaysWebView({ overlay: false }).catch(() => undefined);
    const syncStatusBar = () => {
      const lightTheme = document.documentElement.dataset.theme === "light";
      void StatusBar.setStyle({ style: lightTheme ? Style.Light : Style.Dark }).catch(() => undefined);
      void StatusBar.setBackgroundColor({ color: lightTheme ? "#f4f7f6" : "#090d0c" }).catch(() => undefined);
    };
    syncStatusBar();
    new MutationObserver(syncStatusBar).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    await App.addListener("appStateChange", ({ isActive }) => dispatchAppState(isActive));
    await App.addListener("backButton", async ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
        return;
      }
      const event = new CustomEvent(NATIVE_BACK_EVENT, { cancelable: true });
      if (window.dispatchEvent(event)) await App.minimizeApp();
    });
    await App.addListener("appUrlOpen", ({ url }) => {
      try {
        const incoming = new URL(url);
        const publicOrigin = resolveNativePublicOrigin(import.meta.env.VITE_PUBLIC_APP_ORIGIN);
        if (!publicOrigin || incoming.origin !== publicOrigin || (!incoming.searchParams.has("verify") && !incoming.searchParams.has("reset"))) return;
        const current = new URL(window.location.href);
        current.search = incoming.search;
        window.history.replaceState(window.history.state, "", current);
        window.location.reload();
      } catch {
        // Ignore malformed deep links.
      }
    });
    const network = await Network.getStatus().catch(() => null);
    if (network) document.documentElement.dataset.network = network.connected ? "online" : "offline";
    await Network.addListener("networkStatusChange", ({ connected }) => {
      document.documentElement.dataset.network = connected ? "online" : "offline";
      window.dispatchEvent(new Event(connected ? "online" : "offline"));
    });
    document.addEventListener("click", (event) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      try {
        const target = new URL(anchor.href);
        if (target.protocol !== "https:" || target.origin === window.location.origin) return;
        event.preventDefault();
        void import("@capacitor/browser").then(({ Browser }) => Browser.open({ url: target.toString(), toolbarColor: "#111614" }));
      } catch {
        // Invalid links retain the browser's default behavior.
      }
    });
  })();
  return initialization;
}

export async function finishNativeLaunch(): Promise<void> {
  if (__APP_PLATFORM__ !== "android") return;
  try {
    const [{ Capacitor }, { SplashScreen }] = await Promise.all([import("@capacitor/core"), import("@capacitor/splash-screen")]);
    if (Capacitor.isNativePlatform()) await SplashScreen.hide({ fadeOutDuration: 180 });
  } catch {
    // The WebView remains usable even if the native splash plugin is unavailable.
  }
}
