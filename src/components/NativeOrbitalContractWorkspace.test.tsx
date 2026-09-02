/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopNativeCoreOrbitalContractWorkspaceProjectionRequest,
  DesktopNativeCoreOrbitalContractWorkspaceProjectionResult,
} from "../desktop";
import { addStationInteger, STATION_MAX_INTEGER_DIGITS } from "../game/stationMath";
import { GameDialogProvider } from "./GameDialogProvider";
import { NativeOrbitalContractWorkspace } from "./NativeOrbitalContractWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const projection: DesktopNativeCoreOrbitalContractWorkspaceProjectionResult = {
  schemaVersion: 1,
  projectionType: "orbital-contract-workspace-v1",
  source: "native-core",
  sessionId: "core-main-1",
  runId: "run-1",
  revision: 7,
  registryFingerprint: "7df8cf3a",
  stateVersion: 47,
  stationStatus: "operational",
  taskDay: 100,
  rulesVersion: 1,
  quantumEnabled: true,
  orbitalMarks: "0",
  stationReputation: "0",
  completedContracts: 0,
  featuredContractId: null,
  offers: [{
    id: "station-contract-v1-7-100-1-single",
    templateId: "single",
    slot: 1,
    title: "新合同",
    summary: "由 Rust 生成的有界合同",
    taskDay: 100,
    expiresAtTaskDay: 103,
    special: false,
    difficulty: "P1",
    status: "offered",
    requirements: [{ itemId: "processor", amount: "50", delivered: "0", channel: "any", sourcePlanetIds: [], availableQuantum: "75" }],
    rewardMarks: "65",
    rewardReputation: "45",
    completionBasisPoints: 0,
  }],
  accepted: [{
    id: "station-contract-v1-7-100-0-single",
    templateId: "single",
    slot: 0,
    title: "进行中合同",
    summary: "库存与奖励不由 renderer 提交",
    taskDay: 100,
    expiresAtTaskDay: 103,
    special: false,
    difficulty: "P1",
    status: "accepted",
    requirements: [{ itemId: "processor", amount: "100", delivered: "25", channel: "any", sourcePlanetIds: [], availableQuantum: "75" }],
    rewardMarks: "65",
    rewardReputation: "45",
    completionBasisPoints: 2500,
  }],
  completedHistory: [],
  limits: { offerCount: 4, acceptedCount: 3, historyCount: 8, requirementsPerContract: 6, projectionBytes: 262144 },
  unsupported: ["cargo-terminal-binding", "decorations", "profile", "construction"],
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("NativeOrbitalContractWorkspace", () => {
  it("renders only the bounded projection and emits semantic intents", async () => {
    const onIntent = vi.fn(() => true);
    await act(async () => {
      root.render(<GameDialogProvider><NativeOrbitalContractWorkspace
        open
        identity={{
          sessionId: "core-main-1",
          runId: "run-1",
          expectedRevision: 7,
          expectedRegistryFingerprint: "7df8cf3a",
        }}
        fetchProjection={async () => projection}
        onClose={() => undefined}
        onIntent={onIntent}
      /></GameDialogProvider>);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Rust 权威");
    expect(host.textContent).toContain("货运绑定（未接入）");
    const accept = [...host.querySelectorAll("button")].find((button) => button.textContent === "接受合同")!;
    act(() => accept.click());
    expect(onIntent).toHaveBeenCalledWith(
      { type: "accept", contractId: "station-contract-v1-7-100-1-single" },
      expect.any(String),
    );
    const input = host.querySelector<HTMLInputElement>('input[aria-label="processor量子交付数量"]')!;
    expect(input.value).toBe("75");
    expect(input.maxLength).toBe(256);
    const deliver = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("量子交付"))!;
    act(() => deliver.click());
    expect(onIntent).toHaveBeenCalledWith({
      type: "deliver-quantum",
      contractId: "station-contract-v1-7-100-0-single",
      itemId: "processor",
      requestedAmount: "75",
    }, expect.any(String));
  });

  it("re-reads a same-revision projection when a rejected command leaves the FIFO", async () => {
    const identity: DesktopNativeCoreOrbitalContractWorkspaceProjectionRequest = {
      sessionId: "core-main-1",
      runId: "run-1",
      expectedRevision: 7,
      expectedRegistryFingerprint: "7df8cf3a",
    };
    let current = projection;
    const fetchProjection = vi.fn(async () => current);
    const render = (pending: boolean) => root.render(
      <GameDialogProvider><NativeOrbitalContractWorkspace
        open
        identity={identity}
        fetchProjection={fetchProjection}
        pending={pending}
        onClose={() => undefined}
        onIntent={() => true}
      /></GameDialogProvider>,
    );
    await act(async () => {
      render(false);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("任务日 100");
    current = { ...projection, taskDay: 101 };
    await act(async () => {
      render(true);
      await Promise.resolve();
    });
    expect(fetchProjection).toHaveBeenCalledTimes(1);
    await act(async () => {
      render(false);
      await Promise.resolve();
    });
    expect(fetchProjection).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("任务日 101");
  });

  it("keeps a verified revision mounted read-only while the next revision loads", async () => {
    const identity = {
      sessionId: "core-main-1",
      runId: "run-1",
      expectedRevision: 7,
      expectedRegistryFingerprint: "7df8cf3a",
    } as const;
    let finishNext!: () => void;
    const fetchProjection = vi.fn((request: DesktopNativeCoreOrbitalContractWorkspaceProjectionRequest) => request.expectedRevision === 7
      ? Promise.resolve(projection)
      : new Promise<DesktopNativeCoreOrbitalContractWorkspaceProjectionResult>((resolve) => {
        finishNext = () => resolve({ ...projection, revision: 8, taskDay: 101 });
      }));
    const render = (nextIdentity: DesktopNativeCoreOrbitalContractWorkspaceProjectionRequest) => root.render(
      <GameDialogProvider><NativeOrbitalContractWorkspace
        open
        identity={nextIdentity}
        fetchProjection={fetchProjection}
        onClose={() => undefined}
        onIntent={() => true}
      /></GameDialogProvider>,
    );
    await act(async () => {
      render(identity);
      await Promise.resolve();
    });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="processor量子交付数量"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "10");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("10");

    await act(async () => {
      render({ ...identity, expectedRevision: 8 });
      await Promise.resolve();
    });
    expect(host.querySelector('input[aria-label="processor量子交付数量"]')).toBe(input);
    expect(input.value).toBe("10");
    expect(host.querySelector("[data-native-orbital-contract='workspace-v1']")
      ?.getAttribute("data-native-orbital-contract-status")).toBe("loading");
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .filter((button) => ["接受合同", "量子交付", "领取完成奖励", "放弃并部分结算"].some(
        (label) => button.textContent?.includes(label),
      )).every((button) => button.disabled)).toBe(true);

    await act(async () => {
      finishNext();
      await Promise.resolve();
    });
    expect(host.textContent).toContain("任务日 101");
    expect(host.querySelector("[data-native-orbital-contract='workspace-v1']")
      ?.getAttribute("data-native-orbital-contract-status")).toBe("ready");
  });

  it("never renders an old contract projection across a run change", async () => {
    const firstIdentity = {
      sessionId: "core-main-1",
      runId: "run-1",
      expectedRevision: 7,
      expectedRegistryFingerprint: "7df8cf3a",
    } as const;
    const firstFetch = vi.fn(async () => projection);
    await act(async () => {
      root.render(<GameDialogProvider><NativeOrbitalContractWorkspace
        open identity={firstIdentity} fetchProjection={firstFetch}
        onClose={() => undefined} onIntent={() => true}
      /></GameDialogProvider>);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("进行中合同");

    const nextIdentity = { ...firstIdentity, runId: "run-2", expectedRevision: 8 };
    await act(async () => {
      root.render(<GameDialogProvider><NativeOrbitalContractWorkspace
        open identity={nextIdentity} fetchProjection={() => new Promise(() => undefined)}
        onClose={() => undefined} onIntent={() => true}
      /></GameDialogProvider>);
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("进行中合同");
    expect(host.textContent).not.toContain("由 Rust 生成的有界合同");
    expect(host.querySelector("[data-native-orbital-contract='workspace-v1']")
      ?.getAttribute("data-native-orbital-contract-status")).toBe("loading");
  });

  it("shares the Web/Rust 256-digit station-ledger saturation vector", () => {
    const maximum = "9".repeat(STATION_MAX_INTEGER_DIGITS);
    expect(addStationInteger(maximum, "1")).toBe(maximum);
  });
});
