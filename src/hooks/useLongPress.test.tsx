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
