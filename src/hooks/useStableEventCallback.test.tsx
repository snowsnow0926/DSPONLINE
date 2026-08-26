// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStableEventCallback } from "./useStableEventCallback";

describe("useStableEventCallback", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("preserves identity while invoking the latest render callback", () => {
    const identities: Array<() => number> = [];
    const results: number[] = [];
    function Harness({ value }: { value: number }) {
      const callback = useStableEventCallback(() => value);
      identities.push(callback);
      return <button type="button" onClick={() => results.push(callback())}>run</button>;
    }

    act(() => root.render(<Harness value={1} />));
    act(() => (host.querySelector("button") as HTMLButtonElement).click());
    act(() => root.render(<Harness value={2} />));
    act(() => (host.querySelector("button") as HTMLButtonElement).click());

    expect(identities).toHaveLength(2);
    expect(identities[1]).toBe(identities[0]);
    expect(results).toEqual([1, 2]);
  });
});
