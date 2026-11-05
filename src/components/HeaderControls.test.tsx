// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FACTORY_READ_MODEL_SCHEMA } from "../game/factoryReadModels";
import { HeaderControls } from "./GamePanels";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof HeaderControls>;

function props(overrides: Partial<Props> = {}): Props {
  const noOp = vi.fn();
  return {
    game: null,
    runStatus: {
      schema: FACTORY_READ_MODEL_SCHEMA,
      source: "native-core",
      revision: 12,
      activePlanetId: "home",
      paused: false,
    },
    onReturnToMenu: noOp,
    onPauseToggle: noOp,
    onOpenResources: noOp,
    onOpenInspector: noOp,
    onOpenBlueprints: noOp,
    onOpenRecipes: noOp,
    onOpenTechnology: noOp,
    onOpenStatistics: noOp,
    onOpenStarMap: noOp,
    onOpenSettings: noOp,
    onOpenGalaxy: noOp,
    onOpenCampaign: noOp,
    onOpenConstructionCenter: noOp,
    onOpenDysonPlanner: noOp,
    onOpenCommandPalette: noOp,
    pauseControlAvailable: true,
    ...overrides,
  };
}

describe("HeaderControls native pause control", () => {
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

  const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  const menuItems = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  const key = (target: HTMLElement, value: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init });
    act(() => { target.dispatchEvent(event); });
    return event;
  };

  it("invokes the durable pause callback when a native v1 authority frame is available", () => {
    const onPauseToggle = vi.fn();
    act(() => root.render(<HeaderControls {...props({ onPauseToggle })} />));

    const button = host.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="Space"]');
    expect(button?.disabled).toBe(false);
    act(() => button?.click());
    expect(onPauseToggle).toHaveBeenCalledTimes(1);
  });

  it("fails closed while the native pause bridge or authority frame is unavailable", () => {
    const onPauseToggle = vi.fn();
    act(() => root.render(<HeaderControls {...props({
      onPauseToggle,
      pauseControlAvailable: false,
    })} />));

    const button = host.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="Space"]');
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("Windows 原生暂停控制暂不可用");
    act(() => button?.click());
    expect(onPauseToggle).not.toHaveBeenCalled();
  });

  it("keeps the blueprint workspace explicitly reachable under native authority", () => {
    const onOpenBlueprints = vi.fn();
    act(() => root.render(<HeaderControls {...props({ onOpenBlueprints })} />));

    const button = host.querySelector<HTMLButtonElement>('button[aria-label="打开蓝图工作区"]');
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(onOpenBlueprints).toHaveBeenCalledTimes(1);
  });

  it("navigates enabled menu actions and returns to its opener on Escape", () => {
    act(() => root.render(<HeaderControls {...props({ constructionCenterVisible: true, constructionCenterUnavailable: true })} />));
    trigger().focus();
    key(trigger(), "ArrowUp");
    const items = menuItems();
    expect(document.activeElement).toBe(items.at(-1));
    key(items.at(-1)!, "Home");
    expect(document.activeElement).toBe(items[0]);
    key(items[0], "ArrowUp");
    expect(document.activeElement).toBe(items.at(-1));
    items[3].focus();
    key(items[3], "ArrowDown");
    expect(items[4].disabled).toBe(true);
    expect(document.activeElement).toBe(items[5]);
    key(items[5], "Escape");
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });

  it("captures a connected return target before opening a workspace once", () => {
    const onOpenSettings = vi.fn(() => document.activeElement);
    act(() => root.render(<HeaderControls {...props({ onOpenSettings })} />));
    act(() => trigger().click());
    const settings = menuItems()[1];
    settings.focus();
    key(settings, " ", { repeat: true });
    expect(onOpenSettings).not.toHaveBeenCalled();
    key(settings, " ");
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings.mock.results[0]?.value).toBe(trigger());
    expect(onOpenSettings.mock.results[0]?.value?.isConnected).toBe(true);
    expect(menuItems()).toHaveLength(0);
  });

  it("dismisses for outside focus or pointer without reclaiming focus", () => {
    act(() => root.render(<HeaderControls {...props()} />));
    act(() => trigger().click());
    const outside = document.createElement("button");
    host.append(outside);
    act(() => outside.focus());
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(outside);
    act(() => trigger().click());
    act(() => outside.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).not.toBe(trigger());
  });

  it("leaves composition keystrokes untouched", () => {
    const onOpenSettings = vi.fn();
    act(() => root.render(<HeaderControls {...props({ onOpenSettings })} />));
    trigger().focus();
    expect(key(trigger(), " ", { isComposing: true }).defaultPrevented).toBe(false);
    expect(menuItems()).toHaveLength(0);
    act(() => trigger().click());
    const settings = menuItems()[1];
    settings.focus();
    expect(key(settings, "Enter", { keyCode: 229 }).defaultPrevented).toBe(false);
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(menuItems().length).toBeGreaterThan(0);
  });

  it("keeps menu keys out of gameplay shortcuts and releases ownership when closed", () => {
    const globalKey = vi.fn();
    window.addEventListener("keydown", globalKey);
    try {
      act(() => root.render(<HeaderControls {...props()} />));
      trigger().focus();
      key(trigger(), " ");
      expect(globalKey).not.toHaveBeenCalled();
      const first = menuItems()[0];
      key(first, "p");
      key(first, "Delete");
      expect(globalKey).not.toHaveBeenCalled();
      key(first, "Escape");
      key(trigger(), "p");
      expect(globalKey).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", globalKey);
    }
  });

  it("closes when a breakpoint hides the opener", () => {
    act(() => root.render(<HeaderControls {...props()} />));
    act(() => trigger().click());
    // jsdom has no layout boxes, matching a trigger hidden by the desktop breakpoint.
    act(() => window.dispatchEvent(new Event("resize")));
    expect(menuItems()).toHaveLength(0);
  });
});
