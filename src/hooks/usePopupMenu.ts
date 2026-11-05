import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

function focusItem(item: HTMLButtonElement | undefined) {
  item?.focus({ preventScroll: true });
  item?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/** Event ownership for a non-modal menu; its listeners never capture game state. */
export function usePopupMenu() {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openingEdgeRef = useRef<"first" | "last">("first");
  const tabDismissFrameRef = useRef<number | null>(null);
  const id = useId();
  const triggerId = `${id}-trigger`;
  const menuId = `${id}-menu`;
  const items = useCallback(() => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>(
    'button[role="menuitem"]:not(:disabled)',
  ) ?? []).filter((item) => !item.hidden && item.getAttribute("aria-disabled") !== "true"), []);

  const close = useCallback((returnFocus = false) => {
    openRef.current = false;
    setOpen(false);
    if (tabDismissFrameRef.current !== null) {
      window.cancelAnimationFrame(tabDismissFrameRef.current);
      tabDismissFrameRef.current = null;
    }
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openAt = useCallback((edge: "first" | "last") => {
    openingEdgeRef.current = edge;
    if (openRef.current) {
      const enabled = items();
      focusItem(edge === "last" ? enabled.at(-1) : enabled[0]);
    } else {
      openRef.current = true;
      setOpen(true);
    }
  }, [items]);

  const toggle = useCallback(() => {
    if (openRef.current) close(true);
    else openAt("first");
  }, [close, openAt]);

  const selectAction = useCallback((action: () => void) => {
    // A newly opened dialog must capture a connected return target.
    triggerRef.current?.focus({ preventScroll: true });
    close();
    action();
  }, [close]);

  const onTriggerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      openAt(event.key === "ArrowUp" ? "last" : "first");
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) toggle();
    }
  }, [openAt, toggle]);

  useLayoutEffect(() => {
    if (!open) return;
    const enabled = items();
    focusItem(openingEdgeRef.current === "last" ? enabled.at(-1) : enabled[0]);
  }, [items, open]);

  useEffect(() => {
    if (!open) return;
    const contains = (target: EventTarget | null) => target instanceof Node &&
      Boolean(triggerRef.current?.contains(target) || menuRef.current?.contains(target));
    const onPointerDown = (event: PointerEvent) => { if (!contains(event.target)) close(); };
    const onFocusIn = (event: FocusEvent) => { if (!contains(event.target)) close(); };
    const onResize = () => { if (!triggerRef.current?.getClientRects().length) close(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!openRef.current || !contains(event.target) || event.isComposing || event.keyCode === 229 ||
        event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Tab") {
        // Keep the focused item connected until native Tab navigation finishes.
        if (tabDismissFrameRef.current === null) tabDismissFrameRef.current = window.requestAnimationFrame(() => {
          tabDismissFrameRef.current = null;
          close();
        });
        return;
      }
      event.stopPropagation();
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const enabled = items();
        if (enabled.length === 0) return;
        const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 :
          index < 0 ? event.key === "ArrowUp" ? enabled.length - 1 : 0 :
            (index + (event.key === "ArrowUp" ? -1 : 1) + enabled.length) % enabled.length;
        focusItem(enabled[next]);
      } else if (event.key === "Escape") {
        event.preventDefault(); close(true);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (event.repeat) return;
        if (triggerRef.current?.contains(event.target as Node)) close(true);
        else if (event.target instanceof Element) {
          const item = event.target.closest<HTMLButtonElement>('button[role="menuitem"]');
          if (item && !item.disabled && item.getAttribute("aria-disabled") !== "true") item.click();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("resize", onResize);
      if (tabDismissFrameRef.current !== null) {
        window.cancelAnimationFrame(tabDismissFrameRef.current);
        tabDismissFrameRef.current = null;
      }
    };
  }, [close, items, open]);

  return { open, triggerRef, menuRef, triggerId, menuId, toggle, onTriggerKeyDown, selectAction };
}
