import {
  createContentPackRegistry,
  createContentPackRuntimeSnapshot,
  registerContentPack,
  type ContentPackRuntimeSnapshot,
} from "./contentPacks";
import { createLogisticsBenchmarkState } from "./logisticsBenchmark";
import { validateContentPack } from "./mods";
import { createSyntheticPerformanceFixture } from "./performanceFixtures";
import { createSpeedrunState } from "./speedrun";
import type { GameState, RecipeId } from "./types";

export type RuntimeWorldWorkloadId =
  | "midgame"
  | "production-heavy"
  | "belt-heavy"
  | "logistics-heavy"
  | "fully-blocked"
  | "content-pack"
  | "speedrun"
  | "offline";

export interface RuntimeWorldWorkload {
  id: RuntimeWorldWorkloadId;
  source: "synthetic";
  description: string;
  state: GameState;
  registry: ContentPackRuntimeSnapshot;
  /** The representative exact interval used by the M-1 matrix. */
  simulationSeconds: number;
}

const FIXED_SPEEDRUN_STARTED_AT = 1_767_225_600_000;
const baselineRegistry = createContentPackRuntimeSnapshot(createContentPackRegistry());

function running(state: GameState): GameState {
  state.paused = false;
  state.timeWarp.enabled = false;
  state.timeWarp.pendingSimulationSeconds = 0;
  state.timeWarp.pendingWallSeconds = 0;
  return state;
}

function midgame(): RuntimeWorldWorkload {
  return {
    id: "midgame",
    source: "synthetic",
    description: "中期混合生产、线路与传统物流",
    state: running(createSyntheticPerformanceFixture("p50")),
    registry: baselineRegistry,
    simulationSeconds: 4,
  };
}

function productionHeavy(): RuntimeWorldWorkload {
  const state = running(createSyntheticPerformanceFixture("terminal2x"));
  // Keep enough routes to exercise input/output boundaries while making the
  // machine/power population dominate this shape.
  state.entities = state.entities.filter((entity) => entity.kind !== "station");
  state.belts = state.belts.slice(0, 128);
  for (const entity of state.entities) {
    if (entity.kind !== "machine") continue;
    entity.machineCount = Math.max(100, entity.machineCount);
    entity.inputs.iron_ore = 1_000_000_000;
    entity.outputs.iron_ingot = 0;
    entity.progress = 0.375;
  }
  return {
    id: "production-heavy",
    source: "synthetic",
    description: "高机器栈与供电计算，少量线路",
    state,
    registry: baselineRegistry,
    simulationSeconds: 4,
  };
}

function beltHeavy(): RuntimeWorldWorkload {
  const state = running(createSyntheticPerformanceFixture("terminal2x"));
  // Existing public terminal fixture has 2,500 routes and three million
  // lanes. Retain only its source/target storage records so station and power
  // work cannot masquerade as belt cost in this dedicated shape.
  state.entities = state.entities.filter((entity) => entity.id === "fixture_source" || entity.id === "fixture_target");
  return {
    id: "belt-heavy",
    source: "synthetic",
    description: "高线路数、高 lane 栈、两阶段容量预留",
    state,
    registry: baselineRegistry,
    simulationSeconds: 4,
  };
}

function logisticsHeavy(): RuntimeWorldWorkload {
  return {
    id: "logistics-heavy",
    source: "synthetic",
    description: "1,024 个跨八行星供需站与调度候选",
    state: running(createLogisticsBenchmarkState(1_024)),
    registry: baselineRegistry,
    simulationSeconds: 4,
  };
}

function fullyBlocked(): RuntimeWorldWorkload {
  const state = running(createSyntheticPerformanceFixture("player"));
  for (const entity of state.entities) {
    if (entity.kind === "machine") {
      entity.inputs = {};
      entity.outputs = { iron_ingot: Number.MAX_SAFE_INTEGER };
      entity.progress = 0;
    } else if (entity.kind === "storage") {
      entity.inputs = { iron_ingot: Number.MAX_SAFE_INTEGER };
      entity.outputs = { iron_ingot: Number.MAX_SAFE_INTEGER };
    } else if (entity.kind === "station") {
      entity.inputs = {};
      entity.outputs = {};
    }
  }
  for (const belt of state.belts) {
    belt.lastFlow = 0;
    belt.congestion = 1;
  }
  return {
    id: "fully-blocked",
    source: "synthetic",
    description: "缺料与满输出并存，全部线路无可结算流量",
    state,
    registry: baselineRegistry,
    simulationSeconds: 4,
  };
}

function contentPack(): RuntimeWorldWorkload {
  const validation = validateContentPack({
    formatVersion: 2,
    id: "runtimeworld_m1_pack",
    name: "RuntimeWorld M-1 Pack",
    version: "1.0.0",
    recipes: [{
      id: "runtimeworld_m1_fast_iron",
      name: "M-1 快速铁块",
      buildingId: "arc_smelter",
      duration: 0.5,
      inputs: [{ itemId: "iron_ore", amount: 2 }],
      outputs: [{ itemId: "iron_ingot", amount: 3 }],
    }],
  });
  if (!validation.valid) throw new Error(`RuntimeWorld workload content pack invalid: ${validation.issues.join("; ")}`);
  const registry = createContentPackRuntimeSnapshot(registerContentPack(createContentPackRegistry(), validation).registry);
  const state = running(createSyntheticPerformanceFixture("p95"));
  const machines = state.entities.filter((entity) => entity.kind === "machine").slice(0, 200);
  for (const machine of machines) {
    machine.recipeId = "runtimeworld_m1_fast_iron" as RecipeId;
    machine.inputs = { iron_ore: 1_000_000 };
    machine.outputs = { iron_ingot: 0 };
    machine.progress = 0.75;
  }
  state.contentPacks = [{ id: "runtimeworld_m1_pack", version: "1.0.0" }];
  return {
    id: "content-pack",
    source: "synthetic",
    description: "自定义配方 registry fingerprint 与运行时目录",
    state,
    registry,
    simulationSeconds: 4,
  };
}

function speedrun(): RuntimeWorldWorkload {
  const state = running(createSyntheticPerformanceFixture("p95"));
  state.mode = "speedrun";
  state.settings.resourceMode = "finite";
  state.speedrun = createSpeedrunState(state, FIXED_SPEEDRUN_STARTED_AT, "runtimeworld-m1-speedrun");
  return {
    id: "speedrun",
    source: "synthetic",
    description: "固定身份与活动时钟的有限资源速通",
    state,
    registry: baselineRegistry,
    simulationSeconds: 4,
  };
}

function offline(): RuntimeWorldWorkload {
  const state = running(createSyntheticPerformanceFixture("p50"));
  return {
    id: "offline",
    source: "synthetic",
    description: "带五秒边界的 offline session 快速形状；长时门禁独立执行",
    state,
    registry: baselineRegistry,
    simulationSeconds: 60,
  };
}

/** Build every workload from public deterministic catalog data only. */
export function createRuntimeWorldWorkloads(): RuntimeWorldWorkload[] {
  return [
    midgame(),
    productionHeavy(),
    beltHeavy(),
    logisticsHeavy(),
    fullyBlocked(),
    contentPack(),
    speedrun(),
    offline(),
  ];
}
