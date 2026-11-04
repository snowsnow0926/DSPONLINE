import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

const volatileDrafts = new Map<string, string>();

type DraftFocusHandoff = { current: boolean };

interface PendingDraftFocus {
  ownerDocument: Document;
  scope: Element | null;
  start: number | null;
  end: number | null;
  direction: "forward" | "backward" | "none" | null;
}
const pendingDraftFocus = new Map<string, PendingDraftFocus>();

interface DraftSessionOptions {
  elementRef: { readonly current: HTMLInputElement | HTMLTextAreaElement | null };
  draftId: string;
  sensitive: boolean;
  composingRef: { readonly current: boolean };
  focusedRef: { readonly current: boolean };
  lastStoredDraftRef: { current: string };
  focusHandoffRef: DraftFocusHandoff;
  value: string;
  restoredDraftRef: { current: string | null | undefined };
  setDraft: (value: string) => void;
}

/** A keyed editor owns native composition; only its own draft may survive it. */
function useDraftSessionLifecycle(options: DraftSessionOptions): void {
  const { elementRef, draftId, sensitive, composingRef, focusedRef, lastStoredDraftRef, focusHandoffRef } = options;
  const initialOptionsRef = useRef(options);
  initialOptionsRef.current = options;
  const initializedRef = useRef(false);
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      // Read after the old layout cleanup, which can have captured an IME
      // buffer after this editor's render. Do not replay initialization during
      // StrictMode effect checks or resurrect an explicitly cleared draft.
      const restored = sensitive ? null : volatileDrafts.get(draftId) ?? null;
      const initial = restored ?? initialOptionsRef.current.value;
      initialOptionsRef.current.restoredDraftRef.current = restored;
      initialOptionsRef.current.setDraft(initial);
      lastStoredDraftRef.current = initial;
      if (element.value !== initial) element.value = initial;
      if (!sensitive) volatileDrafts.set(draftId, initial);
    }
    const focusKey = `${draftId}:${sensitive}`;
    const pending = pendingDraftFocus.get(focusKey);
    const matching = pending?.ownerDocument === element.ownerDocument
      && pending.scope === element.closest('[role="dialog"], [role="alertdialog"]') ? pending : null;
    if (matching) pendingDraftFocus.delete(focusKey);
    const wantsFocus = focusHandoffRef.current || matching !== null;
    focusHandoffRef.current = false;
    const active = element.ownerDocument.activeElement;
    if (wantsFocus && (active === element.ownerDocument.body || active === element)
      && !element.disabled && !element.closest("[inert], [hidden], [aria-hidden='true']")) {
      try { element.focus({ preventScroll: true }); } catch { try { element.focus(); } catch { /* Optional focus handoff. */ } }
      if (matching?.start != null && matching.end != null && element.ownerDocument.activeElement === element) {
        try { element.setSelectionRange(Math.min(matching.start, element.value.length), Math.min(matching.end, element.value.length), matching.direction ?? "none"); } catch { /* E-mail and number inputs have no text selection API. */ }
      }
    }
    return () => {
      const active = element.ownerDocument.activeElement;
      const hadFocus = active === element || (focusedRef.current && !element.isConnected && active === element.ownerDocument.body);
      focusHandoffRef.current = hadFocus;
      if (hadFocus) {
        const pending: PendingDraftFocus = {
          ownerDocument: element.ownerDocument,
          scope: element.closest('[role="dialog"], [role="alertdialog"]'),
          start: element.selectionStart,
          end: element.selectionEnd,
          direction: element.selectionDirection,
        };
        pendingDraftFocus.set(focusKey, pending);
        // Only a replacement mounted in this commit may claim it. Reopening a
        // mobile picker later must keep its normal no-autofocus policy.
        queueMicrotask(() => { if (pendingDraftFocus.get(focusKey) === pending) pendingDraftFocus.delete(focusKey); });
      }
      // An IME can update the DOM before input. Preserve that buffer through a
      // responsive remount, unless an explicit clear/update replaced our draft.
      if (!sensitive && composingRef.current && volatileDrafts.has(draftId)
        && volatileDrafts.get(draftId) === lastStoredDraftRef.current) {
        volatileDrafts.set(draftId, element.value);
      }
    };
  }, [elementRef, draftId, sensitive, composingRef, focusedRef, lastStoredDraftRef, focusHandoffRef]);
}

export function clearStableTextDraft(draftId: string): void {
  volatileDrafts.delete(draftId);
}

export function updateStableTextDraft(draftId: string, value: string): void {
  volatileDrafts.set(draftId, value);
}

export function readStableTextDraft(draftId: string): string | null {
  return volatileDrafts.get(draftId) ?? null;
}

/**
 * Keeps a non-sensitive draft through responsive/component remounts in the
 * current page lifetime. It deliberately never uses storage. Passwords must
 * opt out with sensitive so they cannot enter the shared draft map.
 */
type StableTextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  draftId: string;
  sensitive?: boolean;
  commitOnBlur?: boolean;
  value: string;
  onValueChange: (value: string) => void;
};

export const StableTextInput = forwardRef<HTMLInputElement, StableTextInputProps>(function StableTextInput(props, forwardedRef) {
  const focusHandoffRef = useRef(false);
  return <StableTextInputSession key={`${props.draftId}:${props.sensitive === true}:${props.commitOnBlur === true}`} {...props} focusHandoffRef={focusHandoffRef} ref={forwardedRef} />;
});

const StableTextInputSession = forwardRef<HTMLInputElement, StableTextInputProps & { focusHandoffRef: DraftFocusHandoff }>(function StableTextInputSession({ draftId, sensitive = false, commitOnBlur = false, value, onValueChange, onBlur, onFocus, onKeyDown, focusHandoffRef, ...props }, forwardedRef) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(forwardedRef, () => inputRef.current!, []);
  const restoredDraftRef = useRef<string | null | undefined>(undefined);
  if (restoredDraftRef.current === undefined) {
    restoredDraftRef.current = sensitive ? null : volatileDrafts.get(draftId) ?? null;
  }
  const [draft, setDraft] = useState(() => restoredDraftRef.current ?? value);
  const composingRef = useRef(false);
  const focusedRef = useRef(false);
  const latestExternalRef = useRef(value);
  const lastStoredDraftRef = useRef(draft);
  const rememberDraft = (next: string) => {
    lastStoredDraftRef.current = next;
    if (!sensitive) volatileDrafts.set(draftId, next);
  };
  useDraftSessionLifecycle({ elementRef: inputRef, draftId, sensitive, composingRef, focusedRef, lastStoredDraftRef, focusHandoffRef, value, restoredDraftRef, setDraft });
  useLayoutEffect(() => {
    const previousExternal = latestExternalRef.current;
    latestExternalRef.current = value;
    if (value !== previousExternal && !composingRef.current) {
      setDraft(value);
      rememberDraft(value);
      if (inputRef.current && inputRef.current.value !== value) inputRef.current.value = value;
    }
  }, [value]);
  useEffect(() => {
    const restored = restoredDraftRef.current;
    if (!commitOnBlur && typeof restored === "string" && restored !== value) onValueChange(restored);
    // A page-lifetime draft is consumed only to restore this mount. Later
    // external updates are handled by the focused/composition guards above.
    restoredDraftRef.current = null;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <input
    ref={inputRef}
    {...props}
    // Keep the native pre-edit buffer outside React's controlled-value restore.
    // Mobile IMEs can update it before input; a simulation render in that gap
    // must not overwrite it. Explicit external changes synchronize above.
    defaultValue={draft}
    onFocus={(event) => { focusedRef.current = true; onFocus?.(event); }}
    onKeyDown={(event) => {
      // Candidate confirmation/navigation belongs to the IME, including the
      // legacy 229 event emitted after compositionend by some input methods.
      // Leave native editing intact while keeping application shortcuts out.
      if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        event.stopPropagation();
        return;
      }
      onKeyDown?.(event);
    }}
    onChange={(event) => {
      const next = event.currentTarget.value;
      setDraft(next);
      rememberDraft(next);
      if (!composingRef.current && !commitOnBlur) onValueChange(next);
    }}
    onCompositionStart={() => { composingRef.current = true; }}
    onCompositionEnd={(event) => {
      composingRef.current = false;
      const next = event.currentTarget.value;
      setDraft(next);
      rememberDraft(next);
      if (!commitOnBlur) onValueChange(next);
    }}
    onBlur={(event) => {
      focusedRef.current = false;
      const next = event.currentTarget.value;
      if (composingRef.current || next !== latestExternalRef.current) {
        composingRef.current = false;
        setDraft(next);
        rememberDraft(next);
        if (commitOnBlur || next !== latestExternalRef.current) onValueChange(next);
      }
      onBlur?.(event);
    }}
  />;
});

/** Textarea companion with the same page-lifetime and IME guarantees. */
type StableTextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  draftId: string;
  sensitive?: boolean;
  value: string;
  onValueChange: (value: string) => void;
};

export const StableTextArea = forwardRef<HTMLTextAreaElement, StableTextAreaProps>(function StableTextArea(props, forwardedRef) {
  const focusHandoffRef = useRef(false);
  return <StableTextAreaSession key={`${props.draftId}:${props.sensitive === true}`} {...props} focusHandoffRef={focusHandoffRef} ref={forwardedRef} />;
});

const StableTextAreaSession = forwardRef<HTMLTextAreaElement, StableTextAreaProps & { focusHandoffRef: DraftFocusHandoff }>(function StableTextAreaSession({ draftId, sensitive = false, value, onValueChange, onBlur, onFocus, onKeyDown, focusHandoffRef, ...props }, forwardedRef) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(forwardedRef, () => areaRef.current!, []);
  const restoredDraftRef = useRef<string | null | undefined>(undefined);
  if (restoredDraftRef.current === undefined) {
    restoredDraftRef.current = sensitive ? null : volatileDrafts.get(draftId) ?? null;
  }
  const [draft, setDraft] = useState(() => restoredDraftRef.current ?? value);
  const composingRef = useRef(false);
  const focusedRef = useRef(false);
  const latestExternalRef = useRef(value);
  const lastStoredDraftRef = useRef(draft);
  const rememberDraft = (next: string) => {
    lastStoredDraftRef.current = next;
    if (!sensitive) volatileDrafts.set(draftId, next);
  };
  useDraftSessionLifecycle({ elementRef: areaRef, draftId, sensitive, composingRef, focusedRef, lastStoredDraftRef, focusHandoffRef, value, restoredDraftRef, setDraft });
  useLayoutEffect(() => {
    const previousExternal = latestExternalRef.current;
    latestExternalRef.current = value;
    if (value !== previousExternal && !composingRef.current) {
      setDraft(value);
      rememberDraft(value);
      if (areaRef.current && areaRef.current.value !== value) areaRef.current.value = value;
    }
  }, [value]);
  useEffect(() => {
    const restored = restoredDraftRef.current;
    if (typeof restored === "string" && restored !== value) onValueChange(restored);
    restoredDraftRef.current = null;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next: string) => {
    setDraft(next);
    rememberDraft(next);
    onValueChange(next);
  };
  return <textarea
    ref={areaRef}
    {...props}
    defaultValue={draft}
    onFocus={(event) => { focusedRef.current = true; onFocus?.(event); }}
    onKeyDown={(event) => {
      if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        event.stopPropagation();
        return;
      }
      onKeyDown?.(event);
    }}
    onChange={(event) => {
      const next = event.currentTarget.value;
      setDraft(next);
      rememberDraft(next);
      if (!composingRef.current) onValueChange(next);
    }}
    onCompositionStart={() => { composingRef.current = true; }}
    onCompositionEnd={(event) => {
      composingRef.current = false;
      commit(event.currentTarget.value);
    }}
    onBlur={(event) => {
      focusedRef.current = false;
      if (composingRef.current || event.currentTarget.value !== latestExternalRef.current) {
        composingRef.current = false;
        commit(event.currentTarget.value);
      }
      onBlur?.(event);
    }}
  />;
});
