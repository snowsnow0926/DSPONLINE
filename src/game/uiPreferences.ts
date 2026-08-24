import type { ThemeMode } from "./types";
import type {
  CanvasDetailPreference,
  CanvasInteractionDetailPreference,
  CanvasOverlapPreference,
} from "./canvasDensityPresentation";
import {
  MEMORY_AUTO_PAUSE_THRESHOLD_PRESETS_MIB,
  type MemoryAutoPauseThresholdMiB,
} from "./memoryBudget";

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
export const FULL_REALTIME_SIMULATION_PREFERENCE_KEY = "dsp-idle-network.full-realtime-simulation.v1";
export const CANVAS_DETAIL_PREFERENCE_KEY = "dsp-idle-network.ui.canvas-detail.v1";
export const CANVAS_OVERLAP_PREFERENCE_KEY = "dsp-idle-network.ui.canvas-overlap.v1";
export const CANVAS_INTERACTION_DETAIL_PREFERENCE_KEY = "dsp-idle-network.ui.canvas-interaction-detail.v1";
export const BLUEPRINT_ALLOW_OVERLAP_PREFERENCE_KEY = "dsp-idle-network.ui.blueprint-allow-overlap.v1";
export const LARGE_SAVE_AUTOSAVE_THROTTLE_PREFERENCE_KEY = "dsp-idle-network.ui.large-save-autosave-throttle.v1";
export const MEMORY_AUTO_PAUSE_PREFERENCE_KEY = "dsp-idle-network.ui.memory-auto-pause.v1";
export const MEMORY_AUTO_PAUSE_THRESHOLD_PREFERENCE_KEY = "dsp-idle-network.ui.memory-auto-pause-threshold-mib.v1";
export const FACTORY_ALERTS_PREFERENCE_KEY = "dsp-idle-network.ui.factory-alerts.v1";
/** 设备级偏好：保存（自动/手动 durable checkpoint）期间允许玩家继续编辑。
 *  默认 false = 保持既有 fail-safe（保存期间编辑被拒绝并提示）。
 *  开启后保存不再撤销/拒绝操作；保存期间的编辑会保留在 durable 队列，
 *  recovery head 会在下一次保存时滚动追赶。 */
export const ALLOW_EDITS_DURING_SAVE_PREFERENCE_KEY = "dsp-idle-network.save.allow-edits-during-save.v1";

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

/** Include history and all planning payloads in every live Worker projection. */
export function readFullRealtimeSimulationPreference(): boolean {
  const storage = localStorageOrNull();
  if (!storage) return false;
  try {
    return storage.getItem(FULL_REALTIME_SIMULATION_PREFERENCE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeFullRealtimeSimulationPreference(enabled: boolean): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(FULL_REALTIME_SIMULATION_PREFERENCE_KEY, String(enabled)); } catch { /* optional preference */ }
}

export function readCanvasDetailPreference(): CanvasDetailPreference {
  const storage = localStorageOrNull();
  if (!storage) return "auto";
  try {
    const value = storage.getItem(CANVAS_DETAIL_PREFERENCE_KEY);
    return value === "full" || value === "medium" || value === "minimal" || value === "auto" ? value : "auto";
  } catch {
    return "auto";
  }
}

export function writeCanvasDetailPreference(preference: CanvasDetailPreference): void {
  const storage = localStorageOrNull();
  if (!storage || (preference !== "auto" && preference !== "full" && preference !== "medium" && preference !== "minimal")) return;
  try { storage.setItem(CANVAS_DETAIL_PREFERENCE_KEY, preference); } catch { /* optional preference */ }
}

/** How near-identical canvas entities remain discoverable. Never enters GameState. */
export function readCanvasOverlapPreference(): CanvasOverlapPreference {
  const storage = localStorageOrNull();
  if (!storage) return "marker";
  try {
    const value = storage.getItem(CANVAS_OVERLAP_PREFERENCE_KEY);
    return value === "marker" || value === "representative" || value === "all" ? value : "marker";
  } catch {
    return "marker";
  }
}

export function writeCanvasOverlapPreference(preference: CanvasOverlapPreference): void {
  const storage = localStorageOrNull();
  if (!storage || (preference !== "marker" && preference !== "representative" && preference !== "all")) return;
  try { storage.setItem(CANVAS_OVERLAP_PREFERENCE_KEY, preference); } catch { /* optional preference */ }
}

/** Which ordinary interactions may promote a reduced card to full detail. */
export function readCanvasInteractionDetailPreference(): CanvasInteractionDetailPreference {
  const storage = localStorageOrNull();
  if (!storage) return "selected";
  try {
    const value = storage.getItem(CANVAS_INTERACTION_DETAIL_PREFERENCE_KEY);
    return value === "selected" || value === "hover" || value === "base" ? value : "selected";
  } catch {
    return "selected";
  }
}

export function writeCanvasInteractionDetailPreference(preference: CanvasInteractionDetailPreference): void {
  const storage = localStorageOrNull();
  if (!storage || (preference !== "selected" && preference !== "hover" && preference !== "base")) return;
  try { storage.setItem(CANVAS_INTERACTION_DETAIL_PREFERENCE_KEY, preference); } catch { /* optional preference */ }
}

/** Blueprint placement policy is local UI state; placed/queued results remain ordinary GameState commands. */
export function readBlueprintAllowOverlapPreference(): boolean {
  const storage = localStorageOrNull();
  if (!storage) return false;
  try { return storage.getItem(BLUEPRINT_ALLOW_OVERLAP_PREFERENCE_KEY) === "true"; } catch { return false; }
}

export function writeBlueprintAllowOverlapPreference(enabled: boolean): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(BLUEPRINT_ALLOW_OVERLAP_PREFERENCE_KEY, String(enabled)); } catch { /* optional preference */ }
}

/** Protect the main thread from frequent large-save background writes. Device-only and on by default. */
export function readLargeSaveAutosaveThrottlePreference(): boolean {
  const storage = localStorageOrNull();
  if (!storage) return true;
  try {
    const value = storage.getItem(LARGE_SAVE_AUTOSAVE_THROTTLE_PREFERENCE_KEY);
    return value == null ? true : value !== "false";
  } catch {
    return true;
  }
}

export function writeLargeSaveAutosaveThrottlePreference(enabled: boolean): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(LARGE_SAVE_AUTOSAVE_THROTTLE_PREFERENCE_KEY, String(enabled)); } catch { /* optional preference */ }
}

/** Protect large factories from browser heap exhaustion. Device-only and on by default. */
export function readMemoryAutoPauseEnabledPreference(): boolean {
  const storage = localStorageOrNull();
  if (!storage) return true;
  try {
    const value = storage.getItem(MEMORY_AUTO_PAUSE_PREFERENCE_KEY);
    return value == null ? true : value !== "false";
  } catch {
    return true;
  }
}

export function writeMemoryAutoPauseEnabledPreference(enabled: boolean): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(MEMORY_AUTO_PAUSE_PREFERENCE_KEY, String(enabled)); } catch { /* optional preference */ }
}

/** `null` is the automatic browser-heap 90% watermark. */
export function readMemoryAutoPauseThresholdPreference(): MemoryAutoPauseThresholdMiB {
  const storage = localStorageOrNull();
  if (!storage) return null;
  try {
    const value = storage.getItem(MEMORY_AUTO_PAUSE_THRESHOLD_PREFERENCE_KEY);
    if (value == null || value === "auto") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && MEMORY_AUTO_PAUSE_THRESHOLD_PRESETS_MIB.includes(parsed as (typeof MEMORY_AUTO_PAUSE_THRESHOLD_PRESETS_MIB)[number])
      ? parsed as MemoryAutoPauseThresholdMiB
      : null;
  } catch {
    return null;
  }
}

export function writeMemoryAutoPauseThresholdPreference(thresholdMiB: MemoryAutoPauseThresholdMiB): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  if (thresholdMiB !== null && !MEMORY_AUTO_PAUSE_THRESHOLD_PRESETS_MIB.includes(thresholdMiB as (typeof MEMORY_AUTO_PAUSE_THRESHOLD_PRESETS_MIB)[number])) return;
  try { storage.setItem(MEMORY_AUTO_PAUSE_THRESHOLD_PREFERENCE_KEY, thresholdMiB === null ? "auto" : String(thresholdMiB)); } catch { /* optional preference */ }
}

/** Factory diagnostics can be disabled locally for very large factories. */
export function readFactoryAlertsPreference(): boolean {
  const storage = localStorageOrNull();
  if (!storage) return true;
  try {
    const value = storage.getItem(FACTORY_ALERTS_PREFERENCE_KEY);
    return value == null ? true : value !== "false";
  } catch {
    return true;
  }
}

export function writeFactoryAlertsPreference(enabled: boolean): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(FACTORY_ALERTS_PREFERENCE_KEY, String(enabled)); } catch { /* optional preference */ }
}

/** 保存期间允许继续编辑（默认关闭，保持既有 fail-safe）。 */
export function readAllowEditsDuringSavePreference(): boolean {
  const storage = localStorageOrNull();
  if (!storage) return false;
  try {
    return storage.getItem(ALLOW_EDITS_DURING_SAVE_PREFERENCE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeAllowEditsDuringSavePreference(enabled: boolean): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try { storage.setItem(ALLOW_EDITS_DURING_SAVE_PREFERENCE_KEY, String(enabled)); } catch { /* optional preference */ }
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
