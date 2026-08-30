import { describe, expect, it } from "vitest";
import type { DesktopNativeCoreTechnologyProjectionResult } from "../desktop";
import { TECHNOLOGIES } from "./content";
import {
  cancelCurrentResearch,
  createInitialState,
  pauseCurrentResearch,
  selectTechnology,
} from "./engine";
import {
  createNativeProjectedCancelResearchCommand,
  createNativeProjectedInfiniteResearchAutomationCommand,
  createNativeProjectedPauseResearchCommand,
  createNativeProjectedQueueTechnologyCommand,
  createNativeProjectedRemoveQueuedTechnologyCommand,
  createNativeProjectedResumeResearchCommand,
  createNativeProjectedSelectInfiniteResearchCommand,
  createNativeProjectedSelectTechnologyCommand,
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
  it("uses the existing JavaScript lifecycle as the pause, cancel, and alternate-target oracle", () => {
    const alternateSource = createInitialState();
    alternateSource.research.completedTechIds = ["electromagnetism"];
    alternateSource.research.selectedTechId = null;
    alternateSource.research.pausedTechId = "basic_logistics";
    const alternate = selectTechnology(alternateSource, "thermal_power");
    expect(alternate.research).toMatchObject({
      selectedTechId: "thermal_power",
      pausedTechId: "basic_logistics",
    });

    const infiniteSource = createInitialState();
    infiniteSource.research.completedTechIds = ["electromagnetism"];
    infiniteSource.research.selectedTechId = null;
    infiniteSource.research.queuedTechIds = ["basic_logistics"];
    infiniteSource.endgame.activeInfiniteResearchId = "matrix_compression";
    const paused = pauseCurrentResearch(infiniteSource);
    expect(paused.research).toMatchObject({
      selectedTechId: null,
      queuedTechIds: ["basic_logistics"],
    });
    expect(paused.endgame.activeInfiniteResearchId).toBeNull();
    const canceled = cancelCurrentResearch(infiniteSource);
    expect(canceled.research).toMatchObject({
      selectedTechId: "basic_logistics",
      queuedTechIds: [],
    });
    expect(canceled.endgame.activeInfiniteResearchId).toBeNull();
  });

  it("uses JavaScript completion as the construction, exploration, and exporter reward oracle", () => {
    const complete = (techId: keyof typeof TECHNOLOGIES) => {
      const source = createInitialState();
      source.research.selectedTechId = techId;
      source.research.progressByTech[techId] = Object.fromEntries(
        TECHNOLOGIES[techId].costs.map((cost) => [cost.itemId, cost.amount]),
      );
      source.research.completedTechIds = [];
      return cancelCurrentResearch(source);
    };

    const constructionSource = createInitialState();
    const beltBefore = constructionSource.construction.conveyor_belt_mk1 ?? 0;
    constructionSource.research.selectedTechId = "basic_logistics";
    constructionSource.research.progressByTech.basic_logistics = { electromagnetic_matrix: 8 };
    constructionSource.research.completedTechIds = ["electromagnetic_matrix", "electromagnetism"];
    expect(cancelCurrentResearch(constructionSource).construction.conveyor_belt_mk1)
      .toBe(beltBefore + 2);

    expect(complete("interstellar_logistics").exploration.colonizedPlanetIds)
      .toEqual(expect.arrayContaining(["ashen", "giant"]));
    expect(complete("universe_matrix").construction.galactic_material_exporter).toBe(1);
  });

  it("submits only the finite lifecycle intent and lets Rust derive lab resets", () => {
    const paused = projection({ selectedTechId: null, pausedTechId: "research_speed_2" });
    expect(createNativeProjectedResumeResearchCommand({ baseRevision: 7, projection: paused })?.topLevelChanges)
      .toEqual([{ path: ["research", "selectedTechId"], operation: "set", value: "research_speed_2" }]);
    expect(createNativeProjectedSelectTechnologyCommand({
      baseRevision: 7,
      projection: paused,
      techId: "electromagnetic_matrix",
    })?.topLevelChanges).toEqual([{
      path: ["research", "selectedTechId"],
      operation: "set",
      value: "electromagnetic_matrix",
    }]);

    const active = projection();
    expect(createNativeProjectedPauseResearchCommand({ baseRevision: 7, projection: active })?.topLevelChanges)
      .toEqual([{ path: ["research", "pausedTechId"], operation: "set", value: "research_speed_2" }]);
    expect(createNativeProjectedCancelResearchCommand({ baseRevision: 7, projection: active })?.topLevelChanges)
      .toEqual([{ path: ["research", "selectedTechId"], operation: "set", value: null }]);
  });

  it("distinguishes pausing infinite research from cancellation that may promote its queue", () => {
    const activeInfinite = projection({
      selectedTechId: null,
      activeInfiniteResearchId: "matrix_compression",
      queuedTechIds: ["electromagnetic_matrix"],
    });
    expect(createNativeProjectedPauseResearchCommand({
      baseRevision: 7,
      projection: activeInfinite,
    })?.topLevelChanges).toEqual([{
      path: ["endgame", "activeInfiniteResearchId"],
      operation: "set",
      value: null,
    }]);
    expect(createNativeProjectedCancelResearchCommand({
      baseRevision: 7,
      projection: activeInfinite,
    })?.topLevelChanges).toEqual([{
      path: ["research", "selectedTechId"],
      operation: "set",
      value: null,
    }]);
  });

  it("selects an unlocked infinite target but conservatively blocks it during finite research", () => {
    expect(createNativeProjectedSelectInfiniteResearchCommand({
      baseRevision: 7,
      projection: projection({ selectedTechId: null }),
      researchId: "matrix_compression",
    })?.topLevelChanges).toEqual([{
      path: ["endgame", "activeInfiniteResearchId"],
      operation: "set",
      value: "matrix_compression",
    }]);
    expect(createNativeProjectedSelectInfiniteResearchCommand({
      baseRevision: 7,
      projection: projection(),
      researchId: "matrix_compression",
    })).toBeNull();
  });

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
