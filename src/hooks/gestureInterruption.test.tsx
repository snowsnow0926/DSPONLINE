/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHorizontalPan } from "./useHorizontalPan";
import { useSwipeDismiss } from "./useSwipeDismiss";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pointer(type: string, id: number, x = 0, y = 0, button = 0): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: id }, pointerType: { value: "touch" },
    clientX: { value: x }, clientY: { value: y }, button: { value: button },
  });
  return event;
}

function capture(surface: HTMLElement): void {
  const captured = new Set<number>();
  surface.setPointerCapture = (id) => { captured.add(id); };
  surface.hasPointerCapture = (id) => captured.has(id);
  surface.releasePointerCapture = (id) => {
    captured.delete(id);
    surface.dispatchEvent(pointer("lostpointercapture", id));
  };
}

describe("interrupted panel gestures", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div"); document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  function Pan() {
    const pan = useHorizontalPan<HTMLDivElement>();
    return <div ref={pan.surfaceRef} data-panning={pan.isPanning} {...pan.bindings} />;
  }

  function Swipe({ onDismiss }: { onDismiss: () => void }) {
    const swipe = useSwipeDismiss<HTMLButtonElement>({ axis: "y", direction: 1, onDismiss });
    return <button data-dragging={swipe.dragging} data-offset={swipe.offset} {...swipe.bindings}>抽屉把手</button>;
  }

  it.each(["lostpointercapture", "pointercancel"])("stops a horizontal drag on %s and ignores later motion from that pointer", (reason) => {
    act(() => root.render(<Pan />));
    const surface = host.firstElementChild as HTMLDivElement; capture(surface);
    act(() => surface.dispatchEvent(pointer("pointerdown", 7, 100, 0, 1)));
    act(() => surface.dispatchEvent(pointer("pointermove", 7, 60)));
    expect(surface.scrollLeft).toBe(40);
    expect(surface.dataset.panning).toBe("true");
    act(() => surface.dispatchEvent(pointer(reason, 7)));
    expect(surface.dataset.panning).toBe("false");
    act(() => surface.dispatchEvent(pointer("pointermove", 7, 20)));
    expect(surface.scrollLeft).toBe(40);
  });

  it("keeps the active horizontal drag when another pointer loses capture", () => {
    act(() => root.render(<Pan />));
    const surface = host.firstElementChild as HTMLDivElement; capture(surface);
    act(() => surface.dispatchEvent(pointer("pointerdown", 7, 100, 0, 1)));
    act(() => surface.dispatchEvent(pointer("lostpointercapture", 8)));
    expect(surface.dataset.panning).toBe("true");
    act(() => surface.dispatchEvent(pointer("pointermove", 7, 50)));
    expect(surface.scrollLeft).toBe(50);
    act(() => surface.dispatchEvent(pointer("pointerup", 7, 50)));
    expect(surface.dataset.panning).toBe("false");
  });

  it("does not cancel the container's horizontal capture when a descendant loses its old capture", () => {
    act(() => root.render(<Pan />));
    const surface = host.firstElementChild as HTMLDivElement; capture(surface);
    const child = document.createElement("button"); surface.append(child);
    act(() => surface.dispatchEvent(pointer("pointerdown", 7, 100, 0, 1)));
    act(() => child.dispatchEvent(pointer("lostpointercapture", 7)));
    expect(surface.dataset.panning).toBe("true");
    act(() => surface.dispatchEvent(pointer("pointermove", 7, 70)));
    expect(surface.scrollLeft).toBe(30);
  });

  it.each(["lostpointercapture", "pointercancel"])("cancels a drawer swipe on %s without closing it", (reason) => {
    const onDismiss = vi.fn();
    act(() => root.render(<Swipe onDismiss={onDismiss} />));
    const surface = host.firstElementChild as HTMLButtonElement; capture(surface);
    act(() => surface.dispatchEvent(pointer("pointerdown", 1)));
    act(() => surface.dispatchEvent(pointer("pointermove", 1, 0, 90)));
    expect(surface.dataset.offset).toBe("90");
    act(() => surface.dispatchEvent(pointer(reason, 1, 0, 90)));
    expect(surface.dataset.dragging).toBe("false");
    expect(surface.dataset.offset).toBe("0");
    act(() => surface.dispatchEvent(pointer("pointerup", 1, 0, 90)));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("closes once on a completed swipe even when releasing capture dispatches a nested event", () => {
    const onDismiss = vi.fn();
    act(() => root.render(<Swipe onDismiss={onDismiss} />));
    const surface = host.firstElementChild as HTMLButtonElement; capture(surface);
    act(() => surface.dispatchEvent(pointer("pointerdown", 1)));
    act(() => surface.dispatchEvent(pointer("pointermove", 1, 0, 90)));
    act(() => surface.dispatchEvent(pointer("pointerup", 1, 0, 90)));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(surface.dataset.dragging).toBe("false");
  });

  it("preserves a drawer gesture when its child transfers capture to the handle", () => {
    const onDismiss = vi.fn();
    act(() => root.render(<Swipe onDismiss={onDismiss} />));
    const surface = host.firstElementChild as HTMLButtonElement; capture(surface);
    const child = document.createElement("span"); surface.append(child);
    act(() => surface.dispatchEvent(pointer("pointerdown", 1)));
    act(() => child.dispatchEvent(pointer("lostpointercapture", 1)));
    expect(surface.dataset.dragging).toBe("true");
    act(() => surface.dispatchEvent(pointer("pointerup", 1, 0, 90)));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
