// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanvasInteractionOverlay } from "./CanvasInteractionOverlay";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CanvasInteractionOverlay native placement", () => {
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

  it("renders an opaque MOD building without consulting the web content catalog", () => {
    act(() => root.render(<CanvasInteractionOverlay
      active
      placement={null}
      nativePlacementLabel="MOD/量子工厂"
      placementCount={1}
      cargo={null}
      blueprint={null}
      ctrlHeld={false}
      clickConnectionPreview={null}
      clickConnectionTone="pending"
      clickConnectionSnapPoint={null}
      connectionHint={null}
    />));

    const cursor = host.querySelector("[data-native-placement-cursor='true']");
    expect(cursor?.textContent).toContain("MOD/量子工厂");
    expect(cursor?.textContent).toContain("Rust 复核");
  });
});
