import { describe, expect, it } from "vitest";
import {
  addQuantumInteger,
  beginQuantumAttachment,
  compareQuantumInteger,
  createEmptyQuantumLogisticsNetworkState,
  depositIntoQuantumInventory,
  depositIntoNormalizedQuantumInventory,
  getQuantumItemCapacity,
  getQuantumLogisticsMultiplier,
  getQuantumTowerBandwidth,
  isValidQuantumItemCapacity,
  normalizeQuantumInteger,
  settleQuantumAttachment,
  settleQuantumLogisticsNetwork,
} from "./quantumLogisticsNetwork";
import { advanceSimulation, attachAllInterstellarStationsToQuantumNetwork, createPlayerInitialState, setAllOrbitalCollectorsQuantumMode } from "./engine";
import { advancePureIdleMacroSession, createPureIdleMacroSession } from "./pureIdleMacro";
import type { FactoryEntity, StationSlot } from "./types";

describe("quantum logistics network", () => {
  it("deposits immediately up to per-item capacity and returns the exact remainder", () => {
    const base = { ...createEmptyQuantumLogisticsNetworkState(), enabled: true };
    const full = depositIntoQuantumInventory(base, "iron_ore", 100);
    expect(full.accepted).toBe("100");
    expect(full.remainder).toBe("0");
    expect(full.state.inventory.iron_ore).toBe("100");

    const partial = depositIntoQuantumInventory({
      ...base,
      inventory: { iron_ore: "9960" },
      itemCapacities: { iron_ore: "10000" },
    }, "iron_ore", 100);
    expect(partial.accepted).toBe("40");
    expect(partial.remainder).toBe("60");
    expect(partial.state.inventory.iron_ore).toBe("10000");

    const blocked = depositIntoQuantumInventory(partial.state, "iron_ore", 1);
    expect(blocked.accepted).toBe("0");
    expect(blocked.remainder).toBe("1");
    expect(blocked.state.inventory.iron_ore).toBe("10000");
  });

  it("keeps the compiled normalized deposit byte-equivalent without replacing the network", () => {
    const source = {
      ...createEmptyQuantumLogisticsNetworkState(),
      enabled: true,
      inventory: { iron_ore: "9960" as const, copper_ore: "77" as const },
      itemCapacities: { iron_ore: "10000" as const },
    };
    const legacy = depositIntoQuantumInventory(structuredClone(source), "iron_ore", 100);
    const compiledSource = structuredClone(source);
    const compiled = depositIntoNormalizedQuantumInventory(compiledSource, "iron_ore", 100);

    expect(compiled).toEqual(legacy);
    expect(compiled.state).toBe(compiledSource);
    expect(compiled.state.inventory.copper_ore).toBe("77");
  });

  it("量子仓库已满时保留塔内物资，不会静默删除上传缓存", () => {
    const state = createPlayerInitialState();
    state.quantumLogisticsNetwork.enabled = true;
    state.quantumLogisticsNetwork.itemCapacities.iron_ore = "10000";
    state.quantumLogisticsNetwork.inventory.iron_ore = "10000";
    state.entities.push({
      id: "full-quantum-upload",
      kind: "station",
      planetId: "home",
      position: { x: 0, y: 0 },
      interactionLocked: false,
      buildingId: "interstellar_logistics_station",
      stationTier: 2,
      quantumMode: "quantum",
      stationSlots: [{ itemId: "iron_ore", localMode: "storage", remoteMode: "supply", minimumLoad: 0.1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 }],
      stationRoutes: [],
      stationDrones: 0,
      stationVessels: 0,
      inputs: {},
      outputs: { iron_ore: 100 },
      progress: 0,
      utilization: 0,
      productionRate: 0,
      routingCursor: 0,
      machineCount: 1,
      minerCount: 0,
    });

    const advanced = advanceSimulation(state, 30);

    expect(advanced.quantumLogisticsNetwork.inventory.iron_ore).toBe("10000");
    expect(advanced.entities.find((entity) => entity.id === "full-quantum-upload")?.outputs.iron_ore).toBe(100);

    const pureIdle = structuredClone(state);
    pureIdle.entities.push({
      id: "full-quantum-wind", kind: "power", planetId: "home", position: { x: -100, y: 0 }, interactionLocked: false,
      buildingId: "wind_turbine", inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
      routingCursor: 0, machineCount: 100_000_000_000, minerCount: 0,
    }, {
      id: "full-quantum-time-warp", kind: "machine", planetId: "home", position: { x: -50, y: 0 }, interactionLocked: false,
      buildingId: "time_warp_device", inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
      routingCursor: 0, machineCount: 1, minerCount: 0,
    });
    pureIdle.timeWarp = {
      ...pureIdle.timeWarp,
      enabled: true,
      controllerEntityId: "full-quantum-time-warp",
      requestedMultiplier: 12,
      effectiveMultiplier: 12,
      pendingSimulationSeconds: 0,
      pendingWallSeconds: 0,
    };
    const session = createPureIdleMacroSession(pureIdle, "extreme");
    advancePureIdleMacroSession(session, 300);
    expect(session.candidate.quantumLogisticsNetwork.inventory.iron_ore).toBe("10000");
    expect(session.candidate.entities.find((entity) => entity.id === "full-quantum-upload")?.outputs.iron_ore).toBe(100);
  });

  it("lets a quantum supply belt bypass tower input capacity while preserving minStock", () => {
    const state = createPlayerInitialState();
    state.quantumLogisticsNetwork.enabled = true;
    state.quantumLogisticsNetwork.itemCapacities.iron_ore = "1000000";
    const station: FactoryEntity = {
      id: "direct-supply", kind: "station", planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false,
      buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "quantum", machineCount: 1,
      minerCount: 0, stationSlots: [{ itemId: "iron_ore", localMode: "storage", remoteMode: "supply", minimumLoad: 0.1, minStock: 10, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 }], stationRoutes: [], stationDrones: 0, stationVessels: 0,
      inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0,
    };
    state.entities.push(station);
    const source: FactoryEntity = {
      id: "direct-source", kind: "storage", planetId: "home", position: { x: -100, y: 0 }, interactionLocked: false,
      buildingId: "storage_mk1", storedItemId: "iron_ore", machineCount: 1, minerCount: 0, inputs: {}, outputs: { iron_ore: 100 }, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0,
    };
    state.entities.push(source);
    state.belts.push({ id: "direct-belt", planetId: "home", source: source.id, target: station.id, itemId: "iron_ore", lanes: 1, tier: 1, sorterTier: 1, progress: 100, priority: 1, lastFlow: 0 });
    const advanced = advanceSimulation(state, 1);
    expect(advanced.quantumLogisticsNetwork.inventory.iron_ore).toBe("90");
    expect(advanced.entities.find((entity) => entity.id === station.id)?.inputs.iron_ore).toBe(10);
    expect(advanced.entities.find((entity) => entity.id === source.id)?.outputs.iron_ore).toBe(0);
  });
  it("normalizes hostile quantities and keeps exact decimal arithmetic", () => {
    expect(normalizeQuantumInteger("0000012")).toBe("12");
    expect(normalizeQuantumInteger("1e6")).toBe("0");
    expect(normalizeQuantumInteger(-1)).toBe("0");
    expect(addQuantumInteger("9007199254740993", "7")).toBe("9007199254741000");
    expect(compareQuantumInteger("100000000000000000000", "99")).toBe(1);
  });

  it("uses the squared wireless technology multiplier and independent directions", () => {
    expect(getQuantumLogisticsMultiplier(0)).toBe(1);
    expect(getQuantumLogisticsMultiplier(10)).toBe(2.25);
    const baseBandwidth = getQuantumTowerBandwidth({
      buildingId: "interstellar_logistics_station",
      machineCount: 1,
      quantumMode: "quantum",
    }, 0);
    expect(baseBandwidth.uploadPerMinute).toBe(5_000);
    expect(baseBandwidth.downloadPerMinute).toBe(5_000);
    const bandwidth = getQuantumTowerBandwidth({ buildingId: "interstellar_logistics_station", machineCount: 10, quantumMode: "quantum" }, 232, 0.5);
    expect(bandwidth.uploadPerMinute).toBeCloseTo(7_938_000, 6);
    expect(bandwidth.uploadPerBoundary).toBe(661_500);
    expect(bandwidth.downloadPerBoundary).toBe(bandwidth.uploadPerBoundary);
  });

  it("accepts only the configured per-item capacity range", () => {
    const network = createEmptyQuantumLogisticsNetworkState();
    expect(getQuantumItemCapacity(network, "iron_ore")).toBe("10000000000");
    expect(isValidQuantumItemCapacity("10000")).toBe(true);
    expect(isValidQuantumItemCapacity("10000000000")).toBe(true);
    for (const invalid of ["", "9999", "10000000001", "1.5", "1e4", "-1", "iron", NaN]) {
      expect(isValidQuantumItemCapacity(invalid)).toBe(false);
    }
  });

  it("preserves existing over-capacity inventory and lets downloads free upload space", () => {
    const network = {
      ...createEmptyQuantumLogisticsNetworkState(),
      enabled: true,
      inventory: { iron_ore: "15000" as const },
      itemCapacities: { iron_ore: "10000" as const },
    };
    const blocked = settleQuantumLogisticsNetwork(network, [
      { key: "blocked", stationId: "supply", itemId: "iron_ore", requested: 100 },
    ], [], { globalUploadCap: 100 });
    expect(blocked.inputAccepted.blocked).toBe("0");
    expect(blocked.state.inventory.iron_ore).toBe("15000");

    const drained = settleQuantumLogisticsNetwork(network, [
      { key: "upload", stationId: "supply", itemId: "iron_ore", requested: 5000 },
    ], [
      { key: "download", stationId: "demand", itemId: "iron_ore", requested: 7000, capacity: 7000 },
    ], { globalUploadCap: 5000, globalDownloadCap: 7000 });
    expect(drained.outputDelivered.download).toBe("7000");
    expect(drained.inputAccepted.upload).toBe("2000");
    expect(drained.state.inventory.iron_ore).toBe("10000");
  });

  it("settles downloads before uploads and preserves inventory exactly", () => {
    const network = { ...createEmptyQuantumLogisticsNetworkState(), enabled: true, inventory: { iron_ore: "10" } };
    const result = settleQuantumLogisticsNetwork(network, [
      { key: "supply-b", stationId: "supply", itemId: "iron_ore", requested: "100" },
    ], [
      { key: "demand-a", stationId: "demand", itemId: "iron_ore", requested: "80", capacity: "80" },
    ], { globalUploadCap: 50, globalDownloadCap: 80 });
    expect(result.inputAccepted["supply-b"]).toBe("50");
    expect(result.outputDelivered["demand-a"]).toBe("10");
    expect(result.state.inventory.iron_ore).toBe("50");
    expect(result.diagnostics.blockedByInventory).toBe("70");
  });

  it("is deterministic when request arrays are reordered and rotates equal requests fairly", () => {
    const network = { ...createEmptyQuantumLogisticsNetworkState(), enabled: true, inventory: { copper_ore: "5" }, routingCursors: { copper_ore: 0 } };
    const outputs = [
      { key: "station-b:0", stationId: "station-b", itemId: "copper_ore" as const, requested: 5, capacity: 5 },
      { key: "station-a:0", stationId: "station-a", itemId: "copper_ore" as const, requested: 5, capacity: 5 },
    ];
    const first = settleQuantumLogisticsNetwork(network, [], outputs);
    const second = settleQuantumLogisticsNetwork(network, [], [...outputs].reverse());
    expect(first.outputDelivered).toEqual(second.outputDelivered);
    expect(Object.values(first.outputDelivered).reduce((sum, value) => sum + Number(value), 0)).toBe(5);
    expect(first.state.routingCursors.copper_ore).toBe(second.state.routingCursors.copper_ore);
  });

  it("requires a completed station upgrade and waits for legacy route tails", () => {
    const base = createPlayerInitialState();
    base.quantumLogisticsNetwork.enabled = true;
    base.entities.push({
      id: "quantum-station",
      kind: "station",
      planetId: "home",
      position: { x: 0, y: 0 },
      interactionLocked: false,
      buildingId: "interstellar_logistics_station",
      stationTier: 2,
      stationRoutes: [{ id: "route-1", slotIndex: 0, peerId: "peer", itemId: "iron_ore", scope: "remote", cargo: 10, vehicleCount: 1, progress: 0, duration: 10, requiresWarp: false }],
      stationSlots: [],
      inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
      routingCursor: 0, machineCount: 1, minerCount: 0,
    });
    const started = beginQuantumAttachment(base, "quantum-station");
    expect(started.changed).toBe(true);
    expect(started.state.entities.find((entity) => entity.id === "quantum-station")?.quantumMode).toBe("transitioning");
    const waiting = settleQuantumAttachment({ ...started.state, elapsedSeconds: 5 }, "quantum-station");
    expect(waiting.changed).toBe(true);
    expect(waiting.state.entities.find((entity) => entity.id === "quantum-station")?.quantumMode).toBe("transitioning");
    const done = settleQuantumAttachment({
      ...started.state,
      elapsedSeconds: 15,
      entities: started.state.entities.map((entity) => entity.id === "quantum-station" ? {
        ...entity,
        stationRoutes: [],
        quantumTransition: entity.quantumTransition ? {
          ...entity.quantumTransition,
          bridges: entity.quantumTransition.bridges.map((bridge) => ({ ...bridge, remainingCargo: "0" })),
        } : null,
      } : entity),
    }, "quantum-station");
    expect(done.changed).toBe(true);
    expect(done.state.entities.find((entity) => entity.id === "quantum-station")?.quantumMode).toBe("quantum");
  });

  it("tracks a supply tower route stored on the demand tower and clears it after completion", () => {
    const state = createPlayerInitialState();
    state.quantumLogisticsNetwork.enabled = true;
    state.entities.push(
      {
        id: "tail-supply",
        kind: "station",
        planetId: "home",
        position: { x: 0, y: 0 },
        interactionLocked: false,
        buildingId: "interstellar_logistics_station",
        stationTier: 2,
        quantumMode: "legacy",
        stationSlots: [],
        stationRoutes: [],
        inputs: {}, outputs: { iron_ore: 10 }, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 1, minerCount: 0,
      },
      {
        id: "tail-demand",
        kind: "station",
        planetId: "home",
        position: { x: 20, y: 0 },
        interactionLocked: false,
        buildingId: "interstellar_logistics_station",
        stationTier: 2,
        quantumMode: "legacy",
        stationSlots: [],
        stationRoutes: [{
          id: "tail-route", slotIndex: 0, peerId: "tail-supply", itemId: "iron_ore", scope: "remote",
          cargo: 10, vehicleCount: 1, progress: 0, duration: 10, requiresWarp: false, vehicleStationId: "tail-supply",
        }],
        inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 1, minerCount: 0,
      },
    );
    const started = beginQuantumAttachment(state, "tail-supply");
    expect(started.changed).toBe(true);
    const bridge = started.state.entities.find((entity) => entity.id === "tail-supply")?.quantumTransition?.bridges[0];
    expect(bridge?.remainingCargo).toBe("10");
    expect(bridge?.sourceStationId).toBe("tail-supply");
    expect(bridge?.targetStationId).toBe("tail-demand");

    const waiting = settleQuantumAttachment({ ...started.state, elapsedSeconds: 5 }, "tail-supply");
    expect(waiting.changed).toBe(true);
    expect(waiting.state.entities.find((entity) => entity.id === "tail-supply")?.quantumMode).toBe("transitioning");
    expect(waiting.state.entities.find((entity) => entity.id === "tail-supply")?.quantumTransition?.bridges[0].remainingCargo).toBe("10");

    const completed = {
      ...waiting.state,
      elapsedSeconds: 15,
      entities: waiting.state.entities.map((entity) => entity.id === "tail-demand" ? { ...entity, stationRoutes: [] } : entity),
    };
    const done = settleQuantumAttachment(completed, "tail-supply");
    expect(done.changed).toBe(true);
    expect(done.state.entities.find((entity) => entity.id === "tail-supply")?.quantumMode).toBe("quantum");
    expect(done.state.entities.find((entity) => entity.id === "tail-supply")?.quantumTransition).toBeNull();
  });

  it("lets the normal engine route settlement release a supply tower attachment", () => {
    const state = createPlayerInitialState();
    state.quantumLogisticsNetwork.enabled = true;
    state.entities.push(
      {
        id: "engine-supply",
        kind: "station",
        planetId: "home",
        position: { x: 0, y: 0 },
        interactionLocked: false,
        buildingId: "interstellar_logistics_station",
        stationTier: 2,
        quantumMode: "legacy",
        stationSlots: [{
          itemId: "iron_ore", localMode: "storage", remoteMode: "supply", minimumLoad: 1,
          minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2,
        }], stationRoutes: [], stationVessels: 1,
        inputs: {}, outputs: { iron_ore: 10 }, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 1, minerCount: 0,
      },
      {
        id: "engine-demand",
        kind: "station",
        planetId: "home",
        position: { x: 20, y: 0 },
        interactionLocked: false,
        buildingId: "interstellar_logistics_station",
        stationTier: 2,
        quantumMode: "legacy",
        stationSlots: [{
          itemId: "iron_ore", localMode: "storage", remoteMode: "demand", minimumLoad: 1,
          minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2,
        }], stationVessels: 1,
        stationRoutes: [{ id: "engine-route", slotIndex: 0, peerId: "engine-supply", itemId: "iron_ore", scope: "remote", cargo: 10, vehicleCount: 1, progress: 0, duration: 1, requiresWarp: false, vehicleStationId: "engine-supply" }],
        inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 1, minerCount: 0,
      },
      {
        id: "engine-wind", kind: "power", planetId: "home", position: { x: 10, y: 0 }, interactionLocked: false,
        buildingId: "wind_turbine", inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 100, minerCount: 0,
      },
    );
    const started = beginQuantumAttachment(state, "engine-supply");
    const advanced = advanceSimulation(started.state, 5);
    const supply = advanced.entities.find((entity) => entity.id === "engine-supply")!;
    const demand = advanced.entities.find((entity) => entity.id === "engine-demand")!;
    expect(supply.quantumMode).toBe("quantum");
    expect(supply.quantumTransition).toBeNull();
    expect(demand.stationRoutes).toEqual([]);
    expect(demand.outputs.iron_ore).toBe(10);
    expect(supply.outputs.iron_ore).toBe(0);
  });

  it("keeps local drone routes running while a tower attaches and after it becomes quantum", () => {
    const state = createPlayerInitialState();
    state.quantumLogisticsNetwork.enabled = true;
    state.entities.push(
      {
        id: "local-quantum-supply",
        kind: "station",
        planetId: "home",
        position: { x: 0, y: 0 },
        interactionLocked: false,
        buildingId: "interstellar_logistics_station",
        stationTier: 2,
        quantumMode: "legacy",
        stationSlots: [{
          itemId: "iron_ore", localMode: "supply", remoteMode: "storage", minimumLoad: 0.1,
          minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2,
        }],
        stationRoutes: [], stationDrones: 10, stationVessels: 10,
        inputs: {}, outputs: { iron_ore: 1000 }, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 1, minerCount: 0,
      },
      {
        id: "local-traditional-demand",
        kind: "station",
        planetId: "home",
        position: { x: 20, y: 0 },
        interactionLocked: false,
        buildingId: "planetary_logistics_station",
        stationSlots: [{
          itemId: "iron_ore", localMode: "demand", remoteMode: "storage", minimumLoad: 0.1,
          minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2,
        }],
        stationRoutes: [], stationDrones: 10,
        inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 1, minerCount: 0,
      },
      {
        id: "local-quantum-power", kind: "power", planetId: "home", position: { x: 10, y: 0 }, interactionLocked: false,
        buildingId: "wind_turbine", inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 10_000, minerCount: 0,
      },
    );
    const started = beginQuantumAttachment(state, "local-quantum-supply");
    expect(started.state.entities.find((entity) => entity.id === "local-quantum-supply")?.quantumTransition?.bridges).toEqual([]);
    const advanced = advanceSimulation(started.state, 30);
    const supply = advanced.entities.find((entity) => entity.id === "local-quantum-supply")!;
    const demand = advanced.entities.find((entity) => entity.id === "local-traditional-demand")!;
    const inFlight = (demand.stationRoutes ?? []).reduce((sum, route) => sum + route.cargo, 0);
    expect(supply.quantumMode).toBe("quantum");
    expect(demand.outputs.iron_ore).toBeGreaterThan(0);
    expect((supply.outputs.iron_ore ?? 0) + (demand.outputs.iron_ore ?? 0) + inFlight).toBe(1000);
    expect(advanced.quantumLogisticsNetwork.inventory.iron_ore).toBeUndefined();
  });

  it("supports local collection before upload and local delivery after download", () => {
    const state = createPlayerInitialState();
    state.quantumLogisticsNetwork.enabled = true;
    state.quantumLogisticsNetwork.inventory.copper_ore = "1000";
    const station = (
      id: string,
      buildingId: "planetary_logistics_station" | "interstellar_logistics_station",
      itemId: "iron_ore" | "copper_ore",
      localMode: "supply" | "demand",
      remoteMode: "storage" | "supply" | "demand",
      outputs: Partial<Record<"iron_ore" | "copper_ore", number>>,
      quantum = false,
    ): FactoryEntity => ({
      id, kind: "station", planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false,
      buildingId, stationTier: buildingId === "interstellar_logistics_station" ? 2 : undefined,
      quantumMode: quantum ? "quantum" : undefined,
      stationSlots: [{ itemId, localMode, remoteMode, minimumLoad: 0.1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 }],
      stationRoutes: [], stationDrones: 10, stationVessels: buildingId === "interstellar_logistics_station" ? 10 : undefined,
      inputs: {}, outputs, progress: 0, utilization: 0, productionRate: 0,
      routingCursor: 0, machineCount: 1, minerCount: 0,
    });
    state.entities.push(
      station("local-source", "planetary_logistics_station", "iron_ore", "supply", "storage", { iron_ore: 1000 }),
      station("quantum-upload", "interstellar_logistics_station", "iron_ore", "demand", "supply", {}, true),
      station("quantum-download", "interstellar_logistics_station", "copper_ore", "supply", "demand", {}, true),
      station("local-sink", "planetary_logistics_station", "copper_ore", "demand", "storage", {}),
      {
        id: "hybrid-power", kind: "power", planetId: "home", position: { x: 10, y: 0 }, interactionLocked: false,
        buildingId: "wind_turbine", inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 10_000, minerCount: 0,
      },
    );
    const advanced = advanceSimulation(state, 60);
    const source = advanced.entities.find((entity) => entity.id === "local-source")!;
    const sink = advanced.entities.find((entity) => entity.id === "local-sink")!;
    expect(source.outputs.iron_ore).toBeLessThan(1000);
    expect(Number(advanced.quantumLogisticsNetwork.inventory.iron_ore ?? "0")).toBeGreaterThan(0);
    expect(sink.outputs.copper_ore).toBeGreaterThan(0);
    expect(Number(advanced.quantumLogisticsNetwork.inventory.copper_ore ?? "0")).toBeLessThan(1000);
    expect(advanced.entities.flatMap((entity) => entity.stationRoutes ?? []).every((route) => route.scope === "local")).toBe(true);
  });

  it("does not double-spend local route reservations at a quantum boundary", () => {
    const uploadState = createPlayerInitialState();
    uploadState.quantumLogisticsNetwork.enabled = true;
    uploadState.entities.push(
      {
        id: "reserved-quantum-supply", kind: "station", planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false,
        buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "quantum",
        stationSlots: [{ itemId: "iron_ore", localMode: "supply", remoteMode: "supply", minimumLoad: 0.1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 }],
        stationRoutes: [], stationDrones: 1, stationVessels: 0,
        inputs: {}, outputs: { iron_ore: 100 }, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 1, minerCount: 0,
      },
      {
        id: "reserved-local-demand", kind: "station", planetId: "home", position: { x: 20, y: 0 }, interactionLocked: false,
        buildingId: "planetary_logistics_station",
        stationSlots: [{ itemId: "iron_ore", localMode: "demand", remoteMode: "storage", minimumLoad: 0.1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 }],
        stationRoutes: [{ id: "reserved-local-route", slotIndex: 0, peerId: "reserved-quantum-supply", itemId: "iron_ore", scope: "local", cargo: 100, vehicleCount: 1, progress: 0, duration: 100, requiresWarp: false, vehicleStationId: "reserved-local-demand" }],
        stationDrones: 1, inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 1, minerCount: 0,
      },
    );
    const uploadAdvanced = advanceSimulation(uploadState, 5);
    expect(uploadAdvanced.quantumLogisticsNetwork.inventory.iron_ore).toBeUndefined();
    expect(uploadAdvanced.entities.find((entity) => entity.id === "reserved-quantum-supply")?.outputs.iron_ore).toBe(100);

    const downloadState = createPlayerInitialState();
    downloadState.quantumLogisticsNetwork.enabled = true;
    downloadState.quantumLogisticsNetwork.inventory.copper_ore = "100";
    downloadState.entities.push(
      {
        id: "reserved-local-supply", kind: "station", planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false,
        buildingId: "planetary_logistics_station", stationSlots: [], stationRoutes: [], stationDrones: 1,
        inputs: {}, outputs: { copper_ore: 100 }, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 1, minerCount: 0,
      },
      {
        id: "reserved-quantum-demand", kind: "station", planetId: "home", position: { x: 20, y: 0 }, interactionLocked: false,
        buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "quantum",
        stationSlots: [{ itemId: "copper_ore", localMode: "demand", remoteMode: "demand", minimumLoad: 0.1, minStock: 0, maxStock: 100, priority: 1, routePolicy: "direct", warperBudget: 2 }],
        stationRoutes: [{ id: "reserved-incoming-route", slotIndex: 0, peerId: "reserved-local-supply", itemId: "copper_ore", scope: "local", cargo: 100, vehicleCount: 1, progress: 0, duration: 100, requiresWarp: false, vehicleStationId: "reserved-quantum-demand" }],
        stationDrones: 1, stationVessels: 0, inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 1, minerCount: 0,
      },
    );
    const downloadAdvanced = advanceSimulation(downloadState, 5);
    expect(downloadAdvanced.quantumLogisticsNetwork.inventory.copper_ore).toBe("100");
    expect(downloadAdvanced.entities.find((entity) => entity.id === "reserved-quantum-demand")?.outputs.copper_ore).toBe(0);
  });

  it("lets collectors share tower upload bandwidth without contributing their own", () => {
    const makeState = (towerStacks: number) => {
      const state = createPlayerInitialState();
      state.quantumLogisticsNetwork.enabled = true;
      state.entities.push({
        id: "quantum-collector", kind: "station", planetId: "giant", position: { x: 0, y: 0 }, interactionLocked: false,
        buildingId: "orbital_collector", quantumMode: "quantum", storedItemId: "hydrogen",
        stationRoutes: [], inputs: {}, outputs: { hydrogen: 100 }, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 1_000_000, minerCount: 0,
      });
      if (towerStacks > 0) state.entities.push({
        id: "bandwidth-tower", kind: "station", planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false,
        buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "quantum", stationSlots: [], stationRoutes: [],
        inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: towerStacks, minerCount: 0,
      });
      return state;
    };
    const withoutTower = advanceSimulation(makeState(0), 5);
    expect(withoutTower.quantumLogisticsNetwork.inventory.hydrogen).toBeUndefined();
    const withTower = advanceSimulation(makeState(1), 5);
    expect(withTower.quantumLogisticsNetwork.inventory.hydrogen).toBe("416");
  });

  it("uses the engine five-second boundary without creating a quantum StationRoute", () => {
    const state = createPlayerInitialState();
    state.quantumLogisticsNetwork.enabled = true;
    const emptySlots = (): StationSlot[] => Array.from({ length: 5 }, () => ({ localMode: "storage", remoteMode: "storage", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 }));
    const station = (id: string, mode: "supply" | "demand"): FactoryEntity => {
      const slots = emptySlots();
      slots[0] = { ...slots[0], itemId: "iron_ore", remoteMode: mode };
      return {
        id, kind: "station", planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false,
        buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "quantum", stationSlots: slots, stationRoutes: [],
        inputs: {}, outputs: mode === "supply" ? { iron_ore: 100 } : {}, progress: 0, utilization: 0, productionRate: 0,
        routingCursor: 0, machineCount: 1, minerCount: 0, stationDrones: 0, stationVessels: 0,
      };
    };
    state.entities.push(station("q-supply", "supply"), station("q-demand", "demand"), {
      id: "power", kind: "power", planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false,
      buildingId: "wind_turbine", inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
      routingCursor: 0, machineCount: 20, minerCount: 0,
    });
    const advanced = advanceSimulation(state, 10);
    const supply = advanced.entities.find((entity) => entity.id === "q-supply")!;
    const demand = advanced.entities.find((entity) => entity.id === "q-demand")!;
    expect(supply.stationRoutes).toEqual([]);
    expect(demand.stationRoutes).toEqual([]);
    expect(demand.outputs.iron_ore).toBe(100);
    expect(supply.outputs.iron_ore).toBe(0);
  });

  it("starts all eligible stations in stable order and scopes a batch to one star system", () => {
    const state = createPlayerInitialState();
    state.research.completedTechIds.push("quantum_logistics_network");
    state.entities.push(
      { id: "batch-b", kind: "station", planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false, buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "legacy", stationSlots: [], stationRoutes: [], inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0 },
      { id: "batch-a", kind: "station", planetId: "home", position: { x: 10, y: 0 }, interactionLocked: false, buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "legacy", stationSlots: [], stationRoutes: [], inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0 },
      { id: "batch-mk1", kind: "station", planetId: "home", position: { x: 20, y: 0 }, interactionLocked: false, buildingId: "interstellar_logistics_station", stationTier: 1, quantumMode: "legacy", stationSlots: [], stationRoutes: [], inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0 },
    );
    const scoped = attachAllInterstellarStationsToQuantumNetwork(state, "helios");
    expect(scoped.startedIds).toEqual(["batch-a", "batch-b"]);
    expect(scoped.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: "batch-mk1", blocker: "not-upgraded" }),
    ]));
    expect(scoped.state.entities.find((entity) => entity.id === "batch-a")?.quantumMode).toBe("transitioning");
    const outside = createPlayerInitialState();
    outside.research.completedTechIds.push("quantum_logistics_network");
    outside.entities.push({ id: "outside", kind: "station", planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false, buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "legacy", stationSlots: [], stationRoutes: [], inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0 });
    expect(attachAllInterstellarStationsToQuantumNetwork(outside, "helios").startedIds).toEqual(["outside"]);
  });

  it("connects every eligible orbital collector in stable order and reports every skipped reason", () => {
    const state = createPlayerInitialState();
    const collector = (id: string, options: { locked?: boolean; mode?: "legacy" | "quantum" } = {}): FactoryEntity => ({
      id,
      kind: "station",
      planetId: "giant",
      position: { x: 0, y: 0 },
      interactionLocked: options.locked ?? false,
      buildingId: "orbital_collector",
      quantumMode: options.mode ?? "legacy",
      storedItemId: "hydrogen",
      stationRoutes: [],
      inputs: {},
      outputs: { hydrogen: 100 },
      progress: 0,
      utilization: 0,
      productionRate: 0,
      routingCursor: 0,
      machineCount: 1,
      minerCount: 0,
    });
    state.entities.push(
      collector("collector-b"),
      collector("collector-a"),
      collector("collector-locked", { locked: true }),
      collector("collector-connected", { mode: "quantum" }),
    );
    const source = structuredClone(state);

    const blockedByTechnology = setAllOrbitalCollectorsQuantumMode(state, true);
    expect(blockedByTechnology.startedIds).toEqual([]);
    expect(blockedByTechnology.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: "collector-a", blocker: "technology" }),
      expect.objectContaining({ entityId: "collector-locked", blocker: "locked" }),
      expect.objectContaining({ entityId: "collector-connected", blocker: "technology" }),
    ]));
    expect(state).toEqual(source);

    state.research.completedTechIds.push("quantum_logistics_network");
    const result = setAllOrbitalCollectorsQuantumMode(state, true);
    expect(result.startedIds).toEqual(["collector-a", "collector-b"]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: "collector-locked", blocker: "locked", reason: "轨道采集器已锁定" }),
      expect.objectContaining({ entityId: "collector-connected", blocker: "already-quantum", reason: "已经接入量子采集网络" }),
    ]));
    expect(result.state.entities.find((entity) => entity.id === "collector-a")?.quantumMode).toBe("transitioning");
    expect(state.entities.find((entity) => entity.id === "collector-a")?.quantumMode).toBe("legacy");

    const repeated = setAllOrbitalCollectorsQuantumMode(result.state, true);
    expect(repeated.startedIds).toEqual([]);
    expect(repeated.state).toBe(result.state);
    expect(repeated.skipped).toHaveLength(4);
  });
});
