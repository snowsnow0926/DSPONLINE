/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "../game/engine";
import { getPlanetDisplayName } from "../game/galaxy";
import { AppLocaleProvider } from "../i18n/locale";
import { PlanetFactoryResetDialog, StarMapWorkspace } from "./StarMapWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PlanetFactoryResetDialog", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
    window.history.replaceState(window.history.state, "", "/");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("requires three visible confirmations and an exact planet-name match", () => {
    const game = createInitialState();
    const onCancel = vi.fn();
    const onConfirm = vi.fn(() => true);
    act(() => root.render(<AppLocaleProvider><PlanetFactoryResetDialog game={game} planetId="home" onCancel={onCancel} onConfirm={onConfirm} /></AppLocaleProvider>));

    expect(document.querySelector("[role='alertdialog']")).not.toBeNull();
    expect(document.body.textContent).toContain("第 1 / 3 次确认");
    let confirm = document.querySelector<HTMLButtonElement>(".planet-reset-dialog__confirm")!;
    expect(confirm.disabled).toBe(false);
    act(() => confirm.click());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("第 2 / 3 次确认");

    confirm = document.querySelector<HTMLButtonElement>(".planet-reset-dialog__confirm")!;
    act(() => confirm.click());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("第 3 / 3 次确认");
    confirm = document.querySelector<HTMLButtonElement>(".planet-reset-dialog__confirm")!;
    expect(confirm.disabled).toBe(true);

    const input = document.querySelector<HTMLInputElement>(".planet-reset-dialog__name input")!;
    const setInput = (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    setInput("错误名称");
    expect(document.body.textContent).toContain("名称不匹配");
    expect(document.querySelector<HTMLButtonElement>(".planet-reset-dialog__confirm")!.disabled).toBe(true);

    const planetName = getPlanetDisplayName(game, "home");
    setInput(planetName);
    confirm = document.querySelector<HTMLButtonElement>(".planet-reset-dialog__confirm")!;
    expect(confirm.disabled).toBe(false);
    act(() => confirm.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("home");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not allow an uncolonized planet to advance", () => {
    const game = createInitialState();
    const onConfirm = vi.fn(() => true);
    act(() => root.render(<AppLocaleProvider><PlanetFactoryResetDialog game={game} planetId="ashen" onCancel={() => undefined} onConfirm={onConfirm} /></AppLocaleProvider>));

    expect(document.body.textContent).toContain("只能重置已经殖民的行星");
    const confirm = document.querySelector<HTMLButtonElement>(".planet-reset-dialog__confirm")!;
    expect(confirm.disabled).toBe(true);
    act(() => confirm.click());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses the localized display name for the irreversible English confirmation", () => {
    window.history.replaceState(window.history.state, "", "/?lang=en");
    const game = createInitialState();
    const onConfirm = vi.fn(() => true);
    act(() => root.render(<AppLocaleProvider><PlanetFactoryResetDialog game={game} planetId="home" onCancel={() => undefined} onConfirm={onConfirm} /></AppLocaleProvider>));

    act(() => document.querySelector<HTMLButtonElement>(".planet-reset-dialog__confirm")!.click());
    act(() => document.querySelector<HTMLButtonElement>(".planet-reset-dialog__confirm")!.click());
    const input = document.querySelector<HTMLInputElement>(".planet-reset-dialog__name input")!;
    expect(input.placeholder).toBe("Clearwater I");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Clearwater I");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = document.querySelector<HTMLButtonElement>(".planet-reset-dialog__confirm")!;
    expect(confirm.disabled).toBe(false);
    act(() => confirm.click());
    expect(onConfirm).toHaveBeenCalledWith("home");
  });

  it("opens the same protected reset flow from desktop and mobile star maps", () => {
    const game = createInitialState();
    const sharedProps = {
      open: true,
      game,
      onClose: () => undefined,
      onExplore: () => undefined,
      onColonize: () => undefined,
      onTravel: () => true,
      onRoleChange: () => undefined,
      onPlanetMetadataChange: () => undefined,
      onSystemNameChange: () => undefined,
      onStationPriorityChange: () => undefined,
      onStationMinimumLoadChange: () => undefined,
      onStationLimitsChange: () => undefined,
      onFocusStation: () => undefined,
      onUpgradeAllStations: async () => null,
      onAttachAllQuantumStations: async () => null,
      onCollectorQuantumModeChange: async () => null,
      onQuantumItemCapacityChange: () => undefined,
      onResetPlanetFactory: () => true,
    } as const;
    const planetName = getPlanetDisplayName(game, "home");

    act(() => root.render(<AppLocaleProvider><StarMapWorkspace {...sharedProps} /></AppLocaleProvider>));
    const homeActions = document.querySelector<HTMLElement>(`.star-planet-entry[aria-label='${planetName}行星操作']`)!;
    const desktopReset = homeActions.querySelector<HTMLButtonElement>(".star-planet-entry__reset")!;
    expect(desktopReset).not.toBeNull();
    act(() => desktopReset.click());
    expect(document.body.textContent).toContain(`重置${planetName}`);
    act(() => document.querySelectorAll<HTMLButtonElement>(".accessible-dialog__actions button")[0].click());

    act(() => root.render(<AppLocaleProvider><StarMapWorkspace {...sharedProps} mobile mobileSubview="planet:home" /></AppLocaleProvider>));
    const mobileReset = host.querySelector<HTMLButtonElement>(".mobile-planet-reset-button")!;
    expect(mobileReset.textContent).toContain("重置星球工厂");
    act(() => mobileReset.click());
    expect(document.querySelector("[role='alertdialog']")).not.toBeNull();
  });
});
