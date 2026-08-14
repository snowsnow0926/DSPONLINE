import { describe, expect, it } from "vitest";
import {
  CONNECT_EXPAND_ALL_PREFERENCE_KEY,
  DEFAULT_BELT_LANES_PREFERENCE_KEY,
  readConnectExpandAllPreference,
  readDefaultBeltLanesPreference,
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
  writeDefaultBeltLanesPreference,
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
      writeThemePreference("light");
      writeShowRunLogPreference(false);
      writeShowItemHoverPreference(false);
      writeSettingsCategoryPreference("statistics");
      writeConnectionPointSize("large50");
      writeSpeedrunPanelCollapsedPreference(true);
      writeDefaultBeltLanesPreference(4_096);
      writeConnectExpandAllPreference(true);
      expect(readThemePreference()).toBe("light");
      expect(readShowRunLogPreference()).toBe(false);
      expect(readShowItemHoverPreference()).toBe(false);
      expect(readSettingsCategoryPreference()).toBe("statistics");
      expect(readConnectionPointSize()).toBe("large50");
      expect(readSpeedrunPanelCollapsedPreference()).toBe(true);
      expect(readDefaultBeltLanesPreference()).toBe(4_096);
      expect(readConnectExpandAllPreference()).toBe(true);
      expect(storage.getItem(DEFAULT_BELT_LANES_PREFERENCE_KEY)).toBe("4096");
      expect(storage.getItem(CONNECT_EXPAND_ALL_PREFERENCE_KEY)).toBe("true");
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
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: original });
    }
  });
});
