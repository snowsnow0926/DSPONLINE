import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native station configuration App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const inspector = readFileSync(resolve("src/components/NativeFactoryInspectorPanel.tsx"), "utf8");

  it("forms the station binding only from the exact Rust inspector and selection atom", () => {
    const start = app.indexOf("const nativeStationConfigurationProjectionBinding");
    const end = app.indexOf("const nativeTimeWarpControllerProjectionBinding", start);
    const binding = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(binding).toMatch(/factoryInteractionRows\.source !== "native-authoritative"/);
    expect(binding).toMatch(/commandIdentity\.sessionId !== nativePlayerAuthorityActiveFrame\.sessionId/);
    expect(binding).toMatch(/commandIdentity\.runId !== nativePlayerAuthorityActiveFrame\.runId/);
    expect(binding).toMatch(/commandIdentity\.revision !== nativePlayerAuthorityActiveFrame\.revision/);
    expect(binding).toMatch(/selectNativeProjectedStationConfigurationBinding\(\{[\s\S]*?inspector: factoryInspectorSummaryReadModel,[\s\S]*?selection: factoryMultiSelectionSummaryReadModel/);
    expect(binding).not.toMatch(/gameRef|game\.entities|stationRoutes/);
  });

  it("rechecks selection drift, emits only typed intents, and refreshes after durable ACK", () => {
    const start = app.indexOf("const changeNativeStationConfiguration");
    const end = app.indexOf("const selectedBelts", start);
    const handler = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handler).toMatch(/nativePlayerAuthorityCommandInFlightRef\.current/);
    expect(handler).toMatch(/nativeFactoryProjectionIdentityRef\.current/);
    expect(handler).toMatch(/nativePlayerAuthorityCommandBindingRef\.current\?\.source/);
    expect(handler).toMatch(/selectedEntityIdsRef\.current\.length !== 1[\s\S]*?selectedBeltIdsRef\.current\.length !== 0/);
    expect(handler).toMatch(/createNativeProjectedStationSlotPriorityCommand/);
    expect(handler).toMatch(/createNativeProjectedStationSlotMinimumLoadCommand/);
    expect(handler).toMatch(/createNativeProjectedStationSlotLimitsCommand/);
    expect(handler).toMatch(/createNativeProjectedStationSlotRoutePolicyCommand/);
    expect(handler).toMatch(/createNativeProjectedStationSlotWarperBudgetCommand/);
    expect(handler).toMatch(/createNativeProjectedStationScalarCommand/);
    expect(handler).toMatch(/durable revision \$\{receipt\.revision\}/);
    expect(handler).not.toMatch(/commitGame|gameRef\.current|stationRoutes|stationWarpers|inputs|outputs/);
  });

  it("wires the native panel while leaving the ordinary Web station handlers intact", () => {
    expect(app).toMatch(/stationConfiguration=\{nativeStationConfigurationProjectionBinding\}/);
    expect(app).toMatch(/onStationConfigurationChange=\{changeNativeStationConfiguration\}/);
    expect(inspector).toMatch(/data-native-station-configuration="bounded-no-material-v1"/);
    expect(inspector).toMatch(/aria-label="物流站舰队只读"/);
    expect(inspector).toMatch(/value=\{slot\.itemId \?\? ""\} disabled/);
    expect(app).toMatch(/onStationPriorityChange=\{\(entityId:[\s\S]*?setStationSlotPriority/);
    expect(app).toMatch(/onStationMinimumLoadChange=\{\(entityId:[\s\S]*?setStationSlotMinimumLoad/);
    expect(app).toMatch(/onStationLimitsChange=\{\(entityId:[\s\S]*?setStationSlotLimits/);
  });
});
