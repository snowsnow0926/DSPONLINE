/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ITEMS, PLANET_LIST, getItem } from "../game/content";
import { createInitialState } from "../game/engine";
import { createWebRecipeWorkspaceReadModel, type RecipeWorkspaceReadModel } from "../game/recipeWorkspaceReadModel";
import type { ItemId } from "../game/types";
import { APP_LOCALE_PREFERENCE_KEY, AppLocaleProvider } from "../i18n/locale";
import { clearStableTextDraft } from "./CompositionSafeInput";
import { RecipeWorkspace } from "./RecipeWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function model(selectedItemId: ItemId = "iron_ore"): RecipeWorkspaceReadModel {
  const game = createInitialState();
  game.recipeFocus = { ...game.recipeFocus, itemId: selectedItemId };
  game.activePlanetId = PLANET_LIST[1].id;
  const result = createWebRecipeWorkspaceReadModel(game, {
    itemIds: Object.keys(ITEMS).slice(0, 256) as ItemId[],
    selectedItemId,
  }, "builtin:component-test");
  if (!result) throw new Error("recipe component fixture failed");
  return result;
}

function renderWorkspace(readModel: RecipeWorkspaceReadModel, onReadRequest = vi.fn(), focusItemId: ItemId | null = null) {
  act(() => root.render(<AppLocaleProvider>
    <RecipeWorkspace
      open
      readModel={readModel}
      onReadRequest={onReadRequest}
      onClose={vi.fn()}
      focusItemId={focusItemId}
      onFocus={vi.fn()}
      onLocateProductionLine={vi.fn()}
    />
  </AppLocaleProvider>));
  return onReadRequest;
}

function inputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.setItem(APP_LOCALE_PREFERENCE_KEY, "zh-CN");
  clearStableTextDraft("recipe-workspace-search");
  document.body.innerHTML = "";
  host = document.createElement("div");
  host.dataset.testAppRoot = "true";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("RecipeWorkspace bounded read model", () => {
  it("initializes once from persisted focus and active planet in the first same-revision model", () => {
    const onReadRequest = renderWorkspace(model("copper_ingot"));
    act(() => vi.advanceTimersByTime(120));
    expect(onReadRequest).toHaveBeenCalledTimes(1);
    expect(onReadRequest.mock.calls[0][0].selectedItemId).toBe("copper_ingot");
    expect(host.textContent).toContain(getItem("copper_ingot").name);
  });

  it("coalesces rapid search changes into one bounded projection request", () => {
    const onReadRequest = renderWorkspace(model());
    act(() => vi.advanceTimersByTime(120));
    onReadRequest.mockClear();
    const input = host.querySelector<HTMLInputElement>("input[aria-label='搜索配方物品']")!;
    act(() => {
      inputValue(input, "铁");
      inputValue(input, "铜");
      inputValue(input, "矿");
    });
    expect(host.textContent).toContain("不会显示旧版本数据");
    act(() => vi.advanceTimersByTime(119));
    expect(onReadRequest).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onReadRequest).toHaveBeenCalledTimes(1);
    expect(onReadRequest.mock.calls[0][0].itemIds.length).toBeLessThanOrEqual(256);
  });

  it("hides a prior page frame when the selected item matches but the item page does not", () => {
    const current = model();
    const stalePage = {
      ...current,
      selector: {
        ...current.selector,
        itemIds: current.selector.itemIds.slice(1),
      },
    } satisfies RecipeWorkspaceReadModel;
    renderWorkspace(stalePage);
    expect(host.textContent).toContain("不会显示旧版本数据");
    expect(host.textContent).not.toContain("网络库存");
  });

  it("truthfully labels native on-demand selection as production devices, not the whole upstream line", () => {
    const base = model();
    const native = {
      ...base,
      source: "native-core" as const,
      revision: 7,
      selectedItem: {
        ...base.selectedItem,
        productionLocations: [{ planetId: base.activePlanetId, producerCount: 3 }],
      },
    };
    renderWorkspace(native);
    expect(host.textContent).toContain("定位生产设备 · 3");
    expect(host.textContent).not.toContain("定位产线 · 3");
  });
});
