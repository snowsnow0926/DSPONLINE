import { describe, expect, it, vi } from "vitest";

import type { DesktopNativeCoreFactoryReadModelResult } from "../desktop";
import type { NativeFactoryThinViewSource } from "./nativeFactoryThinViewStore";
import {
  NativePlanetNavigationDiscoveryStore,
  type NativePlanetNavigationDiscoveryBinding,
} from "./nativePlanetNavigationDiscoveryStore";

type FactoryNavigationSource = Pick<NativeFactoryThinViewSource, "readVerifiedFactoryReadModel">;

function planetRow(planetId: string, active: boolean) {
  return {
    planetId,
    systemId: active ? "太阳系-α" : "mod/system-β",
    displayName: active ? "家园 🌍" : "模组前哨 🚀",
    code: planetId,
    active,
    discovered: true,
    colonized: true,
    role: active ? null : "量子-工业",
    entityCount: active ? 12 : 3,
    deviceCount: active ? 10 : 2,
    beltCount: active ? 20 : 4,
    constructionQueueCount: active ? 1 : 0,
    powerFactor: active ? 0.75 : 1,
  };
}

function factoryProjection(
  revision: number,
  activePlanetId = "家园-α",
  rows = [planetRow(activePlanetId, true), planetRow("mod-星球-β", false)],
): DesktopNativeCoreFactoryReadModelResult {
  return {
    schemaVersion: 1,
    projectionType: "factory-read-model-v1",
    revision,
    shell: {
      schema: "factory-read-model-v1",
      source: "native-core",
      stateVersion: 47,
      mode: "normal",
      activePlanetId,
      paused: false,
      elapsedSeconds: 12,
      simulationSpeed: 1,
      entityCount: 15,
      beltCount: 24,
      activePlanetEntityCount: 12,
      activePlanetBeltCount: 20,
      constructionQueueCount: 1,
    },
    planetNavigation: {
      schema: "factory-read-model-v1",
      activePlanetId,
      planets: { rows, totalCount: rows.length, truncated: false },
    },
    selection: {
      schema: "factory-read-model-v1",
      activePlanetId,
      requestedEntityCount: 0,
      requestedBeltCount: 0,
      entityRows: { rows: [], totalCount: 0, truncated: false },
      beltRows: { rows: [], totalCount: 0, truncated: false },
    },
    construction: {
      schema: "factory-read-model-v1",
      activePlanetId,
      queue: { rows: [], totalCount: 0, truncated: false },
      automation: {
        enabled: false,
        quantumSourceEnabled: false,
        totalCrafted: 0,
        lastCraftedId: null,
        targets: { rows: [], totalCount: 0, truncated: false },
        jobs: { rows: [], totalCount: 0, truncated: false },
        destroyedByproducts: { rows: [], totalCount: 0, truncated: false },
      },
    },
  };
}

function binding(
  expectedRevision: number,
  sessionId = "native-session-a",
): NativePlanetNavigationDiscoveryBinding {
  return { enabled: true, sessionId, expectedRevision };
}

function source(
  result: DesktopNativeCoreFactoryReadModelResult | null,
): FactoryNavigationSource {
  return {
    readVerifiedFactoryReadModel: vi.fn().mockResolvedValue(result),
  };
}

function invalidProjection(
  edit: (value: Record<string, unknown>) => void,
): DesktopNativeCoreFactoryReadModelResult {
  const value = structuredClone(factoryProjection(7)) as unknown as Record<string, unknown>;
  edit(value);
  return value as unknown as DesktopNativeCoreFactoryReadModelResult;
}

describe("NativePlanetNavigationDiscoveryStore", () => {
  it("discovers one exact Unicode navigation atom without exposing factory state or commands", async () => {
    const store = new NativePlanetNavigationDiscoveryStore();
    const readVerifiedFactoryReadModel = vi.fn().mockResolvedValue(factoryProjection(7));
    const applyCommand = vi.fn();
    const result = await store.refresh({ readVerifiedFactoryReadModel, applyCommand } as unknown as FactoryNavigationSource, binding(7));

    expect(result.status).toBe("committed");
    expect(readVerifiedFactoryReadModel).toHaveBeenCalledWith({
      selectedEntityIds: [],
      selectedBeltIds: [],
    }, 7);
    expect(applyCommand).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      requestedSessionId: "native-session-a",
      requestedRevision: 7,
      frame: {
        sessionId: "native-session-a",
        revision: 7,
        currentPlanetId: "家园-α",
        navigation: { activePlanetId: "家园-α" },
      },
    });
    const frame = store.getSnapshot().frame!;
    expect(Object.keys(frame).sort()).toEqual(["currentPlanetId", "navigation", "revision", "sessionId"]);
    expect(frame).not.toHaveProperty("shell");
    expect(frame).not.toHaveProperty("selection");
    expect(frame).not.toHaveProperty("construction");
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.navigation)).toBe(true);
    expect(Object.isFrozen(frame.navigation.planets)).toBe(true);
    expect(Object.isFrozen(frame.navigation.planets.rows)).toBe(true);
    expect(frame.navigation.planets.rows.every(Object.isFrozen)).toBe(true);
  });

  it("publishes loading then ready and stops notifying an unsubscribed listener", async () => {
    const store = new NativePlanetNavigationDiscoveryStore();
    const notifications: string[] = [];
    const unsubscribe = store.subscribe(() => notifications.push(store.getSnapshot().status));

    await store.refresh(source(factoryProjection(3)), binding(3));
    unsubscribe();
    store.clear();

    expect(notifications).toEqual(["loading", "ready"]);
    expect(store.getSnapshot()).toEqual({
      status: "empty",
      requestedSessionId: null,
      requestedRevision: null,
      frame: null,
    });
  });

  it("fails closed before reading when disabled, unbound, malformed, or unsupported", async () => {
    const readVerifiedFactoryReadModel = vi.fn().mockResolvedValue(factoryProjection(1));
    const readSource = { readVerifiedFactoryReadModel };
    const cases: Array<[FactoryNavigationSource | null, NativePlanetNavigationDiscoveryBinding]> = [
      [readSource, { enabled: false, sessionId: "native-session-a", expectedRevision: 1 }],
      [readSource, { enabled: true, sessionId: null, expectedRevision: 1 }],
      [readSource, { enabled: true, sessionId: "bad/session", expectedRevision: 1 }],
      [readSource, { enabled: true, sessionId: "native-session-a", expectedRevision: -1 }],
      [readSource, { enabled: true, sessionId: "native-session-a", expectedRevision: 1.5 }],
      [null, binding(1)],
    ];

    for (const [candidateSource, candidateBinding] of cases) {
      const store = new NativePlanetNavigationDiscoveryStore();
      await expect(store.refresh(candidateSource, candidateBinding)).resolves.toEqual({ status: "unsupported" });
      expect(store.getSnapshot()).toEqual({
        status: "unsupported",
        requestedSessionId: null,
        requestedRevision: null,
        frame: null,
      });
    }
    expect(readVerifiedFactoryReadModel).not.toHaveBeenCalled();
  });

  it("rejects mismatched factory identity, shell source, incomplete rows, and active-row ambiguity", async () => {
    const malformed = [
      invalidProjection((value) => { value.schemaVersion = 2; }),
      invalidProjection((value) => { value.projectionType = "other"; }),
      invalidProjection((value) => { value.revision = 8; }),
      invalidProjection((value) => { (value.shell as Record<string, unknown>).source = "web-game-state"; }),
      invalidProjection((value) => { (value.shell as Record<string, unknown>).activePlanetId = "other"; }),
      invalidProjection((value) => {
        const planets = ((value.planetNavigation as Record<string, unknown>).planets as Record<string, unknown>);
        planets.truncated = true;
      }),
      invalidProjection((value) => {
        const planets = ((value.planetNavigation as Record<string, unknown>).planets as Record<string, unknown>);
        planets.totalCount = 99;
      }),
      invalidProjection((value) => {
        const rows = (((value.planetNavigation as Record<string, unknown>).planets as Record<string, unknown>).rows as Array<Record<string, unknown>>);
        rows[1]!.planetId = rows[0]!.planetId;
      }),
      invalidProjection((value) => {
        const rows = (((value.planetNavigation as Record<string, unknown>).planets as Record<string, unknown>).rows as Array<Record<string, unknown>>);
        rows[0]!.active = false;
      }),
      invalidProjection((value) => {
        const rows = (((value.planetNavigation as Record<string, unknown>).planets as Record<string, unknown>).rows as Array<Record<string, unknown>>);
        rows[1]!.active = true;
      }),
      factoryProjection(7, "家园-α", Array.from({ length: 65 }, (_, index) => planetRow(`planet-${index}`, index === 0))),
    ];

    for (const projection of malformed) {
      const store = new NativePlanetNavigationDiscoveryStore();
      await expect(store.refresh(source(projection), binding(7))).resolves.toEqual({ status: "unsupported" });
      expect(store.getSnapshot().frame).toBeNull();
    }
  });

  it("rejects malformed UTF-8 text, over-budget IDs, invalid quantities, and non-finite power", async () => {
    const malformed = [
      invalidProjection((value) => {
        const row = ((((value.planetNavigation as Record<string, unknown>).planets as Record<string, unknown>).rows as Array<Record<string, unknown>>)[0]!);
        row.planetId = "bad\ud800id";
      }),
      invalidProjection((value) => {
        const row = ((((value.planetNavigation as Record<string, unknown>).planets as Record<string, unknown>).rows as Array<Record<string, unknown>>)[0]!);
        row.systemId = "x".repeat(161);
      }),
      invalidProjection((value) => {
        const row = ((((value.planetNavigation as Record<string, unknown>).planets as Record<string, unknown>).rows as Array<Record<string, unknown>>)[0]!);
        row.displayName = "x".repeat(2_049);
      }),
      invalidProjection((value) => {
        const row = ((((value.planetNavigation as Record<string, unknown>).planets as Record<string, unknown>).rows as Array<Record<string, unknown>>)[0]!);
        row.entityCount = -1;
      }),
      invalidProjection((value) => {
        const row = ((((value.planetNavigation as Record<string, unknown>).planets as Record<string, unknown>).rows as Array<Record<string, unknown>>)[0]!);
        row.beltCount = 1.25;
      }),
      invalidProjection((value) => {
        const row = ((((value.planetNavigation as Record<string, unknown>).planets as Record<string, unknown>).rows as Array<Record<string, unknown>>)[0]!);
        row.powerFactor = Number.POSITIVE_INFINITY;
      }),
      invalidProjection((value) => {
        const row = ((((value.planetNavigation as Record<string, unknown>).planets as Record<string, unknown>).rows as Array<Record<string, unknown>>)[0]!);
        row.discovered = "yes";
      }),
    ];

    for (const projection of malformed) {
      const store = new NativePlanetNavigationDiscoveryStore();
      await expect(store.refresh(source(projection), binding(7))).resolves.toEqual({ status: "unsupported" });
    }
  });

  it("clears a pending request and prevents its late reply from becoming observable", async () => {
    let resolveFactory!: (value: DesktopNativeCoreFactoryReadModelResult) => void;
    const store = new NativePlanetNavigationDiscoveryStore();
    const pending = store.refresh({
      readVerifiedFactoryReadModel: () => new Promise((resolve) => { resolveFactory = resolve; }),
    }, binding(10));

    expect(store.getSnapshot().status).toBe("loading");
    store.clear();
    resolveFactory(factoryProjection(10));

    await expect(pending).resolves.toEqual({ status: "superseded" });
    expect(store.getSnapshot()).toEqual({
      status: "empty",
      requestedSessionId: null,
      requestedRevision: null,
      frame: null,
    });
  });

  it("lets a newer session/revision win and ignores the older out-of-order reply", async () => {
    let resolveOld!: (value: DesktopNativeCoreFactoryReadModelResult) => void;
    const store = new NativePlanetNavigationDiscoveryStore();
    const oldRefresh = store.refresh({
      readVerifiedFactoryReadModel: () => new Promise((resolve) => { resolveOld = resolve; }),
    }, binding(20, "native-session-old"));

    const current = await store.refresh(
      source(factoryProjection(21, "mod-星球-β", [
        planetRow("家园-α", false),
        planetRow("mod-星球-β", true),
      ])),
      binding(21, "native-session-new"),
    );
    resolveOld(factoryProjection(20));

    expect(current).toMatchObject({ status: "committed", frame: { currentPlanetId: "mod-星球-β" } });
    await expect(oldRefresh).resolves.toEqual({ status: "superseded" });
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      requestedSessionId: "native-session-new",
      requestedRevision: 21,
      frame: { currentPlanetId: "mod-星球-β" },
    });
  });

  it("drops the previous frame when a later read is null, malformed, or throws", async () => {
    const store = new NativePlanetNavigationDiscoveryStore();
    await store.refresh(source(factoryProjection(30)), binding(30));
    expect(store.getSnapshot().status).toBe("ready");

    await expect(store.refresh(source(null), binding(31))).resolves.toEqual({ status: "unsupported" });
    expect(store.getSnapshot()).toMatchObject({ status: "unsupported", requestedRevision: 31, frame: null });

    await expect(store.refresh({
      readVerifiedFactoryReadModel: vi.fn().mockRejectedValue(new Error("projection transport failed")),
    }, binding(32))).resolves.toEqual({ status: "unsupported" });
    expect(store.getSnapshot()).toMatchObject({ status: "unsupported", requestedRevision: 32, frame: null });
  });

  it("detaches the committed navigation rows from a subsequently mutated IPC result", async () => {
    const projection = factoryProjection(40);
    const store = new NativePlanetNavigationDiscoveryStore();
    await store.refresh(source(projection), binding(40));

    const mutableRow = projection.planetNavigation.planets.rows[0] as unknown as Record<string, unknown>;
    mutableRow.displayName = "被篡改";
    mutableRow.active = false;

    const frame = store.getSnapshot().frame!;
    expect(frame.navigation.planets.rows[0]).toMatchObject({ displayName: "家园 🌍", active: true });
    expect(frame.currentPlanetId).toBe("家园-α");
  });
});
