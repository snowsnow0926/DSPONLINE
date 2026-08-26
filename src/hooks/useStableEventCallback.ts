import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Keeps a callback identity stable while dispatching to the latest render.
 *
 * Large factory nodes persist across many canvas revisions. Storing an
 * ordinary render callback in node data can retain the complete render scope
 * that created it, including an older multi-thousand-node array. A stable
 * proxy lives in this small hook scope and holds only the ref; old node data
 * can therefore call current behavior without linking canvas generations.
 */
export function useStableEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}
