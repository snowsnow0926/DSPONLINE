import { useEffect, useRef } from "react";
import type { CanvasViewport } from "../game/types";

const DIRECTIONS: Record<string, { x: number; y: number }> = {
  KeyW: { x: 0, y: 1 }, KeyS: { x: 0, y: -1 },
  KeyA: { x: 1, y: 0 }, KeyD: { x: -1, y: 0 },
};
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"]';

export function isCanvasPanKey(event: KeyboardEvent): boolean {
  return Boolean(DIRECTIONS[event.code]) && !event.isComposing &&
    !event.ctrlKey && !event.metaKey && !event.altKey &&
    !(event.target instanceof Element && event.target.closest(EDITABLE));
}

/** Move the viewport only; never enqueue gameplay commands or retain a key across focus loss. */
export function useCanvasKeyboardPan(options: {
  enabled: () => boolean;
  getViewport: () => CanvasViewport;
  setViewport: (viewport: CanvasViewport) => unknown;
}): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    const keys = new Set<string>();
    let frame: number | null = null;
    let previous: number | null = null;
    const stop = () => {
      keys.clear();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      previous = null;
    };
    const allowed = () => !document.hidden && optionsRef.current.enabled() &&
      !document.querySelector('[role="dialog"], [aria-modal="true"]') &&
      !(document.activeElement instanceof Element && document.activeElement.closest(EDITABLE));
    const tick = (now: number) => {
      frame = null;
      if (!allowed() || keys.size === 0) { stop(); return; }
      const elapsed = previous === null ? 0 : Math.min(32, Math.max(0, now - previous));
      previous = now;
      let x = 0;
      let y = 0;
      for (const key of keys) { x += DIRECTIONS[key].x; y += DIRECTIONS[key].y; }
      const length = Math.hypot(x, y);
      if (elapsed > 0 && length > 0) {
        const viewport = optionsRef.current.getViewport();
        const distance = elapsed * 0.7;
        void optionsRef.current.setViewport({ ...viewport,
          x: viewport.x + x / length * distance, y: viewport.y + y / length * distance });
      }
      frame = requestAnimationFrame(tick);
    };
    const down = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.key === "Escape") { stop(); return; }
      if (event.defaultPrevented || !isCanvasPanKey(event) || !allowed()) return;
      event.preventDefault();
      keys.add(event.code);
      if (frame === null) frame = requestAnimationFrame(tick);
    };
    const up = (event: KeyboardEvent) => {
      keys.delete(event.code);
      if (keys.size === 0) stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    document.addEventListener("focusin", stop);
    return () => {
      stop();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", stop);
      document.removeEventListener("focusin", stop);
    };
  }, []);
}
