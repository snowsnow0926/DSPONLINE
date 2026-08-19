import { useCallback, useEffect, useRef, useTransition, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

/**
 * Publishes a ref-backed snapshot at transition priority without allowing
 * repeated telemetry ticks to retain one large object graph per transition.
 *
 * At most one transition is in flight. Calls made while React is rendering
 * are coalesced and the updater reads the ref only when React processes it,
 * so an obsolete snapshot is never captured by the update queue.
 */
export function useLatestTransitionPublisher<T>(
  committed: T,
  latestRef: MutableRefObject<T>,
  setCommitted: Dispatch<SetStateAction<T>>,
): () => void {
  const [isPending, startLatestTransition] = useTransition();
  const committedRef = useRef(committed);
  const transitionInFlightRef = useRef(false);
  const republishRequestedRef = useRef(false);
  committedRef.current = committed;

  const publishLatest = useCallback(() => {
    if (Object.is(committedRef.current, latestRef.current)) {
      republishRequestedRef.current = false;
      return;
    }
    if (transitionInFlightRef.current) {
      republishRequestedRef.current = true;
      return;
    }
    transitionInFlightRef.current = true;
    republishRequestedRef.current = false;
    startLatestTransition(() => {
      // Reading through the ref here is intentional. Capturing the current
      // multi-megabyte snapshot would keep every queued version alive.
      setCommitted(() => latestRef.current);
    });
  }, [latestRef, setCommitted, startLatestTransition]);

  useEffect(() => {
    if (isPending || !transitionInFlightRef.current) return;
    transitionInFlightRef.current = false;
    const needsRepublish = republishRequestedRef.current &&
      !Object.is(committedRef.current, latestRef.current);
    republishRequestedRef.current = false;
    if (needsRepublish) publishLatest();
  }, [committed, isPending, latestRef, publishLatest]);

  useEffect(() => () => {
    transitionInFlightRef.current = false;
    republishRequestedRef.current = false;
  }, []);

  return publishLatest;
}
