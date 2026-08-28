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
});
