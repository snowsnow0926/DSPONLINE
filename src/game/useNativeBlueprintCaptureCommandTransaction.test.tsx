// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeBlueprintCaptureAuthorityObservation } from "./nativeBlueprintCaptureCommandReconciliation";
import type { NativeBlueprintCaptureContext } from "./nativeBlueprintCaptureContext";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type {
  NativeBlueprintDirectDeploySelectionBinding,
  NativeBlueprintLibraryMembershipProof,
  NativeBlueprintWorkspaceSource,
} from "./nativeBlueprintWorkspaceStore";
import { useNativeBlueprintCaptureCommandTransaction } from "./useNativeBlueprintCaptureCommandTransaction";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function captureContext(
  revision = 10,
  sessionId = "session-1",
  runId = "run-1",
): NativeBlueprintCaptureContext {
  return Object.freeze({
    sessionId,
    runId,
    schemaVersion: 1,
    projectionType: "blueprint-capture-context-v1",
    source: "native-core",
    revision,
    stateVersion: 47,
    registryFingerprint: "registry-a",
    request: Object.freeze({
      expectedRevision: revision,
      expectedRegistryFingerprint: "registry-a",
      entityIds: Object.freeze(["entity-b", "entity-a"]),
    }),
    activePlanetId: "planet-a",
    support: Object.freeze({ supported: true, reason: null }),
    expectedBlueprintId: "blueprint_17",
    expectedBlueprintName: "蓝图 08",
    expectedBlueprintRevision: 1,
    limits: Object.freeze({
      selectionEntityIds: 512,
      blueprintEntities: 512,
      blueprintBelts: 1_024,
      opaqueIdBytes: 512,
      projectionBytes: 1_048_576,
    }),
  });
}

function authority(
  revision = 10,
  sessionId = "session-1",
  runId = "run-1",
): NativeBlueprintCaptureAuthorityObservation {
  return { sessionId, runId, revision };
}

function membershipSource(
  revision: number,
  reader: NonNullable<NativeBlueprintWorkspaceSource["readVerifiedLibraryMembership"]> =
    vi.fn(async (blueprintId: string): Promise<NativeBlueprintLibraryMembershipProof> => ({
      sessionId: "session-1",
      runId: "run-1",
      revision,
      registryFingerprint: "registry-a",
      blueprintId,
      present: true,
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
    readVerifiedQueueMembership: async () => null,
    readVerifiedLibraryMembership: reader,
  };
}

function committedReceipt() {
  return {
    commandId: "renderer-local-capture-1",
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
  readonly context: NativeBlueprintCaptureContext;
  readonly observation: NativeBlueprintCaptureAuthorityObservation;
  readonly membershipSource: NativeBlueprintWorkspaceSource | null;
  readonly onConfirmed: (binding: NativeBlueprintDirectDeploySelectionBinding) => void;
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
  const transaction = useNativeBlueprintCaptureCommandTransaction({
    authority: props.observation,
    membershipSource: props.membershipSource,
    authorityOwnedRef,
    commandInFlightRef,
    commandSourceRef,
    setCommandPending,
    rejectPlayerStateEdit: () => false,
    refreshAuthority: props.refresh ?? vi.fn(async () => undefined),
    setNotice,
    onConfirmed: props.onConfirmed,
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
      onClick={() => transaction.commit(props.context)}
    >复制所选为蓝图</button>
  </>;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
  });
}

describe("useNativeBlueprintCaptureCommandTransaction", () => {
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

  it("dispatches one exact capture marker, proves membership, and enters direct placement once", async () => {
    const applyCommand = vi.fn(async (_command: SimulationCommandPatch) => committedReceipt());
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand: vi.fn(),
    };
    const reader = vi.fn(async (blueprintId: string) => ({
      sessionId: "session-1",
      runId: "run-1",
      revision: 11,
      registryFingerprint: "registry-a",
      blueprintId,
      present: true,
    }));
    const onConfirmed = vi.fn();
    const render = (
      observation: NativeBlueprintCaptureAuthorityObservation,
      projectionSource: NativeBlueprintWorkspaceSource,
    ) => act(() => root.render(<Harness
      source={source}
      context={captureContext()}
      observation={observation}
      membershipSource={projectionSource}
      onConfirmed={onConfirmed}
      wait={vi.fn(async () => undefined)}
    />));

    render(authority(), membershipSource(10));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(applyCommand.mock.calls[0]?.[0]).toEqual({
      protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
      baseRevision: 10,
      topLevelChanges: [{
        path: ["blueprints", "intent"],
        operation: "set",
        value: { kind: "capture", entityIds: ["entity-b", "entity-a"], revision: 10 },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("awaiting-projection");

    render(authority(11), membershipSource(11, reader));
    await flushAsyncWork();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith("blueprint_17");
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith({
      sessionId: "session-1",
      runId: "run-1",
      registryFingerprint: "registry-a",
      blueprintId: "blueprint_17",
      blueprintName: "蓝图 08",
      currentRowRevision: 1,
    });
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("false");
    expect(source.reconcileCommand).not.toHaveBeenCalled();
  });

  it("never resends after an unknown transport result and uses exactly six read-only reconciliations", async () => {
    const applyCommand = vi.fn(async () => { throw new Error("lost response"); });
    const reconcileCommand = vi.fn(async () => ({
      status: "pending" as const,
      baseRevision: 10,
      currentRevision: 10,
    }));
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand,
    };
    const waits: number[] = [];
    act(() => root.render(<Harness
      source={source}
      context={captureContext()}
      observation={authority()}
      membershipSource={membershipSource(10)}
      onConfirmed={vi.fn()}
      wait={async (milliseconds) => { waits.push(milliseconds); }}
    />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();

    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(reconcileCommand).toHaveBeenCalledTimes(6);
    expect(waits).toEqual([100, 250, 500, 1_000, 2_000]);
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("true");
  });

  it("uses at most six read-only membership proofs after ACK and stays locked when unavailable", async () => {
    const applyCommand = vi.fn(async () => committedReceipt());
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand: vi.fn(),
    };
    const reader = vi.fn(async () => null);
    const onConfirmed = vi.fn();
    const render = (revision: number, projectionSource: NativeBlueprintWorkspaceSource) => act(() => root.render(
      <Harness
        source={source}
        context={captureContext()}
        observation={authority(revision)}
        membershipSource={projectionSource}
        onConfirmed={onConfirmed}
        wait={vi.fn(async () => undefined)}
      />,
    ));

    render(10, membershipSource(10));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    render(11, membershipSource(11, reader));
    for (let index = 0; index < 4; index += 1) await flushAsyncWork();

    expect(reader).toHaveBeenCalledTimes(6);
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(source.reconcileCommand).not.toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");
  });

  it("retires a pending capture only when the authority lineage changes", async () => {
    const response = deferred<ReturnType<typeof committedReceipt>>();
    const applyCommand = vi.fn(() => response.promise);
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand: vi.fn(),
    };
    const onConfirmed = vi.fn();
    const render = (observation: NativeBlueprintCaptureAuthorityObservation) => act(() => root.render(
      <Harness
        source={source}
        context={captureContext()}
        observation={observation}
        membershipSource={membershipSource(observation.revision)}
        onConfirmed={onConfirmed}
      />,
    ));

    render(authority());
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("dispatching");
    render(authority(0, "session-2", "run-2"));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(applyCommand).toHaveBeenCalledTimes(1);

    await act(async () => response.resolve(committedReceipt()));
    await flushAsyncWork();
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });

  it("retires a stale membership proof and confirms only a proof at the current authority revision", async () => {
    const applyCommand = vi.fn(async () => committedReceipt());
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand: vi.fn(),
    };
    const staleProof = deferred<NativeBlueprintLibraryMembershipProof | null>();
    const staleReader = vi.fn(() => staleProof.promise);
    const freshReader = vi.fn(async (blueprintId: string) => ({
      sessionId: "session-1",
      runId: "run-1",
      revision: 12,
      registryFingerprint: "registry-a",
      blueprintId,
      present: true,
    }));
    const onConfirmed = vi.fn();
    const render = (
      revision: number,
      projectionSource: NativeBlueprintWorkspaceSource,
    ) => act(() => root.render(<Harness
      source={source}
      context={captureContext()}
      observation={authority(revision)}
      membershipSource={projectionSource}
      onConfirmed={onConfirmed}
      wait={vi.fn(async () => undefined)}
    />));

    render(10, membershipSource(10));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    render(11, membershipSource(11, staleReader));
    await flushAsyncWork();
    expect(staleReader).toHaveBeenCalledTimes(1);

    await act(async () => {
      staleProof.resolve({
        sessionId: "session-1",
        runId: "run-1",
        revision: 11,
        registryFingerprint: "registry-a",
        blueprintId: "blueprint_17",
        present: true,
      });
      await Promise.resolve();
      root.render(<Harness
        source={source}
        context={captureContext()}
        observation={authority(12)}
        membershipSource={membershipSource(12, freshReader)}
        onConfirmed={onConfirmed}
        wait={vi.fn(async () => undefined)}
      />);
    });
    await flushAsyncWork();

    expect(freshReader).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });
});
