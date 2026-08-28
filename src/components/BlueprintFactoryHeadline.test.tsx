// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlueprintFactoryHeadline } from "./BlueprintFactoryHeadline";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BlueprintFactoryHeadline", () => {
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

  it("renders queue and planet semantics from a bounded model", () => {
    act(() => root.render(<BlueprintFactoryHeadline model={{
      schema: "factory-read-model-v1",
      source: "native-core",
      revision: 17,
      activePlanetId: "home",
      activePlanetDisplayName: "澄海 I",
      constructionQueueCount: 3,
    }} />));

    expect(host.textContent).toContain("施工队列 3");
    expect(host.textContent).toContain("部署行星 澄海 I");
    expect(host.querySelector("[data-factory-read-model-source]")?.getAttribute("data-factory-read-model-source")).toBe("native-core");
    expect(host.querySelector("[data-factory-read-model-revision]")?.getAttribute("data-factory-read-model-revision")).toBe("17");
  });
});
