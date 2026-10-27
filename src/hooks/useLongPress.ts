import { useCallback, useLayoutEffect, useRef, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from "react";

type LongPressBindings<T extends HTMLElement> = Pick<HTMLAttributes<T>,
  "onPointerDownCapture" | "onPointerMoveCapture" | "onPointerUpCapture" | "onPointerCancelCapture">;

interface LongPressOptions<T extends HTMLElement> {
  delayMs?: number;
  movementTolerance?: number;
  disabled?: boolean;
  resetKey?: string | number;
  getTarget: (event: ReactPointerEvent<T>) => string | null;
  onLongPress: (targetId: string, point: { x: number; y: number }) => void;
}

export function useLongPress<T extends HTMLElement>({
  delayMs = 520,
  movementTolerance = 12,
  disabled = false,
  resetKey = 0,
  getTarget,
  onLongPress,
}: LongPressOptions<T>): LongPressBindings<T> {
  const activePointersRef = useRef(new Set<number>());
  const gestureRef = useRef<{
    pointerId: number;
    targetId: string;
    x: number;
    y: number;
    timer: number;
  } | null>(null);

  const cancel = useCallback((pointerId?: number) => {
    const gesture = gestureRef.current;
    if (!gesture || (pointerId != null && gesture.pointerId !== pointerId)) return;
    window.clearTimeout(gesture.timer);
    gestureRef.current = null;
  }, []);

  const cancelAll = useCallback(() => {
    cancel();
    activePointersRef.current.clear();
  }, [cancel]);

  useLayoutEffect(() => {
    cancelAll();
    return cancelAll;
  }, [cancelAll, disabled, resetKey]);

  return {
    onPointerDownCapture: (event) => {
      const pointerEvent = event as ReactPointerEvent<T>;
      if (disabled) {
        cancelAll();
        return;
      }
      if (pointerEvent.pointerType === "mouse" || pointerEvent.button !== 0) return;
      activePointersRef.current.add(pointerEvent.pointerId);
      if (activePointersRef.current.size > 1) {
        cancel();
        return;
      }
      const targetId = getTarget(pointerEvent);
      if (!targetId) return;
      cancel();
      const gesture = {
        pointerId: pointerEvent.pointerId,
        targetId,
        x: pointerEvent.clientX,
        y: pointerEvent.clientY,
        timer: 0,
      };
      gesture.timer = window.setTimeout(() => {
        if (gestureRef.current !== gesture) return;
        gestureRef.current = null;
        onLongPress(targetId, { x: gesture.x, y: gesture.y });
        if (navigator.vibrate) navigator.vibrate(16);
      }, delayMs);
      gestureRef.current = gesture;
    },
    onPointerMoveCapture: (event) => {
      const pointerEvent = event as ReactPointerEvent<T>;
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== pointerEvent.pointerId) return;
      if (Math.hypot(pointerEvent.clientX - gesture.x, pointerEvent.clientY - gesture.y) > movementTolerance) {
        cancel(pointerEvent.pointerId);
      }
    },
    onPointerUpCapture: (event) => {
      const pointerId = (event as ReactPointerEvent<T>).pointerId;
      activePointersRef.current.delete(pointerId);
      cancel(pointerId);
    },
    onPointerCancelCapture: (event) => {
      const pointerId = (event as ReactPointerEvent<T>).pointerId;
      activePointersRef.current.delete(pointerId);
      cancel(pointerId);
    },
  };
}
