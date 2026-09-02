// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NativeBlueprintDirectDeployAuthorityObservation,
  NativeBlueprintDirectDeployTopologyObservation,
} from "./nativeBlueprintDirectDeployCommandReconciliation";
import type { NativeBlueprintDirectDeployContext } from "./nativeBlueprintDirectDeployContext";
import {
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import { useNativeBlueprintDirectDeployCommandTransaction } from "./useNativeBlueprintDirectDeployCommandTransaction";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function context(supported = true): NativeBlueprintDirectDeployContext {
  return Object.freeze({
    sessionId: "session-1",
    runId: "run-1",
    schemaVersion: 1,
    projectionType: "blueprint-direct-deploy-context-v1",
    source: "native-core",
    revision: 10,
    stateVersion: 47,
    registryFingerprint: "registry-a",
    request: Object.freeze({
      expectedRevision: 10,
      expectedRegistryFingerprint: "registry-a",
      blueprintId: "ordinary-alpha",
      blueprintRevision: 3,
      position: Object.freeze({ x: 12.5, y: -7 }),
    }),
    activePlanetId: "planet-a",
    support: Object.freeze(supported
      ? { supported: true, reason: null }
      : { supported: false, reason: "insufficient-construction-materials" }),
    limits: Object.freeze({ projectionBytes: 1_048_576 }),
  });
}

function authority(
  revision = 10,
  sessionId = "session-1",
  runId = "run-1",
): NativeBlueprintDirectDeployAuthorityObservation {
  return { sessionId, runId, revision };
}

function topology(
  revision: number,
  activePlanetId = "planet-a",
  sessionId = "session-1",
  runId = "run-1",
  registryFingerprint = "registry-a",
): NativeBlueprintDirectDeployTopologyObservation {
  return {
    source: "native-authoritative",
    sessionId,
    runId,
    revision,
    registryFingerprint,
    activePlanetId,
  };
}

function committedReceipt() {
  return {
    commandId: "renderer-local-direct-1",
    previousRevision: 10,
    revision: 11,
    changedEntityIds: [] as const,
    changedBeltIds: [] as const,
    topologyDirty: true,
  };
}

interface HarnessProps {
  readonly source: NativePlayerAuthorityCommandSource;
  readonly context: NativeBlueprintDirectDeployContext;
  readonly observation: NativeBlueprintDirectDeployAuthorityObservation | null;
  readonly topologyObservation: NativeBlueprintDirectDeployTopologyObservation | null;
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
  const transaction = useNativeBlueprintDirectDeployCommandTransaction({
    authority: props.observation,
    topology: props.topologyObservation,
    authorityOwnedRef,
    commandInFlightRef,
    commandSourceRef,
    setCommandPending,
    rejectPlayerStateEdit: () => false,
    refreshAuthority: props.refresh ?? (() => Promise.resolve()),
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
      onClick={() => transaction.commit(props.context)}
    >直接部署</button>
  </>;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
  });
}

describe("useNativeBlueprintDirectDeployCommandTransaction", () => {
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

  it("dispatches exactly once and unlocks on newer same-lineage topology after a planet switch", async () => {
    const applyCommand = vi.fn(async () => committedReceipt());
    const commandSource: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand: vi.fn(),
    };
    const render = (topologyObservation: NativeBlueprintDirectDeployTopologyObservation | null) => act(() => root.render(<Harness
      source={commandSource}
      context={context()}
      observation={authority(topologyObservation?.revision ?? 10)}
      topologyObservation={topologyObservation}
    />));

    render(topology(10));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("awaiting-topology");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("true");

    render(topology(12, "planet-b"));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("false");
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(commandSource.reconcileCommand).not.toHaveBeenCalled();
  });

  it("reconciles an uncertain transport outcome read-only and never resends", async () => {
    const applyCommand = vi.fn(async () => { throw new Error("lost response"); });
    const outcomes = [
      { status: "pending" as const, baseRevision: 10, currentRevision: 10 },
      {
        status: "committed" as const,
        receipt: {
          previousRevision: 10,
          revision: 11,
          changedEntityIds: [] as const,
          changedBeltIds: [] as const,
          topologyDirty: true,
        },
      },
    ];
    const reconcileCommand = vi.fn(async () => outcomes.shift()! as never);
    const commandSource: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand,
    };
    const render = (topologyObservation: NativeBlueprintDirectDeployTopologyObservation | null) => act(() => root.render(<Harness
      source={commandSource}
      context={context()}
      observation={authority(topologyObservation?.revision ?? 10)}
      topologyObservation={topologyObservation}
      wait={vi.fn(async () => undefined)}
    />));
    render(topology(10));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(reconcileCommand).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("awaiting-topology");
    render(topology(11));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });

  it("keeps all-pending reconciliation locked after six reads without another apply", async () => {
    const applyCommand = vi.fn(async () => { throw new Error("lost response"); });
    const reconcileCommand = vi.fn(async () => ({
      status: "pending" as const,
      baseRevision: 10,
      currentRevision: 10,
    }));
    const commandSource: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1", runId: "run-1", baseRevision: 10, applyCommand, reconcileCommand,
    };
    act(() => root.render(<Harness
      source={commandSource}
      context={context()}
      observation={authority()}
      topologyObservation={topology(10)}
      wait={vi.fn(async () => undefined)}
    />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(reconcileCommand).toHaveBeenCalledTimes(6);
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("true");
  });

  it("unlocks a proven pre-dispatch commandId=null failure without reconciliation", async () => {
    const applyCommand = vi.fn(() => {
      throw new NativePlayerAuthorityCommandSourceError(
        "unavailable before dispatch",
        "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
        null,
      );
    });
    const commandSource = {
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      applyCommand,
      reconcileCommand: vi.fn(),
    } as unknown as NativePlayerAuthorityCommandSource;
    act(() => root.render(<Harness
      source={commandSource}
      context={context()}
      observation={authority()}
      topologyObservation={topology(10)}
    />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(applyCommand).toHaveBeenCalledTimes(1);
    expect(commandSource.reconcileCommand).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("false");
  });

  it("does not dispatch unsupported context or stale authority and retires a blocked command on lineage change", async () => {
    const applyCommand = vi.fn(async () => { throw new Error("lost response"); });
    const reconcileCommand = vi.fn(async () => ({
      status: "conflict" as const, baseRevision: 10, currentRevision: 12,
    }));
    const commandSource: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1", runId: "run-1", baseRevision: 10, applyCommand, reconcileCommand,
    };
    const render = (
      value: NativeBlueprintDirectDeployContext,
      observation: NativeBlueprintDirectDeployAuthorityObservation,
      topologyObservation: NativeBlueprintDirectDeployTopologyObservation,
      key = "same",
    ) => act(() => root.render(<Harness
      key={key}
      source={commandSource}
      context={value}
      observation={observation}
      topologyObservation={topologyObservation}
      wait={vi.fn(async () => undefined)}
    />));

    render(context(false), authority(), topology(10));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(applyCommand).not.toHaveBeenCalled();

    render(context(), authority(11), topology(11), "stale");
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(applyCommand).not.toHaveBeenCalled();

    render(context(), authority(), topology(10), "conflict");
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");
    expect(applyCommand).toHaveBeenCalledTimes(1);
    render(context(), authority(1, "session-2", "run-2"), topology(1, "planet-b", "session-2", "run-2"), "conflict");
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase")).toBe("none");
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });
});
