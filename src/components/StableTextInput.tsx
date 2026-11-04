import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

const volatileDrafts = new Map<string, string>();

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
export const StableTextInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  draftId: string;
  sensitive?: boolean;
  commitOnBlur?: boolean;
  value: string;
  onValueChange: (value: string) => void;
}>(function StableTextInput({ draftId, sensitive = false, commitOnBlur = false, value, onValueChange, onBlur, onFocus, onKeyDown, ...props }, forwardedRef) {
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
  const initializedFromDraftRef = useRef(restoredDraftRef.current !== null);
  useLayoutEffect(() => {
    const previousExternal = latestExternalRef.current;
    latestExternalRef.current = value;
    if (initializedFromDraftRef.current) {
      initializedFromDraftRef.current = false;
      return;
    }
    if (!composingRef.current && (!focusedRef.current || value !== previousExternal)) {
      setDraft(value);
      if (inputRef.current && inputRef.current.value !== value) inputRef.current.value = value;
    }
  }, [value]);
  useEffect(() => {
    if (!sensitive) volatileDrafts.set(draftId, draft);
  }, [draft, draftId, sensitive]);
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
      if (!sensitive) volatileDrafts.set(draftId, next);
      if (!composingRef.current && !commitOnBlur) onValueChange(next);
    }}
    onCompositionStart={() => { composingRef.current = true; }}
    onCompositionEnd={(event) => {
      composingRef.current = false;
      const next = event.currentTarget.value;
      setDraft(next);
      if (!sensitive) volatileDrafts.set(draftId, next);
      if (!commitOnBlur) onValueChange(next);
    }}
    onBlur={(event) => {
      focusedRef.current = false;
      const next = event.currentTarget.value;
      if (composingRef.current || next !== latestExternalRef.current) {
        composingRef.current = false;
        setDraft(next);
        if (!sensitive) volatileDrafts.set(draftId, next);
        if (commitOnBlur || next !== latestExternalRef.current) onValueChange(next);
      }
      onBlur?.(event);
    }}
  />;
});

/** Textarea companion with the same page-lifetime and IME guarantees. */
export const StableTextArea = forwardRef<HTMLTextAreaElement, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  draftId: string;
  sensitive?: boolean;
  value: string;
  onValueChange: (value: string) => void;
}>(function StableTextArea({ draftId, sensitive = false, value, onValueChange, onBlur, onFocus, onKeyDown, ...props }, forwardedRef) {
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
  const initializedFromDraftRef = useRef(restoredDraftRef.current !== null);
  useLayoutEffect(() => {
    const previousExternal = latestExternalRef.current;
    latestExternalRef.current = value;
    if (initializedFromDraftRef.current) {
      initializedFromDraftRef.current = false;
      return;
    }
    if (!composingRef.current && (!focusedRef.current || value !== previousExternal)) {
      setDraft(value);
      if (areaRef.current && areaRef.current.value !== value) areaRef.current.value = value;
    }
  }, [value]);
  useEffect(() => {
    if (!sensitive) volatileDrafts.set(draftId, draft);
  }, [draft, draftId, sensitive]);
  useEffect(() => {
    const restored = restoredDraftRef.current;
    if (typeof restored === "string" && restored !== value) onValueChange(restored);
    restoredDraftRef.current = null;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next: string) => {
    setDraft(next);
    if (!sensitive) volatileDrafts.set(draftId, next);
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
      if (!sensitive) volatileDrafts.set(draftId, next);
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
