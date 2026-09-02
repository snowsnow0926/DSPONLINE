/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "../game/engine";
import { createWebTechnologyWorkspaceReadModel } from "../game/technologyWorkspaceReadModel";
import { TechnologyWorkspace } from "./TechnologyWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  host.dataset.testAppRoot = "true";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("TechnologyWorkspace", () => {
  it("renders compact matrix/effect data and dispatches commands without a GameState prop", () => {
    const game = createInitialState();
    game.tray.electromagnetic_matrix = 42;
    game.research.completedTechIds.push("electromagnetic_matrix");
    const readModel = createWebTechnologyWorkspaceReadModel(game);
    const onLayoutChange = vi.fn();
    act(() => root.render(
      <TechnologyWorkspace
        open
        readModel={readModel}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onPauseResearch={vi.fn()}
        onCancelResearch={vi.fn()}
        onResumeResearch={vi.fn()}
        onRemoveQueued={vi.fn()}
        onSelectInfiniteResearch={vi.fn()}
        onInfiniteResearchAutomation={vi.fn()}
        onLayoutChange={onLayoutChange}
      />,
    ));

    expect(host.querySelector(".matrix-stock strong")?.textContent).toBe("42");
    const advanced = host.querySelector<HTMLButtonElement>(".research-advanced-toggle")!;
    act(() => advanced.click());
    expect(host.textContent).toContain("科研吞吐");
    const compact = Array.from(host.querySelectorAll<HTMLButtonElement>(".technology-layout-toggle button"))
      .find((button) => button.textContent === "精简")!;
    act(() => compact.click());
    expect(onLayoutChange).toHaveBeenCalledWith("compact");
  });

  it("exposes the native research lifecycle while retaining native-only guards", () => {
    const game = createInitialState();
    game.research.selectedTechId = "electromagnetic_matrix";
    game.research.queuedTechIds = ["electromagnetism"];
    game.research.completedTechIds.push("universe_matrix");
    const readModel = createWebTechnologyWorkspaceReadModel(game);
    const onSelect = vi.fn();
    const onPauseResearch = vi.fn();
    const onCancelResearch = vi.fn();
    const onResumeResearch = vi.fn();
    const onRemoveQueued = vi.fn();
    const onSelectInfiniteResearch = vi.fn();
    const onInfiniteResearchAutomation = vi.fn();
    const onLayoutChange = vi.fn();
    act(() => root.render(
      <TechnologyWorkspace
        open
        readModel={readModel}
        nativeAuthorityRequired
        onClose={vi.fn()}
        onSelect={onSelect}
        onPauseResearch={onPauseResearch}
        onCancelResearch={onCancelResearch}
        onResumeResearch={onResumeResearch}
        onRemoveQueued={onRemoveQueued}
        onSelectInfiniteResearch={onSelectInfiniteResearch}
        onInfiniteResearchAutomation={onInfiniteResearchAutomation}
        onLayoutChange={onLayoutChange}
      />,
    ));

    const currentActions = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".research-current-actions button"),
    );
    expect(currentActions.every((button) => !button.disabled)).toBe(true);
    act(() => currentActions.find((button) => button.textContent?.includes("暂停"))!.click());
    act(() => currentActions.find((button) => button.textContent?.includes("取消"))!.click());
    expect(onPauseResearch).toHaveBeenCalledOnce();
    expect(onCancelResearch).toHaveBeenCalledOnce();
    const layoutButtons = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".technology-layout-toggle button"),
    );
    expect(layoutButtons.every((button) => !button.disabled)).toBe(true);
    act(() => layoutButtons.find((button) => button.textContent === "精简")!.click());
    expect(onLayoutChange).toHaveBeenCalledWith("compact");

    const append = host.querySelector<HTMLButtonElement>('[data-tech-id="basic_logistics"]')!;
    expect(append.disabled).toBe(false);
    act(() => append.click());
    expect(onSelect).toHaveBeenCalledWith("basic_logistics");

    const remove = host.querySelector<HTMLButtonElement>('.research-queue__item button[aria-label*="电磁学"]')!;
    expect(remove.disabled).toBe(false);
    act(() => remove.click());
    expect(onRemoveQueued).toHaveBeenCalledWith("electromagnetism");

    act(() => host.querySelector<HTMLButtonElement>(".research-advanced-toggle")!.click());
    const automation = host.querySelector<HTMLInputElement>('.infinite-research-console input[type="checkbox"]')!;
    expect(automation.disabled).toBe(false);
    act(() => automation.click());
    expect(onInfiniteResearchAutomation).toHaveBeenCalledWith(!readModel.autoResearch);
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>(".infinite-research-console button"))
      .every((button) => button.disabled)).toBe(true);
    expect(onResumeResearch).not.toHaveBeenCalled();
    expect(onSelectInfiniteResearch).not.toHaveBeenCalled();
  });

  it("does not apply the conservative native infinite-research guard to Web play", () => {
    const game = createInitialState();
    game.research.selectedTechId = "electromagnetic_matrix";
    game.research.completedTechIds.push("universe_matrix");
    const onSelectInfiniteResearch = vi.fn();
    act(() => root.render(
      <TechnologyWorkspace
        open
        readModel={createWebTechnologyWorkspaceReadModel(game)}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onPauseResearch={vi.fn()}
        onCancelResearch={vi.fn()}
        onResumeResearch={vi.fn()}
        onRemoveQueued={vi.fn()}
        onSelectInfiniteResearch={onSelectInfiniteResearch}
        onInfiniteResearchAutomation={vi.fn()}
        onLayoutChange={vi.fn()}
      />,
    ));

    act(() => host.querySelector<HTMLButtonElement>(".research-advanced-toggle")!.click());
    const matrixCompression = host.querySelector<HTMLButtonElement>(
      ".infinite-research-console button",
    )!;
    expect(matrixCompression.disabled).toBe(false);
    act(() => matrixCompression.click());
    expect(onSelectInfiniteResearch).toHaveBeenCalledWith("matrix_compression");
  });

  it("keeps native layout writes single-flight while the durable ACK is pending", () => {
    act(() => root.render(
      <TechnologyWorkspace
        open
        readModel={createWebTechnologyWorkspaceReadModel(createInitialState())}
        nativeAuthorityRequired
        nativeCommandPending
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onPauseResearch={vi.fn()}
        onCancelResearch={vi.fn()}
        onResumeResearch={vi.fn()}
        onRemoveQueued={vi.fn()}
        onSelectInfiniteResearch={vi.fn()}
        onInfiniteResearchAutomation={vi.fn()}
        onLayoutChange={vi.fn()}
      />,
    ));

    const layoutButtons = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".technology-layout-toggle button"),
    );
    expect(layoutButtons.every((button) => button.disabled)).toBe(true);
    expect(layoutButtons.every((button) => button.title.includes("等待上一条原生科研命令确认")))
      .toBe(true);
  });

  it("preserves local workspace state and focus when a confirmed projection becomes pending", () => {
    const readModel = createWebTechnologyWorkspaceReadModel(createInitialState());
    const callbacks = {
      onClose: vi.fn(),
      onSelect: vi.fn(),
      onPauseResearch: vi.fn(),
      onCancelResearch: vi.fn(),
      onResumeResearch: vi.fn(),
      onRemoveQueued: vi.fn(),
      onSelectInfiniteResearch: vi.fn(),
      onInfiniteResearchAutomation: vi.fn(),
      onLayoutChange: vi.fn(),
    };
    const renderPending = (nativeCommandPending: boolean) => act(() => root.render(
      <TechnologyWorkspace
        open
        readModel={readModel}
        nativeAuthorityRequired
        nativeCommandPending={nativeCommandPending}
        {...callbacks}
      />,
    ));

    renderPending(false);
    const before = host.querySelector<HTMLButtonElement>(".research-advanced-toggle")!;
    act(() => {
      before.click();
      before.focus();
    });
    expect(host.textContent).toContain("科研吞吐");

    renderPending(true);
    const after = host.querySelector<HTMLButtonElement>(".research-advanced-toggle")!;
    expect(after).toBe(before);
    expect(document.activeElement).toBe(after);
    expect(host.textContent).toContain("科研吞吐");
  });
});
