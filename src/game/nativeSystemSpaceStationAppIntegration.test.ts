import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("native system-space-station App integration", () => {
  const app = source("src/App.tsx");
  const component = source("src/components/NativeSystemSpaceStationWorkspace.tsx");

  it("routes every native control through the intent-only durable bridge", () => {
    const start = app.indexOf("const commitNativeSystemSpaceStationIntent = useCallback");
    const end = app.indexOf("const submitNativeBlueprintRenameIntent", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = app.slice(start, end);
    expect(block).toContain("desktopBridge?.commitNativeSystemSpaceStationIntent");
    expect(block).toContain("rejectPlayerStateEditDuringPrimarySave()");
    expect(block).toContain("nativePlayerAuthorityCommandInFlightRef.current");
    expect(block).toContain("nativePlayerAuthorityClockRef.current?.refresh()");
    expect(block).not.toMatch(/commitGame|gameRef\.current|SimulationCommandPatch|applySimulationCommandPatch/);

    for (const type of [
      "start",
      "deliver-from-tray",
      "module-target",
      "upgrade-one",
      "upgrade-all",
      "mode-target",
      "output-target",
    ]) {
      expect(app).toContain(`type: "${type}"`);
    }
    expect(app).toMatch(/type: "output-target",[\s\S]*?confirmations: 2/);
    expect(app).toMatch(/<NativeSystemSpaceStationWorkspace[\s\S]*?pending=\{nativePlayerAuthorityCommandPending\}/);
    expect(app).toMatch(/commandsAvailable=\{typeof desktopBridge\?\.commitNativeSystemSpaceStationIntent === "function"\}/);
  });

  it("keeps the renderer surface bounded and free of full-state mutation inputs", () => {
    expect(component).not.toMatch(/import[^\n]+GameState|game\s*:\s*GameState|commitGame|SimulationCommandPatch|gameRef/);
    for (const action of [
      "start",
      "deliver",
      "module-backbone-increase",
      "upgrade-one",
      "upgrade-all",
      "mode-legacy",
      "mode-elevator",
    ]) {
      expect(component).toContain(`data-native-system-station-command=${action.startsWith("module-") ? "{`" : `"${action}"`}`);
    }
    expect(component).toContain("data-native-system-station-output-submit");
    expect(component).toMatch(/armed \? "再次确认"/);
  });

  it("keeps session, run, command ID and patch ownership out of preload", () => {
    const desktop = source("src/desktop.ts");
    const preload = source("desktop/preload.cjs");
    const broker = source("desktop/native-player-authority-system-space-station-broker.cjs");
    expect(desktop).toMatch(/interface DesktopNativeSystemSpaceStationIntentRequest \{[\s\S]*?expectedRevision:[\s\S]*?expectedRegistryFingerprint:[\s\S]*?intent:/);
    expect(preload).toMatch(/commitNativeSystemSpaceStationIntent:[\s\S]*?desktop:native-player-authority-system-space-station-intent/);
    expect(preload).not.toMatch(/commitPlayerAuthoritySystemSpaceStationCommand/);
    expect(broker).toMatch(/renderer supplies only the revision\/catalog it rendered plus one exact/);
    expect(broker).toMatch(/exactKeys\(rawRequest, \["expectedRevision", "expectedRegistryFingerprint", "intent"\]\)/);
    expect(broker).not.toMatch(/rawRequest\.(?:sessionId|runId|command|patch)/);
  });
});
