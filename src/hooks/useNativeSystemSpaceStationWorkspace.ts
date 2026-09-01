import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR,
  NativeSystemSpaceStationWorkspaceStore,
  createNativeSystemSpaceStationWorkspaceSource,
  nativeSystemSpaceStationSelectorWithCursor,
  selectNativeSystemSpaceStationWorkspaceFrame,
  type NativeSystemSpaceStationPageLane,
  type NativeSystemSpaceStationWorkspaceFetchProjection,
  type NativeSystemSpaceStationWorkspaceFrame,
  type NativeSystemSpaceStationWorkspaceIdentity,
  type NativeSystemSpaceStationWorkspaceSelector,
  type NativeSystemSpaceStationWorkspaceSnapshot,
} from "../game/nativeSystemSpaceStationWorkspaceStore";

export interface UseNativeSystemSpaceStationWorkspaceOptions {
  readonly open: boolean;
  readonly identity: NativeSystemSpaceStationWorkspaceIdentity | null;
  readonly fetchProjection: NativeSystemSpaceStationWorkspaceFetchProjection | null;
}

export interface UseNativeSystemSpaceStationWorkspaceResult {
  readonly snapshot: NativeSystemSpaceStationWorkspaceSnapshot;
  readonly selector: NativeSystemSpaceStationWorkspaceSelector;
  readonly frame: NativeSystemSpaceStationWorkspaceFrame | null;
  readonly setPageCursor: (lane: NativeSystemSpaceStationPageLane, cursor: number) => void;
  readonly retry: () => void;
  readonly close: () => void;
}

function identityToken(identity: NativeSystemSpaceStationWorkspaceIdentity | null): string {
  return identity ? [
    identity.sessionId,
    identity.runId,
    identity.registryFingerprint,
    identity.systemId,
  ].join("\u0000") : "";
}

/**
 * Owns only one bounded Rust projection at a time. Identity or selector drift
 * cancels the prior request, and close/unmount makes late IPC responses inert.
 */
export function useNativeSystemSpaceStationWorkspace({
  open,
  identity,
  fetchProjection,
}: UseNativeSystemSpaceStationWorkspaceOptions): UseNativeSystemSpaceStationWorkspaceResult {
  const storeRef = useRef<NativeSystemSpaceStationWorkspaceStore | null>(null);
  if (storeRef.current === null) storeRef.current = new NativeSystemSpaceStationWorkspaceStore();
  const store = storeRef.current;
  const token = identityToken(identity);
  const [selectorState, setSelectorState] = useState<{
    readonly identityToken: string;
    readonly selector: NativeSystemSpaceStationWorkspaceSelector;
  }>(() => ({ identityToken: token, selector: DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR }));
  const selector = selectorState.identityToken === token
    ? selectorState.selector
    : DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR;
  const source = useMemo(() => identity
    ? createNativeSystemSpaceStationWorkspaceSource(fetchProjection, identity)
    : null, [
    fetchProjection,
    identity?.sessionId,
    identity?.runId,
    identity?.revision,
    identity?.registryFingerprint,
    identity?.systemId,
  ]);
  const boundIdentity = source?.boundIdentity ?? null;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    setSelectorState((current) => current.identityToken === token
      ? current
      : { identityToken: token, selector: DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR });
  }, [token]);

  useEffect(() => {
    if (!open || !boundIdentity || !source) {
      store.close();
      return;
    }
    void store.refresh(source, boundIdentity, selector);
  }, [boundIdentity, open, selector, source, store]);

  useEffect(() => () => store.close(), [store]);

  const setPageCursor = useCallback((lane: NativeSystemSpaceStationPageLane, cursor: number) => {
    setSelectorState((current) => {
      const base = current.identityToken === token ? current.selector : DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR;
      const next = nativeSystemSpaceStationSelectorWithCursor(base, lane, cursor);
      return next ? { identityToken: token, selector: next } : current;
    });
  }, [token]);

  const retry = useCallback(() => {
    if (open && boundIdentity && source) void store.refresh(source, boundIdentity, selector, true);
  }, [boundIdentity, open, selector, source, store]);
  const close = useCallback(() => store.close(), [store]);
  const frame = boundIdentity
    ? selectNativeSystemSpaceStationWorkspaceFrame(snapshot, boundIdentity, selector)
    : null;

  return { snapshot, selector, frame, setPageCursor, retry, close };
}
