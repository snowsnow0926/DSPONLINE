// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopBridge, DesktopNativePlayerAuthorityClockState } from "../desktop";
import type { NativeConstructionQueueCancelAuthorityObservation } from "./nativeConstructionQueueCancelCommandReconciliation";
import {
  createNativePlayerAuthorityCommandSource,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintWorkspaceFrame,
  NativeBlueprintWorkspaceSource,
  NativeConstructionQueueCancelBinding,
  NativeConstructionQueueMembershipProof,
} from "./nativeBlueprintWorkspaceStore";
import { useNativeConstructionQueueCancelCommandTransaction } from "./useNativeConstructionQueueCancelCommandTransaction";

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
  sessionId = "session-1",
  runId = "run-1",
): NativeConstructionQueueCancelBinding {
  return {
    sessionId,
    runId,
    revision,
    registryFingerprint: "registry-a",
    queueEntryId: "queue-target",
    queueTotalCount: 2,
  };
}

function queueRow(id: string) {
  return {
    id,
    blueprintId: `blueprint-${id}`,
    blueprintVersionId: `version-${id}`,
    blueprintRevision: 1,
    blueprintName: id === "queue-target" ? "待取消订单" : "保留订单",
    planetId: "planet-a",
    planetName: "母星",
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: "none" as const,
    queuedAt: 1,
    status: "pending-materials" as const,
    counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    semanticStatus: "catalog-backed" as const,
    reservedConstructionTotal: 2,
    reservedFleetTotal: 1,
    placedEntityCount: 0,
    actionable: false as const,
  };
}

function frame(
  revision = 10,
  includeTarget = true,
  sessionId = "session-1",
  runId = "run-1",
): NativeBlueprintWorkspaceFrame {
  const rows = includeTarget
    ? [queueRow("queue-target"), queueRow("queue-other")]
    : [queueRow("queue-other")];
  return {
    source: "native-core",
    readOnly: true,
    sessionId,
    runId,
    revision,
    registryFingerprint: "registry-a",
    selectedBlueprintId: null,
    library: [],
    libraryById: new Map(),
    libraryPage: { cursor: 0, totalCount: 0, nextCursor: null },
    detail: null,
    queue: rows,
    queuePage: { cursor: 0, totalCount: includeTarget ? 2 : 1, nextCursor: null },
  };
}

function authority(
  revision = 10,
  sessionId = "session-1",
  runId = "run-1",
): NativeConstructionQueueCancelAuthorityObservation {
  return { sessionId, runId, revision };
}

function membershipSource(revision: number, present: boolean): NativeBlueprintWorkspaceSource {
  const boundIdentity = {
    sessionId: "session-1",
    runId: "run-1",
    revision,
    registryFingerprint: "registry-a",
  };
  return {
    boundIdentity,
    readVerifiedBlueprintPage: async () => null,
    readVerifiedQueueMembership: async (queueEntryId) => ({
      ...boundIdentity,
      queueEntryId,
      present,
    }),
  };
}

function membershipSourceWithReader(
  revision: number,
  readVerifiedQueueMembership: NativeBlueprintWorkspaceSource["readVerifiedQueueMembership"],
): NativeBlueprintWorkspaceSource {
  return {
    boundIdentity: {
      sessionId: "session-1",
      runId: "run-1",
      revision,
      registryFingerprint: "registry-a",
    },
    readVerifiedBlueprintPage: async () => null,
    readVerifiedQueueMembership,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
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
  readonly binding: NativeConstructionQueueCancelBinding;
  readonly frame: NativeBlueprintWorkspaceFrame | null;
  readonly observation: NativeConstructionQueueCancelAuthorityObservation;
  readonly membershipSource?: NativeBlueprintWorkspaceSource | null;
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
  const transaction = useNativeConstructionQueueCancelCommandTransaction({
    authority: props.observation,
    frame: props.frame,
    membershipSource: props.membershipSource ?? null,
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
    >取消并返还</button>
  </>;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

describe("useNativeConstructionQueueCancelCommandTransaction", () => {
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

  it("dispatches once, reconciles a lost response read-only, and waits for target absence", async () => {
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
    const target = binding();
    const render = (projection: NativeBlueprintWorkspaceFrame, observation: NativeConstructionQueueCancelAuthorityObservation) =>
      act(() => root.render(<Harness
        source={source}
        binding={target}
        frame={projection}
        observation={observation}
        membershipSource={projection.revision > 10 ? membershipSource(projection.revision, false) : null}
        refresh={vi.fn(async () => { throw new Error("projection refresh offline"); })}
        wait={vi.fn(async () => undefined)}
      />));

    render(frame(), authority());
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(bridge.reconcileNativeCoreCommand).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("awaiting-projection");

    render(frame(12, false), authority(12));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("false");
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["proof", "null"] as const)(
    "discards a retired revision membership %s and confirms from the replacement revision",
    async (retiredResult) => {
      const initialClock = clock();
      const bridge = {
        getNativePlayerAuthorityState: vi.fn()
          .mockResolvedValueOnce(initialClock)
          .mockResolvedValueOnce({
            ...clock(11),
            acknowledgedSequence: 21,
            nextSequence: 22,
          }),
        applyNativeCoreCommand: vi.fn(async () => committedReceipt()),
        reconcileNativeCoreCommand: vi.fn(),
      } satisfies Pick<DesktopBridge,
        "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand">;
      const commandSource = createNativePlayerAuthorityCommandSource(bridge, initialClock)!;
      const oldDeferred = deferred<NativeConstructionQueueMembershipProof | null>();
      const nextDeferred = deferred<NativeConstructionQueueMembershipProof | null>();
      const oldRead = vi.fn(() => oldDeferred.promise);
      const nextRead = vi.fn(() => nextDeferred.promise);
      const oldSource = membershipSourceWithReader(11, oldRead);
      const nextSource = membershipSourceWithReader(12, nextRead);
      const render = (
        revision: number,
        projectionSource: NativeBlueprintWorkspaceSource | null,
      ) => act(() => root.render(<Harness
        source={commandSource}
        binding={binding()}
        frame={frame(revision, revision === 10)}
        observation={authority(revision)}
        membershipSource={projectionSource}
        refresh={vi.fn(async () => undefined)}
      />));

      render(10, null);
      act(() => host.querySelector<HTMLButtonElement>("button")!.click());
      await flushAsyncWork();
      expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
      expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
        .toBe("awaiting-projection");

      render(11, oldSource);
      await flushAsyncWork();
      expect(oldRead).toHaveBeenCalledTimes(1);

      render(12, nextSource);
      await flushAsyncWork();
      expect(nextRead).toHaveBeenCalledTimes(1);
      await act(async () => {
        oldDeferred.resolve(retiredResult === "proof" ? {
          sessionId: "session-1",
          runId: "run-1",
          revision: 11,
          registryFingerprint: "registry-a",
          queueEntryId: "queue-target",
          present: false,
        } : null);
        await Promise.resolve();
      });
      expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
        .toBe("awaiting-projection");
      expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);

      await act(async () => {
        nextDeferred.resolve({
          sessionId: "session-1",
          runId: "run-1",
          revision: 12,
          registryFingerprint: "registry-a",
          queueEntryId: "queue-target",
          present: false,
        });
        await Promise.resolve();
      });
      await flushAsyncWork();
      expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
        .toBe("none");
      expect(nextRead).toHaveBeenCalledTimes(1);
      expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    },
  );

  it("unlocks proven non-commit but keeps conflict locked without resending", async () => {
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
    const target = binding();
    const first = makeSource("not-committed");
    act(() => root.render(<Harness
      source={first.source}
      binding={target}
      frame={frame()}
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
      binding={target}
      frame={frame()}
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

  it("retires a blocked transaction only after an explicit session/run handoff", async () => {
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
    const target = binding();
    const render = (projection: NativeBlueprintWorkspaceFrame, observation: NativeConstructionQueueCancelAuthorityObservation) =>
      act(() => root.render(<Harness
        source={source}
        binding={target}
        frame={projection}
        observation={observation}
        refresh={vi.fn(async () => undefined)}
        wait={vi.fn(async () => undefined)}
      />));
    render(frame(), authority());
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");

    render(frame(0, false, "session-2", "run-2"), authority(0, "session-2", "run-2"));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });
});
