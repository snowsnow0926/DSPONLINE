import { useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from "react";
import { alignToDevicePixel } from "../game/displayPixels";

type SwipeDismissBindings<T extends HTMLElement> = Pick<HTMLAttributes<T>,
  "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onLostPointerCapture">;

interface SwipeDismissOptions {
  axis: "x" | "y";
  direction: 1 | -1;
  threshold?: number;
  onDismiss: () => void;
}

export function useSwipeDismiss<T extends HTMLElement>({ axis, direction, threshold = 64, onDismiss }: SwipeDismissOptions): {
  bindings: SwipeDismissBindings<T>;
  offset: number;
  dragging: boolean;
  consumeSwipeClick: () => boolean;
} {
  const dragRef = useRef<{ pointerId: number; start: number } | null>(null);
  const suppressClickRef = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const finish = (event: ReactPointerEvent<T>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = axis === "x" ? event.clientX - drag.start : event.clientY - drag.start;
    dragRef.current = null;
    setDragging(false);
    setOffset(0);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && distance * direction >= threshold) {
      suppressClickRef.current = true;
      event.preventDefault();
      onDismiss();
    }
  };

  return {
    offset,
    dragging,
    consumeSwipeClick: () => {
      const suppress = suppressClickRef.current;
      suppressClickRef.current = false;
      return suppress;
    },
    bindings: {
      onPointerDown: (event) => {
        const pointerEvent = event as ReactPointerEvent<T>;
        if (pointerEvent.button !== 0) return;
        suppressClickRef.current = false;
        pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
        dragRef.current = {
          pointerId: pointerEvent.pointerId,
          start: axis === "x" ? pointerEvent.clientX : pointerEvent.clientY,
        };
        setDragging(true);
      },
      onPointerMove: (event) => {
        const pointerEvent = event as ReactPointerEvent<T>;
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== pointerEvent.pointerId) return;
        const current = axis === "x" ? pointerEvent.clientX : pointerEvent.clientY;
        setOffset(alignToDevicePixel(Math.max(0, (current - drag.start) * direction)));
      },
      onPointerUp: (event) => finish(event as ReactPointerEvent<T>),
      onPointerCancel: (event) => finish(event as ReactPointerEvent<T>, true),
      onLostPointerCapture: (event) => {
        if (event.target === event.currentTarget) finish(event as ReactPointerEvent<T>, true);
      },
    },
  };
}
