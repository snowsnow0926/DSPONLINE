import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

/**
 * Coalesces a burst of ref-backed snapshots into one default-priority update.
 *
 * Runtime, canvas, and panel clocks are already rate-limited. Giving each of
 * them an independent React transition can entangle their lanes indefinitely:
 * every pending lane then retains its own large render/memo graph. A default
 * update is allowed to finish before the next timer task, while the ref-backed
 * updater still avoids capturing obsolete multi-megabyte snapshots.
 */
export function useLatestSnapshotPublisher<T>(
  committed: T,
  latestRef: MutableRefObject<T>,
  setCommitted: Dispatch<SetStateAction<T>>,
): () => void {
  const committedRef = useRef(committed);
  const publicationScheduledRef = useRef(false);
  committedRef.current = committed;

  return useCallback(() => {
    if (Object.is(committedRef.current, latestRef.current) || publicationScheduledRef.current) return;
    publicationScheduledRef.current = true;
    queueMicrotask(() => {
      publicationScheduledRef.current = false;
      if (Object.is(committedRef.current, latestRef.current)) return;
      // Resolve at processing time so the update queue never owns a stale
      // GameState/CanvasRenderSnapshot object graph.
      setCommitted(() => latestRef.current);
    });
  }, [latestRef, setCommitted]);
}
