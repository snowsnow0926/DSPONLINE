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

function matchesObservation(belt: BeltConnection, observation: BeltFlowObservation): boolean {
  return belt.lastFlow === observation.flowPerSecond &&
    belt.recentFlowSampleSeconds === observation.sampleSeconds &&
    belt.recentFlowTransferred === observation.transferred &&
    belt.recentFlowSampling === observation.sampling;
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
  private projectionIndexes: number[] = [];

  sample(state: GameState, options: { planetId?: PlanetId } = {}): ReadonlyMap<string, BeltFlowObservation> {
    const elapsedSeconds = Math.max(0, state.elapsedSeconds);
    const activeIds = new Set<string>();

    this.projectionIndexes.length = 0;
    for (let index = 0; index < state.belts.length; index += 1) {
      const belt = state.belts[index];
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
      const nextObservation = {
        flowPerSecond: Math.round(Math.max(0, flowPerSecond) * 1_000) / 1_000,
        sampleSeconds: Math.round(sampleSeconds * 1_000) / 1_000,
        transferred: Math.round(transferred * 1_000) / 1_000,
        sampling: sampleSeconds + 0.000_001 < BELT_FLOW_WINDOW_SECONDS,
      } satisfies BeltFlowObservation;
      // Every publication starts from a fresh authoritative snapshot. Even a
      // stable window must replace that snapshot's instantaneous lastFlow and
      // missing UI-only fields; comparison with the previous observation would
      // incorrectly omit these belts after the five-second window fills.
      if (!matchesObservation(belt, nextObservation)) this.projectionIndexes.push(index);
      this.latest.set(belt.id, nextObservation);
    }

    for (const beltId of this.histories.keys()) {
      if (!activeIds.has(beltId)) {
        this.histories.delete(beltId);
        this.latest.delete(beltId);
      }
    }
    return this.latest;
  }

  /** Consume indexes that need projection onto the exact state just sampled. */
  consumeProjectionIndexes(): number[] {
    const indexes = this.projectionIndexes;
    this.projectionIndexes = [];
    return indexes;
  }

  reset(): void {
    this.histories.clear();
    this.latest.clear();
    this.projectionIndexes.length = 0;
  }
}

export function applyBeltFlowObservations(
  state: GameState,
  observations: ReadonlyMap<string, BeltFlowObservation>,
  planetId?: PlanetId,
  projectionIndexes?: readonly number[],
): GameState {
  if (state.belts.length === 0) return state;
  // Flow observations are a UI projection. Most large-factory publications
  // do not change every belt's displayed window; avoid allocating a new
  // 233k-record array and cloning every belt when all observed values are the
  // same. When a value changes, preserve untouched belt identities so React
  // Flow and diagnostics do not retain a second full belt object tree.
  let nextBelts: BeltConnection[] | null = null;
  const count = projectionIndexes?.length ?? state.belts.length;
  for (let position = 0; position < count; position += 1) {
    const index = projectionIndexes ? projectionIndexes[position] : position;
    if (index < 0 || index >= state.belts.length) continue;
    const belt = state.belts[index];
    const observation = planetId && belt.planetId !== planetId ? undefined : observations.get(belt.id);
    if (!observation || matchesObservation(belt, observation)) continue;
    nextBelts ??= state.belts.slice();
    nextBelts[index] = {
      ...belt,
      lastFlow: observation.flowPerSecond,
      recentFlowSampleSeconds: observation.sampleSeconds,
      recentFlowTransferred: observation.transferred,
      recentFlowSampling: observation.sampling,
    };
  }
  return nextBelts ? { ...state, belts: nextBelts } : state;
}
