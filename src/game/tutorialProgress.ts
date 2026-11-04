export const TUTORIAL_CONTENT_REVISION = "2026-08-14-r1";
export const TUTORIAL_PROGRESS_KEY = `dspidle:tutorial-progress:${TUTORIAL_CONTENT_REVISION}`;

const LEGACY_TUTORIAL_PROGRESS_KEYS = ["dspidle:tutorial-progress:1.0.15"] as const;

function parseProgress(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((id): id is string => typeof id === "string"))]
      : null;
  } catch {
    return null;
  }
}

/**
 * Tutorial progress follows content revisions, not application versions.
 * A legacy key is copied only when the current revision does not exist, so
 * rerunning the migration can never overwrite newer player progress.
 */
export function readTutorialProgress(storage?: Pick<Storage, "getItem" | "setItem">): Set<string> {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!target) return new Set();
    const current = parseProgress(target.getItem(TUTORIAL_PROGRESS_KEY));
    if (current) return new Set(current);
    for (const legacyKey of LEGACY_TUTORIAL_PROGRESS_KEYS) {
      const legacy = parseProgress(target.getItem(legacyKey));
      if (!legacy) continue;
      try { target.setItem(TUTORIAL_PROGRESS_KEY, JSON.stringify(legacy)); } catch { /* The legacy progress remains readable. */ }
      return new Set(legacy);
    }
  } catch {
    // Tutorial completion is optional device UI state, never a game save.
  }
  return new Set();
}

export function writeTutorialProgress(
  storage: Pick<Storage, "setItem"> | undefined,
  completed: Iterable<string>,
): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(TUTORIAL_PROGRESS_KEY, JSON.stringify([...new Set(completed)]));
  } catch { /* Optional device progress must not prevent opening the tutorial. */ }
}
