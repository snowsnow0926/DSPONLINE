export interface NativePlanetRouteIdentity<TPlanetId extends string = string> {
  readonly sessionId: string;
  readonly planetId: TPlanetId;
}

export interface NativePlanetTransitionIntent extends NativePlanetRouteIdentity {
  readonly acceptedRevision: number;
}

export interface NativePlanetWorkspaceProof {
  readonly sessionId: string;
  readonly revision: number;
  readonly activePlanetId: string;
  readonly targetRowActive: boolean;
}

export interface NativePlanetCanvasProof extends NativePlanetRouteIdentity {
  readonly revision: number;
}

export type NativePlanetTransitionDecision =
  | "idle"
  | "waiting"
  | "session-mismatch"
  | "projection-mismatch"
  | "target-mismatch"
  | "target-inactive"
  | "ready";

/**
 * Exact discovery is revision-scoped and therefore disappears briefly while
 * the next projection atom is being fetched. Keep the last confirmed route
 * only inside the same native session so an ordinary clock tick does not look
 * like planet travel. This identity is presentation-only: callers must still
 * require an exact atom before issuing a projection read.
 */
export function retainNativePlanetRouteIdentity<TPlanetId extends string>(
  activeSessionId: string | null | undefined,
  exact: NativePlanetRouteIdentity<TPlanetId> | null,
  confirmed: NativePlanetRouteIdentity<TPlanetId> | null,
): NativePlanetRouteIdentity<TPlanetId> | null {
  if (!activeSessionId) return null;
  if (exact?.sessionId === activeSessionId) return exact;
  return confirmed?.sessionId === activeSessionId ? confirmed : null;
}

/**
 * A route identity change must start with an unpinned atom. This covers normal
 * travel, an uncertain-but-committed command, and a recovered/rebound native
 * session without guessing which renderer interaction still belongs to it.
 */
export function nativePlanetRouteRequiresBootstrap(
  nativeAuthoritative: boolean,
  confirmed: NativePlanetRouteIdentity | null,
  discovered: NativePlanetRouteIdentity | null,
): boolean {
  return nativeAuthoritative && (
    discovered === null || confirmed === null || confirmed.sessionId !== discovered.sessionId ||
    confirmed.planetId !== discovered.planetId
  );
}

/**
 * Order-independent receipt/projection reconciliation. The caller may feed a
 * projection before or after the durable receipt; a visible transition is
 * allowed only when both independent proofs describe the same target.
 */
export function evaluateNativePlanetTransition(
  intent: NativePlanetTransitionIntent | null,
  workspace: NativePlanetWorkspaceProof | null,
  canvas: NativePlanetCanvasProof | null,
): NativePlanetTransitionDecision {
  if (!intent) return "idle";
  if (!workspace || !canvas) return "waiting";
  if (workspace.sessionId !== intent.sessionId) return "session-mismatch";
  if (workspace.revision < intent.acceptedRevision) return "waiting";
  if (canvas.sessionId !== workspace.sessionId || canvas.revision !== workspace.revision ||
    canvas.planetId !== intent.planetId) return "projection-mismatch";
  if (workspace.activePlanetId !== intent.planetId) return "target-mismatch";
  if (!workspace.targetRowActive) return "target-inactive";
  return "ready";
}
