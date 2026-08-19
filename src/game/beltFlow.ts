import type { BeltConnection, GameState, PlanetId } from "./types";

export const BELT_FLOW_WINDOW_SECONDS = 5;

interface BeltFlowPoint {
  elapsedSeconds: number;
  totalTransferred: number;
}

export interface BeltFlowObservation {
  flowPerSecond: number;
  sampleSeconds: number;
  transferred: number;
  sampling: boolean;
}

function normalizedTotal(belt: BeltConnection): number {
  return Math.max(0, Math.floor(belt.totalTransferred ?? 0));
}

function interpolateTotal(before: BeltFlowPoint, after: BeltFlowPoint, elapsedSeconds: number): number {
  const span = after.elapsedSeconds - before.elapsedSeconds;
  if (span <= 0) return before.totalTransferred;
  const ratio = Math.max(0, Math.min(1, (elapsedSeconds - before.elapsedSeconds) / span));
  return before.totalTransferred + (after.totalTransferred - before.totalTransferred) * ratio;
}

/**
 * UI-only rolling observations derived from the monotonic transport counter.
 * The sampler is deliberately kept outside GameState so save size, simulation
 * determinism and Worker payloads do not depend on rendering frequency.
 */
export class BeltFlowSampler {
  private readonly histories = new Map<string, BeltFlowPoint[]>();
  private readonly latest = new Map<string, BeltFlowObservation>();

  sample(state: GameState, options: { planetId?: PlanetId } = {}): ReadonlyMap<string, BeltFlowObservation> {
    const elapsedSeconds = Math.max(0, state.elapsedSeconds);
    const activeIds = new Set<string>();

    for (const belt of state.belts) {
      if (options.planetId && belt.planetId !== options.planetId) continue;
      activeIds.add(belt.id);
      const totalTransferred = normalizedTotal(belt);
      let history = this.histories.get(belt.id);
      const previous = history?.[history.length - 1];
      if (!history || !previous || elapsedSeconds < previous.elapsedSeconds || totalTransferred < previous.totalTransferred) {
        history = [{ elapsedSeconds, totalTransferred }];
        this.histories.set(belt.id, history);
      } else if (elapsedSeconds > previous.elapsedSeconds || totalTransferred !== previous.totalTransferred) {
        history.push({ elapsedSeconds, totalTransferred });
      }

      const cutoff = elapsedSeconds - BELT_FLOW_WINDOW_SECONDS;
      while (history.length > 2 && history[1].elapsedSeconds <= cutoff) history.shift();

      let baseElapsed = history[0].elapsedSeconds;
      let baseTotal = history[0].totalTransferred;
      if (history.length > 1 && baseElapsed < cutoff) {
        baseElapsed = cutoff;
        baseTotal = interpolateTotal(history[0], history[1], cutoff);
      }
      const sampleSeconds = Math.max(0, elapsedSeconds - baseElapsed);
      const transferred = Math.max(0, totalTransferred - baseTotal);
      const fallback = Math.max(0, Number.isFinite(belt.lastFlow) ? belt.lastFlow : 0);
      const flowPerSecond = sampleSeconds > 0.000_001 ? transferred / sampleSeconds : fallback;
      this.latest.set(belt.id, {
        flowPerSecond: Math.round(Math.max(0, flowPerSecond) * 1_000) / 1_000,
        sampleSeconds: Math.round(sampleSeconds * 1_000) / 1_000,
        transferred: Math.round(transferred * 1_000) / 1_000,
        sampling: sampleSeconds + 0.000_001 < BELT_FLOW_WINDOW_SECONDS,
      });
    }

    for (const beltId of this.histories.keys()) {
      if (!activeIds.has(beltId)) {
        this.histories.delete(beltId);
        this.latest.delete(beltId);
      }
    }
    return this.latest;
  }

  reset(): void {
    this.histories.clear();
    this.latest.clear();
  }
}

/**
 * Reuses render-only belt records across observation publications. React may
 * retain interrupted render versions, so allocating a fresh object for every
 * belt on every visual tick turns a bounded five-second sampler into linear
 * live-heap growth. Source GameState records are never mutated.
 */
export class BeltFlowProjectionCache {
  private readonly projectedById = new Map<string, BeltConnection>();

  project(
    state: GameState,
    observations: ReadonlyMap<string, BeltFlowObservation>,
    planetId?: PlanetId,
  ): GameState {
    const activeIds = new Set<string>();
    const belts = state.belts.map((belt) => {
      activeIds.add(belt.id);
      const observation = planetId && belt.planetId !== planetId ? undefined : observations.get(belt.id);
      let projected = this.projectedById.get(belt.id);
      if (!projected) {
        projected = { ...belt };
        this.projectedById.set(belt.id, projected);
      } else {
        Object.assign(projected, belt);
      }
      if (observation) {
        projected.lastFlow = observation.flowPerSecond;
        projected.recentFlowSampleSeconds = observation.sampleSeconds;
        projected.recentFlowTransferred = observation.transferred;
        projected.recentFlowSampling = observation.sampling;
      }
      return projected;
    });
    for (const beltId of this.projectedById.keys()) {
      if (!activeIds.has(beltId)) this.projectedById.delete(beltId);
    }
    return { ...state, belts };
  }

  get size(): number {
    return this.projectedById.size;
  }

  clear(): void {
    this.projectedById.clear();
  }
}

export function applyBeltFlowObservations(
  state: GameState,
  observations: ReadonlyMap<string, BeltFlowObservation>,
  planetId?: PlanetId,
): GameState {
  if (state.belts.length === 0) return state;
  return {
    ...state,
    belts: state.belts.map((belt) => {
      const observation = planetId && belt.planetId !== planetId ? undefined : observations.get(belt.id);
      if (!observation) return belt;
      return {
        ...belt,
        lastFlow: observation.flowPerSecond,
        recentFlowSampleSeconds: observation.sampleSeconds,
        recentFlowTransferred: observation.transferred,
        recentFlowSampling: observation.sampling,
      };
    }),
  };
}
