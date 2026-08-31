// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopBridge, DesktopNativePlayerAuthorityClockState } from "../desktop";
import type {
  NativeBlueprintEnqueueAuthorityObservation,
} from "./nativeBlueprintEnqueueCommandReconciliation";
import type { NativeBlueprintEnqueueContext } from "./nativeBlueprintEnqueueContext";
import {
  createNativePlayerAuthorityCommandSource,
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type { NativeBlueprintWorkspaceSource } from "./nativeBlueprintWorkspaceStore";
import type { NativeConstructionQueueMembershipProof } from "./nativeBlueprintWorkspaceStore";
import { useNativeBlueprintEnqueueCommandTransaction } from "./useNativeBlueprintEnqueueCommandTransaction";

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

function context(
  revision = 10,
  sessionId = "session-1",
  runId = "run-1",
): NativeBlueprintEnqueueContext {
  return Object.freeze({
    sessionId,
    runId,
    schemaVersion: 1,
    projectionType: "blueprint-enqueue-context-v1",
    source: "native-core",
    revision,
    stateVersion: 47,
    registryFingerprint: "registry-a",
    request: Object.freeze({
      expectedRevision: revision,
      expectedRegistryFingerprint: "registry-a",
      blueprintId: "blueprint-a",
      blueprintRevision: 3,
    }),
    activePlanetId: "planet-a",
    support: Object.freeze({ supported: true, reason: null }),
    expectedQueueId: "construction_17",
    limits: Object.freeze({ projectionBytes: 1_048_576 }),
  });
}

function authority(
  revision = 10,
  sessionId = "session-1",
  runId = "run-1",
): NativeBlueprintEnqueueAuthorityObservation {
  return { sessionId, runId, revision };
}

function membershipSource(
  revision: number,
  present: boolean,
  reader: NativeBlueprintWorkspaceSource["readVerifiedQueueMembership"] = vi.fn(async (queueEntryId: string) => ({
    sessionId: "session-1",
    runId: "run-1",
    revision,
    registryFingerprint: "registry-a",
    queueEntryId,
    present,
  })),
): NativeBlueprintWorkspaceSource {
  return {
    boundIdentity: {
      sessionId: "session-1",
      runId: "run-1",
      revision,
      registryFingerprint: "registry-a",
    },
    readVerifiedBlueprintPage: async () => null,
    readVerifiedQueueMembership: reader,
  };
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

interface HarnessProps {
  readonly source: NativePlayerAuthorityCommandSource;
  readonly context: NativeBlueprintEnqueueContext;
  readonly observation: NativeBlueprintEnqueueAuthorityObservation;
  readonly membershipSource: NativeBlueprintWorkspaceSource | null;
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
  const transaction = useNativeBlueprintEnqueueCommandTransaction({
    authority: props.observation,
    membershipSource: props.membershipSource,
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
      onClick={() => transaction.commit(props.context, { x: 12.5, y: -7 })}
    >加入待建施工</button>
  </>;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

describe("useNativeBlueprintEnqueueCommandTransaction", () => {
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

  it("dispatches once, reconciles a lost response read-only, then proves the exact queue ID", async () => {
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
    const initialMembership = membershipSource(10, false);
    const queueReader = vi.fn(async (queueEntryId: string) => ({
      sessionId: "session-1",
      runId: "run-1",
      revision: 12,
      registryFingerprint: "registry-a",
      queueEntryId,
      present: true,
    }));
    const currentMembership = membershipSource(12, true, queueReader);
    const render = (
      observation: NativeBlueprintEnqueueAuthorityObservation,
      projectionSource: NativeBlueprintWorkspaceSource,
    ) => act(() => root.render(<Harness
      source={source}
      context={context()}
      observation={observation}
      membershipSource={projectionSource}
      refresh={vi.fn(async () => undefined)}
      wait={vi.fn(async () => undefined)}
    />));

    render(authority(), initialMembership);
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(bridge.reconcileNativeCoreCommand).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("awaiting-projection");

    // The blueprint workspace can be closed; authority plus exact membership is sufficient.
    render(authority(12), currentMembership);
    await flushAsyncWork();
    expect(queueReader).toHaveBeenCalledTimes(1);
    expect(queueReader).toHaveBeenCalledWith("construction_17");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("false");
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it("retires a just-attached stale proof, rereads at the newer revision, and never resends", async () => {
    const applyCommand = vi.fn(async () => ({
      commandId: "renderer-local-test-1",
      ...committedReceipt(),
    }));
    const commandSource: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand: vi.fn(),
    };
    const oldDeferred = deferred<NativeConstructionQueueMembershipProof | null>();
    const oldReader = vi.fn(() => oldDeferred.promise);
    const oldMembership = membershipSource(11, true, oldReader);
    const nextReader = vi.fn(async (queueEntryId: string) => ({
      sessionId: "session-1",
      runId: "run-1",
      revision: 12,
      registryFingerprint: "registry-a",
      queueEntryId,
      present: true,
    }));
    const nextMembership = membershipSource(12, true, nextReader);
    const render = (
      observation: NativeBlueprintEnqueueAuthorityObservation,
      projectionSource: NativeBlueprintWorkspaceSource,
    ) => root.render(<Harness
      source={commandSource}
      context={context()}
      observation={observation}
      membershipSource={projectionSource}
      refresh={vi.fn(async () => undefined)}
    />);

    act(() => render(authority(), membershipSource(10, false)));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("awaiting-projection");
    act(() => render(authority(11), oldMembership));
    await flushAsyncWork();
    expect(oldReader).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldDeferred.resolve({
        sessionId: "session-1",
        runId: "run-1",
        revision: 11,
        registryFingerprint: "registry-a",
        queueEntryId: "construction_17",
        present: true,
      });
      // Let the membership callback attach R11 while React still batches the
      // render; the next committed props already carry authority/source R12.
      await Promise.resolve();
      render(authority(12), nextMembership);
    });
    await flushAsyncWork();
    expect(nextReader).toHaveBeenCalledTimes(1);
    expect(nextReader).toHaveBeenCalledWith("construction_17");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(commandSource.reconcileCommand).not.toHaveBeenCalled();
  });

  it.each(["null", "reject"] as const)(
    "recovers a %s stale membership read at the next revision without resending",
    async (failureMode) => {
      const applyCommand = vi.fn(async () => ({
        commandId: "renderer-local-membership-race",
        ...committedReceipt(),
      }));
      const commandSource: NativePlayerAuthorityCommandSource = {
        sessionId: "session-1",
        runId: "run-1",
        baseRevision: 10,
        applyCommand,
        reconcileCommand: vi.fn(),
      };
      const oldReader = vi.fn(async () => {
        if (failureMode === "reject") throw new Error("expected revision moved");
        return null;
      });
      const oldMembership = membershipSource(11, true, oldReader);
      const nextReader = vi.fn(async (queueEntryId: string) => ({
        sessionId: "session-1",
        runId: "run-1",
        revision: 12,
        registryFingerprint: "registry-a",
        queueEntryId,
        present: true,
      }));
      const nextMembership = membershipSource(12, true, nextReader);
      const blockedRetryDelay = deferred<void>();
      const wait = vi.fn((milliseconds: number) => milliseconds === 0
        ? Promise.resolve()
        : blockedRetryDelay.promise);
      const refresh = vi.fn(async () => undefined);
      const render = (
        observation: NativeBlueprintEnqueueAuthorityObservation,
        projectionSource: NativeBlueprintWorkspaceSource,
      ) => act(() => root.render(<Harness
        source={commandSource}
        context={context()}
        observation={observation}
        membershipSource={projectionSource}
        refresh={refresh}
        wait={wait}
      />));

      render(authority(), membershipSource(10, false));
      act(() => host.querySelector<HTMLButtonElement>("button")!.click());
      await flushAsyncWork();
      render(authority(11), oldMembership);
      await flushAsyncWork();
      expect(oldReader).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalled();
      expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
        .toBe("awaiting-projection");

      render(authority(12), nextMembership);
      await flushAsyncWork();
      expect(nextReader).toHaveBeenCalledTimes(1);
      expect(nextReader).toHaveBeenCalledWith("construction_17");
      expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
        .toBe("none");
      expect(applyCommand).toHaveBeenCalledTimes(1);
      expect(commandSource.reconcileCommand).not.toHaveBeenCalled();
    },
  );

  it("keeps one same-revision membership flight when projection refresh rebuilds the source", async () => {
    const applyCommand = vi.fn(async () => ({
      commandId: "renderer-local-membership-source-refresh",
      ...committedReceipt(),
    }));
    const commandSource: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand: vi.fn(),
    };
    const retryDelay = deferred<void>();
    const wait = vi.fn((milliseconds: number) => milliseconds === 0
      ? Promise.resolve()
      : retryDelay.promise);
    const firstReader = vi.fn(async (queueEntryId: string) => firstReader.mock.calls.length === 1
      ? null
      : {
          sessionId: "session-1",
          runId: "run-1",
          revision: 11,
          registryFingerprint: "registry-a",
          queueEntryId,
          present: true,
        });
    const replacementReader = vi.fn(async () => null);
    const render = (projectionSource: NativeBlueprintWorkspaceSource) => act(() => root.render(<Harness
      source={commandSource}
      context={context()}
      observation={authority(projectionSource.boundIdentity.revision)}
      membershipSource={projectionSource}
      refresh={vi.fn(async () => undefined)}
      wait={wait}
    />));

    render(membershipSource(10, false));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    render(membershipSource(11, true, firstReader));
    await flushAsyncWork();
    expect(firstReader).toHaveBeenCalledTimes(1);

    render(membershipSource(11, true, replacementReader));
    await flushAsyncWork();
    expect(replacementReader).not.toHaveBeenCalled();
    await act(async () => {
      retryDelay.resolve();
      await Promise.resolve();
    });
    await flushAsyncWork();

    expect(firstReader).toHaveBeenCalledTimes(2);
    expect(replacementReader).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(commandSource.reconcileCommand).not.toHaveBeenCalled();
  });

  it("locks after six same-revision unavailable membership reads without resending", async () => {
    const applyCommand = vi.fn(async () => ({
      commandId: "renderer-local-membership-exhausted",
      ...committedReceipt(),
    }));
    const commandSource: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand: vi.fn(),
    };
    const queueReader = vi.fn(async () => null);
    const refresh = vi.fn(async () => undefined);
    const render = (
      observation: NativeBlueprintEnqueueAuthorityObservation,
      projectionSource: NativeBlueprintWorkspaceSource,
    ) => act(() => root.render(<Harness
      source={commandSource}
      context={context()}
      observation={observation}
      membershipSource={projectionSource}
      refresh={refresh}
      wait={vi.fn(async () => undefined)}
    />));

    render(authority(), membershipSource(10, false));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    render(authority(11), membershipSource(11, true, queueReader));
    for (let index = 0; index < 3; index += 1) await flushAsyncWork();

    expect(queueReader).toHaveBeenCalledTimes(6);
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(commandSource.reconcileCommand).not.toHaveBeenCalled();
  });

  it("unlocks proven non-commit but keeps a conflict locked without resending", async () => {
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
    act(() => root.render(<Harness
      source={first.source}
      context={context()}
      observation={authority()}
      membershipSource={membershipSource(10, false)}
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
      context={context()}
      observation={authority()}
      membershipSource={membershipSource(10, false)}
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

  it("retires a blocked enqueue only after an explicit session/run change", async () => {
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
    const render = (observation: NativeBlueprintEnqueueAuthorityObservation) => act(() => root.render(<Harness
      source={source}
      context={context()}
      observation={observation}
      membershipSource={membershipSource(10, false)}
      refresh={vi.fn(async () => undefined)}
      wait={vi.fn(async () => undefined)}
    />));
    render(authority());
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");

    render(authority(1, "session-2", "run-2"));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects stale context and unlocks a proven pre-dispatch failure", async () => {
    const staleApply = vi.fn();
    const staleSource: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand: staleApply,
      reconcileCommand: vi.fn(),
    };
    act(() => root.render(<Harness
      source={staleSource}
      context={context()}
      observation={authority(11)}
      membershipSource={membershipSource(11, false)}
      refresh={vi.fn(async () => undefined)}
    />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(staleApply).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");

    const preDispatchApply = vi.fn(() => {
      throw new NativePlayerAuthorityCommandSourceError(
        "unavailable before dispatch",
        "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
        null,
      );
    });
    const preDispatchSource: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand: preDispatchApply,
      reconcileCommand: vi.fn(),
    };
    act(() => root.render(<Harness
      key="pre-dispatch"
      source={preDispatchSource}
      context={context()}
      observation={authority()}
      membershipSource={membershipSource(10, false)}
      refresh={vi.fn(async () => undefined)}
    />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(preDispatchApply).toHaveBeenCalledTimes(1);
    expect(preDispatchSource.reconcileCommand).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("false");
  });
});
