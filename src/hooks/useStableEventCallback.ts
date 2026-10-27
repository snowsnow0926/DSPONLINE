import { useLayoutEffect, useMemo, useRef } from "react";

function invokeCurrentCallback<Args extends unknown[], Result>(
  this: { current: (...args: Args) => Result },
  ...args: Args
): Result {
  return this.current(...args);
}

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
  // A closure created in this hook can share the layout effect's lexical
  // environment and retain the initial callback even after current changes.
  // Binding a module function retains only the ref, including after minifying.
  return useMemo(() => (invokeCurrentCallback<Args, Result>).bind(callbackRef), [callbackRef]);
}
