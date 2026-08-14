import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import { createContentPackRegistry } from "./contentPacks";
import { advanceSimulation, createInitialState, placeBuilding } from "./engine";
import { computeSaveStateChecksum } from "./saveEnvelopeIntegrity";
import { projectPersistentSaveState } from "./saveProjection";
import { inspectSave, migrateGame, serializeEnvelope } from "./storage";

const environment = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;

describe("v46 sparse save projection", () => {
  it("consumes the shared contract for every projected entity and belt default", () => {
    const state = createInitialState(1, false);
    const station = structuredClone(state.entities[0]);
    Object.assign(station, {
      id: "contract-station",
      kind: "station",
      buildingId: "interstellar_logistics_station",
      interactionLocked: false,
      powerGridId: "grid-a",
      powerPriority: 2,
      machineCount: 0,
      minerCount: 0,
      progress: 0,
      routingCursor: 0,
      powerInputKw: 0,
      powerOutputKw: 0,
      stationProgress: 0,
      stationTrips: 0,
      stationLastTransfer: 0,
      stationCongestion: 0,
      stationDispatchCursor: 0,
      proliferatorPoints: 0,
      resourceDepletionRemainder: 0,
      stationWarperAutoRefill: false,
      stationHubEnabled: false,
      quantumTarget: false,
      stationWarpEnabled: true,
      proliferatorBonusProgress: {},
      inputs: {},
      outputs: {},
      stationLastSupplyPeerBySlot: {},
      stationRoutes: [],
    });
    state.entities = [station];
    state.belts = [{
      id: "contract-line",
      planetId: station.planetId,
      source: station.id,
      target: station.id,
      itemId: "iron_ore",
      lanes: 1,
      tier: 1,
      sorterTier: 1,
      progress: 0,
      priority: 0,
      stackSize: 1,
      monitorEnabled: false,
      totalTransferred: 0,
      congestion: 0,
      lastFlow: 0,
      routeMode: "auto",
    }];
    const original = structuredClone(state);
    const projected = projectPersistentSaveState(state, createContentPackRegistry());
    const projectedEntity = projected.entities[0] as unknown as Record<string, unknown>;
    const projectedBelt = projected.belts[0] as unknown as Record<string, unknown>;
    for (const key of [
      "interactionLocked", "powerGridId", "powerPriority", "machineCount", "minerCount", "progress", "routingCursor",
      "powerInputKw", "powerOutputKw", "stationProgress", "stationTrips", "stationLastTransfer", "stationCongestion",
      "stationDispatchCursor", "proliferatorPoints", "resourceDepletionRemainder", "stationWarperAutoRefill", "stationHubEnabled",
      "quantumTarget", "stationWarpEnabled", "proliferatorBonusProgress", "inputs", "outputs", "stationLastSupplyPeerBySlot", "stationRoutes",
    ]) expect(projectedEntity).not.toHaveProperty(key);
    for (const key of [
      "lanes", "tier", "sorterTier", "progress", "priority", "stackSize", "monitorEnabled", "totalTransferred", "congestion", "lastFlow", "routeMode",
    ]) expect(projectedBelt).not.toHaveProperty(key);
    expect(state).toEqual(original);
  });

  it("preserves nondefault and explicit invalid values for authoritative validation instead of silently normalizing them", () => {
    const state = createInitialState(1, false);
    const entity = state.entities[0] as unknown as Record<string, unknown>;
    entity.interactionLocked = null;
    entity.powerPriority = 3;
    entity.inputs = { iron_ore: 1 };
    state.belts = [{
      id: "invalid-line",
      planetId: state.entities[0].planetId,
      source: state.entities[0].id,
      target: state.entities[1].id,
      itemId: "iron_ore",
      lanes: 0,
      tier: 4,
      sorterTier: 3,
      progress: -1,
      priority: 2,
      stackSize: 4,
      monitorEnabled: true,
      totalTransferred: 5,
      congestion: 0.5,
      lastFlow: 2,
      routeMode: "upper",
    }];
    const projected = projectPersistentSaveState(state, createContentPackRegistry());
    expect(projected.entities[0]).toMatchObject({ interactionLocked: null, powerPriority: 3, inputs: { iron_ore: 1 } });
    expect(projected.belts[0]).toMatchObject({
      lanes: 0,
      tier: 4,
      progress: -1,
      priority: 2,
      stackSize: 4,
      monitorEnabled: true,
      totalTransferred: 5,
      congestion: 0.5,
      lastFlow: 2,
      routeMode: "upper",
    });
  });

  it("compacts station slots without shifting an interior slot or erasing explicit null/nondefault values", () => {
    const state = createInitialState(1, false);
    state.construction.interstellar_logistics_station = 1;
    const placed = placeBuilding(state, "interstellar_logistics_station", { x: 100, y: 100 });
    const station = placed.entities.at(-1)! as typeof placed.entities[number] & Record<string, unknown>;
    station.stationSlots = [
      {
        itemId: "iron_ore",
        localMode: "supply",
        remoteMode: "storage",
        minimumLoad: 0.25,
        minStock: 17,
        maxStock: 300,
        priority: 2,
        routePolicy: "direct",
        warperBudget: 4,
      },
      { localMode: "storage", remoteMode: "storage", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "relay-preferred", warperBudget: 2 },
      { itemId: "copper_ore", localMode: "storage", remoteMode: "storage", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "relay-preferred", warperBudget: 2 },
      { localMode: "storage", remoteMode: "storage", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "relay-preferred", warperBudget: 2 },
      { localMode: "storage", remoteMode: "storage", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "relay-preferred", warperBudget: 2 },
    ];
    const invalid = station.stationSlots![3] as unknown as Record<string, unknown>;
    invalid.localMode = null;
    const original = structuredClone(placed);

    const projected = projectPersistentSaveState(placed, createContentPackRegistry());
    const projectedStation = projected.entities.at(-1)!;
    expect(projectedStation.stationSlots).toEqual([
      { itemId: "iron_ore", localMode: "supply", minimumLoad: 0.25, minStock: 17, maxStock: 300, priority: 2, routePolicy: "direct", warperBudget: 4 },
      {},
      { itemId: "copper_ore" },
      { localMode: null },
    ]);
    expect(placed).toEqual(original);
  });

  it("loads dense and sparse five-slot stations to the same exact state and 1000-second result", () => {
    let state = createInitialState(1, false);
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 100, y: 100 });
    state.paused = false;
    const station = state.entities.at(-1)!;
    station.stationSlots = [
      { itemId: "iron_ore", localMode: "supply", remoteMode: "storage", minimumLoad: 0.25, minStock: 17, maxStock: 300, priority: 2, routePolicy: "direct", warperBudget: 4 },
      { localMode: "storage", remoteMode: "storage", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "relay-preferred", warperBudget: 2 },
      { itemId: "copper_ore", localMode: "storage", remoteMode: "supply", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "relay-preferred", warperBudget: 2 },
      { localMode: "storage", remoteMode: "storage", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "relay-preferred", warperBudget: 2 },
      { localMode: "storage", remoteMode: "storage", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "relay-preferred", warperBudget: 2 },
    ];
    station.outputs.iron_ore = 23;
    station.outputs.copper_ore = 11;
    station.routingCursor = 7;
    station.stationDispatchCursor = 9;
    station.stationRoutes = [{
      id: "preserved-route",
      slotIndex: 0,
      peerId: station.id,
      itemId: "iron_ore",
      scope: "remote",
      cargo: 5,
      vehicleCount: 1,
      progress: 0.5,
      duration: 20,
      requiresWarp: false,
      vehicleStationId: station.id,
    }];
    state.nextId = 98_765;

    const sparseRaw = serializeEnvelope(state, 1_786_377_600_000);
    const sparseParsed = JSON.parse(sparseRaw) as { state: typeof state };
    expect(sparseParsed.state.entities.at(-1)!.stationSlots).toEqual([
      { itemId: "iron_ore", localMode: "supply", minimumLoad: 0.25, minStock: 17, maxStock: 300, priority: 2, routePolicy: "direct", warperBudget: 4 },
      {},
      { itemId: "copper_ore", remoteMode: "supply" },
    ]);
    const denseState = structuredClone(sparseParsed.state);
    const denseStation = denseState.entities.at(-1)!;
    const defaults = { localMode: "storage" as const, remoteMode: "storage" as const, minimumLoad: 1 as const, minStock: 0, maxStock: 0, priority: 1 as const, routePolicy: "relay-preferred" as const, warperBudget: 2 };
    denseStation.stationSlots = Array.from({ length: 5 }, (_, index) => ({ ...defaults, ...(denseStation.stationSlots?.[index] ?? {}) }));
    const denseRaw = JSON.stringify({
      formatVersion: 2,
      kind: "primary",
      savedAt: 1_786_377_600_000,
      mode: "normal",
      slot: "main",
      state: denseState,
      checksum: computeSaveStateChecksum(2, denseState),
    });
    const denseLoaded = inspectSave(denseRaw);
    const sparseLoaded = inspectSave(sparseRaw);
    expect(denseLoaded).toMatchObject({ valid: true, checksum: "valid", stateVersion: 46 });
    expect(sparseLoaded).toMatchObject({ valid: true, checksum: "valid", stateVersion: 46 });
    expect(sparseLoaded.state).toEqual(denseLoaded.state);
    expect(sparseLoaded.state!.entities.at(-1)!.stationSlots).toHaveLength(5);
    expect(sparseLoaded.state!.entities.at(-1)).toMatchObject({
      outputs: { iron_ore: 23, copper_ore: 11 },
      routingCursor: 7,
      stationDispatchCursor: 9,
      stationRoutes: [{ id: "preserved-route", slotIndex: 0, cargo: 5, vehicleCount: 1 }],
    });
    expect(sparseLoaded.state!.nextId).toBe(98_765);
    const denseAdvanced = advanceSimulation(structuredClone(denseLoaded.state!), 1_000);
    const sparseAdvanced = advanceSimulation(structuredClone(sparseLoaded.state!), 1_000);
    expect(hashGameState(sparseAdvanced)).toBe(hashGameState(denseAdvanced));
    expect(sparseAdvanced).toEqual(denseAdvanced);
  }, 30_000);

  it("does not apply v46 sparse projection rules to a v45 dense state", () => {
    const state = createInitialState(1, false);
    state.version = 45;
    state.entities = [state.entities[0]];
    state.belts = [{
      id: "v45-dense-line",
      planetId: state.entities[0].planetId,
      source: state.entities[0].id,
      target: state.entities[0].id,
      itemId: "iron_ore",
      lanes: 1,
      tier: 1,
      sorterTier: 1,
      progress: 0,
      priority: 0,
      stackSize: 1,
      monitorEnabled: false,
      totalTransferred: 0,
      congestion: 0,
      lastFlow: 0,
      routeMode: "auto",
    }];
    const projected = projectPersistentSaveState(state, createContentPackRegistry());
    expect(projected.entities[0]).toHaveProperty("interactionLocked", false);
    expect(projected.entities[0]).toHaveProperty("inputs");
    expect(projected.entities[0]).toHaveProperty("outputs");
    expect(projected.belts[0]).toMatchObject({
      lanes: 1,
      tier: 1,
      sorterTier: 1,
      progress: 0,
      priority: 0,
      stackSize: 1,
      monitorEnabled: false,
      totalTransferred: 0,
      congestion: 0,
      lastFlow: 0,
      routeMode: "auto",
    });
  });

  it("omits only default/zero runtime fields while preserving authoritative nonzero state", () => {
    const state = createInitialState(1, false);
    const primary = state.entities[0];
    const secondary = state.entities[1];
    primary.inputs.iron_ore = 42;
    primary.outputs.iron_ore = 7;
    primary.progress = 0.5;
    primary.powerFactor = 0.8;
    primary.productionRate = 12;
    secondary.inputs = {};
    secondary.outputs = { copper_ore: 0 };
    state.belts.push({
      id: "compact-line",
      planetId: primary.planetId,
      source: primary.id,
      target: secondary.id,
      itemId: "iron_ore",
      lanes: 1,
      tier: 1,
      sorterTier: 1,
      progress: 0,
      priority: 0,
      stackSize: 1,
      monitorEnabled: false,
      totalTransferred: 0,
      congestion: 0,
      lastFlow: 0,
      routeMode: "auto",
    });
    const raw = serializeEnvelope(state, 1_786_377_600_000);
    const parsed = JSON.parse(raw) as { state: typeof state };
    const persistedPrimary = parsed.state.entities.find((entity) => entity.id === primary.id)! as unknown as Record<string, unknown>;
    const persistedSecondary = parsed.state.entities.find((entity) => entity.id === secondary.id)! as unknown as Record<string, unknown>;
    const persistedBelt = parsed.state.belts[0] as unknown as Record<string, unknown>;
    expect(persistedPrimary).toMatchObject({ inputs: { iron_ore: 42 }, outputs: { iron_ore: 7 }, progress: 0.5, powerFactor: 0.8, productionRate: 12 });
    expect(persistedSecondary).not.toHaveProperty("inputs");
    expect(persistedSecondary).toHaveProperty("outputs.copper_ore", 0);
    for (const key of ["lanes", "tier", "sorterTier", "progress", "priority", "stackSize", "monitorEnabled", "totalTransferred", "congestion", "lastFlow", "routeMode"]) {
      expect(persistedBelt).not.toHaveProperty(key);
    }
    const inspection = inspectSave(raw);
    expect(inspection).toMatchObject({ valid: true, checksum: "valid", stateVersion: 46 });
    expect(inspection.state!.entities.find((entity) => entity.id === primary.id)).toMatchObject({
      inputs: { iron_ore: 42 }, outputs: { iron_ore: 7 }, progress: 0.5, powerFactor: 0.8, productionRate: 12,
    });
    expect(inspection.state!.belts[0]).toMatchObject({ lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 0, stackSize: 1, lastFlow: 0 });
  });

  it("preserves explicit micro black hole operation intent while missing legacy flags stay safely paused", () => {
    const state = createInitialState(1, false);
    const makeBlackHole = (index: number, id: string, flags?: { paused: boolean; confirmed: boolean }) => {
      const entity = structuredClone(state.entities[index]) as typeof state.entities[number] & Record<string, unknown>;
      Object.assign(entity, {
        id,
        kind: "machine",
        buildingId: "micro_black_hole_connector",
        blackHolePorts: [0, 1, 2].map((portIndex) => ({ index: portIndex, totalDestroyed: "0" })),
      });
      if (flags) {
        entity.blackHolePaused = flags.paused;
        entity.blackHoleActivationConfirmed = flags.confirmed;
      } else {
        delete entity.blackHolePaused;
        delete entity.blackHoleActivationConfirmed;
      }
      return entity;
    };
    const legacyMissing = makeBlackHole(2, "black-hole-legacy-missing");
    state.entities = [
      makeBlackHole(0, "black-hole-running", { paused: false, confirmed: true }),
      makeBlackHole(1, "black-hole-player-paused", { paused: true, confirmed: true }),
    ];
    state.belts = [];

    const raw = serializeEnvelope(state, 1_786_377_600_000);
    const persisted = JSON.parse(raw) as { state: typeof state };
    const persistedRunning = persisted.state.entities.find((entity) => entity.id === "black-hole-running")!;
    const persistedPaused = persisted.state.entities.find((entity) => entity.id === "black-hole-player-paused")!;
    expect(persistedRunning).toMatchObject({
      blackHolePaused: false,
      blackHoleActivationConfirmed: true,
    });
    expect(persistedPaused).toMatchObject({
      blackHolePaused: true,
      blackHoleActivationConfirmed: true,
    });
    for (const projected of [persistedRunning, persistedPaused]) {
      expect(Object.prototype.hasOwnProperty.call(projected, "blackHolePaused")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(projected, "blackHoleActivationConfirmed")).toBe(true);
    }
    const loaded = inspectSave(raw);
    expect(loaded).toMatchObject({ valid: true, checksum: "valid", stateVersion: 46 });
    expect(loaded.state!.entities.find((entity) => entity.id === "black-hole-running")).toMatchObject({
      blackHolePaused: false,
      blackHoleActivationConfirmed: true,
    });
    expect(loaded.state!.entities.find((entity) => entity.id === "black-hole-player-paused")).toMatchObject({
      blackHolePaused: true,
      blackHoleActivationConfirmed: true,
    });
    const legacyState = structuredClone(state);
    legacyState.entities.push(legacyMissing);
    const legacyEnvelope = {
      formatVersion: 2,
      kind: "primary",
      mode: "normal",
      slot: "main",
      savedAt: 1_786_377_599_000,
      state: legacyState,
      checksum: computeSaveStateChecksum(2, legacyState),
    };
    const legacyLoaded = inspectSave(JSON.stringify(legacyEnvelope));
    expect(legacyLoaded.valid).toBe(true);
    expect(legacyLoaded.state!.entities.find((entity) => entity.id === "black-hole-legacy-missing")).toMatchObject({
      blackHolePaused: true,
      blackHoleActivationConfirmed: false,
    });
    expect(() => serializeEnvelope(legacyState, 1_786_377_600_001)).toThrow(/explicit pause and activation-confirmation state/);
  });

  it("loads an uncompressed v46 envelope and keeps the next exact step identical after sparse round-trip", () => {
    const state = createInitialState(1, false);
    state.paused = false;
    const oldEnvelope = {
      formatVersion: 2,
      kind: "primary",
      savedAt: 100,
      mode: "normal",
      slot: "main",
      state,
      checksum: computeSaveStateChecksum(2, state),
    };
    const oldInspection = inspectSave(JSON.stringify(oldEnvelope));
    expect(oldInspection.valid).toBe(true);
    const compactInspection = inspectSave(serializeEnvelope(oldInspection.state!, 101));
    expect(compactInspection.valid).toBe(true);
    expect(hashGameState(advanceSimulation(structuredClone(oldInspection.state!), 5))).toBe(
      hashGameState(advanceSimulation(structuredClone(compactInspection.state!), 5)),
    );
  });

  it("keeps a deterministic lean 2x anonymous semantic fixture below 60 MiB", () => {
    const entityCount = 27_153 * 2;
    const beltCount = 48_917 * 2;
    const stationCount = 10_593 * 2;
    let templates = createInitialState(1, false);
    templates.construction.interstellar_logistics_station = 1;
    templates.construction.storage_mk1 = 1;
    templates = placeBuilding(templates, "interstellar_logistics_station", { x: 0, y: 0 });
    templates = placeBuilding(templates, "storage_mk1", { x: 300, y: 0 });
    const stationTemplate = templates.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    const storageTemplate = templates.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    const state = createInitialState(1, false);
    const resourceEntities = state.entities.map((entity) => structuredClone(entity));
    const anonymousEntities = Array.from({ length: entityCount - resourceEntities.length }, (_, index) => {
      const template = index < stationCount ? stationTemplate : storageTemplate;
      return {
        ...template,
        id: `anonymous_entity_${index}`,
        position: { x: (index % 500) * 20, y: Math.floor(index / 500) * 20 },
        inputs: {},
        outputs: {},
        ...(template.stationSlots ? { stationSlots: template.stationSlots.map((slot) => ({ ...slot })) } : {}),
      };
    });
    state.entities = [...resourceEntities, ...anonymousEntities];
    state.belts = Array.from({ length: beltCount }, (_, index) => ({
      id: `anonymous_belt_${index}`,
      planetId: "home" as const,
      source: "anonymous_entity_0",
      target: `anonymous_entity_${stationCount}`,
      itemId: "iron_ore" as const,
      lanes: 1,
      tier: 1 as const,
      sorterTier: 1 as const,
      progress: 0,
      priority: 0 as const,
      stackSize: 1 as const,
      monitorEnabled: false,
      totalTransferred: 0,
      congestion: 0,
      lastFlow: 0,
      routeMode: "auto" as const,
    }));
    state.nextId = entityCount + beltCount + 1;

    const raw = serializeEnvelope(state, 1_786_377_600_000);
    const bytes = new TextEncoder().encode(raw).byteLength;
    const inspection = inspectSave(raw);
    console.log(`V144_ANONYMOUS_2X_SAVE ${JSON.stringify({ bytes, entityCount, beltCount, stationCount })}`);
    expect(bytes).toBeLessThanOrEqual(60 * 1024 * 1024);
    expect(inspection).toMatchObject({ valid: true, checksum: "valid", stateVersion: 46 });
    expect(inspection.state?.entities).toHaveLength(entityCount);
    expect(inspection.state?.belts).toHaveLength(beltCount);
  }, 120_000);

  it.skipIf(!environment?.DSP_REAL_FIXTURE)("measures read-only real-save reduction and reload integrity", () => {
    const sourcePath = environment!.DSP_REAL_FIXTURE!;
    const beforeStat = statSync(sourcePath);
    const sourceRaw = readFileSync(sourcePath, "utf8");
    const beforeHash = createHash("sha256").update(sourceRaw).digest("hex");
    const parsed = JSON.parse(sourceRaw);
    const state = migrateGame(parsed.state ?? parsed);
    expect(state).not.toBeNull();
    const compactRaw = serializeEnvelope(state!, 1_786_377_600_000);
    const sourceBytes = new TextEncoder().encode(sourceRaw).byteLength;
    const compactBytes = new TextEncoder().encode(compactRaw).byteLength;
    const inspection = inspectSave(compactRaw);
    const report = {
      sourceBytes,
      compactBytes,
      reductionBytes: sourceBytes - compactBytes,
      reductionRatio: Number(((sourceBytes - compactBytes) / sourceBytes).toFixed(4)),
      entities: state!.entities.length,
      belts: state!.belts.length,
    };
    console.log(`V138_SAVE_COMPACTION ${JSON.stringify(report)}`);
    expect(inspection).toMatchObject({ valid: true, checksum: "valid", stateVersion: 46 });
    expect(compactBytes).toBeLessThan(sourceBytes);
    if (sourceBytes >= 35 * 1024 * 1024 && sourceBytes <= 36 * 1024 * 1024) {
      expect(compactBytes).toBeLessThanOrEqual(Math.floor(29.7 * 1024 * 1024));
    }

    // Preserve the player's field distribution instead of treating the lean
    // synthetic fixture above as a byte-shape proxy. The second factory is
    // built only in memory with a deterministic one-character ID namespace;
    // every entity/belt endpoint and station route reference is remapped.
    const remapEntityId = new Map(state!.entities.map((entity) => [entity.id, `~${entity.id}`]));
    const remapReference = (id: string): string => remapEntityId.get(id) ?? id;
    const copiedEntities = state!.entities.map((source) => {
      const entity = structuredClone(source);
      entity.id = remapReference(source.id);
      if (entity.stationPeerId) entity.stationPeerId = remapReference(entity.stationPeerId);
      if (entity.stationLastSupplyPeerBySlot) {
        entity.stationLastSupplyPeerBySlot = Object.fromEntries(
          Object.entries(entity.stationLastSupplyPeerBySlot).map(([slot, peerId]) => [slot, peerId === undefined ? peerId : remapReference(peerId)]),
        );
      }
      if (entity.stationRoutes) {
        entity.stationRoutes = entity.stationRoutes.map((route) => ({
          ...route,
          id: `~${route.id}`,
          peerId: remapReference(route.peerId),
          ...(route.vehicleStationId ? { vehicleStationId: remapReference(route.vehicleStationId) } : {}),
          ...(route.waypointStationIds ? { waypointStationIds: route.waypointStationIds.map(remapReference) } : {}),
        }));
      }
      return entity;
    });
    const copiedBelts = state!.belts.map((source) => ({
      ...structuredClone(source),
      id: `~${source.id}`,
      source: remapReference(source.source),
      target: remapReference(source.target),
    }));
    const doubledState = structuredClone(state!);
    doubledState.entities = [...state!.entities, ...copiedEntities];
    doubledState.belts = [...state!.belts, ...copiedBelts];
    const doubledRaw = serializeEnvelope(doubledState, 1_786_377_600_001);
    const doubledBytes = new TextEncoder().encode(doubledRaw).byteLength;
    const doubledInspection = inspectSave(doubledRaw);
    console.log(`V144_REAL_SHAPE_2X_SAVE ${JSON.stringify({
      bytes: doubledBytes,
      entities: doubledState.entities.length,
      belts: doubledState.belts.length,
      stationCount: doubledState.entities.filter((entity) => Boolean(entity.stationSlots)).length,
    })}`);
    expect(doubledBytes).toBeLessThanOrEqual(60 * 1024 * 1024);
    expect(doubledInspection).toMatchObject({ valid: true, checksum: "valid", stateVersion: 46 });
    expect(doubledInspection.state?.entities).toHaveLength(state!.entities.length * 2);
    expect(doubledInspection.state?.belts).toHaveLength(state!.belts.length * 2);

    const afterStat = statSync(sourcePath);
    const afterHash = createHash("sha256").update(readFileSync(sourcePath, "utf8")).digest("hex");
    expect({ bytes: afterStat.size, modified: afterStat.mtimeMs, hash: afterHash }).toEqual({
      bytes: beforeStat.size,
      modified: beforeStat.mtimeMs,
      hash: beforeHash,
    });
  }, 120_000);
});
