/** @vitest-environment jsdom */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StableTextArea, StableTextInput, clearStableTextDraft, readStableTextDraft, updateStableTextDraft } from "./StableTextInput";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Field = HTMLInputElement | HTMLTextAreaElement;
type Kind = "input" | "textarea";

describe("text draft ownership changes", () => {
  let host: HTMLDivElement;
  let root: Root;
  const ids = new Set<string>();
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); for (const id of ids) clearStableTextDraft(id); ids.clear(); });

  function render(kind: Kind, draftId: string, value: string, onValueChange = vi.fn(), sensitive = false) {
    ids.add(draftId);
    act(() => root.render(kind === "input"
      ? <StableTextInput draftId={draftId} value={value} onValueChange={onValueChange} sensitive={sensitive} commitOnBlur />
      : <StableTextArea draftId={draftId} value={value} onValueChange={onValueChange} sensitive={sensitive} />));
    return host.firstElementChild as Field;
  }
  function nativeValue(field: Field, value: string, notify = true) {
    const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    act(() => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
      if (notify) field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  for (const kind of ["input", "textarea"] as const) {
    it(`${kind} changes owner even when both external values are equal, and discards the old IME tail`, () => {
      const first = vi.fn(); const second = vi.fn();
      const a = render(kind, `${kind}:owner-a`, "同名", first);
      act(() => { a.focus(); a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
      nativeValue(a, "甲的未确认草稿");
      const b = render(kind, `${kind}:owner-b`, "同名", second);
      expect(b).not.toBe(a);
      expect(b.value).toBe("同名");
      expect(document.activeElement).toBe(b);
      expect(readStableTextDraft(`${kind}:owner-a`)).toBe("甲的未确认草稿");
      nativeValue(a, "迟到的甲输入", false);
      act(() => a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "迟到的甲输入" })));
      expect(second).not.toHaveBeenCalled();
      expect(b.value).toBe("同名");
      expect(render(kind, `${kind}:owner-a`, "同名", first).value).toBe("甲的未确认草稿");
    });

    it(`${kind} never transfers sensitive text into the shared draft when the field mode changes`, () => {
      const id = `${kind}:sensitive-slot`;
      const secret = render(kind, id, "", vi.fn(), true);
      nativeValue(secret, "test-only-private-draft");
      expect(readStableTextDraft(id)).toBeNull();
      const publicField = render(kind, id, "", vi.fn(), false);
      expect(publicField.value).toBe("");
      expect(readStableTextDraft(id)).not.toBe("test-only-private-draft");
    });

    it(`${kind} retains the native pre-edit buffer through a same-owner responsive remount`, () => {
      const id = `${kind}:native-remount`;
      const field = render(kind, id, "");
      act(() => { field.focus(); field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
      nativeValue(field, "尚未发出input的中文", false);
      act(() => root.render(<div>responsive replacement</div>));
      expect(readStableTextDraft(id)).toBe("尚未发出input的中文");
      expect(render(kind, id, "").value).toBe("尚未发出input的中文");
    });

    it(`${kind} respects an explicit draft clear before an unfinished editor is removed`, () => {
      const id = `${kind}:explicit-cancel`;
      const field = render(kind, id, "");
      act(() => field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
      nativeValue(field, "已明确取消的内容", false);
      clearStableTextDraft(id);
      act(() => root.render(<div>cancelled</div>));
      expect(readStableTextDraft(id)).toBeNull();
    });

    it(`${kind} preserves native pre-edit when old and new layouts commit in the same commit`, () => {
      const id = `${kind}:one-commit-remount`; ids.add(id);
      const field = kind === "input"
        ? <StableTextInput draftId={id} value="" onValueChange={() => undefined} />
        : <StableTextArea draftId={id} value="" onValueChange={() => undefined} />;
      act(() => root.render(<section>{field}</section>));
      const previous = host.querySelector<Field>("input, textarea")!;
      act(() => { previous.focus(); previous.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
      nativeValue(previous, "横竖屏同时切换的中文", false);
      act(() => previous.setSelectionRange(1, 5, "forward"));
      act(() => root.render(<aside>{field}</aside>));
      const replacement = host.querySelector<Field>("input, textarea")!;
      expect(replacement.value).toBe("横竖屏同时切换的中文");
      expect(document.activeElement).toBe(replacement);
      expect([replacement.selectionStart, replacement.selectionEnd]).toEqual([1, 5]);
      expect(readStableTextDraft(id)).toBe("横竖屏同时切换的中文");
    });

    it(`${kind} retains a restored draft under StrictMode while the parent still reports the old value`, () => {
      const id = `${kind}:strict-restoration`; ids.add(id);
      updateStableTextDraft(id, "未提交的原草稿");
      const change = vi.fn();
      act(() => root.render(<StrictMode>{kind === "input"
        ? <StableTextInput draftId={id} value="服务器旧值" onValueChange={change} commitOnBlur />
        : <StableTextArea draftId={id} value="服务器旧值" onValueChange={change} />}</StrictMode>));
      expect(host.querySelector<Field>("input, textarea")!.value).toBe("未提交的原草稿");
      expect(readStableTextDraft(id)).toBe("未提交的原草稿");
      if (kind === "input") expect(change).not.toHaveBeenCalled();
    });

    it(`${kind} preserves an explicit blur clear after committing a native-only IME buffer`, () => {
      const id = `${kind}:blur-clear`; ids.add(id);
      const onBlur = () => clearStableTextDraft(id);
      act(() => root.render(kind === "input"
        ? <StableTextInput draftId={id} value="" onValueChange={() => undefined} commitOnBlur onBlur={onBlur} />
        : <StableTextArea draftId={id} value="" onValueChange={() => undefined} onBlur={onBlur} />));
      const field = host.querySelector<Field>("input, textarea")!;
      act(() => { field.focus(); field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
      nativeValue(field, "已提交并清除的草稿", false);
      act(() => field.blur());
      expect(readStableTextDraft(id)).toBeNull();
    });
  }

  it("does not steal focus from the control the player selected before switching owners", () => {
    const field = render("input", "focus:owner-a", "");
    const outside = document.createElement("button"); document.body.append(outside);
    try {
      act(() => { field.focus(); outside.focus(); });
      render("input", "focus:owner-b", "");
      expect(document.activeElement).toBe(outside);
    } finally { outside.remove(); }
  });

  it("respects another control's explicit autofocus during a layout replacement", () => {
    const id = "focus:competing-layout"; ids.add(id);
    const field = <StableTextInput draftId={id} value="" onValueChange={() => undefined} />;
    act(() => root.render(<section>{field}</section>));
    act(() => host.querySelector("input")!.focus());
    act(() => root.render(<aside><button autoFocus>明确的下一步</button>{field}</aside>));
    expect(document.activeElement).toBe(host.querySelector("button"));
  });

  it("does not autofocus a mobile field reopened after the previous commit finished", async () => {
    const field = render("input", "focus:later-reopen", "");
    act(() => field.focus());
    act(() => root.render(<div>closed picker</div>));
    await act(async () => { await Promise.resolve(); });
    const reopened = render("input", "focus:later-reopen", "");
    expect(document.activeElement).not.toBe(reopened);
  });
});
