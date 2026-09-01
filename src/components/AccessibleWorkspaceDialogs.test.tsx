/** @vitest-environment jsdom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "../game/engine";
import { CommandPalette } from "./CommandPalette";
import { TrayManagementDialog } from "./TrayManagementDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function click(element: Element): void {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

function inputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  });
}

function keydown(key: string): void {
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.documentElement.removeAttribute("style");
});

describe("accessible workspace dialogs", () => {
  it("gives the command palette combobox semantics, trapped focus and safe Escape close", () => {
    const game = createInitialState();
    const onClose = vi.fn();
    render(<CommandPalette
      open
      webEntities={game.entities}
      paused={game.paused}
      performanceMode={game.settings.performanceMode}
      reducedMotion={game.settings.reducedMotion}
      onClose={onClose}
      onOpenWorkspace={vi.fn()}
      onFocusRecipe={vi.fn()}
      onFocusEntity={vi.fn()}
      onAutoLayout={vi.fn()}
      onPauseToggle={vi.fn()}
      onTogglePerformance={vi.fn()}
      onToggleReducedMotion={vi.fn()}
    />);
    const dialog = document.querySelector<HTMLElement>("section.command-palette[role='dialog']")!;
    const input = dialog.querySelector<HTMLInputElement>("[role='combobox']")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-controls")).toBe("command-palette-results");
    expect(document.querySelector(".command-palette-backdrop > section.command-palette")).toBe(dialog);
    keydown("Escape");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses only native scalar rows while native authority is bound and pages without reading GameState entities", () => {
    const onEntitySearchRequest = vi.fn();
    const onFocusEntity = vi.fn();
    const common = {
      open: true,
      webEntities: null,
      paused: false,
      performanceMode: false,
      reducedMotion: false,
      onClose: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onFocusRecipe: vi.fn(),
      onFocusEntity,
      onAutoLayout: vi.fn(),
      onPauseToggle: vi.fn(),
      onTogglePerformance: vi.fn(),
      onToggleReducedMotion: vi.fn(),
      entitySearchMode: "native" as const,
      onEntitySearchRequest,
    };
    const nativeEntitySearch = {
      schema: "command-palette-entity-search-read-model-v1" as const,
      source: "native-core" as const,
      sessionId: "authority-1",
      runId: "run-1",
      revision: 12,
      registryFingerprint: "builtin:test",
      query: "熔炉",
      cursor: 0,
      limit: 1,
      totalCount: 2,
      rows: [{
        entityId: "native-entity-1",
        buildingId: "arc_smelter" as const,
        resourceId: null,
        planetId: "home" as const,
        recipeId: "iron_ingot" as const,
        positionX: 240,
        positionY: -80,
      }],
      nextCursor: 1,
    };
    render(<CommandPalette {...common} nativeEntitySearch={nativeEntitySearch} nativeEntitySearchStatus="ready" />);
    const input = document.querySelector<HTMLInputElement>(".command-palette-search input")!;
    inputValue(input, "熔炉");
    expect(document.querySelector(".command-palette")?.textContent).toContain("native-entity-1");
    click([...document.querySelectorAll(".command-palette-pagination button")]
      .find((button) => button.textContent === "下一页")!);
    expect(onEntitySearchRequest).toHaveBeenLastCalledWith("熔炉", 1);

    render(<CommandPalette {...common} nativeEntitySearch={nativeEntitySearch} nativeEntitySearchStatus="loading" />);
    expect(document.querySelector(".command-palette")?.textContent).not.toContain("native-entity-1");
    expect(document.querySelector(".command-palette-search-status")?.textContent).toContain("正在从原生权威目录搜索设备");

    render(<CommandPalette {...common} nativeEntitySearch={nativeEntitySearch} nativeEntitySearchStatus="unavailable" />);
    expect(document.querySelector(".command-palette")?.textContent).not.toContain("native-entity-1");
    expect(document.querySelector(".command-palette-search-status")?.textContent).toContain("暂不可用");

    render(<CommandPalette {...common} nativeEntitySearch={nativeEntitySearch} nativeEntitySearchStatus="ready" />);
    click([...document.querySelectorAll(".command-palette-list > button")]
      .find((button) => button.textContent?.includes("native-entity-1"))!);
    expect(onFocusEntity).toHaveBeenCalledWith("native-entity-1", {
      sessionId: "authority-1",
      runId: "run-1",
      revision: 12,
      registryFingerprint: "builtin:test",
      planetId: "home",
      label: expect.any(String),
      positionX: 240,
      positionY: -80,
    });
  });

  it("keeps tray deletion behind an explicit alertdialog and returns exact confirmed amounts", () => {
    const game = createInitialState();
    game.tray.iron_ore = 9;
    game.tray.copper_ore = 1;
    const onDiscard = vi.fn();
    const onClose = vi.fn();
    render(<TrayManagementDialog game={game} onDiscard={onDiscard} onClose={onClose} />);
    const dialog = document.querySelector<HTMLElement>(".tray-management > section[role='dialog']")!;
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog.querySelector("input[aria-label='搜索托盘物资']"));
    click([...dialog.querySelectorAll(".tray-management__list > button")].find((button) => button.textContent?.includes("铁矿"))!);
    click([...dialog.querySelectorAll("footer button")].find((button) => button.textContent?.includes("删除一半"))!);
    const confirmation = document.querySelector<HTMLElement>(".tray-discard-confirm > section[role='alertdialog']")!;
    expect(confirmation).not.toBeNull();
    expect(document.activeElement?.textContent).toContain("返回");
    keydown("Escape");
    expect(document.querySelector("[role='alertdialog']")).not.toBeNull();
    expect(onDiscard).not.toHaveBeenCalled();
    click([...confirmation.querySelectorAll("button")].find((button) => button.textContent?.includes("确认删除"))!);
    expect(onDiscard).toHaveBeenCalledWith([{ itemId: "iron_ore", amount: 4 }]);
    expect(document.querySelector("[role='alertdialog']")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
