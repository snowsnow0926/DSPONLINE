import { describe, expect, it } from "vitest";
import { createInitialState, setBeltMonitorEnabled, setBeltRouteOffsetY } from "./engine";
import { selectInspectorBelt } from "./inspectorProjection";
import type { BeltConnection } from "./types";

function inspectorState() {
  const state = createInitialState();
  const belt: BeltConnection = {
    id: "inspector-belt",
    planetId: state.activePlanetId,
    source: state.entities[0].id,
    target: state.entities[1].id,
    itemId: "iron_ore",
    lanes: 1,
    tier: 1,
    sorterTier: 1,
    progress: 0,
    priority: 1,
    lastFlow: 0,
    routeMode: "manual",
    routeOffsetY: 0,
    monitorEnabled: false,
  };
  return { ...state, belts: [belt] };
}

describe("inspector projection authority", () => {
  it("publishes a new controlled belt record for consecutive route and monitor commands", () => {
    const initial = inspectorState();
    const before = selectInspectorBelt(initial, "inspector-belt");
    const routed = setBeltRouteOffsetY(initial, "inspector-belt", 240);
    const afterRoute = selectInspectorBelt(routed, "inspector-belt");
    const monitored = setBeltMonitorEnabled(routed, "inspector-belt", true);
    const afterMonitor = selectInspectorBelt(monitored, "inspector-belt");

    expect(before?.routeOffsetY).toBe(0);
    expect(afterRoute?.routeOffsetY).toBe(240);
    expect(afterRoute).not.toBe(before);
    expect(afterMonitor?.monitorEnabled).toBe(true);
    expect(afterMonitor).not.toBe(afterRoute);
  });

  it("does not select a belt from another active planet", () => {
    const state = inspectorState();
    state.belts[0] = { ...state.belts[0], planetId: "ashen" };
    expect(selectInspectorBelt(state, "inspector-belt")).toBeNull();
  });
});
