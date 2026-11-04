import { useCallback, useLayoutEffect, useRef, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from "react";

type LongPressBindings<T extends HTMLElement> = Pick<HTMLAttributes<T>,
  "onPointerDownCapture" | "onPointerMoveCapture" | "onPointerUpCapture" | "onPointerCancelCapture" | "onLostPointerCaptureCapture" | "onClickCapture">;

interface LongPressOptions<T extends HTMLElement> {
  delayMs?: number;
  movementTolerance?: number;
  disabled?: boolean;
  resetKey?: string | number;
  getTarget: (event: ReactPointerEvent<T>) => string | null;
  /** Return false when the caller already handles the trailing click. */
  onLongPress: (targetId: string, point: { x: number; y: number }) => void | boolean;
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
  const completedPressRef = useRef<{ pointerId: number; x: number; y: number; expiresAt: number | null } | null>(null);
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
    completedPressRef.current = null;
  }, [cancel]);

  useLayoutEffect(() => {
    cancelAll();
    return cancelAll;
  }, [cancelAll, disabled, resetKey]);

  return {
    onPointerDownCapture: (event) => {
      const pointerEvent = event as ReactPointerEvent<T>;
      completedPressRef.current = null;
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
        if (onLongPress(targetId, { x: gesture.x, y: gesture.y }) !== false) {
          completedPressRef.current = { pointerId: gesture.pointerId, x: gesture.x, y: gesture.y, expiresAt: null };
        }
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
      if (completedPressRef.current?.pointerId === pointerId) completedPressRef.current.expiresAt = performance.now() + 500;
      activePointersRef.current.delete(pointerId);
      cancel(pointerId);
    },
    onPointerCancelCapture: (event) => {
      const pointerId = (event as ReactPointerEvent<T>).pointerId;
      if (completedPressRef.current?.pointerId === pointerId) completedPressRef.current = null;
      activePointersRef.current.delete(pointerId);
      cancel(pointerId);
    },
    onLostPointerCaptureCapture: (event) => {
      const pointerId = (event as ReactPointerEvent<T>).pointerId;
      // React Flow can transfer implicit touch capture from a node to an
      // ancestor in this surface. That is still the same active gesture.
      let ancestor = event.target instanceof Element ? event.target : null;
      while (ancestor && event.currentTarget.contains(ancestor)) {
        if (ancestor.hasPointerCapture?.(pointerId)) return;
        ancestor = ancestor.parentElement;
      }
      activePointersRef.current.delete(pointerId);
      cancel(pointerId);
    },
    onClickCapture: (event) => {
      const completed = completedPressRef.current;
      if (!completed || event.detail === 0) return;
      if (completed.expiresAt !== null && performance.now() > completed.expiresAt) {
        completedPressRef.current = null;
        return;
      }
      const matchesPointer = "pointerId" in event.nativeEvent
        ? event.nativeEvent.pointerId === completed.pointerId
        : Math.hypot(event.clientX - completed.x, event.clientY - completed.y) <= movementTolerance;
      if (!matchesPointer) return;
      completedPressRef.current = null;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
