// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FactoryRunStatus } from "./FactoryRunStatus";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("FactoryRunStatus", () => {
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

  it("preserves the existing running and paused copy from bounded models", () => {
    act(() => root.render(<FactoryRunStatus model={{
      schema: "factory-read-model-v1",
      source: "web-game-state",
      revision: null,
      activePlanetId: "home",
      paused: false,
    }} />));
    expect(host.querySelector(".running")?.textContent).toBe("实时运行");
    expect(host.firstElementChild?.getAttribute("data-factory-read-model-source")).toBe("web-game-state");

    act(() => root.render(<FactoryRunStatus model={{
      schema: "factory-read-model-v1",
      source: "native-core",
      revision: 9,
      activePlanetId: "home",
      paused: true,
    }} />));
    expect(host.querySelector(".paused")?.textContent).toBe("模拟暂停");
    expect(host.firstElementChild?.getAttribute("data-factory-read-model-revision")).toBe("9");
  });
});
