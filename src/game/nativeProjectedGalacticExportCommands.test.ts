import { describe, expect, it } from "vitest";
import type { DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult } from "../desktop";
import type { FactoryEntity } from "./types";
import type { NativeGalaxyWorkspaceFrame } from "./nativeCampaignGalaxyWorkspaceStore";
import {
  createNativeProjectedGalacticExporterPauseCommand,
  createNativeProjectedGalacticExportCommand,
} from "./nativeProjectedGalacticExportCommands";

function frame(): NativeGalaxyWorkspaceFrame {
  const projection: DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult = {
    schemaVersion: 1, projectionType: "galaxy-account-workspace-v1", source: "native-core",
    stateVersion: 47, sessionId: "session-1", runId: "run-1", revision: 7,
    registryFingerprint: "7df8cf3a", truncated: false,
    limits: { payloadBytes: 65536, decimalDigits: 256 },
    game: { mode: "normal", elapsedSeconds: "1", difficulty: "standard" },
    production: { totalProduced: "0", universeMatrixProduced: "0", generationKw: "0", throughputPerMinute: "0" },
    progress: { campaignCompleted: 0, campaignTotal: 1, researchCompleted: 1, exploredSystems: 1, colonizedPlanets: 1, galacticScore: "0" },
    dyson: { powerKw: "0", structurePoints: "0", rocketsLaunched: "0", sailsLaunched: "0" },
    galacticExports: {
      unlocked: true, inputMode: "legacy-network", autoDispatch: false, dispatchThrottle: 1,
      galacticCredits: "0", galacticScore: "0", totalExported: "0", exportedLastMinute: "0",
      exporters: { total: 1, paused: 1, running: 0 },
      projects: [
        { id: "universe_archive", itemId: "universe_matrix", enabled: false, priority: 1, level: "0", delivered: "0", totalDelivered: "0", dispatchProgress: "0", target: "1000", reserve: "120" },
        { id: "solar_sail_array", itemId: "solar_sail", enabled: false, priority: 1, level: "0", delivered: "0", totalDelivered: "0", dispatchProgress: "0", target: "5000", reserve: "240" },
        { id: "carrier_rocket_fleet", itemId: "small_carrier_rocket", enabled: false, priority: 1, level: "0", delivered: "0", totalDelivered: "0", dispatchProgress: "0", target: "1000", reserve: "60" },
        { id: "antimatter_exchange", itemId: "antimatter_fuel_rod", enabled: false, priority: 1, level: "0", delivered: "0", totalDelivered: "0", dispatchProgress: "0", target: "500", reserve: "24" },
      ],
    },
    cloudCompatibility: { gameStateVersion: 47, envelopeVersion: 2, cloudSchemaVersion: 8, exportSupported: true, restoreIntoActiveAuthority: false, importIntoActiveAuthority: false, overwriteActiveAuthority: false },
  };
  return Object.freeze({
    source: "native-core", sessionId: "session-1", runId: "run-1", revision: 7,
    registryFingerprint: "7df8cf3a", projection,
  });
}

function exporter(): FactoryEntity {
  return {
    id: "exporter-1", kind: "machine", planetId: "home", position: { x: 0, y: 0 },
    interactionLocked: false, buildingId: "galactic_material_exporter",
    machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0,
    routingCursor: 0, utilization: 0, productionRate: 0, galacticExporterPaused: true,
  } as unknown as FactoryEntity;
}

describe("native projected galactic export commands", () => {
  it("emits only one bounded top-level semantic marker", () => {
    expect(() => createNativeProjectedGalacticExportCommand(frame(), {
      type: "manual-dispatch", projectId: "universe_archive", requestedAmount: "001",
    })).toThrow();
    const command = createNativeProjectedGalacticExportCommand(frame(), {
      type: "manual-dispatch", projectId: "universe_archive", requestedAmount: "900",
    })!;
    expect(command).toMatchObject({
      baseRevision: 7,
      topLevelChanges: [{
        path: ["galacticExports", "intent"], operation: "set",
        value: { type: "manual-dispatch", projectId: "universe_archive", requestedAmount: "900" },
      }],
      changedEntities: [], changedBelts: [], removedEntityIds: [], removedBeltIds: [],
    });
  });

  it("rejects no-ops, stale shape and out-of-range quantities", () => {
    expect(createNativeProjectedGalacticExportCommand(frame(), {
      type: "set-auto-dispatch", enabled: false,
    })).toBeNull();
    expect(() => createNativeProjectedGalacticExportCommand(frame(), {
      type: "manual-dispatch", projectId: "universe_archive", requestedAmount: "9007199254740992",
    })).toThrow();
    const stale = frame();
    stale.projection.revision = 8;
    expect(() => createNativeProjectedGalacticExportCommand(stale, {
      type: "set-project-priority", projectId: "universe_archive", priority: 2,
    })).toThrow();
    const duplicate = frame();
    duplicate.projection.galacticExports.projects[3] = {
      ...duplicate.projection.galacticExports.projects[2],
    };
    expect(() => createNativeProjectedGalacticExportCommand(duplicate, {
      type: "set-project-priority", projectId: "universe_archive", priority: 2,
    })).toThrow();
    const itemDrift = frame();
    itemDrift.projection.galacticExports.projects[0] = {
      ...itemDrift.projection.galacticExports.projects[0],
      itemId: "solar_sail",
    };
    expect(() => createNativeProjectedGalacticExportCommand(itemDrift, {
      type: "set-project-priority", projectId: "universe_archive", priority: 2,
    })).toThrow();
  });

  it("emits one exporter pause intent without an authored entity patch", () => {
    const command = createNativeProjectedGalacticExporterPauseCommand({
      sessionId: "session-1", runId: "run-1", revision: 7, activePlanetId: "home", entity: exporter(),
    }, false)!;
    expect(command.changedEntities).toEqual([{ id: "exporter-1", changes: [{
      path: ["galacticExporter", "pauseIntent"], operation: "set", value: { paused: false },
    }] }]);
    expect(() => createNativeProjectedGalacticExporterPauseCommand({
      sessionId: "session-1", runId: "run-1", revision: 7, activePlanetId: "home",
      entity: { ...exporter(), id: "bad\nexporter" },
    }, false)).toThrow();
  });
});
