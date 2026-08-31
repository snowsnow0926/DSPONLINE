// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NativeConstructionQueueDeployAuthorityObservation,
} from "./nativeConstructionQueueDeployCommandReconciliation";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";
import {
  selectNativeConstructionQueueDeployBinding,
  type NativeBlueprintWorkspaceFrame,
  type NativeBlueprintWorkspaceSource,
  type NativeConstructionQueueDeployBinding,
  type NativeConstructionQueueMembershipProof,
} from "./nativeBlueprintWorkspaceStore";
import { useNativeConstructionQueueDeployCommandTransaction } from "./useNativeConstructionQueueDeployCommandTransaction";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function frame(revision = 10): NativeBlueprintWorkspaceFrame {
  const queue = Object.freeze([{
    id: "construction_17",
    blueprintId: "blueprint-a",
    blueprintVersionId: "version-a",
    blueprintRevision: 3,
    blueprintName: "普通工厂",
    planetId: "planet-a",
    planetName: "行星 A",
    position: { x: 1, y: 2 },
    rotation: 0 as const,
    mirror: "none" as const,
    queuedAt: 1,
    status: "pending-materials" as const,
    counts: { entities: 2, belts: 1, resourceAnchors: 0, externalPorts: 0 },
    semanticStatus: "catalog-backed" as const,
    reservedConstructionTotal: 3,
    reservedFleetTotal: 0,
    placedEntityCount: 0,
    actionable: true,
  }]);
  return Object.freeze({
    sessionId: "session-1",
    runId: "run-1",
    revision,
    registryFingerprint: "registry-a",
    source: "native-core" as const,
    readOnly: true as const,
    selectedBlueprintId: null,
    library: Object.freeze([]),
    libraryPage: Object.freeze({ cursor: 0, totalCount: 0, nextCursor: null }),
    libraryById: new Map(),
    detail: null,
    queue,
    queuePage: Object.freeze({ cursor: 0, totalCount: 1, nextCursor: null }),
  });
}

function authority(
  revision = 10,
  sessionId = "session-1",
  runId = "run-1",
): NativeConstructionQueueDeployAuthorityObservation {
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

function receipt() {
  return {
    commandId: "renderer-local-test-1",
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
  readonly binding: NativeConstructionQueueDeployBinding;
  readonly frame: NativeBlueprintWorkspaceFrame | null;
  readonly observation: NativeConstructionQueueDeployAuthorityObservation;
  readonly membershipSource: NativeBlueprintWorkspaceSource | null;
  readonly refresh?: () => Promise<void>;
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
  const transaction = useNativeConstructionQueueDeployCommandTransaction({
    authority: props.observation,
    frame: props.frame,
    membershipSource: props.membershipSource,
    authorityOwnedRef,
    commandInFlightRef,
    commandSourceRef,
    setCommandPending,
    rejectPlayerStateEdit: () => false,
    refreshAuthority: props.refresh ?? vi.fn(async () => undefined),
    setNotice,
    wait: props.wait,
  });
  return <>
    <output
      data-testid="transaction"
      data-phase={transaction.pending?.phase ?? "none"}
      data-command-pending={String(commandPending)}
    >{notice}</output>
    <button type="button" onClick={() => transaction.commit(props.binding)}>开始建造</button>
  </>;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 14; index += 1) await Promise.resolve();
  });
}

describe("useNativeConstructionQueueDeployCommandTransaction", () => {
  let host: HTMLDivElement;
  let root: Root;
  const initial = frame();
  const binding = selectNativeConstructionQueueDeployBinding(initial, "construction_17")!;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("dispatches once and confirms only after an exact absent membership proof", async () => {
    const applyCommand = vi.fn(async (
      _command: Parameters<NativePlayerAuthorityCommandSource["applyCommand"]>[0],
    ) => receipt());
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand: vi.fn(),
    };
    const reader = vi.fn(async (queueEntryId: string) => ({
      sessionId: "session-1",
      runId: "run-1",
      revision: 11,
      registryFingerprint: "registry-a",
      queueEntryId,
      present: false,
    }));
    const render = (
      observation: NativeConstructionQueueDeployAuthorityObservation,
      projectionFrame: NativeBlueprintWorkspaceFrame | null,
      projectionSource: NativeBlueprintWorkspaceSource,
    ) => act(() => root.render(<Harness
      source={source}
      binding={binding}
      frame={projectionFrame}
      observation={observation}
      membershipSource={projectionSource}
    />));

    render(authority(), initial, membershipSource(10, true));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(applyCommand.mock.calls[0][0].topLevelChanges[0].value)
      .toEqual({ kind: "deploy", id: "construction_17", revision: 10 });
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("awaiting-projection");

    // Confirmation intentionally does not need the paged workspace frame.
    render(authority(11), null, membershipSource(11, false, reader));
    await flushAsyncWork();
    expect(reader).toHaveBeenCalledWith("construction_17");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });

  it("reconciles a lost response read-only and never automatically reapplies", async () => {
    const applyCommand = vi.fn(async () => { throw new Error("response lost"); });
    const outcomes = [
      { status: "pending" as const, baseRevision: 10, currentRevision: 10 },
      { status: "committed" as const, receipt: {
        previousRevision: 10,
        revision: 11,
        changedEntityIds: [],
        changedBeltIds: [],
        topologyDirty: true,
      } },
    ];
    const reconcileCommand = vi.fn(async () => outcomes.shift()!);
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand,
    };
    const render = (
      observation: NativeConstructionQueueDeployAuthorityObservation,
      projectionFrame: NativeBlueprintWorkspaceFrame | null,
      projectionSource: NativeBlueprintWorkspaceSource,
    ) => act(() => root.render(<Harness
      source={source}
      binding={binding}
      frame={projectionFrame}
      observation={observation}
      membershipSource={projectionSource}
      wait={vi.fn(async () => undefined)}
    />));
    render(authority(), initial, membershipSource(10, true));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(reconcileCommand).toHaveBeenCalledTimes(2);
    render(authority(11), null, membershipSource(11, false));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });

  it("retires a stale attached proof and rereads at the newer revision without resending", async () => {
    const applyCommand = vi.fn(async () => receipt());
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand: vi.fn(),
    };
    const oldDeferred = deferred<NativeConstructionQueueMembershipProof | null>();
    const oldReader = vi.fn(() => oldDeferred.promise);
    const nextReader = vi.fn(async (queueEntryId: string) => ({
      sessionId: "session-1",
      runId: "run-1",
      revision: 12,
      registryFingerprint: "registry-a",
      queueEntryId,
      present: false,
    }));
    const render = (
      observation: NativeConstructionQueueDeployAuthorityObservation,
      projectionSource: NativeBlueprintWorkspaceSource,
      projectionFrame: NativeBlueprintWorkspaceFrame | null = null,
    ) => root.render(<Harness
      source={source}
      binding={binding}
      frame={projectionFrame}
      observation={observation}
      membershipSource={projectionSource}
    />);

    act(() => render(authority(), membershipSource(10, true), initial));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    act(() => render(authority(11), membershipSource(11, false, oldReader)));
    await flushAsyncWork();
    expect(oldReader).toHaveBeenCalledTimes(1);
    await act(async () => {
      oldDeferred.resolve({
        sessionId: "session-1",
        runId: "run-1",
        revision: 11,
        registryFingerprint: "registry-a",
        queueEntryId: "construction_17",
        present: false,
      });
      await Promise.resolve();
      render(authority(12), membershipSource(12, false, nextReader));
    });
    await flushAsyncWork();
    expect(nextReader).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a present target and retires only on new session/run", async () => {
    const applyCommand = vi.fn(async () => receipt());
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand: vi.fn(),
    };
    const render = (
      observation: NativeConstructionQueueDeployAuthorityObservation,
      projectionSource: NativeBlueprintWorkspaceSource,
      projectionFrame: NativeBlueprintWorkspaceFrame | null = null,
    ) => act(() => root.render(<Harness
      source={source}
      binding={binding}
      frame={projectionFrame}
      observation={observation}
      membershipSource={projectionSource}
    />));
    render(authority(), membershipSource(10, true), initial);
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    render(authority(11), membershipSource(11, true));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");
    render(authority(1, "session-2", "run-2"), membershipSource(11, true));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });
});
