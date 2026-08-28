import { describe, expect, it } from "vitest";
import {
  CONNECT_EXPAND_ALL_PREFERENCE_KEY,
  CANVAS_DETAIL_PREFERENCE_KEY,
  CANVAS_INTERACTION_DETAIL_PREFERENCE_KEY,
  CANVAS_OVERLAP_PREFERENCE_KEY,
  BLUEPRINT_ALLOW_OVERLAP_PREFERENCE_KEY,
  DEFAULT_BELT_LANES_PREFERENCE_KEY,
  FULL_REALTIME_SIMULATION_PREFERENCE_KEY,
  FACTORY_ALERTS_PREFERENCE_KEY,
  LARGE_SAVE_AUTOSAVE_THROTTLE_PREFERENCE_KEY,
  MEMORY_AUTO_PAUSE_PREFERENCE_KEY,
  MEMORY_AUTO_PAUSE_THRESHOLD_PREFERENCE_KEY,
  readConnectExpandAllPreference,
  readCanvasDetailPreference,
  readCanvasInteractionDetailPreference,
  readCanvasOverlapPreference,
  readBlueprintAllowOverlapPreference,
  readDefaultBeltLanesPreference,
  readFullRealtimeSimulationPreference,
  readFactoryAlertsPreference,
  readLargeSaveAutosaveThrottlePreference,
  readMemoryAutoPauseEnabledPreference,
  readMemoryAutoPauseThresholdPreference,
  readSettingsCategoryPreference,
  readConnectionPointSize,
  readShowRunLogPreference,
  readShowItemHoverPreference,
  readSpeedrunPanelCollapsedPreference,
  readThemePreference,
  writeSettingsCategoryPreference,
  writeShowRunLogPreference,
  writeShowItemHoverPreference,
  writeSpeedrunPanelCollapsedPreference,
  writeThemePreference,
  writeConnectionPointSize,
  writeConnectExpandAllPreference,
  writeCanvasDetailPreference,
  writeCanvasInteractionDetailPreference,
  writeCanvasOverlapPreference,
  writeBlueprintAllowOverlapPreference,
  writeDefaultBeltLanesPreference,
  writeFullRealtimeSimulationPreference,
  writeFactoryAlertsPreference,
  writeLargeSaveAutosaveThrottlePreference,
  writeMemoryAutoPauseEnabledPreference,
  writeMemoryAutoPauseThresholdPreference,
} from "./uiPreferences";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  } as Storage;
}

describe("device-only UI preferences", () => {
  it("keeps theme, run-log and category values independent from game state", () => {
    const storage = memoryStorage();
    const original = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, matchMedia: () => ({ matches: false }) } });
    try {
      expect(readThemePreference()).toBeNull();
      expect(readShowRunLogPreference()).toBe(true);
      expect(readShowItemHoverPreference()).toBe(true);
      expect(readSettingsCategoryPreference()).toBe("all");
      expect(readConnectionPointSize()).toBe("default");
      expect(readSpeedrunPanelCollapsedPreference()).toBe(false);
      expect(readDefaultBeltLanesPreference()).toBe(1);
      expect(readConnectExpandAllPreference()).toBe(false);
      expect(readFullRealtimeSimulationPreference()).toBe(false);
      expect(readFactoryAlertsPreference()).toBe(true);
      expect(readCanvasDetailPreference()).toBe("auto");
      expect(readCanvasOverlapPreference()).toBe("marker");
      expect(readCanvasInteractionDetailPreference()).toBe("selected");
      expect(readBlueprintAllowOverlapPreference()).toBe(false);
      expect(readLargeSaveAutosaveThrottlePreference()).toBe(true);
      expect(readMemoryAutoPauseEnabledPreference()).toBe(false);
      expect(readMemoryAutoPauseThresholdPreference()).toBeNull();
      writeThemePreference("light");
      writeShowRunLogPreference(false);
      writeShowItemHoverPreference(false);
      writeSettingsCategoryPreference("statistics");
      writeConnectionPointSize("large50");
      writeSpeedrunPanelCollapsedPreference(true);
      writeDefaultBeltLanesPreference(4_096);
      writeConnectExpandAllPreference(true);
      writeFullRealtimeSimulationPreference(true);
      writeFactoryAlertsPreference(false);
      writeCanvasDetailPreference("medium");
      writeCanvasOverlapPreference("representative");
      writeCanvasInteractionDetailPreference("hover");
      writeBlueprintAllowOverlapPreference(true);
      writeLargeSaveAutosaveThrottlePreference(false);
      writeMemoryAutoPauseEnabledPreference(true);
      writeMemoryAutoPauseThresholdPreference(1_536);
      expect(readThemePreference()).toBe("light");
      expect(readShowRunLogPreference()).toBe(false);
      expect(readShowItemHoverPreference()).toBe(false);
      expect(readSettingsCategoryPreference()).toBe("statistics");
      expect(readConnectionPointSize()).toBe("large50");
      expect(readSpeedrunPanelCollapsedPreference()).toBe(true);
      expect(readDefaultBeltLanesPreference()).toBe(4_096);
      expect(readConnectExpandAllPreference()).toBe(true);
      expect(readFullRealtimeSimulationPreference()).toBe(true);
      expect(readFactoryAlertsPreference()).toBe(false);
      expect(storage.getItem(DEFAULT_BELT_LANES_PREFERENCE_KEY)).toBe("4096");
      expect(storage.getItem(CONNECT_EXPAND_ALL_PREFERENCE_KEY)).toBe("true");
      expect(storage.getItem(FULL_REALTIME_SIMULATION_PREFERENCE_KEY)).toBe("true");
      expect(storage.getItem(FACTORY_ALERTS_PREFERENCE_KEY)).toBe("false");
      expect(readCanvasDetailPreference()).toBe("medium");
      expect(readCanvasOverlapPreference()).toBe("representative");
      expect(readCanvasInteractionDetailPreference()).toBe("hover");
      expect(readBlueprintAllowOverlapPreference()).toBe(true);
      expect(readLargeSaveAutosaveThrottlePreference()).toBe(false);
      expect(readMemoryAutoPauseEnabledPreference()).toBe(true);
      expect(readMemoryAutoPauseThresholdPreference()).toBe(1_536);
      expect(storage.getItem(CANVAS_DETAIL_PREFERENCE_KEY)).toBe("medium");
      expect(storage.getItem(CANVAS_OVERLAP_PREFERENCE_KEY)).toBe("representative");
      expect(storage.getItem(CANVAS_INTERACTION_DETAIL_PREFERENCE_KEY)).toBe("hover");
      expect(storage.getItem(BLUEPRINT_ALLOW_OVERLAP_PREFERENCE_KEY)).toBe("true");
      expect(storage.getItem(MEMORY_AUTO_PAUSE_PREFERENCE_KEY)).toBe("true");
      expect(storage.getItem(MEMORY_AUTO_PAUSE_THRESHOLD_PREFERENCE_KEY)).toBe("1536");
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: original });
    }
  });

  it("falls back safely when a stored value is invalid", () => {
    const storage = memoryStorage();
    storage.setItem("dsp-idle-network.ui.theme.v1", "neon");
    storage.setItem("dsp-idle-network.ui.show-run-log.v1", "maybe");
    storage.setItem("dsp-idle-network.ui.show-item-hover.v1", "maybe");
    storage.setItem("dsp-idle-network.ui.settings-category.v1", "unknown");
    storage.setItem("dsp-idle-network.ui.connection-point-size.v1", "huge");
    storage.setItem("dsp-idle-network.ui.speedrun-panel-collapsed.v1", "maybe");
    storage.setItem(DEFAULT_BELT_LANES_PREFERENCE_KEY, "4097");
    storage.setItem(CONNECT_EXPAND_ALL_PREFERENCE_KEY, "damaged");
    storage.setItem(FULL_REALTIME_SIMULATION_PREFERENCE_KEY, "damaged");
    storage.setItem(FACTORY_ALERTS_PREFERENCE_KEY, "damaged");
    storage.setItem(CANVAS_DETAIL_PREFERENCE_KEY, "damaged");
    storage.setItem(CANVAS_OVERLAP_PREFERENCE_KEY, "damaged");
    storage.setItem(CANVAS_INTERACTION_DETAIL_PREFERENCE_KEY, "damaged");
    storage.setItem(BLUEPRINT_ALLOW_OVERLAP_PREFERENCE_KEY, "damaged");
    storage.setItem(LARGE_SAVE_AUTOSAVE_THROTTLE_PREFERENCE_KEY, "damaged");
    storage.setItem(MEMORY_AUTO_PAUSE_PREFERENCE_KEY, "damaged");
    storage.setItem(MEMORY_AUTO_PAUSE_THRESHOLD_PREFERENCE_KEY, "999");
    const original = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, matchMedia: () => ({ matches: false }) } });
    try {
      expect(readThemePreference()).toBeNull();
      expect(readShowRunLogPreference()).toBe(true);
      expect(readShowItemHoverPreference()).toBe(true);
      expect(readSettingsCategoryPreference()).toBe("all");
      expect(readConnectionPointSize()).toBe("default");
      expect(readSpeedrunPanelCollapsedPreference()).toBe(false);
      expect(readDefaultBeltLanesPreference()).toBe(1);
      expect(readConnectExpandAllPreference()).toBe(false);
      expect(readFullRealtimeSimulationPreference()).toBe(false);
      expect(readFactoryAlertsPreference()).toBe(true);
      expect(readCanvasDetailPreference()).toBe("auto");
      expect(readCanvasOverlapPreference()).toBe("marker");
      expect(readCanvasInteractionDetailPreference()).toBe("selected");
      expect(readBlueprintAllowOverlapPreference()).toBe(false);
      expect(readLargeSaveAutosaveThrottlePreference()).toBe(true);
      expect(readMemoryAutoPauseEnabledPreference()).toBe(false);
      expect(readMemoryAutoPauseThresholdPreference()).toBeNull();
      expect(storage.getItem(LARGE_SAVE_AUTOSAVE_THROTTLE_PREFERENCE_KEY)).toBe("damaged");
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: original });
    }
  });
});
