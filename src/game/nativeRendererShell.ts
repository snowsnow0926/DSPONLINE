import { createInitialState } from "./engine";
import type { GameState } from "./types";

/**
 * Builds a small, inert GameState-shaped tombstone for the React tree after
 * main/Rust has durably become the player authority. It is never a save or a
 * fallback authority: native-owned UI must continue to consume bounded
 * projections and persistence is fenced in main before this object is used.
 */
export function createNativeRendererShellState(source: GameState): GameState {
  if (source.version !== 47 || source.mode !== "normal") {
    throw new TypeError("native renderer shell requires a normal GameState v47 authority handoff");
  }
  const shell = createInitialState(source.galaxy.seed, false);
  const emptyPlanetTrays = Object.fromEntries(
    Object.keys(shell.planetTrays).map((planetId) => [planetId, {}]),
  ) as GameState["planetTrays"];

  return {
    ...shell,
    version: 47,
    mode: source.mode,
    entities: [],
    belts: [],
    cargo: null,
    tray: {},
    planetTrays: emptyPlanetTrays,
    construction: {},
    portableFleet: { logistics_drone: 0, logistics_vessel: 0 },
    totalProduced: {},
    contentPacks: source.contentPacks.map((pack) => ({ id: pack.id, version: pack.version })),
    settings: { ...source.settings },
    productionHistory: [],
    canvasBookmarks: [],
    canvasRegions: [],
    blueprints: [],
    blueprintVersions: [],
    constructionQueue: [],
    handcraftQueue: [],
    productionPlans: [],
    elapsedSeconds: 0,
    speedrun: undefined,
    timeWarp: {
      ...shell.timeWarp,
      enabled: false,
      pendingSimulationSeconds: 0,
      pendingWallSeconds: 0,
    },
    paused: true,
  };
}
