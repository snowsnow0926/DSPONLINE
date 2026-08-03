import { useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

type HorizontalPanBindings<T extends HTMLElement> = Pick<HTMLAttributes<T>,
  "onWheel" | "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onContextMenu">;

/** Convert a vertical wheel gesture to horizontal motion without leaking it to the page. */
export function horizontalWheelDelta(deltaX: number, deltaY: number): number {
  return Math.abs(deltaX) > 0.01 ? deltaX : deltaY;
}

export function useHorizontalPan<T extends HTMLElement>(options: { wheelMode?: "horizontal" | "axis-lock" } = {}): { bindings: HorizontalPanBindings<T>; isPanning: boolean } {
  const dragRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number } | null>(null);
  const wheelLockRef = useRef<{ axis: "x" | "y"; expiresAt: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  const finishPan = (event: ReactPointerEvent<T>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setIsPanning(false);
  };

  return {
    isPanning,
    bindings: {
      onWheel: (event) => {
        const wheelEvent = event as ReactWheelEvent<T>;
        const surface = wheelEvent.currentTarget;
        if (options.wheelMode === "axis-lock") {
          const now = performance.now();
          const currentLock = wheelLockRef.current;
          let axis = currentLock && currentLock.expiresAt > now
            ? currentLock.axis
            : Math.abs(wheelEvent.deltaX) > Math.abs(wheelEvent.deltaY) ? "x" as const : "y" as const;
          if (axis === "x" && surface.scrollWidth <= surface.clientWidth && surface.scrollHeight > surface.clientHeight) axis = "y";
          if (axis === "y" && surface.scrollHeight <= surface.clientHeight && surface.scrollWidth > surface.clientWidth) axis = "x";
          const delta = axis === "x"
            ? horizontalWheelDelta(wheelEvent.deltaX, wheelEvent.deltaY)
            : wheelEvent.deltaY;
          if (Math.abs(delta) <= 0.01) return;
          wheelLockRef.current = { axis, expiresAt: now + 180 };
          if (axis === "x") surface.scrollLeft += delta;
          else surface.scrollTop += delta;
          wheelEvent.preventDefault();
          wheelEvent.stopPropagation();
          return;
        }
        const scrollTop = surface.scrollTop;
        const delta = horizontalWheelDelta(wheelEvent.deltaX, wheelEvent.deltaY);
        wheelEvent.preventDefault();
        wheelEvent.stopPropagation();
        if (Math.abs(delta) > 0.01) surface.scrollLeft += delta;
        // Horizontal-only surfaces must not leak diagonal or boundary gestures.
        if (surface.scrollTop !== scrollTop) surface.scrollTop = scrollTop;
      },
      onPointerDown: (event) => {
        const pointerEvent = event as ReactPointerEvent<T>;
        if (pointerEvent.button !== 2) return;
        pointerEvent.preventDefault();
        pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
        dragRef.current = {
          pointerId: pointerEvent.pointerId,
          startX: pointerEvent.clientX,
          startScrollLeft: pointerEvent.currentTarget.scrollLeft,
        };
        setIsPanning(true);
      },
      onPointerMove: (event) => {
        const pointerEvent = event as ReactPointerEvent<T>;
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== pointerEvent.pointerId) return;
        pointerEvent.currentTarget.scrollLeft = drag.startScrollLeft - (pointerEvent.clientX - drag.startX);
      },
      onPointerUp: (event) => finishPan(event as ReactPointerEvent<T>),
      onPointerCancel: (event) => finishPan(event as ReactPointerEvent<T>),
      onContextMenu: (event) => event.preventDefault(),
    },
  };
}
