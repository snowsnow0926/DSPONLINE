// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeConstructionQueueFundAuthorityObservation } from "./nativeConstructionQueueFundCommandReconciliation";
import {
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintWorkspaceFrame,
  NativeConstructionQueueFundBinding,
} from "./nativeBlueprintWorkspaceStore";
import { useNativeConstructionQueueFundCommandTransaction } from "./useNativeConstructionQueueFundCommandTransaction";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function binding(): NativeConstructionQueueFundBinding {
  return {
    sessionId: "session-1",
    runId: "run-1",
    revision: 10,
    registryFingerprint: "registry-a",
    queueEntryId: "queue-target",
    queueTotalCount: 2,
    queuePageCursor: 0,
    initialStatus: "pending-materials",
    initialReservedConstructionTotal: 2,
    initialReservedFleetTotal: 1,
  };
}

function frame(revision = 10, construction = 2, fleet = 1): NativeBlueprintWorkspaceFrame {
  const row = {
    id: "queue-target",
    blueprintId: "blueprint-target",
    blueprintVersionId: "version-target",
    blueprintRevision: 1,
    blueprintName: "待领料订单",
    planetId: "planet-a",
    planetName: "母星",
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: "none" as const,
    queuedAt: 1,
    status: "pending-materials" as const,
    counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    semanticStatus: "catalog-backed" as const,
    reservedConstructionTotal: construction,
    reservedFleetTotal: fleet,
    placedEntityCount: 0,
    actionable: false as const,
  };
  return {
    source: "native-core",
    readOnly: true,
    sessionId: "session-1",
    runId: "run-1",
    revision,
    registryFingerprint: "registry-a",
    selectedBlueprintId: null,
    library: [],
    libraryById: new Map(),
    libraryPage: { cursor: 0, totalCount: 0, nextCursor: null },
    detail: null,
    queue: [row],
    queuePage: { cursor: 0, totalCount: 2, nextCursor: null },
  };
}

function authority(revision = 10): NativeConstructionQueueFundAuthorityObservation {
  return { sessionId: "session-1", runId: "run-1", revision };
}

function receipt() {
  return {
    commandId: "renderer-local-a-b",
    previousRevision: 10,
    revision: 11,
    changedEntityIds: [],
    changedBeltIds: [],
    topologyDirty: true,
  };
}

interface HarnessProps {
  readonly source: NativePlayerAuthorityCommandSource;
  readonly frame: NativeBlueprintWorkspaceFrame;
  readonly observation: NativeConstructionQueueFundAuthorityObservation;
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
  const transaction = useNativeConstructionQueueFundCommandTransaction({
    authority: props.observation,
    frame: props.frame,
    authorityOwnedRef,
    commandInFlightRef,
    commandSourceRef,
    setCommandPending,
    rejectPlayerStateEdit: () => false,
    refreshAuthority: async () => undefined,
    setNotice,
    wait: async () => undefined,
  });
  return <>
    <output data-testid="transaction" data-phase={transaction.pending?.phase ?? "none"}
      data-command-pending={String(commandPending)}>{notice}</output>
    <button type="button" onClick={() => transaction.commit(binding(), "all")}>补充全部</button>
  </>;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

describe("useNativeConstructionQueueFundCommandTransaction", () => {
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

  it("dispatches once, reconciles an unknown outcome read-only, and confirms at R+n", async () => {
    const outcomes = [
      { status: "pending" as const, baseRevision: 10, currentRevision: 10 },
      { status: "committed" as const, receipt: receipt() },
    ];
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand: vi.fn(async () => { throw new Error("lost response"); }),
      reconcileCommand: vi.fn(async () => outcomes.shift()!),
    };
    const render = (value: NativeBlueprintWorkspaceFrame, observation: NativeConstructionQueueFundAuthorityObservation) =>
      act(() => root.render(<Harness source={source} frame={value} observation={observation} />));
    render(frame(), authority());
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(source.applyCommand).toHaveBeenCalledTimes(1);
    expect(source.reconcileCommand).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("awaiting-projection");

    render(frame(13, 4, 1), authority(13));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(source.applyCommand).toHaveBeenCalledTimes(1);
  });

  it("unlocks a proven pre-dispatch no-op rejection without reconciliation", async () => {
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand: vi.fn(async () => {
        throw new NativePlayerAuthorityCommandSourceError(
          "no-op",
          "NATIVE_PLAYER_AUTHORITY_COMMAND_INVALID",
          null,
        );
      }),
      reconcileCommand: vi.fn(),
    };
    act(() => root.render(<Harness source={source} frame={frame()} observation={authority()} />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("false");
    expect(source.applyCommand).toHaveBeenCalledTimes(1);
    expect(source.reconcileCommand).not.toHaveBeenCalled();
  });

  it("keeps the transaction locked when R+1 totals are unchanged", async () => {
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand: vi.fn(async () => receipt()),
      reconcileCommand: vi.fn(),
    };
    const render = (value: NativeBlueprintWorkspaceFrame, observation: NativeConstructionQueueFundAuthorityObservation) =>
      act(() => root.render(<Harness source={source} frame={value} observation={observation} />));
    render(frame(), authority());
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    render(frame(11), authority(11));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("blocked");
    expect(source.applyCommand).toHaveBeenCalledTimes(1);
  });
});

