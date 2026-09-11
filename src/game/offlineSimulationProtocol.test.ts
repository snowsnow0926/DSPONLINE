import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import {
  createOfflineSimulationTextPayload,
  decodeOfflineSimulationTextPayload,
  deserializeOfflineSimulationState,
  OFFLINE_SIMULATION_PROTOCOL_VERSION,
  serializeOfflineSimulationState,
} from "./offlineSimulationProtocol";

describe("offline simulation transferable protocol", () => {
  it("round-trips a v46 state and safe large integers", () => {
    const state = createInitialState();
    state.elapsedSeconds = 123_456.75;
    state.tray.iron_ore = Number.MAX_SAFE_INTEGER;
    state.entities[0].stationSlots = undefined;
    const payload = serializeOfflineSimulationState(state);
    const decoded = deserializeOfflineSimulationState(payload);

    expect(payload.protocolVersion).toBe(OFFLINE_SIMULATION_PROTOCOL_VERSION);
    expect(payload.kind).toBe("game-state-json");
    expect(decoded.version).toBe(46);
    expect(decoded.elapsedSeconds).toBe(123_456.75);
    expect(decoded.tray.iron_ore).toBe(Number.MAX_SAFE_INTEGER);
    expect(Object.hasOwn(decoded.entities[0], "stationSlots")).toBe(true);
    expect(decoded.entities[0].stationSlots).toBeUndefined();
  });

  it("rejects non-finite state instead of silently changing it to null", () => {
    const state = createInitialState();
    state.elapsedSeconds = Number.POSITIVE_INFINITY;
    expect(() => serializeOfflineSimulationState(state)).toThrow("非有限数值");
  });

  it("rejects a mismatched protocol or payload kind", () => {
    const payload = createOfflineSimulationTextPayload("{}", "save-envelope-json");
    expect(() => decodeOfflineSimulationTextPayload(payload, "game-state-json")).toThrow("载荷类型不匹配");
    expect(() => decodeOfflineSimulationTextPayload({ ...payload, protocolVersion: 999 as 1 })).toThrow("协议版本不匹配");
  });
});
