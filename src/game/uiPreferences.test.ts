import { describe, expect, it } from "vitest";
import {
  readSettingsCategoryPreference,
  readConnectionPointSize,
  readShowRunLogPreference,
  readThemePreference,
  writeSettingsCategoryPreference,
  writeShowRunLogPreference,
  writeThemePreference,
  writeConnectionPointSize,
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
      expect(readSettingsCategoryPreference()).toBe("all");
      expect(readConnectionPointSize()).toBe("default");
      writeThemePreference("light");
      writeShowRunLogPreference(false);
      writeSettingsCategoryPreference("statistics");
      writeConnectionPointSize("large50");
      expect(readThemePreference()).toBe("light");
      expect(readShowRunLogPreference()).toBe(false);
      expect(readSettingsCategoryPreference()).toBe("statistics");
      expect(readConnectionPointSize()).toBe("large50");
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: original });
    }
  });

  it("falls back safely when a stored value is invalid", () => {
    const storage = memoryStorage();
    storage.setItem("dsp-idle-network.ui.theme.v1", "neon");
    storage.setItem("dsp-idle-network.ui.show-run-log.v1", "maybe");
    storage.setItem("dsp-idle-network.ui.settings-category.v1", "unknown");
    storage.setItem("dsp-idle-network.ui.connection-point-size.v1", "huge");
    const original = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, matchMedia: () => ({ matches: false }) } });
    try {
      expect(readThemePreference()).toBeNull();
      expect(readShowRunLogPreference()).toBe(true);
      expect(readSettingsCategoryPreference()).toBe("all");
      expect(readConnectionPointSize()).toBe("default");
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: original });
    }
  });
});
