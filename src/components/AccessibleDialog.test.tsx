/** @vitest-environment jsdom */

import { act, StrictMode, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccessibleDialog,
  collectAccessibleDialogBackgroundElements,
  useAccessibleModalSurface,
  type AccessibleDialogCloseReason,
} from "./AccessibleDialog";
import { WorkspaceFrame } from "./WorkspaceFrame";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function keydown(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  act(() => document.dispatchEvent(event));
  return event;
}

function pointerEvent(type: string, init: { pointerId: number; clientX: number; clientY: number }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    button: { value: 0 },
  });
  return event;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "scroll";
  document.documentElement.style.overflow = "visible";
  host = document.createElement("div");
  host.dataset.testAppRoot = "true";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.documentElement.removeAttribute("style");
});

describe("AccessibleDialog", () => {
  it("keeps the top portal interactive when a workspace and report mount in the same commit", () => {
    function Harness() {
      const [workspaceOpen, setWorkspaceOpen] = useState(false);
      const [reportOpen, setReportOpen] = useState(false);
      return <>
        <main className="game-shell">
          <button data-open-both onClick={() => { setWorkspaceOpen(true); setReportOpen(true); }}>打开</button>
          <div data-factory><button>工厂操作</button></div>
          {workspaceOpen ? <WorkspaceFrame ariaLabel="存档工作区" onRequestClose={() => setWorkspaceOpen(false)}>
            <button data-close-workspace onClick={() => setWorkspaceOpen(false)}>关闭工作区</button>
          </WorkspaceFrame> : null}
        </main>
        <AccessibleDialog open={reportOpen} title="离线结算报告" onRequestClose={() => setReportOpen(false)}>
          <button data-close-report onClick={() => setReportOpen(false)}>确认结算</button>
        </AccessibleDialog>
      </>;
    }
    render(<Harness />);
    const trigger = host.querySelector<HTMLElement>("[data-open-both]")!;
    trigger.focus();
    click(trigger);
    const report = document.querySelector<HTMLElement>("[data-accessible-dialog-boundary]")!;
    const reportButton = report.querySelector<HTMLElement>("[data-close-report]")!;
    const workspaceButton = host.querySelector<HTMLElement>("[data-close-workspace]")!;
    const factory = host.querySelector<HTMLElement>("[data-factory]")!;

    expect(report.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(document.activeElement).toBe(reportButton);
    expect(workspaceButton.closest("[inert]")).not.toBeNull();
    expect(factory.closest("[inert]")).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");
    workspaceButton.focus();
    expect(document.activeElement).toBe(reportButton);

    click(reportButton);
    expect(workspaceButton.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(document.activeElement).toBe(workspaceButton);
    expect(factory.closest("[inert]")).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");

    click(workspaceButton);
    expect(factory.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("scroll");
    expect(document.documentElement.style.overflow).toBe("visible");
  });

  it("keeps additional focus roots active without exposing their unrelated ancestor branches", () => {
    function ExtraRootsHarness() {
      const headerRef = useRef<HTMLElement>(null);
      const boundaryRef = useRef<HTMLDivElement>(null);
      const surfaceRef = useRef<HTMLElement>(null);
      useAccessibleModalSurface({
        open: true,
        boundaryRef,
        surfaceRef,
        onRequestClose: () => undefined,
        getAdditionalFocusRoots: () => headerRef.current ? [headerRef.current] : [],
      });
      return <>
        <main>
          <header ref={headerRef}><button data-extra-focus>导航</button></header>
          <div data-unrelated-branch><button data-background-control>背景操作</button></div>
        </main>
        {createPortal(<div ref={boundaryRef}>
          <section ref={surfaceRef} role="dialog" aria-label="外部导航" tabIndex={-1}>
            <button data-surface-focus>弹窗操作</button>
          </section>
        </div>, document.body)}
      </>;
    }
    render(<ExtraRootsHarness />);
    const extra = document.querySelector<HTMLElement>("[data-extra-focus]")!;
    const surface = document.querySelector<HTMLElement>("[data-surface-focus]")!;
    const background = document.querySelector<HTMLElement>("[data-background-control]")!;
    expect(extra.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(surface.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(background.closest("[inert]")).not.toBeNull();
    extra.focus();
    expect(document.activeElement).toBe(extra);
    background.focus();
    expect(document.activeElement).toBe(extra);
    surface.focus();
    keydown("Tab");
    expect(document.activeElement).toBe(extra);
    render(<></>);
    expect(host.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("recomputes nested portal isolation without hiding the remaining modal on top close", () => {
    const container = document.createElement("div");
    const lowerTarget = document.createElement("div");
    const upperTarget = document.createElement("div");
    const sibling = document.createElement("button");
    lowerTarget.append(upperTarget, sibling);
    container.append(lowerTarget);
    document.body.append(container);
    const dialogs = (upperOpen: boolean) => <>
      <AccessibleDialog open title="下层" portalTarget={lowerTarget} onRequestClose={() => undefined}>
        <button data-nested-lower>下层操作</button>
      </AccessibleDialog>
      <AccessibleDialog open={upperOpen} title="上层" portalTarget={upperTarget} onRequestClose={() => undefined}>
        <button data-nested-upper>上层操作</button>
      </AccessibleDialog>
    </>;
    render(dialogs(true));
    const lower = document.querySelector<HTMLElement>("[data-nested-lower]")!;
    const upper = document.querySelector<HTMLElement>("[data-nested-upper]")!;
    expect(upper.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(lower.closest("[inert]")).not.toBeNull();
    expect(sibling.closest("[inert]")).not.toBeNull();
    expect(host.closest("[inert]")).not.toBeNull();
    render(dialogs(false));
    expect(lower.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(document.activeElement).toBe(lower);
    expect(sibling.closest("[inert]")).not.toBeNull();
    render(<></>);
    expect(sibling.hasAttribute("inert")).toBe(false);
    expect(host.hasAttribute("inert")).toBe(false);
    container.remove();
  });

  it("preserves the focus return chain when a lower modal unmounts before the top modal", () => {
    const existing = document.createElement("aside");
    existing.setAttribute("inert", "original");
    existing.setAttribute("aria-hidden", "false");
    document.body.append(existing);
    const trigger = document.createElement("button");
    host.before(trigger);
    trigger.focus();
    const dialogs = (lowerOpen: boolean, upperOpen: boolean) => <>
      <AccessibleDialog open={lowerOpen} title="下层" onRequestClose={() => undefined}><button data-return-lower>下层操作</button></AccessibleDialog>
      <AccessibleDialog open={upperOpen} title="上层" onRequestClose={() => undefined}><button data-return-upper>上层操作</button></AccessibleDialog>
    </>;
    render(dialogs(true, true));
    const upper = document.querySelector<HTMLElement>("[data-return-upper]")!;
    render(dialogs(false, true));
    expect(upper.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(document.activeElement).toBe(upper);
    expect(host.hasAttribute("inert")).toBe(true);
    expect(existing.getAttribute("aria-hidden")).toBe("true");
    render(dialogs(false, false));
    expect(document.activeElement).toBe(trigger);
    expect(existing.getAttribute("inert")).toBe("original");
    expect(existing.getAttribute("aria-hidden")).toBe("false");
    expect(document.body.style.overflow).toBe("scroll");
    existing.remove();
    trigger.remove();
  });

  it("restores original isolation and scroll styles after StrictMode lifecycle replays", () => {
    const existing = document.createElement("aside");
    existing.inert = true;
    existing.setAttribute("inert", "before");
    existing.setAttribute("aria-hidden", "false");
    document.body.append(existing);
    document.body.style.overscrollBehavior = "contain";
    document.documentElement.style.overscrollBehavior = "auto";
    render(<StrictMode>
      <AccessibleDialog open title="下层" onRequestClose={() => undefined}><button>下层</button></AccessibleDialog>
      <AccessibleDialog open title="上层" onRequestClose={() => undefined}><button data-strict-top>上层</button></AccessibleDialog>
    </StrictMode>);
    const top = document.querySelector<HTMLElement>("[data-strict-top]")!;
    expect(top.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(document.activeElement).toBe(top);
    expect(host.hasAttribute("inert")).toBe(true);
    render(<></>);
    expect(existing.inert).toBe(true);
    expect(existing.getAttribute("inert")).toBe("before");
    expect(existing.getAttribute("aria-hidden")).toBe("false");
    expect(host.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe("scroll");
    expect(document.documentElement.style.overflow).toBe("visible");
    expect(document.body.style.overscrollBehavior).toBe("contain");
    expect(document.documentElement.style.overscrollBehavior).toBe("auto");
    existing.remove();
  });

  it("returns focus inside the remaining modal when the original return target was removed", () => {
    const dialogs = (replacement: boolean, upperOpen: boolean) => <>
      <AccessibleDialog open title="下层" onRequestClose={() => undefined}>
        {replacement ? <input key="replacement" data-replacement aria-label="替换控件" /> : <button key="original">原始控件</button>}
      </AccessibleDialog>
      <AccessibleDialog open={upperOpen} title="上层" onRequestClose={() => undefined}><button data-temporary-top>上层操作</button></AccessibleDialog>
    </>;
    render(dialogs(false, true));
    const top = document.querySelector<HTMLElement>("[data-temporary-top]")!;
    render(dialogs(true, true));
    expect(document.activeElement).toBe(top);
    render(dialogs(true, false));
    const replacement = document.querySelector<HTMLElement>("[data-replacement]")!;
    expect(replacement.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(document.activeElement).toBe(replacement);
    expect(host.hasAttribute("inert")).toBe(true);
  });

  it("exposes named dialog semantics, moves focus in, inerts the background, and restores lifecycle state", () => {
    const reasons: AccessibleDialogCloseReason[] = [];

    function Harness() {
      const [open, setOpen] = useState(false);
      const initialFocusRef = useRef<HTMLInputElement>(null);
      return <>
        <button
          data-trigger
          type="button"
          onClick={() => setOpen(true)}
        >打开</button>
        <AccessibleDialog
          open={open}
          title="云存档冲突"
          description="请选择要保留的版本。"
          initialFocusRef={initialFocusRef}
          onRequestClose={(reason) => {
            reasons.push(reason);
            setOpen(false);
          }}
          actions={<button type="button">确认</button>}
        >
          <input ref={initialFocusRef} aria-label="存档名称" />
        </AccessibleDialog>
      </>;
    }

    render(<Harness />);
    const trigger = host.querySelector<HTMLElement>("[data-trigger]")!;
    trigger.focus();
    click(trigger);

    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    const title = document.getElementById(dialog.getAttribute("aria-labelledby")!)!;
    const description = document.getElementById(dialog.getAttribute("aria-describedby")!)!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(title.textContent).toBe("云存档冲突");
    expect(description.textContent).toBe("请选择要保留的版本。");
    expect(document.activeElement).toBe(dialog.querySelector("input"));
    expect(host.hasAttribute("inert")).toBe(true);
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overflow).toBe("hidden");

    const escape = keydown("Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(reasons).toEqual(["escape"]);
    expect(document.querySelector("[data-accessible-dialog-boundary]")).toBeNull();
    expect(host.hasAttribute("inert")).toBe(false);
    expect(host.hasAttribute("aria-hidden")).toBe(false);
    expect(document.body.style.overflow).toBe("scroll");
    expect(document.documentElement.style.overflow).toBe("visible");
    expect(document.activeElement).toBe(trigger);
  });

  it("cycles Tab in DOM order and redirects escaped programmatic focus", () => {
    render(
      <AccessibleDialog
        open
        title="键盘测试"
        description="焦点必须留在弹窗内。"
        onRequestClose={() => undefined}
      >
        <button data-first type="button">第一项</button>
        <button type="button" disabled>禁用项</button>
        <button data-last type="button">最后一项</button>
      </AccessibleDialog>,
    );

    const first = document.querySelector<HTMLElement>("[data-first]")!;
    const last = document.querySelector<HTMLElement>("[data-last]")!;
    expect(document.activeElement).toBe(first);

    last.focus();
    const forward = keydown("Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const backward = keydown("Tab", { shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(last);
    outside.remove();
  });

  it("uses alertdialog semantics and consumes Escape under the explicit risk policy", () => {
    const onRequestClose = vi.fn();
    render(
      <AccessibleDialog
        open
        role="alertdialog"
        riskPolicy="explicit"
        title="永久删除"
        description="只能通过可见按钮完成或取消。"
        onRequestClose={onRequestClose}
      >
        <button type="button">取消</button>
        <button type="button">确认永久删除</button>
      </AccessibleDialog>,
    );

    expect(document.querySelector("[role='alertdialog']")).not.toBeNull();
    const escape = keydown("Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alertdialog']")).not.toBeNull();
  });

  it("restores nested modal isolation and focus without releasing the factory background", () => {
    function NestedHarness() {
      const [outerOpen, setOuterOpen] = useState(false);
      const [innerOpen, setInnerOpen] = useState(false);
      return <>
        <button data-open-outer type="button" onClick={() => setOuterOpen(true)}>打开外层</button>
        <AccessibleDialog
          open={outerOpen}
          title="外层"
          description="外层说明"
          onRequestClose={() => setOuterOpen(false)}
        >
          <button data-open-inner type="button" onClick={() => setInnerOpen(true)}>打开内层</button>
          <button data-close-outer type="button" onClick={() => setOuterOpen(false)}>关闭外层</button>
          <AccessibleDialog
            open={innerOpen}
            role="alertdialog"
            title="内层"
            description="内层说明"
            onRequestClose={() => setInnerOpen(false)}
          >
            <button data-close-inner type="button" onClick={() => setInnerOpen(false)}>关闭内层</button>
          </AccessibleDialog>
        </AccessibleDialog>
      </>;
    }

    render(<NestedHarness />);
    const outerTrigger = host.querySelector<HTMLElement>("[data-open-outer]")!;
    outerTrigger.focus();
    click(outerTrigger);
    const innerTrigger = document.querySelector<HTMLElement>("[data-open-inner]")!;
    innerTrigger.focus();
    click(innerTrigger);

    const boundaries = document.querySelectorAll<HTMLElement>("[data-accessible-dialog-boundary]");
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0].hasAttribute("inert")).toBe(true);
    expect(host.hasAttribute("inert")).toBe(true);

    click(document.querySelector("[data-close-inner]")!);
    expect(document.querySelectorAll("[data-accessible-dialog-boundary]")).toHaveLength(1);
    expect(boundaries[0].hasAttribute("inert")).toBe(false);
    expect(host.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(innerTrigger);

    click(document.querySelector("[data-close-outer]")!);
    expect(document.querySelector("[data-accessible-dialog-boundary]")).toBeNull();
    expect(host.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(outerTrigger);
  });

  it("preserves pre-existing inert and aria-hidden values after unmount", () => {
    const existing = document.createElement("aside");
    existing.setAttribute("inert", "existing");
    existing.setAttribute("aria-hidden", "false");
    document.body.insertBefore(existing, host);

    render(
      <AccessibleDialog
        open
        title="生命周期"
        description="卸载必须恢复原始属性。"
        onRequestClose={() => undefined}
      >
        <button type="button">完成</button>
      </AccessibleDialog>,
    );
    expect(existing.getAttribute("aria-hidden")).toBe("true");

    render(<></>);
    expect(existing.getAttribute("inert")).toBe("existing");
    expect(existing.getAttribute("aria-hidden")).toBe("false");
    existing.remove();
  });

  it("supports a composable background resolver without inerting the portal branch", () => {
    const extraBackground = document.createElement("aside");
    document.body.append(extraBackground);
    const resolver = vi.fn((boundary: HTMLElement) => [
      ...collectAccessibleDialogBackgroundElements(boundary),
      extraBackground,
      boundary,
    ]);

    render(
      <AccessibleDialog
        open
        title="组合边界"
        description="调用方可以增加特殊背景根。"
        getBackgroundElements={resolver}
        onRequestClose={() => undefined}
      >
        <button type="button">完成</button>
      </AccessibleDialog>,
    );

    const boundary = document.querySelector<HTMLElement>("[data-accessible-dialog-boundary]")!;
    expect(resolver).toHaveBeenCalledWith(boundary);
    expect(boundary.hasAttribute("inert")).toBe(false);
    expect(extraBackground.hasAttribute("inert")).toBe(true);

    render(<></>);
    expect(extraBackground.hasAttribute("inert")).toBe(false);
    extraBackground.remove();
  });

  it("treats a short backdrop tap as dismissal but ignores a drag gesture", () => {
    const onRequestClose = vi.fn();
    render(
      <AccessibleDialog
        open
        title="触控基础"
        description="拖动背景不应误关闭。"
        onRequestClose={onRequestClose}
      >
        <button type="button">完成</button>
      </AccessibleDialog>,
    );

    const backdrop = document.querySelector<HTMLElement>(".accessible-dialog__backdrop")!;
    act(() => {
      backdrop.dispatchEvent(pointerEvent("pointerdown", { pointerId: 1, clientX: 10, clientY: 10 }));
      backdrop.dispatchEvent(pointerEvent("pointerup", { pointerId: 1, clientX: 40, clientY: 10 }));
    });
    expect(onRequestClose).not.toHaveBeenCalled();

    act(() => {
      backdrop.dispatchEvent(pointerEvent("pointerdown", { pointerId: 2, clientX: 10, clientY: 10 }));
      backdrop.dispatchEvent(pointerEvent("pointerup", { pointerId: 2, clientX: 14, clientY: 14 }));
    });
    expect(onRequestClose).toHaveBeenCalledOnce();
    expect(onRequestClose).toHaveBeenCalledWith("backdrop");
  });

  it("maps an optional platform back event to an external close request", () => {
    const onRequestClose = vi.fn();
    render(
      <AccessibleDialog
        open
        title="平台返回"
        externalCloseEventName="dsp-test-native-back"
        onRequestClose={onRequestClose}
      >
        <button type="button">完成</button>
      </AccessibleDialog>,
    );

    act(() => window.dispatchEvent(new CustomEvent("dsp-test-native-back", { cancelable: true })));
    expect(onRequestClose).toHaveBeenCalledOnce();
    expect(onRequestClose).toHaveBeenCalledWith("external");
  });

  it("places a consumer backdrop class on the backdrop without changing surface semantics", () => {
    render(
      <AccessibleDialog
        open
        title="兼容布局"
        layout="bare"
        ariaLabel="兼容布局"
        className="legacy-surface"
        backdropClassName="legacy-backdrop"
        onRequestClose={() => undefined}
      >
        <button type="button">完成</button>
      </AccessibleDialog>,
    );
    expect(document.querySelector(".accessible-dialog__backdrop.legacy-backdrop")).not.toBeNull();
    expect(document.querySelector("section.accessible-dialog__surface.legacy-surface[role='dialog']")).not.toBeNull();
    expect(document.querySelector(".legacy-backdrop > section.legacy-surface")).not.toBeNull();
  });
});
