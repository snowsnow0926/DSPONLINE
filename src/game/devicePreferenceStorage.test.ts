import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INSPECTOR_SECTION_ORDER, readInspectorLayoutPreference, writeInspectorLayoutPreference } from "./inspectorLayout";
import { readWindowsNativeCoreBetaEnabled, writeWindowsNativeCoreBetaEnabled } from "./nativeCoreBetaSettings";
import { OFFLINE_APPROXIMATION_DEFAULT_ENABLED, readOfflineApproximationEnabled } from "./offlineApproximation";
import { readMulticoreSimulationOptions } from "./multicoreSimulation";
import { readTutorialProgress, writeTutorialProgress, TUTORIAL_PROGRESS_KEY } from "./tutorialProgress";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
function denyStorage() {
  const get = vi.fn(() => { throw new DOMException("preference storage denied", "SecurityError"); });
  vi.stubGlobal("window", Object.defineProperty({}, "localStorage", { get }));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get });
  return get;
}

describe("optional device storage boundaries", () => {
  it("loads the default inspector layout even when obtaining storage is denied", () => {
    denyStorage();
    expect(readInspectorLayoutPreference()).toEqual({ version: 1, order: [...DEFAULT_INSPECTOR_SECTION_ORDER], collapsed: [] });
    expect(() => writeInspectorLayoutPreference({ version: 1, order: ["power"], collapsed: ["power"] })).not.toThrow();
  });
  it("keeps the native beta opt-in disabled and its writer harmless without storage", () => {
    denyStorage();
    expect(readWindowsNativeCoreBetaEnabled()).toBe(false);
    expect(() => writeWindowsNativeCoreBetaEnabled(true)).not.toThrow();
  });
  it("retains the established offline approximation default without reading a save", () => {
    denyStorage();
    expect(readOfflineApproximationEnabled()).toBe(OFFLINE_APPROXIMATION_DEFAULT_ENABLED);
  });
  it("does not enable the development multicore experiment when storage rejects access", () => {
    denyStorage(); vi.stubEnv("DEV", true);
    expect(readMulticoreSimulationOptions()).toEqual({});
  });
  it("keeps explicit injected preferences and an explicit null beta opt-out independent of the browser", () => {
    const get = denyStorage();
    expect(readInspectorLayoutPreference({ getItem: () => '{"order":["power"],"collapsed":["recipe"]}' }).order[0]).toBe("power");
    expect(readWindowsNativeCoreBetaEnabled({ getItem: () => "true" })).toBe(true);
    expect(readWindowsNativeCoreBetaEnabled(null)).toBe(false);
    writeWindowsNativeCoreBetaEnabled(true, null);
    expect(get).not.toHaveBeenCalled();
  });
  it("does not enable experiments by reading device preferences outside a browser", () => {
    vi.stubGlobal("window", undefined);
    expect(readInspectorLayoutPreference().collapsed).toEqual([]);
    expect(readWindowsNativeCoreBetaEnabled()).toBe(false);
    expect(readOfflineApproximationEnabled()).toBe(OFFLINE_APPROXIMATION_DEFAULT_ENABLED);
    expect(readMulticoreSimulationOptions()).toEqual({});
  });
  it("keeps tutorial progress readable when the one-time legacy copy cannot be written", () => {
    const storage = { getItem: (key: string) => key === TUTORIAL_PROGRESS_KEY ? null : '["canvas","belts"]', setItem: () => { throw new DOMException("full", "QuotaExceededError"); } };
    expect([...readTutorialProgress(storage)]).toEqual(["canvas", "belts"]);
    expect(() => writeTutorialProgress(storage, ["canvas"])).not.toThrow();
  });
  it("does not prevent opening the tutorial when its progress reader fails", () => {
    const storage = { getItem: () => { throw new Error("read denied"); }, setItem: vi.fn() };
    expect([...readTutorialProgress(storage)]).toEqual([]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
