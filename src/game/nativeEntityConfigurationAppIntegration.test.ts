import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native entity configuration App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const inspector = readFileSync(resolve("src/components/NativeFactoryInspectorPanel.tsx"), "utf8");

  it("forms one configuration atom from the same bounded Rust row and identity", () => {
    const start = app.indexOf("const nativeEntityConfigurationProjectionBinding");
    const end = app.indexOf("const factorySelectionToolbarReadModel", start);
    const binding = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(binding).toMatch(/factoryInteractionRows\.source !== "native-authoritative"/);
    expect(binding).toMatch(/identity\.sessionId !== nativePlayerAuthorityActiveFrame\.sessionId/);
    expect(binding).toMatch(/identity\.runId !== nativePlayerAuthorityActiveFrame\.runId/);
    expect(binding).toMatch(/identity\.revision !== nativePlayerAuthorityActiveFrame\.revision/);
    expect(binding).toMatch(/selectionIdentity\.sessionId !== identity\.sessionId[\s\S]*?selectionIdentity\.revision !== identity\.revision/);
    expect(binding).toMatch(/requestedEntityCount !== 1[\s\S]*?requestedBeltCount !== 0/);
    expect(binding).toMatch(/entityRows\.truncated[\s\S]*?beltRows\.truncated/);
    expect(binding).toMatch(/inspectorEntity\.entityId !== projected\.id[\s\S]*?projected\.planetId !== identity\.planetId/);
    expect(binding).not.toMatch(/gameRef|panelGame|game\.entities/);
  });

  it("submits only exact single-leaf helpers and waits for the authoritative reread", () => {
    const start = app.indexOf("const changeNativeEntityPowerPriority");
    const end = app.indexOf("const selectedBelts", start);
    const handlers = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handlers).toMatch(/nativeFactoryProjectionIdentityRef\.current[\s\S]*?nativePlayerAuthorityCommandBindingRef\.current/);
    expect(handlers).toMatch(/commandSource\.sessionId !== binding\.sessionId[\s\S]*?commandSource\.baseRevision !== binding\.revision/);
    expect(handlers).toMatch(/commitNativeProjectedCommand\(binding\.revision,[\s\S]*?createNativeProjectedEntityPowerPriorityCommand\(binding, targetPriority\)/);
    expect(handlers).toMatch(/commitNativeProjectedCommand\(binding\.revision,[\s\S]*?createNativeProjectedSplitterDistributionModeCommand\(binding, targetMode\)/);
    expect(handlers).toMatch(/commitNativeProjectedCommand\(binding\.revision,[\s\S]*?createNativeProjectedEnergyExchangerModeCommand\(binding, targetMode\)/);
    expect(handlers).not.toMatch(/commitGame|gameRef\.current|setPowerPriority|setSplitterMode/);
    expect(app).toMatch(/Never install or predict the projected edit locally[\s\S]*?nativePlayerAuthorityClockRef\.current\?\.refresh\(\)/);
  });

  it("exposes only the covered built-in entity controls in the thin inspector", () => {
    expect(inspector).toMatch(/data-native-entity-power-priority="ordinary-single-v1"/);
    expect(inspector).toMatch(/\(\[3, 2, 1\] as const\)\.map/);
    expect(inspector).toMatch(/data-native-splitter-mode="ordinary-single-v1"/);
    expect(inspector).toMatch(/\(\["balanced", "priority"\] as const\)\.map/);
    expect(inspector).toMatch(/data-native-energy-exchanger-mode="ordinary-single-v1"/);
    expect(inspector).toMatch(/\(\["charge", "discharge"\] as const\)\.map/);
    expect(app).toMatch(/entityConfiguration=\{nativeEntityConfigurationProjectionBinding\}/);
    expect(app).toMatch(/onEntityPowerPriorityChange=\{changeNativeEntityPowerPriority\}/);
    expect(app).toMatch(/onSplitterDistributionModeChange=\{changeNativeSplitterDistributionMode\}/);
    expect(app).toMatch(/onEnergyExchangerModeChange=\{changeNativeEnergyExchangerMode\}/);
    expect(inspector).not.toMatch(/fuelItemId|stationSlots/);
  });
});
