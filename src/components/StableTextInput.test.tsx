/** @vitest-environment jsdom */
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StableTextArea, StableTextInput, clearStableTextDraft, readStableTextDraft, updateStableTextDraft } from "./StableTextInput";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ draftId = "search", sensitive = false }: { draftId?: string; sensitive?: boolean }) {
  const [value, setValue] = useState("");
  return <StableTextInput aria-label="测试输入" draftId={draftId} sensitive={sensitive} value={value} onValueChange={setValue} />;
}

function TextAreaHarness({ draftId = "notes" }: { draftId?: string }) {
  const [value, setValue] = useState("");
  return <StableTextArea aria-label="测试备注" draftId={draftId} value={value} onValueChange={setValue} />;
}

function ControlledHarness({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) {
  return <StableTextInput aria-label="受控输入" draftId="controlled-reset" value={value} onValueChange={onValueChange} />;
}

function BlurCommitHarness({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) {
  return <StableTextInput commitOnBlur aria-label={`${value || "未命名"}名称`} draftId="blur-commit" value={value} onValueChange={onValueChange} />;
}

function inputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function composingValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: value }));
  });
}

describe("StableTextInput", () => {
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

  it("keeps Chinese composition text when a parent render supplies the old external value", () => {
    act(() => root.render(<Harness draftId="ime" />));
    const input = host.querySelector("input")!;
    act(() => input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    inputValue(input, "单极");
    act(() => root.render(<Harness draftId="ime" />));
    expect(input.value).toBe("单极");
    act(() => input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "单极" })));
    expect(input.value).toBe("单极");
    clearStableTextDraft("ime");
  });

  it("keeps the native IME buffer when a parent refresh precedes the input event", () => {
    const changes: string[] = [];
    const render = () => root.render(<StableTextInput
      draftId="ime-before-input"
      value=""
      onValueChange={(value) => changes.push(value)}
    />);
    act(render);
    const input = host.querySelector("input")!;
    act(() => {
      input.focus();
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      // Some mobile IMEs expose the pre-edit buffer before dispatching input.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "dian");
      input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "dian" }));
    });
    act(render);
    expect(input.value).toBe("dian");
    expect(document.activeElement).toBe(input);
    expect(changes).toEqual([]);
    composingValue(input, "电路板");
    expect(input.value).toBe("电路板");
    expect(changes).toEqual(["电路板"]);
    clearStableTextDraft("ime-before-input");
  });

  it("survives a responsive remount in the same page without persistent storage", () => {
    act(() => root.unmount());
    host.remove();
    updateStableTextDraft("responsive-search", "量子物流");
    expect(readStableTextDraft("responsive-search")).toBe("量子物流");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness draftId="responsive-search" />));
    expect(host.querySelector("input")!.value).toBe("量子物流");
    clearStableTextDraft("responsive-search");
  });

  it("never shares a sensitive password draft across remounts", () => {
    act(() => root.render(<Harness draftId="password" sensitive />));
    inputValue(host.querySelector("input")!, "secret-pass");
    act(() => root.unmount());
    host.remove();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness draftId="password" sensitive />));
    expect(host.querySelector("input")!.value).toBe("");
  });

  it("keeps independent search and picker drafts without leaking between fields", () => {
    updateStableTextDraft("recipe-search", "单极磁石");
    updateStableTextDraft("item-picker", "量子芯片");
    expect(readStableTextDraft("recipe-search")).toBe("单极磁石");
    expect(readStableTextDraft("item-picker")).toBe("量子芯片");
    clearStableTextDraft("recipe-search");
    expect(readStableTextDraft("recipe-search")).toBeNull();
    expect(readStableTextDraft("item-picker")).toBe("量子芯片");
    clearStableTextDraft("item-picker");
  });

  it("keeps textarea composition and restores its page-lifetime draft after a remount", () => {
    act(() => root.render(<TextAreaHarness draftId="planet-notes" />));
    const area = host.querySelector("textarea")!;
    act(() => area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      setter?.call(area, "绿糖出口");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => root.render(<TextAreaHarness draftId="planet-notes" />));
    expect(area.value).toBe("绿糖出口");
    act(() => area.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "绿糖出口" })));
    act(() => root.unmount());
    host.remove();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<TextAreaHarness draftId="planet-notes" />));
    expect(host.querySelector("textarea")!.value).toBe("绿糖出口");
    clearStableTextDraft("planet-notes");
  });

  it("keeps the textarea native pre-edit buffer and selection across refreshes", () => {
    const ref = createRef<HTMLTextAreaElement>();
    const changes: string[] = [];
    const render = () => root.render(<StableTextArea ref={ref} draftId="area-before-input" value="" onValueChange={(value) => changes.push(value)} />);
    act(render);
    const area = host.querySelector("textarea")!;
    expect(ref.current).toBe(area);
    act(() => {
      area.focus();
      area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "量子物流备注");
      area.setSelectionRange(2, 4);
      area.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "物流" }));
    });
    act(render);
    expect(area.value).toBe("量子物流备注");
    expect([area.selectionStart, area.selectionEnd]).toEqual([2, 4]);
    expect(changes).toEqual([]);
    act(() => area.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "物流" })));
    expect(changes).toEqual(["量子物流备注"]);
    clearStableTextDraft("area-before-input");
  });

  it("forwards the native input ref and applies external history choices and clears", () => {
    const ref = createRef<HTMLInputElement>();
    const render = (value: string) => root.render(<StableTextInput ref={ref} draftId="external-history" value={value} onValueChange={() => undefined} />);
    act(() => render("磁线圈"));
    const input = host.querySelector("input")!;
    expect(ref.current).toBe(input);
    act(() => ref.current!.focus());
    act(() => render("电路板"));
    expect(input.value).toBe("电路板");
    act(() => render(""));
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    clearStableTextDraft("external-history");
  });

  it("survives parent refresh, viewport events, blur and a late compositionend", () => {
    act(() => root.render(<Harness draftId="mobile-ime-sequence" />));
    const input = host.querySelector("input")!;
    act(() => {
      input.focus();
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    inputValue(input, "量子物");
    act(() => {
      root.render(<Harness draftId="mobile-ime-sequence" />);
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("orientationchange"));
      document.dispatchEvent(new Event("fullscreenchange"));
      input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "量子物流" }));
    });
    expect(input.value).toBe("量子物");
    expect(readStableTextDraft("mobile-ime-sequence")).toBe("量子物");
    clearStableTextDraft("mobile-ime-sequence");
  });

  it("accepts an intentional external clear while focused after ordinary input", () => {
    const onValueChange = (next: string) => {
      act(() => root.render(<ControlledHarness value={next} onValueChange={onValueChange} />));
    };
    act(() => root.render(<ControlledHarness value="" onValueChange={onValueChange} />));
    const input = host.querySelector("input")!;
    act(() => input.focus());
    inputValue(input, "提交后的反馈");
    expect(input.value).toBe("提交后的反馈");
    act(() => root.render(<ControlledHarness value="" onValueChange={onValueChange} />));
    expect(input.value).toBe("");
    clearStableTextDraft("controlled-reset");
  });

  it("keeps a rename label stable while editing and commits once on blur", () => {
    const changes: string[] = [];
    const onValueChange = (next: string) => changes.push(next);
    act(() => root.render(<BlurCommitHarness value="原名称" onValueChange={onValueChange} />));
    const input = host.querySelector("input")!;
    act(() => input.focus());
    inputValue(input, "新名称");
    expect(input.getAttribute("aria-label")).toBe("原名称名称");
    expect(changes).toEqual([]);
    act(() => input.blur());
    expect(changes).toEqual(["新名称"]);
    clearStableTextDraft("blur-commit");
  });
});
