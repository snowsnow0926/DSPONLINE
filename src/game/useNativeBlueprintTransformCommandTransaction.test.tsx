// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopBridge,
  DesktopNativePlayerAuthorityClockState,
} from "../desktop";
import type { NativeBlueprintTransformAuthorityObservation } from "./nativeBlueprintTransformCommandReconciliation";
import {
  createNativePlayerAuthorityCommandSource,
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintTransformBinding,
  NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";
import { useNativeBlueprintTransformCommandTransaction } from "./useNativeBlueprintTransformCommandTransaction";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function clock(
  revision = 10,
  sessionId = "session-1",
  runId = "run-1",
): DesktopNativePlayerAuthorityClockState {
  return {
    schemaVersion: 1,
    phase: "active",
    sessionId,
    runId,
    revision,
    acknowledgedSequence: 20,
    nextSequence: 21,
    nextDeadlineMs: 50_000,
    inFlight: false,
    currentOperation: null,
    queuedCommands: 0,
    lastErrorCode: null,
  };
}

function binding(
  revision = 10,
  rowRevision = 4,
  rotation: 0 | 90 | 180 | 270 = 90,
  mirror: "none" | "horizontal" = "horizontal",
  sessionId = "session-1",
  runId = "run-1",
): NativeBlueprintTransformBinding {
  return {
    sessionId,
    runId,
    revision,
    registryFingerprint: "registry-a",
    blueprintId: "mod:opaque/rocket",
    currentRowRevision: rowRevision,
    currentRotation: rotation,
    currentMirror: mirror,
  };
}

function frame(value: NativeBlueprintTransformBinding): NativeBlueprintWorkspaceFrame {
  const row = {
    id: value.blueprintId,
    name: "不透明蓝图",
    revision: value.currentRowRevision,
    rotation: value.currentRotation,
    mirror: value.currentMirror,
    counts: { entities: 513, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    detailStatus: "truncated" as const,
  };
  return {
    source: "native-core",
    readOnly: true,
    sessionId: value.sessionId,
    runId: value.runId,
    revision: value.revision,
    registryFingerprint: value.registryFingerprint,
    selectedBlueprintId: value.blueprintId,
    library: [row],
    libraryById: new Map([[row.id, row]]),
    libraryPage: { cursor: 0, totalCount: 1, nextCursor: null },
    detail: null,
    queue: [],
    queuePage: { cursor: 0, totalCount: 0, nextCursor: null },
  };
}

function authority(value: NativeBlueprintTransformBinding): NativeBlueprintTransformAuthorityObservation {
  return { sessionId: value.sessionId, runId: value.runId, revision: value.revision };
}

function committedReceipt() {
  return {
    previousRevision: 10,
    revision: 11,
    changedEntityIds: [],
    changedBeltIds: [],
    topologyDirty: true,
  };
}

interface HarnessProps {
  readonly source: NativePlayerAuthorityCommandSource;
  readonly projection: NativeBlueprintTransformBinding;
  readonly observation: NativeBlueprintTransformAuthorityObservation;
  readonly refresh: () => Promise<void>;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

function Harness(props: HarnessProps) {
  const authorityOwnedRef = useRef(true);
  const commandInFlightRef = useRef(false);
  const commandSourceRef = useRef<Readonly<{ source: NativePlayerAuthorityCommandSource }> | null>({
    source: props.source,
  });
  commandSourceRef.current = { source: props.source };
  const [commandPending, setCommandPending] = useState(false);
  const [notice, setNotice] = useState("");
  const transaction = useNativeBlueprintTransformCommandTransaction({
    authority: props.observation,
    projection: props.projection,
    frame: frame(props.projection),
    authorityOwnedRef,
    commandInFlightRef,
    commandSourceRef,
    setCommandPending,
    rejectPlayerStateEdit: () => false,
    refreshAuthority: props.refresh,
    setNotice,
    wait: props.wait,
  });
  return <>
    <output
      data-testid="transaction"
      data-phase={transaction.pending?.phase ?? "none"}
      data-command-pending={String(commandPending)}
    >{notice}</output>
    <button
      type="button"
      disabled={transaction.pending !== null || commandPending}
      onClick={() => transaction.commit(props.projection, 180, "none")}
    >变换</button>
  </>;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

describe("useNativeBlueprintTransformCommandTransaction", () => {
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

  it("dispatches once, reconciles a lost response read-only, and waits for the exact target row", async () => {
    const initialClock = clock();
    const outcomes = [
      { status: "pending" as const, baseRevision: 10, currentRevision: 10 },
      { status: "committed" as const, receipt: committedReceipt() },
    ];
    const bridge = {
      getNativePlayerAuthorityState: vi.fn(async () => initialClock),
      applyNativeCoreCommand: vi.fn(async () => { throw new Error("lost response"); }),
      reconcileNativeCoreCommand: vi.fn(async () => outcomes.shift()!),
    } satisfies Pick<DesktopBridge,
      "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand">;
    const source = createNativePlayerAuthorityCommandSource(bridge, initialClock)!;
    const refresh = vi.fn(async () => { throw new Error("projection refresh offline"); });
    const wait = vi.fn(async () => undefined);
    const render = (value: NativeBlueprintTransformBinding) => act(() => root.render(<Harness
      source={source}
      projection={value}
      observation={authority(value)}
      refresh={refresh}
      wait={wait}
    />));

    render(binding());
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(bridge.reconcileNativeCoreCommand).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("awaiting-projection");
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);

    render(binding(12, 5, 180, "none"));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("false");
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it("unlocks a proven non-commit but keeps conflict locked without resending", async () => {
    const initialClock = clock();
    const bridge = {
      getNativePlayerAuthorityState: vi.fn(async () => initialClock),
      applyNativeCoreCommand: vi.fn(async () => { throw new Error("lost response"); }),
      reconcileNativeCoreCommand: vi.fn(async () => ({
        status: "not-committed" as const,
        baseRevision: 10,
        currentRevision: 10,
      })),
    } satisfies Pick<DesktopBridge,
      "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand">;
    const source = createNativePlayerAuthorityCommandSource(bridge, initialClock)!;
    act(() => root.render(<Harness
      source={source}
      projection={binding()}
      observation={authority(binding())}
      refresh={vi.fn(async () => undefined)}
      wait={vi.fn(async () => undefined)}
    />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);

    const conflictBridge = {
      getNativePlayerAuthorityState: vi.fn(async () => initialClock),
      applyNativeCoreCommand: vi.fn(async () => { throw new Error("lost response"); }),
      reconcileNativeCoreCommand: vi.fn(async () => ({
        status: "conflict" as const,
        baseRevision: 10,
        currentRevision: 12,
      })),
    } satisfies Pick<DesktopBridge,
      "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand">;
    const conflictSource = createNativePlayerAuthorityCommandSource(conflictBridge, initialClock)!;
    act(() => root.render(<Harness
      key="conflict"
      source={conflictSource}
      projection={binding()}
      observation={authority(binding())}
      refresh={vi.fn(async () => undefined)}
      wait={vi.fn(async () => undefined)}
    />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(conflictBridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it("ends an old uncertain transaction only when session/run explicitly changes", async () => {
    const initialClock = clock();
    const bridge = {
      getNativePlayerAuthorityState: vi.fn(async () => initialClock),
      applyNativeCoreCommand: vi.fn(async () => { throw new Error("lost response"); }),
      reconcileNativeCoreCommand: vi.fn(async () => ({
        status: "conflict" as const,
        baseRevision: 10,
        currentRevision: 12,
      })),
    } satisfies Pick<DesktopBridge,
      "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand">;
    const source = createNativePlayerAuthorityCommandSource(bridge, initialClock)!;
    const render = (value: NativeBlueprintTransformBinding) => act(() => root.render(<Harness
      source={source}
      projection={value}
      observation={authority(value)}
      refresh={vi.fn(async () => undefined)}
      wait={vi.fn(async () => undefined)}
    />));
    render(binding());
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");

    render(binding(0, 4, 90, "horizontal", "session-2", "run-2"));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("false");
  });

  it("unlocks only a typed bridge-proven pre-dispatch failure", async () => {
    const initialClock = clock();
    const base = createNativePlayerAuthorityCommandSource({
      getNativePlayerAuthorityState: vi.fn(async () => initialClock),
      applyNativeCoreCommand: vi.fn(),
      reconcileNativeCoreCommand: vi.fn(),
    }, initialClock)!;
    const reconcile = vi.fn(base.reconcileCommand);
    const proven: NativePlayerAuthorityCommandSource = Object.freeze({
      ...base,
      applyCommand: vi.fn((): Promise<never> => {
        throw new NativePlayerAuthorityCommandSourceError(
          "preflight",
          "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
          null,
        );
      }),
      reconcileCommand: reconcile,
    });
    act(() => root.render(<Harness
      source={proven}
      projection={binding()}
      observation={authority(binding())}
      refresh={vi.fn(async () => undefined)}
    />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("fails closed before pending or apply when command preparation reaches the safe revision limit", async () => {
    const exhaustedClock = clock(Number.MAX_SAFE_INTEGER);
    const bridge = {
      getNativePlayerAuthorityState: vi.fn(async () => exhaustedClock),
      applyNativeCoreCommand: vi.fn(),
      reconcileNativeCoreCommand: vi.fn(),
    } satisfies Pick<DesktopBridge,
      "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand">;
    const source = createNativePlayerAuthorityCommandSource(bridge, exhaustedClock)!;
    const exhaustedBinding = binding(Number.MAX_SAFE_INTEGER);
    act(() => root.render(<Harness
      source={source}
      projection={exhaustedBinding}
      observation={authority(exhaustedBinding)}
      refresh={vi.fn(async () => undefined)}
    />));

    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();

    const transaction = host.querySelector("[data-testid='transaction']");
    expect(transaction?.getAttribute("data-phase")).toBe("none");
    expect(transaction?.getAttribute("data-command-pending")).toBe("false");
    expect(transaction?.textContent).toContain("revision 已到安全上限");
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
    expect(bridge.applyNativeCoreCommand).not.toHaveBeenCalled();
    expect(bridge.reconcileNativeCoreCommand).not.toHaveBeenCalled();
  });
});
