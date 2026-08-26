export type CanvasNodeSemanticRevisionPart = string | number | boolean | null;

/**
 * Creates an unambiguous revision key for the values that can change a React
 * Flow node's visible or interactive presentation. Object identity is
 * deliberately excluded: large-factory selectors often rebuild equivalent
 * Sets and Maps while the semantic inputs remain unchanged.
 */
export function createCanvasNodeSemanticRevisionToken(
  parts: readonly CanvasNodeSemanticRevisionPart[],
): string {
  return JSON.stringify(parts);
}

/** A revision becomes current only after its animation-frame derivation starts. */
export function isCanvasNodeSemanticRevisionApplied(
  appliedToken: string | null,
  requestedToken: string,
): boolean {
  return appliedToken === requestedToken;
}
