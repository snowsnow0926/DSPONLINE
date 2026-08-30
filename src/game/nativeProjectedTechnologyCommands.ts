import type { DesktopNativeCoreTechnologyProjectionResult } from "../desktop";
import { getTechnology, isDeprecatedTechnology } from "./content";
import { isInfiniteResearchComplete } from "./infiniteResearch";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import {
  selectNativeTechnologyWorkspaceReadModel,
  type TechnologyWorkspaceReadModel,
} from "./technologyWorkspaceReadModel";
import type { InfiniteResearchId, TechnologyLayoutMode, TechId } from "./types";

const COMMAND_PROJECTION_SESSION_ID = "native-technology-command";

interface NativeProjectedTechnologyCommandInput {
  /** Exact revision carried by the verified technology-v1 projection. */
  readonly baseRevision: number;
  /** Complete, non-truncated technology-v1 atom for the same revision. */
  readonly projection: DesktopNativeCoreTechnologyProjectionResult;
}

export interface NativeProjectedQueueTechnologyCommandInput
  extends NativeProjectedTechnologyCommandInput {
  readonly techId: TechId;
}

export interface NativeProjectedRemoveQueuedTechnologyCommandInput
  extends NativeProjectedTechnologyCommandInput {
  readonly techId: TechId;
}

export interface NativeProjectedInfiniteResearchAutomationCommandInput
  extends NativeProjectedTechnologyCommandInput {
  readonly enabled: boolean;
}

export interface NativeProjectedSelectInfiniteResearchCommandInput
  extends NativeProjectedTechnologyCommandInput {
  readonly researchId: InfiniteResearchId;
}

export interface NativeProjectedTechnologyLayoutCommandInput
  extends NativeProjectedTechnologyCommandInput {
  readonly layout: TechnologyLayoutMode;
}

function emptyCommand(baseRevision: number): SimulationCommandPatch {
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

function requireExactNativeReadModel(
  input: NativeProjectedTechnologyCommandInput,
): TechnologyWorkspaceReadModel {
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 ||
      input.projection.revision !== input.baseRevision) {
    throw new TypeError("原生科研命令 revision 与投影不一致");
  }
  const readModel = selectNativeTechnologyWorkspaceReadModel({
    sessionId: COMMAND_PROJECTION_SESSION_ID,
    revision: input.baseRevision,
    projection: input.projection,
  }, {
    enabled: true,
    sessionId: COMMAND_PROJECTION_SESSION_ID,
    expectedRevision: input.baseRevision,
  });
  if (!readModel || readModel.source !== "native-core" || readModel.revision !== input.baseRevision) {
    throw new TypeError("原生科研命令需要完整且未截断的当前投影");
  }
  return readModel;
}

function requireKnownActiveTechnology(
  techId: TechId,
): NonNullable<ReturnType<typeof getTechnology>> {
  const technology = getTechnology(techId);
  if (!technology || isDeprecatedTechnology(techId)) {
    throw new TypeError("原生科研命令科技 ID 未知或已停用");
  }
  return technology;
}

function requireCanonicalFinitePlan(readModel: TechnologyWorkspaceReadModel): Set<TechId> {
  const completed = new Set(readModel.research.completedTechIds);
  const planned = new Set(completed);
  for (const techId of [readModel.research.pausedTechId, readModel.research.selectedTechId]) {
    if (!techId) continue;
    const technology = requireKnownActiveTechnology(techId);
    if (completed.has(techId) || !technology.prerequisites.every((id) => completed.has(id))) {
      throw new TypeError("原生科研投影中的当前或暂停科技状态无效");
    }
    planned.add(techId);
  }
  for (const techId of readModel.research.queuedTechIds) {
    const technology = requireKnownActiveTechnology(techId);
    if (planned.has(techId) || !technology.prerequisites.every((id) => planned.has(id))) {
      throw new TypeError("原生科研投影中的队列依赖无效");
    }
    planned.add(techId);
  }
  return planned;
}

function selectedResearchBoundaryIsDue(
  readModel: TechnologyWorkspaceReadModel,
  techId: TechId,
): boolean {
  const technology = requireKnownActiveTechnology(techId);
  const progress = readModel.research.progressByTech[techId] ?? {};
  return technology.costs.every((cost) =>
    Math.floor(progress[cost.itemId] ?? 0) >= cost.amount);
}

/** Appends one finite technology while another finite technology is active. */
export function createNativeProjectedQueueTechnologyCommand(
  input: NativeProjectedQueueTechnologyCommandInput,
): SimulationCommandPatch | null {
  const readModel = requireExactNativeReadModel(input);
  const selectedTechId = readModel.research.selectedTechId;
  if (!selectedTechId || readModel.activeInfiniteResearchId) return null;
  const target = requireKnownActiveTechnology(input.techId);
  const planned = requireCanonicalFinitePlan(readModel);
  if (selectedResearchBoundaryIsDue(readModel, selectedTechId)) {
    throw new TypeError("当前科研已到完成边界，需等待权威结算后刷新投影");
  }
  if (readModel.research.completedTechIds.includes(input.techId) ||
      readModel.research.pausedTechId === input.techId ||
      selectedTechId === input.techId ||
      readModel.research.queuedTechIds.includes(input.techId) ||
      !target.prerequisites.every((id) => planned.has(id))) return null;

  const command = emptyCommand(input.baseRevision);
  command.topLevelChanges.push({
    path: ["research", "queuedTechIds"],
    operation: "set",
    value: [...readModel.research.queuedTechIds, input.techId],
  });
  return command;
}

/** Starts or resumes finite research, or appends when one is already active. */
export function createNativeProjectedSelectTechnologyCommand(
  input: NativeProjectedQueueTechnologyCommandInput,
): SimulationCommandPatch | null {
  const readModel = requireExactNativeReadModel(input);
  if (readModel.research.selectedTechId) {
    return createNativeProjectedQueueTechnologyCommand(input);
  }
  if (readModel.activeInfiniteResearchId) return null;
  const technology = requireKnownActiveTechnology(input.techId);
  requireCanonicalFinitePlan(readModel);
  const completed = new Set(readModel.research.completedTechIds);
  if (completed.has(input.techId) || readModel.research.queuedTechIds.includes(input.techId) ||
      !technology.prerequisites.every((id) => completed.has(id))) return null;
  const command = emptyCommand(input.baseRevision);
  command.topLevelChanges.push({
    path: ["research", "selectedTechId"],
    operation: "set",
    value: input.techId,
  });
  return command;
}

/** Pauses the current finite target, or stops the current infinite target. */
export function createNativeProjectedPauseResearchCommand(
  input: NativeProjectedTechnologyCommandInput,
): SimulationCommandPatch | null {
  const readModel = requireExactNativeReadModel(input);
  requireCanonicalFinitePlan(readModel);
  const command = emptyCommand(input.baseRevision);
  if (readModel.research.selectedTechId) {
    command.topLevelChanges.push({
      path: ["research", "pausedTechId"],
      operation: "set",
      value: readModel.research.selectedTechId,
    });
    return command;
  }
  if (readModel.activeInfiniteResearchId) {
    command.topLevelChanges.push({
      path: ["endgame", "activeInfiniteResearchId"],
      operation: "set",
      value: null,
    });
    return command;
  }
  return null;
}

/** Cancels finite research, or stops infinite research, while preserving progress. */
export function createNativeProjectedCancelResearchCommand(
  input: NativeProjectedTechnologyCommandInput,
): SimulationCommandPatch | null {
  const readModel = requireExactNativeReadModel(input);
  requireCanonicalFinitePlan(readModel);
  const command = emptyCommand(input.baseRevision);
  if (readModel.research.selectedTechId) {
    command.topLevelChanges.push({
      path: ["research", "selectedTechId"],
      operation: "set",
      value: null,
    });
    return command;
  }
  if (readModel.activeInfiniteResearchId) {
    // `cancelCurrentResearch()` also promotes the first currently legal queue
    // row. Keep cancellation distinct from the simpler infinite stop/pause
    // intent so Rust can reproduce that lifecycle transition exactly.
    command.topLevelChanges.push({
      path: ["research", "selectedTechId"],
      operation: "set",
      value: null,
    });
    return command;
  }
  return null;
}

export function createNativeProjectedResumeResearchCommand(
  input: NativeProjectedTechnologyCommandInput,
): SimulationCommandPatch | null {
  const readModel = requireExactNativeReadModel(input);
  requireCanonicalFinitePlan(readModel);
  const target = readModel.research.pausedTechId;
  if (!target || readModel.research.selectedTechId || readModel.activeInfiniteResearchId) return null;
  const command = emptyCommand(input.baseRevision);
  command.topLevelChanges.push({
    path: ["research", "selectedTechId"],
    operation: "set",
    value: target,
  });
  return command;
}

export function createNativeProjectedSelectInfiniteResearchCommand(
  input: NativeProjectedSelectInfiniteResearchCommandInput,
): SimulationCommandPatch | null {
  const readModel = requireExactNativeReadModel(input);
  requireCanonicalFinitePlan(readModel);
  const progress = readModel.infiniteResearch[input.researchId];
  if (!progress || !readModel.research.completedTechIds.includes("universe_matrix") ||
      readModel.research.selectedTechId || readModel.activeInfiniteResearchId === input.researchId ||
      isInfiniteResearchComplete(input.researchId, progress.level)) return null;
  const command = emptyCommand(input.baseRevision);
  command.topLevelChanges.push({
    path: ["endgame", "activeInfiniteResearchId"],
    operation: "set",
    value: input.researchId,
  });
  return command;
}

/** Persists the technology workspace's visual layout through Rust authority. */
export function createNativeProjectedTechnologyLayoutCommand(
  input: NativeProjectedTechnologyLayoutCommandInput,
): SimulationCommandPatch | null {
  const readModel = requireExactNativeReadModel(input);
  if (input.layout !== "standard" && input.layout !== "compact") {
    throw new TypeError("原生科技树布局目标无效");
  }
  if (readModel.settings.technologyLayout === input.layout) return null;
  const command = emptyCommand(input.baseRevision);
  command.topLevelChanges.push({
    path: ["settings", "technologyLayout"],
    operation: "set",
    value: input.layout,
  });
  return command;
}

/**
 * Removes one queued technology and deterministically drops every later row
 * whose prerequisite is no longer present in the completed/current plan.
 */
export function createNativeProjectedRemoveQueuedTechnologyCommand(
  input: NativeProjectedRemoveQueuedTechnologyCommandInput,
): SimulationCommandPatch | null {
  const readModel = requireExactNativeReadModel(input);
  requireKnownActiveTechnology(input.techId);
  requireCanonicalFinitePlan(readModel);
  if (!readModel.research.queuedTechIds.includes(input.techId)) return null;

  const planned = new Set<TechId>([
    ...readModel.research.completedTechIds,
    ...(readModel.research.pausedTechId ? [readModel.research.pausedTechId] : []),
    ...(readModel.research.selectedTechId ? [readModel.research.selectedTechId] : []),
  ]);
  const targetQueue: TechId[] = [];
  for (const techId of readModel.research.queuedTechIds) {
    if (techId === input.techId) continue;
    const technology = requireKnownActiveTechnology(techId);
    if (!technology.prerequisites.every((id) => planned.has(id))) continue;
    targetQueue.push(techId);
    planned.add(techId);
  }

  const command = emptyCommand(input.baseRevision);
  command.topLevelChanges.push({
    path: ["research", "queuedTechIds"],
    operation: "set",
    value: targetQueue,
  });
  return command;
}

/** Toggles infinite-research automation without changing its active target. */
export function createNativeProjectedInfiniteResearchAutomationCommand(
  input: NativeProjectedInfiniteResearchAutomationCommandInput,
): SimulationCommandPatch | null {
  const readModel = requireExactNativeReadModel(input);
  if (typeof input.enabled !== "boolean") {
    throw new TypeError("原生无限科研自动续研目标无效");
  }
  requireCanonicalFinitePlan(readModel);
  if (!readModel.research.completedTechIds.includes("universe_matrix")) return null;
  if (readModel.autoResearch === input.enabled) return null;
  const command = emptyCommand(input.baseRevision);
  command.topLevelChanges.push({
    path: ["endgame", "autoResearch"],
    operation: "set",
    value: input.enabled,
  });
  return command;
}
