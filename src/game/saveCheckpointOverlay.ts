import type { AuthoritativeSaveCheckpointOverlay } from "./authoritativeSaveSerializationProtocol";
import type { GameState } from "./types";

const MIN_CANVAS_ZOOM = 0.25;
const MAX_CANVAS_ZOOM = 1.8;
const MAX_PENDING_TIME_WARP_SECONDS = 30 * 24 * 60 * 60;

export function applyAuthoritativeSaveCheckpointOverlay(
  state: GameState,
  overlay: AuthoritativeSaveCheckpointOverlay | undefined,
): GameState {
  if (!overlay) return state;
  let next = state;
  if (overlay.planetViewports !== undefined) {
    if (!Array.isArray(overlay.planetViewports) || overlay.planetViewports.length > Object.keys(state.planetViewports).length) {
      throw new Error("save checkpoint viewport overlay 不合法");
    }
    let planetViewports = state.planetViewports;
    const seenPlanetIds = new Set<string>();
    for (const entry of overlay.planetViewports) {
      const viewport = entry?.viewport;
      if (!entry || !viewport ||
        typeof entry.planetId !== "string" || !Object.hasOwn(state.planetViewports, entry.planetId) ||
        seenPlanetIds.has(entry.planetId) ||
        !Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) ||
        !Number.isFinite(viewport.zoom) || viewport.zoom < MIN_CANVAS_ZOOM || viewport.zoom > MAX_CANVAS_ZOOM) {
        throw new Error("save checkpoint viewport overlay 不合法");
      }
      seenPlanetIds.add(entry.planetId);
      const previous = planetViewports[entry.planetId];
      if (previous?.x === viewport.x && previous.y === viewport.y && previous.zoom === viewport.zoom) continue;
      if (planetViewports === state.planetViewports) planetViewports = { ...state.planetViewports };
      planetViewports[entry.planetId] = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
    }
    if (planetViewports !== state.planetViewports) next = { ...next, planetViewports };
  }
  if (overlay.timeWarp !== undefined && (
    !Number.isFinite(overlay.timeWarp.pendingSimulationSeconds) || !Number.isFinite(overlay.timeWarp.pendingWallSeconds) ||
    overlay.timeWarp.pendingSimulationSeconds < 0 || overlay.timeWarp.pendingWallSeconds < 0 ||
    overlay.timeWarp.pendingSimulationSeconds > MAX_PENDING_TIME_WARP_SECONDS ||
    overlay.timeWarp.pendingWallSeconds > MAX_PENDING_TIME_WARP_SECONDS
  )) {
    throw new Error("save checkpoint time warp overlay 不合法");
  }
  const pendingSimulationSeconds = overlay.timeWarp?.pendingSimulationSeconds;
  const pendingWallSeconds = overlay.timeWarp?.pendingWallSeconds;
  if (pendingSimulationSeconds !== undefined && pendingWallSeconds !== undefined &&
    (next.timeWarp.pendingSimulationSeconds !== pendingSimulationSeconds || next.timeWarp.pendingWallSeconds !== pendingWallSeconds)) {
    next = {
      ...next,
      timeWarp: {
        ...next.timeWarp,
        pendingSimulationSeconds,
        pendingWallSeconds,
      },
    };
  }
  return next;
}
