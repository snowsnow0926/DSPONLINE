import type { ThemeMode } from "./types";

/** Device-only preferences. These values never belong in GameState or cloud payloads. */
export const UI_THEME_PREFERENCE_KEY = "dsp-idle-network.ui.theme.v1";
export const SHOW_RUN_LOG_PREFERENCE_KEY = "dsp-idle-network.ui.show-run-log.v1";
export const SHOW_ITEM_HOVER_PREFERENCE_KEY = "dsp-idle-network.ui.show-item-hover.v1";
export const SETTINGS_CATEGORY_PREFERENCE_KEY = "dsp-idle-network.ui.settings-category.v1";
export const CONNECTION_POINT_SIZE_PREFERENCE_KEY = "dsp-idle-network.ui.connection-point-size.v1";
export const CONNECTION_HIT_AREA_PREFERENCE_KEY = "dsp-idle-network.ui.connection-hit-area.v1";
export const SPEEDRUN_PANEL_COLLAPSED_PREFERENCE_KEY = "dsp-idle-network.ui.speedrun-panel-collapsed.v1";
export const DEFAULT_BELT_LANES_PREFERENCE_KEY = "dsp-idle-network.ui.default-belt-lanes.v1";
export const CONNECT_EXPAND_ALL_PREFERENCE_KEY = "dsp-idle-network.ui.connect-expand-all.v1";

export type SettingsCategory = "all" | "visual" | "performance" | "interaction" | "storage" | "statistics" | "other";
export type ConnectionPointSize = "default" | "large25" | "large50";
export type ConnectionHitArea = "standard" | "large" | "huge" | "auto";

function localStorageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light" || value === "system";
}

export function readThemePreference(): ThemeMode | null {
  const storage = localStorageOrNull();
  if (!storage) return null;
  try {
    const value = storage.getItem(UI_THEME_PREFERENCE_KEY);
    return isThemeMode(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeThemePreference(mode: ThemeMode): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(UI_THEME_PREFERENCE_KEY, mode); } catch { /* optional preference */ }
}

export function readShowRunLogPreference(): boolean {
  const storage = localStorageOrNull();
  if (!storage) return true;
  try {
    const value = storage.getItem(SHOW_RUN_LOG_PREFERENCE_KEY);
    return value == null ? true : value !== "false";
  } catch {
    return true;
  }
}

export function writeShowRunLogPreference(enabled: boolean): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(SHOW_RUN_LOG_PREFERENCE_KEY, String(enabled)); } catch { /* optional preference */ }
}

export function readShowItemHoverPreference(): boolean {
  const storage = localStorageOrNull();
  if (!storage) return true;
  try {
    const value = storage.getItem(SHOW_ITEM_HOVER_PREFERENCE_KEY);
    return value == null ? true : value !== "false";
  } catch {
    return true;
  }
}

export function writeShowItemHoverPreference(enabled: boolean): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(SHOW_ITEM_HOVER_PREFERENCE_KEY, String(enabled)); } catch { /* optional preference */ }
}

export function readSettingsCategoryPreference(): SettingsCategory {
  const storage = localStorageOrNull();
  if (!storage) return "all";
  try {
    const value = storage.getItem(SETTINGS_CATEGORY_PREFERENCE_KEY);
    return value === "visual" || value === "performance" || value === "interaction" || value === "storage" || value === "statistics" || value === "other" || value === "all"
      ? value
      : "all";
  } catch {
    return "all";
  }
}

export function writeSettingsCategoryPreference(category: SettingsCategory): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(SETTINGS_CATEGORY_PREFERENCE_KEY, category); } catch { /* optional preference */ }
}

export function isConnectionPointSize(value: unknown): value is ConnectionPointSize {
  return value === "default" || value === "large25" || value === "large50";
}

export function readConnectionPointSize(): ConnectionPointSize {
  const storage = localStorageOrNull();
  if (!storage) return "default";
  try {
    const value = storage.getItem(CONNECTION_POINT_SIZE_PREFERENCE_KEY);
    return isConnectionPointSize(value) ? value : "default";
  } catch {
    return "default";
  }
}

export function writeConnectionPointSize(size: ConnectionPointSize): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(CONNECTION_POINT_SIZE_PREFERENCE_KEY, size); } catch { /* optional preference */ }
}

export function isConnectionHitArea(value: unknown): value is ConnectionHitArea {
  return value === "standard" || value === "large" || value === "huge" || value === "auto";
}

export function readConnectionHitArea(): ConnectionHitArea {
  const storage = localStorageOrNull();
  if (!storage) return "auto";
  try {
    const value = storage.getItem(CONNECTION_HIT_AREA_PREFERENCE_KEY);
    return isConnectionHitArea(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function writeConnectionHitArea(size: ConnectionHitArea): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(CONNECTION_HIT_AREA_PREFERENCE_KEY, size); } catch { /* optional preference */ }
}

/** Device-only construction preference; validation is repeated at the domain boundary. */
export function readDefaultBeltLanesPreference(): number {
  const storage = localStorageOrNull();
  if (!storage) return 1;
  try {
    const value = Number(storage.getItem(DEFAULT_BELT_LANES_PREFERENCE_KEY));
    return Number.isSafeInteger(value) && value >= 1 && value <= 4_096 ? value : 1;
  } catch {
    return 1;
  }
}

export function writeDefaultBeltLanesPreference(lanes: number): void {
  const storage = localStorageOrNull();
  if (!storage || !Number.isSafeInteger(lanes) || lanes < 1 || lanes > 4_096) return;
  try { storage.setItem(DEFAULT_BELT_LANES_PREFERENCE_KEY, String(lanes)); } catch { /* optional preference */ }
}

/** Expand every active-planet node only while connecting. Never persisted in a save. */
export function readConnectExpandAllPreference(): boolean {
  const storage = localStorageOrNull();
  if (!storage) return false;
  try {
    return storage.getItem(CONNECT_EXPAND_ALL_PREFERENCE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeConnectExpandAllPreference(enabled: boolean): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(CONNECT_EXPAND_ALL_PREFERENCE_KEY, String(enabled)); } catch { /* optional preference */ }
}

/** The speedrun panel is expanded by default and is never part of a save. */
export function readSpeedrunPanelCollapsedPreference(): boolean {
  const storage = localStorageOrNull();
  if (!storage) return false;
  try {
    return storage.getItem(SPEEDRUN_PANEL_COLLAPSED_PREFERENCE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeSpeedrunPanelCollapsedPreference(collapsed: boolean): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(SPEEDRUN_PANEL_COLLAPSED_PREFERENCE_KEY, String(collapsed)); } catch { /* optional preference */ }
}

/** Apply a saved theme before React mounts, preventing a dark flash on light-mode launches. */
export function initializeDocumentTheme(): ThemeMode {
  const mode = readThemePreference() ?? "dark";
  const resolved = mode === "system"
    ? (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : mode;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }
  return mode;
}
