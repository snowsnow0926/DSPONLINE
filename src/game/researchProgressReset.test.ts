import { describe, expect, it } from "vitest";
import { TECHNOLOGIES } from "./content";
import { hashGameState } from "./benchmark";
import { advanceSimulationSession, completeSimulationAdvanceSession, createSimulationAdvanceSession,
  createInitialState, placeBuilding, type SimulationAdvanceOptions } from "./engine";
import type { FactoryEntity, TechId } from "./types";

function advance(state: ReturnType<typeof createInitialState>, seconds: number, options: SimulationAdvanceOptions) {
  const session = createSimulationAdvanceSession(state, seconds, { ...options, mutateState: true, wallSeconds: seconds });
  advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  return completeSimulationAdvanceSession(session);
}

function fixture(mode: "infinite" | "finite" | "last-level") {
  let state = createInitialState(20261026, false);
  state.paused = false;
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as TechId[];
  state.construction.wind_turbine = 10_000;
  state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 10_000);
  state.construction.matrix_lab = 1;
  state = placeBuilding(state, "matrix_lab", { x: 10, y: 0 });
  const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  const lab = state.entities.find((entity) => entity.buildingId === "matrix_lab")!;
  state.entities = [wind, { ...structuredClone(wind), id: "frost-wind", planetId: "frost" },
    ...Array.from({ length: 12 }, (_, index): FactoryEntity => ({
      ...structuredClone(lab), id: `lab-${index}`, planetId: index % 2 ? "frost" : "home",
      recipeId: "matrix_research", machineCount: index > 9 || index % 3 === 0 ? 1 : 100,
      inputs: { universe_matrix: index % 4 ? 10_000 : 0, electromagnetic_matrix: 10_000 },
      outputs: {}, progress: index > 9 ? 0 : 0.7,
    })),
    { ...structuredClone(lab), id: "legacy-nonmachine-research", kind: "storage", recipeId: "matrix_research", progress: 0.7 },
  ];
  state.endgame.activeInfiniteResearchId = "matrix_compression";
  state.endgame.infiniteResearch.matrix_compression = { level: mode === "infinite" ? 320 : 0, progress: "0" };
  state.endgame.autoResearch = mode !== "last-level";
  if (mode === "finite") {
    state.research.completedTechIds = state.research.completedTechIds.filter((id) => id !== "electromagnetism" && id !== "thermal_power");
    state.research.selectedTechId = "electromagnetism";
    state.research.queuedTechIds = ["thermal_power"];
  }
  return state;
}

describe("batched research progress resets", () => {
  it.each(["infinite", "finite", "last-level"] as const)("matches eager resets at every planet boundary: %s", (mode) => {
    for (const indexedLogistics of [false, true]) {
      let eager = fixture(mode);
      let batched = structuredClone(eager);
      for (const seconds of [0.001, 0.1, 1.7, 6.4]) {
        const observed: number[][] = [];
        const expected: number[][] = [];
        eager = advance(eager, seconds, { indexedLogistics,
          contractExperiment: { eagerResearchProgressResetForTest: true,
            afterPlanetProduction: (state) => expected.push(state.entities.filter((entity) => entity.recipeId === "matrix_research").map((entity) => entity.progress)),
          },
        });
        batched = advance(batched, seconds, { indexedLogistics,
          contractExperiment: {
            afterPlanetProduction: (state) => observed.push(state.entities.filter((entity) => entity.recipeId === "matrix_research").map((entity) => entity.progress)),
          },
        });
        expect(observed).toEqual(expected);
        expect(hashGameState(batched)).toBe(hashGameState(eager));
      }
    }
  });

  it("clears an unrelated research record once per active planet instead of once per deposit", () => {
    const countResets = (eager: boolean) => {
      const state = fixture("infinite");
      const record = state.entities.find((entity) => entity.id === "legacy-nonmachine-research")!;
      let progress = record.progress;
      let resets = 0;
      Object.defineProperty(record, "progress", { enumerable: true, get: () => progress,
        set: (next: number) => { progress = next; if (next === 0) resets += 1; } });
      advance(state, 0.1, { mutateState: true,
        contractExperiment: { eagerResearchProgressResetForTest: eager } });
      return resets;
    };
    expect(countResets(true)).toBeGreaterThan(2);
    expect(countResets(false)).toBeLessThanOrEqual(2);
  });
});
