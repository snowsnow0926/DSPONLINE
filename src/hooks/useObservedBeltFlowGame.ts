import { useMemo, useRef } from "react";
import { applyBeltFlowObservations, BeltFlowSampler } from "../game/beltFlow";
import { measureRuntimeTransitionPhase, trackRuntimeRetentionReference } from "../game/runtimeTransitionDiagnostics";
import type { GameState } from "../game/types";

export function useObservedBeltFlowGame(game: GameState, sampleEnabled = true): GameState {
  const samplerRef = useRef<BeltFlowSampler | null>(null);
  if (!samplerRef.current) samplerRef.current = new BeltFlowSampler();
  return useMemo(() => {
    // A paused canvas is already showing an authoritative snapshot. Avoid
    // rebuilding every belt observation until simulation or editing publishes
    // a new source state.
    if (!sampleEnabled) return game;
    return measureRuntimeTransitionPhase("belt-flow-observation", () => {
      const observations = samplerRef.current!.sample(game, { planetId: game.activePlanetId });
      const observed = applyBeltFlowObservations(game, observations, game.activePlanetId);
      trackRuntimeRetentionReference("belt-observed-game", observed);
      trackRuntimeRetentionReference("belt-observed-belts", observed.belts);
      trackRuntimeRetentionReference("belt-observed-belt-sample", observed.belts[0]);
      return observed;
    }, { entities: game.entities.length, belts: game.belts.length });
  }, [game, game.activePlanetId, sampleEnabled]);
}
