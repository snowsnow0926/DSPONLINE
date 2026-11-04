/** @vitest-environment jsdom */
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessibleDialog } from "./AccessibleDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("dialog focus return during responsive changes", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });

  function opener(name: string) { const button = document.createElement("button"); button.textContent = name; document.body.append(button); return button; }
  function render(open: boolean, returnFocusRef: ReturnType<typeof createRef<HTMLButtonElement>>) {
    act(() => root.render(<AccessibleDialog open={open} title="焦点检查" returnFocusRef={returnFocusRef} onRequestClose={() => undefined}><button type="button">弹窗操作</button></AccessibleDialog>));
  }

  it("returns to the current opener ref after the old responsive control is replaced", () => {
    const first = opener("旧布局入口"); const second = document.createElement("button"); second.textContent = "新布局入口";
    const returnRef = createRef<HTMLButtonElement>(); returnRef.current = first;
    act(() => first.focus()); render(true, returnRef);
    act(() => { first.replaceWith(second); returnRef.current = second; });
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
    render(false, returnRef);
    expect(document.activeElement).toBe(second);
  });

  it("falls back to the captured opener if the latest ref cannot receive focus", () => {
    const first = opener("原入口"); const returnRef = createRef<HTMLButtonElement>(); returnRef.current = first;
    act(() => first.focus()); render(true, returnRef);
    returnRef.current = document.createElement("button");
    render(false, returnRef);
    expect(document.activeElement).toBe(first);
  });

  it("does not crash closing the dialog when a focus method rejects both call styles", () => {
    const first = opener("失效入口"); const returnRef = createRef<HTMLButtonElement>(); returnRef.current = first;
    act(() => first.focus()); render(true, returnRef);
    first.focus = () => { throw new Error("focus target unavailable"); };
    expect(() => render(false, returnRef)).not.toThrow();
    expect(host.hasAttribute("inert")).toBe(false);
  });

  it.each(["before", "after"])("keeps a live outer opener when its layout changes %s the parent dialog closes", (timing) => {
    const first = opener("外层旧入口");
    const second = document.createElement("button"); second.textContent = "外层新入口";
    const outerRef = createRef<HTMLButtonElement>(); outerRef.current = first;
    const innerRef = createRef<HTMLButtonElement>();
    const renderNested = (outerOpen: boolean, innerOpen: boolean) => act(() => root.render(<>
      <AccessibleDialog open={outerOpen} title="外层" returnFocusRef={outerRef} onRequestClose={() => undefined}>
        <button ref={innerRef} type="button">内层入口</button>
      </AccessibleDialog>
      <AccessibleDialog open={innerOpen} title="内层" returnFocusRef={innerRef} onRequestClose={() => undefined}>
        <button type="button">内层操作</button>
      </AccessibleDialog>
    </>));
    act(() => first.focus()); renderNested(true, false); renderNested(true, true);
    const replaceOpener = () => act(() => { first.replaceWith(second); outerRef.current = second; });
    if (timing === "before") replaceOpener();
    renderNested(false, true);
    expect(document.activeElement?.textContent).toBe("内层操作");
    if (timing === "after") replaceOpener();
    renderNested(false, false);
    expect(document.activeElement).toBe(second);
    expect(host.hasAttribute("inert")).toBe(false);
  });
});
