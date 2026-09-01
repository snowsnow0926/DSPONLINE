// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopNativePlayerAuthorityClockState } from "../desktop";
import type {
  NativeStatisticsWorkspaceFrame,
  NativeStatisticsWorkspaceIdentity,
} from "../game/nativeStatisticsWorkspaceStore";
import { selectNativeStatisticsWorkspaceAuthorityFrames } from "../game/nativeStatisticsWorkspaceStore";
import type { NativePlayerAuthorityClockSnapshot } from "../game/nativePlayerAuthorityClock";
import type { ProductionHistorySample } from "../game/types";
import { NativeStatisticsWorkspace } from "./NativeStatisticsWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sample(elapsedSeconds: number, production: number, consumption: number): ProductionHistorySample {
  return {
    elapsedSeconds,
    sampleDurationSeconds: 1,
    productionPerMinute: { iron_ore: production, "模组:矿": production / 2 },
    consumptionPerMinute: { iron_ore: consumption },
    inventory: { iron_ore: 1234, "模组:矿": 9 },
    generationKw: 500,
    demandKw: 450,
  } as ProductionHistorySample;
}

const IDENTITY: NativeStatisticsWorkspaceIdentity = Object.freeze({
  sessionId: "session-1",
  runId: "run-1",
  revision: 17,
  registryFingerprint: "registry-a",
});

function frame(
  revision: number,
  samples: readonly ProductionHistorySample[],
  overrides: Partial<NativeStatisticsWorkspaceIdentity> = {},
): NativeStatisticsWorkspaceFrame {
  return {
    source: "native-core",
    ...IDENTITY,
    revision,
    ...overrides,
    samples,
  };
}

describe("NativeStatisticsWorkspace", () => {
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

  it("renders bounded Rust samples, including opaque item ids, without GameState", () => {
    act(() => root.render(<NativeStatisticsWorkspace
      open
      frame={frame(17, [sample(1, 60, 10), sample(2, 120, 20)])}
      latestIdentity={IDENTITY}
      status="ready"
      onClose={() => undefined}
    />));

    expect(host.querySelector("[data-native-statistics='history-v1']")?.textContent).toContain("revision 17");
    expect(host.textContent).toContain("铁矿");
    expect(host.textContent).toContain("模组:矿");
    expect(host.querySelectorAll(".production-history-line")).toHaveLength(2);
    expect(host.textContent).toContain("不会读取旧网页存档");
  });

  it("filters rows and closes through the workspace control", () => {
    const onClose = vi.fn();
    act(() => root.render(<NativeStatisticsWorkspace
      open
      frame={frame(17, [sample(1, 60, 10)])}
      latestIdentity={IDENTITY}
      status="ready"
      onClose={onClose}
    />));
    const input = host.querySelector<HTMLInputElement>("input[aria-label='筛选原生统计物品']")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "模组");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("模组:矿");
    expect(host.querySelectorAll(".statistics-row")).toHaveLength(1);
    act(() => host.querySelector<HTMLButtonElement>("button[aria-label='关闭生产统计']")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps filtering, selection, input identity, and focus from settled 17 through tick to settled 18", () => {
    const firstFrame = frame(17, [sample(1, 60, 10), sample(2, 120, 20)]);
    const render = (
      currentFrame: NativeStatisticsWorkspaceFrame,
      latestIdentity: NativeStatisticsWorkspaceIdentity,
      status: "loading" | "ready",
    ) => root.render(<NativeStatisticsWorkspace
      open frame={currentFrame} latestIdentity={latestIdentity} status={status} onClose={() => undefined}
    />);
    act(() => render(firstFrame, IDENTITY, "ready"));
    const modRow = [...host.querySelectorAll<HTMLButtonElement>(".statistics-row")]
      .find((row) => row.textContent?.includes("模组:矿"))!;
    act(() => modRow.click());
    const input = host.querySelector<HTMLInputElement>("input[aria-label='筛选原生统计物品']")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "模组");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
    expect(document.activeElement).toBe(input);

    const confirmed17: DesktopNativePlayerAuthorityClockState = {
      schemaVersion: 1,
      phase: "active",
      sessionId: IDENTITY.sessionId,
      runId: IDENTITY.runId,
      revision: 17,
      acknowledgedSequence: 17,
      nextSequence: 18,
      nextDeadlineMs: 17_000,
      inFlight: false,
      currentOperation: null,
      queuedCommands: 0,
      lastErrorCode: null,
    };
    const tickSnapshot: NativePlayerAuthorityClockSnapshot = {
      availability: "ready",
      expectedSessionId: IDENTITY.sessionId,
      currentFrame: {
        ...confirmed17,
        revision: 18,
        acknowledgedSequence: 18,
        nextSequence: 19,
        nextDeadlineMs: 18_000,
        inFlight: true,
        currentOperation: "tick",
      },
      lastConfirmedFrame: confirmed17,
    };
    const tickFrames = selectNativeStatisticsWorkspaceAuthorityFrames(
      tickSnapshot,
      IDENTITY.sessionId,
    );
    expect(tickFrames.readFrame).toBeNull();
    expect(tickFrames.displayFrame?.revision).toBe(17);
    act(() => render(firstFrame, IDENTITY, "ready"));
    expect(host.querySelector<HTMLInputElement>("input[aria-label='筛选原生统计物品']")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("模组");
    expect(host.querySelector(".statistics-row--trend-selected")?.textContent).toContain("模组:矿");

    const revision18 = { ...IDENTITY, revision: 18 };
    act(() => render(firstFrame, revision18, "loading"));
    expect(host.querySelector("[data-native-statistics='history-v1']")
      ?.getAttribute("data-native-statistics-display-stale")).toBe("true");
    expect(host.querySelector("[data-native-statistics-revision='17']")).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>("input[aria-label='筛选原生统计物品']")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("模组");
    expect(host.querySelector(".statistics-row--trend-selected")?.textContent).toContain("模组:矿");
    expect(host.textContent).toContain("继续显示已验证的 revision 17");

    act(() => render(frame(18, [sample(3, 180, 30)]), revision18, "ready"));
    expect(host.querySelector<HTMLInputElement>("input[aria-label='筛选原生统计物品']")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("模组");
    expect(host.querySelector(".statistics-row--trend-selected")?.textContent).toContain("模组:矿");
    expect(host.querySelector("[data-native-statistics-revision='18']")
      ?.getAttribute("data-native-statistics-status")).toBe("ready");
  });

  it("keeps the focused read-only frame mounted when the newer same-scope read is unavailable", () => {
    const oldFrame = frame(17, [sample(1, 60, 10)]);
    const revision18 = { ...IDENTITY, revision: 18 };
    const render = (status: "loading" | "unavailable") => root.render(<NativeStatisticsWorkspace
      open frame={oldFrame} latestIdentity={revision18} status={status} onClose={() => undefined}
    />);
    act(() => render("loading"));
    const input = host.querySelector<HTMLInputElement>("input[aria-label='筛选原生统计物品']")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "模组");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });

    act(() => render("unavailable"));
    expect(host.querySelector<HTMLInputElement>("input[aria-label='筛选原生统计物品']")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("模组");
    expect(host.textContent).toContain("Rust revision 18 暂不可用");
    expect(host.querySelector("[data-native-statistics-status='unavailable']")).not.toBeNull();
  });

  it("never displays an old frame across a run, registry, or revision rollback boundary", () => {
    const oldFrame = frame(17, [sample(1, 60, 10)]);
    const render = (latestIdentity: NativeStatisticsWorkspaceIdentity) => root.render(
      <NativeStatisticsWorkspace
        open frame={oldFrame} latestIdentity={latestIdentity} status="loading" onClose={() => undefined}
      />,
    );

    act(() => render({ ...IDENTITY, runId: "run-2", revision: 18 }));
    expect(host.querySelectorAll(".statistics-row")).toHaveLength(0);
    expect(host.textContent).toContain("正在读取当前 revision");

    act(() => render({ ...IDENTITY, registryFingerprint: "registry-b", revision: 18 }));
    expect(host.querySelectorAll(".statistics-row")).toHaveLength(0);

    act(() => render({ ...IDENTITY, revision: 16 }));
    expect(host.querySelectorAll(".statistics-row")).toHaveLength(0);
    expect(host.textContent).not.toContain("1234");
  });
});
