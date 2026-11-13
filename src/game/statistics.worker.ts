/// <reference lib="webworker" />
import "../compat/runtime";

import { applyContentPackRuntimeSnapshot, type ContentPackRuntimeSnapshot } from "./contentPacks";
import { calculateFactoryStatistics, type FactoryStatistics } from "./statistics";
import type { GameState, PlanetId } from "./types";

export interface StatisticsWorkerRequest {
  id: number;
  state: GameState;
  planetScope: PlanetId | "all";
  registry?: ContentPackRuntimeSnapshot;
}

export interface StatisticsWorkerResponse {
  id: number;
  statistics?: FactoryStatistics;
  sampledAtSeconds: number;
  durationMs: number;
  error?: string;
}

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<StatisticsWorkerRequest>) => {
  const request = event.data;
  const startedAt = performance.now();
  try {
    if (request.registry) applyContentPackRuntimeSnapshot(request.registry);
    const statistics = calculateFactoryStatistics(request.state, request.planetScope);
    workerScope.postMessage({
      id: request.id,
      statistics,
      sampledAtSeconds: request.state.elapsedSeconds,
      durationMs: performance.now() - startedAt,
    } satisfies StatisticsWorkerResponse);
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      sampledAtSeconds: request.state.elapsedSeconds,
      durationMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : "统计 Worker 计算失败",
    } satisfies StatisticsWorkerResponse);
  }
};

export {};
