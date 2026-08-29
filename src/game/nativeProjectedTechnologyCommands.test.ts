import { describe, expect, it } from "vitest";
import type { DesktopNativeCoreTechnologyProjectionResult } from "../desktop";
import {
  createNativeProjectedInfiniteResearchAutomationCommand,
  createNativeProjectedQueueTechnologyCommand,
  createNativeProjectedRemoveQueuedTechnologyCommand,
} from "./nativeProjectedTechnologyCommands";

function projection(
  overrides: Partial<DesktopNativeCoreTechnologyProjectionResult> = {},
): DesktopNativeCoreTechnologyProjectionResult {
  const completedTechIds = overrides.completedTechIds ?? [
    "gravity_matrix",
    "research_speed_1",
    "universe_matrix",
  ];
  const queuedTechIds = overrides.queuedTechIds ?? [];
  const progressByTech = overrides.progressByTech ?? [{
    techId: "research_speed_2",
    totalCount: 1,
    truncated: false,
    items: [{ itemId: "gravity_matrix", amount: 9 }],
  }];
  const infiniteResearch = overrides.infiniteResearch ?? [
    { researchId: "matrix_compression", level: 2, historicalLevel: null, progress: "17" },
    { researchId: "vein_utilization", level: 1, historicalLevel: null, progress: "0" },
    { researchId: "galactic_logistics", level: 3, historicalLevel: null, progress: "0" },
    { researchId: "stellar_harnessing", level: 4, historicalLevel: null, progress: "0" },
    { researchId: "continuum_simulation", level: 0, historicalLevel: null, progress: "0" },
  ];
  return {
    schemaVersion: 1,
    projectionType: "technology-v1",
    revision: 7,
    truncated: false,
    limits: { techRows: 512, progressItemsPerTech: 16, infiniteRows: 8 },
    counts: {
      completedTechIds: completedTechIds.length,
      queuedTechIds: queuedTechIds.length,
      progressTechs: progressByTech.length,
      infiniteResearch: infiniteResearch.length,
    },
    selectedTechId: "research_speed_2",
    pausedTechId: null,
    completedTechIds,
    queuedTechIds,
    progressByTech,
    activeInfiniteResearchId: null,
    autoResearch: false,
    infiniteResearch,
    settings: { technologyLayout: "compact", fontScale: 1.25, difficulty: "hard" },
    matrixStock: {
      electromagnetic_matrix: 10,
      energy_matrix: 20,
      structure_matrix: 30,
      information_matrix: 40,
      gravity_matrix: 50,
      universe_matrix: 60,
    },
    ...overrides,
  };
}

describe("native projected technology commands", () => {
  it("appends a queue row from one exact current projection without predicting lab state", () => {
    const command = createNativeProjectedQueueTechnologyCommand({
      baseRevision: 7,
      projection: projection(),
      techId: "research_speed_3",
    });

    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 7,
      topLevelChanges: [{
        path: ["research", "queuedTechIds"],
        operation: "set",
        value: ["research_speed_3"],
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
  });

  it("removes the chosen row and cascades only later rows whose prerequisites disappear", () => {
    const value = projection({
      completedTechIds: ["electromagnetic_matrix"],
      selectedTechId: "electromagnetism",
      queuedTechIds: ["basic_logistics", "thermal_power", "high_efficiency_plasma_control"],
      progressByTech: [],
    });
    const command = createNativeProjectedRemoveQueuedTechnologyCommand({
      baseRevision: 7,
      projection: value,
      techId: "basic_logistics",
    });

    expect(command?.topLevelChanges).toEqual([{
      path: ["research", "queuedTechIds"],
      operation: "set",
      value: ["thermal_power"],
    }]);
    expect(command?.changedEntities).toEqual([]);
  });

  it("toggles infinite automation only after the endgame prerequisite", () => {
    expect(createNativeProjectedInfiniteResearchAutomationCommand({
      baseRevision: 7,
      projection: projection(),
      enabled: true,
    })?.topLevelChanges).toEqual([{
      path: ["endgame", "autoResearch"],
      operation: "set",
      value: true,
    }]);

    expect(createNativeProjectedInfiniteResearchAutomationCommand({
      baseRevision: 7,
      projection: projection({ completedTechIds: ["gravity_matrix", "research_speed_1"] }),
      enabled: true,
    })).toBeNull();
  });

  it("fails closed on stale, truncated, unknown, completed-boundary, and non-queueable input", () => {
    expect(() => createNativeProjectedQueueTechnologyCommand({
      baseRevision: 8,
      projection: projection(),
      techId: "research_speed_3",
    })).toThrow(/revision/);
    expect(() => createNativeProjectedQueueTechnologyCommand({
      baseRevision: 7,
      projection: projection({ truncated: true }),
      techId: "research_speed_3",
    })).toThrow(/完整且未截断/);
    expect(() => createNativeProjectedQueueTechnologyCommand({
      baseRevision: 7,
      projection: projection(),
      techId: "missing_mod_technology" as never,
    })).toThrow(/未知或已停用/);
    expect(() => createNativeProjectedQueueTechnologyCommand({
      baseRevision: 7,
      projection: projection({
        progressByTech: [{
          techId: "research_speed_2",
          totalCount: 5,
          truncated: false,
          items: [
            { itemId: "electromagnetic_matrix", amount: 20 },
            { itemId: "energy_matrix", amount: 20 },
            { itemId: "structure_matrix", amount: 20 },
            { itemId: "information_matrix", amount: 20 },
            { itemId: "gravity_matrix", amount: 20 },
          ],
        }],
      }),
      techId: "research_speed_3",
    })).toThrow(/完成边界/);
    expect(createNativeProjectedQueueTechnologyCommand({
      baseRevision: 7,
      projection: projection(),
      techId: "solar_sail_life_1",
    })).toBeNull();
  });

  it("returns null for an unchanged automation value or a missing queue row", () => {
    expect(createNativeProjectedInfiniteResearchAutomationCommand({
      baseRevision: 7,
      projection: projection(),
      enabled: false,
    })).toBeNull();
    expect(createNativeProjectedRemoveQueuedTechnologyCommand({
      baseRevision: 7,
      projection: projection(),
      techId: "research_speed_3",
    })).toBeNull();
  });
});
