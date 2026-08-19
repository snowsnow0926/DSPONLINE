import { useMemo, useRef } from "react";
import { BeltFlowProjectionCache, BeltFlowSampler } from "../game/beltFlow";
import { measureRuntimeTransitionPhase } from "../game/runtimeTransitionDiagnostics";
import type { GameState } from "../game/types";

export function useObservedBeltFlowGame(game: GameState, sampleEnabled = true): GameState {
  const samplerRef = useRef<BeltFlowSampler | null>(null);
  const projectionRef = useRef<BeltFlowProjectionCache | null>(null);
  if (!samplerRef.current) samplerRef.current = new BeltFlowSampler();
  if (!projectionRef.current) projectionRef.current = new BeltFlowProjectionCache();
  return useMemo(() => {
    // A paused canvas is already showing an authoritative snapshot. Avoid
    // rebuilding every belt observation until simulation or editing publishes
    // a new source state.
    if (!sampleEnabled) return game;
    return measureRuntimeTransitionPhase("belt-flow-observation", () => {
      const observations = samplerRef.current!.sample(game, { planetId: game.activePlanetId });
      return projectionRef.current!.project(game, observations, game.activePlanetId);
    }, { entities: game.entities.length, belts: game.belts.length });
  }, [game, game.activePlanetId, sampleEnabled]);
}
