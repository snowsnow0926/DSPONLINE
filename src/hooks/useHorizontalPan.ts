import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

type HorizontalPanBindings<T extends HTMLElement> = Pick<HTMLAttributes<T>,
  "onKeyDown" | "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onLostPointerCapture" | "onContextMenu">;

/** Convert a vertical wheel gesture to horizontal motion without leaking it to the page. */
export function horizontalWheelDelta(deltaX: number, deltaY: number, deltaMode = 0, pagePixels = 800): number {
  const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, pagePixels) : 1;
  return (deltaX + deltaY) * scale;
}

export function horizontalFocusScrollLeft(
  currentScrollLeft: number,
  viewportLeft: number,
  viewportWidth: number,
  targetLeft: number,
  targetWidth: number,
  scrollWidth: number,
): number {
  const centered = currentScrollLeft + targetLeft - viewportLeft - (viewportWidth - targetWidth) / 2;
  return Math.max(0, Math.min(Math.max(0, scrollWidth - viewportWidth), centered));
}

export function useHorizontalPan<T extends HTMLElement>(options: { wheelMode?: "horizontal" | "axis-lock" } = {}): { bindings: HorizontalPanBindings<T>; isPanning: boolean; surfaceRef: RefObject<T | null> } {
  const surfaceRef = useRef<T | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number } | null>(null);
  const wheelLockRef = useRef<{ axis: "x" | "y"; expiresAt: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const onWheel = (wheelEvent: WheelEvent) => {
      if (options.wheelMode === "axis-lock") {
        const now = performance.now();
        const currentLock = wheelLockRef.current;
        let axis = currentLock && currentLock.expiresAt > now
          ? currentLock.axis
          : Math.abs(wheelEvent.deltaX) > Math.abs(wheelEvent.deltaY) ? "x" as const : "y" as const;
        if (axis === "x" && surface.scrollWidth <= surface.clientWidth && surface.scrollHeight > surface.clientHeight) axis = "y";
        if (axis === "y" && surface.scrollHeight <= surface.clientHeight && surface.scrollWidth > surface.clientWidth) axis = "x";
        const delta = axis === "x"
          ? horizontalWheelDelta(wheelEvent.deltaX, wheelEvent.deltaY, wheelEvent.deltaMode, surface.clientWidth)
          : wheelEvent.deltaY * (wheelEvent.deltaMode === 1 ? 16 : wheelEvent.deltaMode === 2 ? surface.clientHeight : 1);
        if (Math.abs(delta) <= 0.01) return;
        wheelLockRef.current = { axis, expiresAt: now + 180 };
        if (axis === "x") surface.scrollLeft += delta;
        else surface.scrollTop += delta;
        wheelEvent.preventDefault();
        wheelEvent.stopPropagation();
        return;
      }
      const delta = horizontalWheelDelta(
        wheelEvent.deltaX,
        wheelEvent.deltaY,
        wheelEvent.deltaMode,
        surface.clientWidth,
      );
      if (Math.abs(delta) <= 0.01) return;
      surface.scrollLeft += delta;
      // A native non-passive listener is required here. React/Chrome may make
      // delegated wheel listeners passive, which allows the same gesture to
      // move scrollTop before the synthetic handler can cancel it.
      surface.scrollTop = 0;
      wheelEvent.preventDefault();
      wheelEvent.stopPropagation();
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, [options.wheelMode]);

  const finishPan = (event: ReactPointerEvent<T>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return {
    surfaceRef,
    isPanning,
    bindings: {
      onKeyDown: (event) => {
        const keyboardEvent = event as ReactKeyboardEvent<T>;
        if (keyboardEvent.target !== keyboardEvent.currentTarget) return;
        const surface = keyboardEvent.currentTarget;
        const step = Math.max(80, surface.clientWidth * 0.8);
        if (keyboardEvent.key === "ArrowLeft") surface.scrollLeft -= 80;
        else if (keyboardEvent.key === "ArrowRight") surface.scrollLeft += 80;
        else if (keyboardEvent.key === "PageUp") surface.scrollLeft -= step;
        else if (keyboardEvent.key === "PageDown") surface.scrollLeft += step;
        else if (keyboardEvent.key === "Home") surface.scrollLeft = 0;
        else if (keyboardEvent.key === "End") surface.scrollLeft = surface.scrollWidth;
        else return;
        keyboardEvent.preventDefault();
        keyboardEvent.stopPropagation();
      },
      onPointerDown: (event) => {
        const pointerEvent = event as ReactPointerEvent<T>;
        if (pointerEvent.button !== 1 && pointerEvent.button !== 2) return;
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
      onLostPointerCapture: (event) => {
        if (event.target === event.currentTarget) finishPan(event as ReactPointerEvent<T>);
      },
      onContextMenu: (event) => event.preventDefault(),
    },
  };
}
