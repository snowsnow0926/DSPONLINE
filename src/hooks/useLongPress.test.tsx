/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLongPress } from "./useLongPress";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pointerEvent(type: string, pointerId = 1): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "touch" },
    clientX: { value: 12 },
    clientY: { value: 18 },
    button: { value: 0 },
  });
  return event;
}

describe("useLongPress", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("cancels a lost pointer before the menu opens and allows a later long press", () => {
    const onLongPress = vi.fn();
    function Harness() {
      return <div {...useLongPress<HTMLDivElement>({ delayMs: 100, getTarget: () => "entity", onLongPress })} />;
    }
    act(() => root.render(<Harness />));
    const target = host.firstElementChild!;
    act(() => target.dispatchEvent(pointerEvent("pointerdown", 1)));
    act(() => target.dispatchEvent(pointerEvent("lostpointercapture", 1)));
    act(() => vi.advanceTimersByTime(150));
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => target.dispatchEvent(pointerEvent("pointerdown", 2)));
    act(() => vi.advanceTimersByTime(100));
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it("keeps a long press when touch capture moves from its child to this surface", () => {
    const onLongPress = vi.fn();
    function Harness() {
      return <div {...useLongPress<HTMLDivElement>({ delayMs: 100, getTarget: () => "entity", onLongPress })}><span>node</span></div>;
    }
    act(() => root.render(<Harness />));
    const surface = host.firstElementChild as HTMLElement;
    surface.hasPointerCapture = (id) => id === 1;
    act(() => surface.firstElementChild!.dispatchEvent(pointerEvent("pointerdown", 1)));
    act(() => surface.firstElementChild!.dispatchEvent(pointerEvent("lostpointercapture", 1)));
    act(() => vi.advanceTimersByTime(100));
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it("consumes the release click after a long hold but preserves the next ordinary tap", () => {
    const click = vi.fn();
    function Harness() {
      const bindings = useLongPress<HTMLDivElement>({ delayMs: 100, getTarget: () => "entity", onLongPress: () => undefined });
      return <div onClick={click}><div data-target {...bindings} /></div>;
    }
    act(() => root.render(<Harness />));
    const target = host.querySelector("[data-target]")!;
    act(() => target.dispatchEvent(pointerEvent("pointerdown", 1)));
    act(() => vi.advanceTimersByTime(1500));
    act(() => target.dispatchEvent(pointerEvent("pointerup", 1)));
    const release = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: 12, clientY: 18 });
    act(() => target.dispatchEvent(release));
    expect(release.defaultPrevented).toBe(true);
    expect(click).not.toHaveBeenCalled();
    act(() => target.dispatchEvent(pointerEvent("pointerdown", 2)));
    act(() => target.dispatchEvent(pointerEvent("pointerup", 2)));
    act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 12, clientY: 18 })));
    expect(click).toHaveBeenCalledOnce();
  });

  it("keeps keyboard activation and caller-owned port click handling", () => {
    const click = vi.fn();
    function Harness({ callerOwnsClick = false }: { callerOwnsClick?: boolean }) {
      const bindings = useLongPress<HTMLDivElement>({ delayMs: 100, getTarget: () => "port", onLongPress: () => callerOwnsClick ? false : undefined });
      return <div onClick={click}><div data-target {...bindings} /></div>;
    }
    act(() => root.render(<Harness />));
    const target = host.querySelector("[data-target]")!;
    act(() => target.dispatchEvent(pointerEvent("pointerdown", 1)));
    act(() => vi.advanceTimersByTime(100));
    act(() => target.dispatchEvent(pointerEvent("pointerup", 1)));
    act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    expect(click).toHaveBeenCalledOnce();
    act(() => root.render(<Harness callerOwnsClick />));
    act(() => target.dispatchEvent(pointerEvent("pointerdown", 2)));
    act(() => vi.advanceTimersByTime(100));
    act(() => target.dispatchEvent(pointerEvent("pointerup", 2)));
    act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 12, clientY: 18 })));
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("cancels the old timer and active pointer when a native route reset arrives", () => {
    const onLongPress = vi.fn();
    function Harness({ resetKey, revision, disabled = false }: { resetKey: string; revision: number; disabled?: boolean }) {
      const bindings = useLongPress<HTMLDivElement>({
        delayMs: 100,
        disabled,
        resetKey,
        getTarget: () => "entity-old",
        onLongPress,
      });
      return <div data-testid="target" data-revision={revision} {...bindings} />;
    }

    act(() => root.render(<Harness resetKey="session-a:home" revision={7} />));
    const target = host.querySelector("[data-testid=target]")!;
    act(() => target.dispatchEvent(pointerEvent("pointerdown")));

    // A normal simulation revision on the same route must not starve a 520 ms
    // gesture. Revision is intentionally not part of resetKey.
    act(() => root.render(<Harness resetKey="session-a:home" revision={8} />));
    act(() => vi.advanceTimersByTime(100));
    expect(onLongPress).toHaveBeenCalledOnce();
    act(() => target.dispatchEvent(pointerEvent("pointerup")));
    onLongPress.mockClear();

    act(() => target.dispatchEvent(pointerEvent("pointerdown", 2)));
    act(() => root.render(<Harness resetKey="session-b:frost" revision={1} disabled />));
    act(() => vi.advanceTimersByTime(150));
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => root.render(<Harness resetKey="session-b:frost" revision={2} />));
    act(() => target.dispatchEvent(pointerEvent("pointerdown", 3)));
    act(() => vi.advanceTimersByTime(100));
    expect(onLongPress).toHaveBeenCalledOnce();
  });
});
