// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopBridge,
  DesktopNativePlayerAuthorityClockState,
} from "../desktop";
import type { NativeBlueprintDeleteAuthorityObservation } from "./nativeBlueprintDeleteCommandReconciliation";
import {
  createNativePlayerAuthorityCommandSource,
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintDeleteBinding,
  NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";
import { useNativeBlueprintDeleteCommandTransaction } from "./useNativeBlueprintDeleteCommandTransaction";

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
  sessionId = "session-1",
  runId = "run-1",
): NativeBlueprintDeleteBinding {
  return {
    sessionId,
    runId,
    revision,
    registryFingerprint: "registry-a",
    blueprintId: "mod:opaque/rocket",
    currentRowRevision: rowRevision,
    libraryTotalCount: 2,
  };
}

function summary(id: string, revision: number) {
  return {
    id,
    name: id === "other-blueprint" ? "保留蓝图" : "待删除蓝图",
    revision,
    rotation: 90 as const,
    mirror: "horizontal" as const,
    counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    detailStatus: "candidate" as const,
  };
}

function selectedFrame(value: NativeBlueprintDeleteBinding): NativeBlueprintWorkspaceFrame {
  const target = summary(value.blueprintId, value.currentRowRevision);
  const other = summary("other-blueprint", 2);
  return {
    source: "native-core",
    readOnly: true,
    sessionId: value.sessionId,
    runId: value.runId,
    revision: value.revision,
    registryFingerprint: value.registryFingerprint,
    selectedBlueprintId: value.blueprintId,
    library: [target, other],
    libraryById: new Map([[target.id, target], [other.id, other]]),
    libraryPage: { cursor: 0, totalCount: 2, nextCursor: null },
    detail: null,
    queue: [],
    queuePage: { cursor: 0, totalCount: 1, nextCursor: null },
  };
}

function deletedFrame(
  revision = 11,
  sessionId = "session-1",
  runId = "run-1",
): NativeBlueprintWorkspaceFrame {
  const other = summary("other-blueprint", 2);
  return {
    source: "native-core",
    readOnly: true,
    sessionId,
    runId,
    revision,
    registryFingerprint: "registry-a",
    selectedBlueprintId: null,
    library: [other],
    libraryById: new Map([[other.id, other]]),
    libraryPage: { cursor: 0, totalCount: 1, nextCursor: null },
    detail: null,
    queue: [],
    queuePage: { cursor: 0, totalCount: 1, nextCursor: null },
  };
}

function authority(
  revision = 10,
  sessionId = "session-1",
  runId = "run-1",
): NativeBlueprintDeleteAuthorityObservation {
  return { sessionId, runId, revision };
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
  readonly binding: NativeBlueprintDeleteBinding;
  readonly frame: NativeBlueprintWorkspaceFrame | null;
  readonly observation: NativeBlueprintDeleteAuthorityObservation;
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
  const transaction = useNativeBlueprintDeleteCommandTransaction({
    authority: props.observation,
    frame: props.frame,
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
      onClick={() => transaction.commit(props.binding)}
    >删除</button>
  </>;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

describe("useNativeBlueprintDeleteCommandTransaction", () => {
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

  it("dispatches once, reconciles a lost response read-only, and waits for exact absence", async () => {
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
    const initialBinding = binding();
    const render = (frame: NativeBlueprintWorkspaceFrame, observation: NativeBlueprintDeleteAuthorityObservation) =>
      act(() => root.render(<Harness
        source={source}
        binding={initialBinding}
        frame={frame}
        observation={observation}
        refresh={vi.fn(async () => { throw new Error("projection refresh offline"); })}
        wait={vi.fn(async () => undefined)}
      />));

    render(selectedFrame(initialBinding), authority());
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(bridge.reconcileNativeCoreCommand).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("awaiting-projection");

    render(deletedFrame(12), authority(12));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("false");
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it("unlocks a proven non-commit but keeps conflict locked without resending", async () => {
    const initialClock = clock();
    const makeSource = (status: "not-committed" | "conflict") => {
      const bridge = {
        getNativePlayerAuthorityState: vi.fn(async () => initialClock),
        applyNativeCoreCommand: vi.fn(async () => { throw new Error("lost response"); }),
        reconcileNativeCoreCommand: vi.fn(async () => ({
          status,
          baseRevision: 10,
          currentRevision: status === "conflict" ? 12 : 10,
        })),
      } satisfies Pick<DesktopBridge,
        "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand">;
      return { bridge, source: createNativePlayerAuthorityCommandSource(bridge, initialClock)! };
    };
    const first = makeSource("not-committed");
    const initialBinding = binding();
    act(() => root.render(<Harness
      source={first.source}
      binding={initialBinding}
      frame={selectedFrame(initialBinding)}
      observation={authority()}
      refresh={vi.fn(async () => undefined)}
      wait={vi.fn(async () => undefined)}
    />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");

    const second = makeSource("conflict");
    act(() => root.render(<Harness
      key="conflict"
      source={second.source}
      binding={initialBinding}
      frame={selectedFrame(initialBinding)}
      observation={authority()}
      refresh={vi.fn(async () => undefined)}
      wait={vi.fn(async () => undefined)}
    />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");
    expect(first.bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(second.bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it("retires a blocked old transaction only after explicit session/run handoff", async () => {
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
    const initialBinding = binding();
    const render = (frame: NativeBlueprintWorkspaceFrame, observation: NativeBlueprintDeleteAuthorityObservation) =>
      act(() => root.render(<Harness
        source={source}
        binding={initialBinding}
        frame={frame}
        observation={observation}
        refresh={vi.fn(async () => undefined)}
        wait={vi.fn(async () => undefined)}
      />));
    render(selectedFrame(initialBinding), authority());
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");

    render(deletedFrame(0, "session-2", "run-2"), authority(0, "session-2", "run-2"));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it("fails closed before pending/apply at the global safe revision limit", async () => {
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
      binding={exhaustedBinding}
      frame={selectedFrame(exhaustedBinding)}
      observation={authority(Number.MAX_SAFE_INTEGER)}
      refresh={vi.fn(async () => undefined)}
    />));

    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    const transaction = host.querySelector("[data-testid='transaction']");
    expect(transaction?.getAttribute("data-phase")).toBe("none");
    expect(transaction?.getAttribute("data-command-pending")).toBe("false");
    expect(transaction?.textContent).toContain("revision 已到安全上限");
    expect(bridge.applyNativeCoreCommand).not.toHaveBeenCalled();
    expect(bridge.reconcileNativeCoreCommand).not.toHaveBeenCalled();
  });

  it("unlocks only a typed bridge-proven synchronous pre-dispatch failure", async () => {
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
    const initialBinding = binding();
    act(() => root.render(<Harness
      source={proven}
      binding={initialBinding}
      frame={selectedFrame(initialBinding)}
      observation={authority()}
      refresh={vi.fn(async () => undefined)}
    />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(reconcile).not.toHaveBeenCalled();
  });
});
