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
});
