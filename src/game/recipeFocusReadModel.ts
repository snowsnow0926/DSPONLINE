import { ITEMS } from "./content";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";
import type { GameState, ItemId, RecipeFocusMode } from "./types";

export const RECIPE_FOCUS_NATIVE_BASE_FIELDS = Object.freeze(["recipeFocus"] as const);

export interface RecipeFocusReadModel {
  readonly schema: "recipe-focus-read-model-v1";
  readonly source: "web-game-state" | "native-core";
  readonly revision: number | null;
  readonly itemId: ItemId | null;
  readonly mode: RecipeFocusMode;
  readonly position: Readonly<{ x: number; y: number }>;
}

export interface NativeRecipeFocusBinding {
  readonly enabled: boolean;
  readonly sessionId: string | null;
  readonly expectedRevision: number;
  readonly activePlanetId: string;
}

function readModel(
  source: RecipeFocusReadModel["source"],
  revision: number | null,
  itemId: ItemId | null,
  mode: RecipeFocusMode,
  position: Readonly<{ x: number; y: number }>,
): RecipeFocusReadModel {
  return Object.freeze({
    schema: "recipe-focus-read-model-v1",
    source,
    revision,
    itemId,
    mode,
    position: Object.freeze({ x: position.x, y: position.y }),
  });
}

export function createWebRecipeFocusReadModel(game: GameState): RecipeFocusReadModel {
  return readModel(
    "web-game-state",
    null,
    game.recipeFocus.itemId,
    game.recipeFocus.mode,
    game.recipeFocus.position,
  );
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

/**
 * Selects the always-visible recipe focus overlay from the same complete,
 * revision-bound viewport atom as the factory canvas. The generic viewport
 * base is already capped at 1 MiB and renderer-sanitized; this final boundary
 * additionally proves the exact recipeFocus shape before React sees it.
 */
export function selectNativeRecipeFocusReadModel(
  snapshot: NativeFactoryThinViewSnapshot,
  binding: NativeRecipeFocusBinding,
): RecipeFocusReadModel | null {
  if (!binding.enabled || !isOpaqueId(binding.sessionId) || !isOpaqueId(binding.activePlanetId) ||
    !Number.isSafeInteger(binding.expectedRevision) || binding.expectedRevision < 0 ||
    snapshot.status !== "ready" || snapshot.requestedRevision !== binding.expectedRevision) return null;
  const frame = snapshot.frame;
  const viewport = frame?.viewport;
  if (!frame || frame.authoritySessionId !== binding.sessionId ||
    frame.revision !== binding.expectedRevision || frame.planetId !== binding.activePlanetId ||
    !viewport || viewport.schemaVersion !== 2 || viewport.projectionType !== "viewport-v2" ||
    viewport.revision !== binding.expectedRevision || viewport.planetId !== binding.activePlanetId) return null;

  const focus = viewport.base.recipeFocus;
  if (!exactObject(focus, ["itemId", "mode", "position"]) ||
    focus.itemId !== null && (typeof focus.itemId !== "string" || !ITEMS[focus.itemId as ItemId]) ||
    focus.mode !== "two-level" && focus.mode !== "full" ||
    !exactObject(focus.position, ["x", "y"])) return null;
  const x = focus.position.x;
  const y = focus.position.y;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || (x as number) < 8 || (y as number) < 8) return null;

  return readModel(
    "native-core",
    binding.expectedRevision,
    focus.itemId as ItemId | null,
    focus.mode,
    { x: x as number, y: y as number },
  );
}
