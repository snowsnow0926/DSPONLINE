// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeBlueprintImportAuthorityObservation } from "./nativeBlueprintImportCommandReconciliation";
import type { NativeBlueprintImportContext } from "./nativeBlueprintImportContext";
import {
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintLibraryMembershipProof,
  NativeBlueprintWorkspaceSource,
} from "./nativeBlueprintWorkspaceStore";
import type { SimulationCommandPatch } from "./simulationRuntimeProtocol";
import {
  useNativeBlueprintImportCommandTransaction,
  type NativeBlueprintImportConfirmation,
} from "./useNativeBlueprintImportCommandTransaction";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function context(revision = 10, sessionId = "session-1", runId = "run-1"): NativeBlueprintImportContext {
  return Object.freeze({
    sessionId,
    runId,
    schemaVersion: 1,
    projectionType: "blueprint-import-context-v1",
    source: "native-core",
    revision,
    stateVersion: 47,
    registryFingerprint: "registry-a",
    request: Object.freeze({
      expectedRevision: revision,
      expectedRegistryFingerprint: "registry-a",
      rawBytes: 32,
      rawSha256: "1".repeat(64),
    }),
    activePlanetId: "planet-a",
    support: Object.freeze({ supported: true, reason: null }),
    preparedIntent: Object.freeze({
      kind: "import",
      sourceName: "交换蓝图",
      blueprint: Object.freeze({
        id: "blueprint_41",
        name: "蓝图 09",
        revision: 1,
        entities: Object.freeze([Object.freeze({
          key: "entity-a",
          buildingId: "assembler_mk1",
          offset: Object.freeze({ x: 0, y: -0.5 }),
          machineCount: 1,
        })]),
        resourceAnchors: [] as const,
        belts: Object.freeze([]),
        externalPorts: [] as const,
        rotation: 0,
        mirror: "none",
        recipeOverrides: Object.freeze({}),
      }),
      blueprintSha256: "2".repeat(64),
      revision,
    }),
    limits: Object.freeze({
      rawBytes: 1_048_576,
      projectionBytes: 1_048_576,
      commandBytes: 1_048_576,
      libraryRows: 64,
      blueprintEntities: 512,
      blueprintBelts: 1_024,
    }),
  });
}

function authority(
  revision = 10,
  sessionId = "session-1",
  runId = "run-1",
): NativeBlueprintImportAuthorityObservation {
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

function receipt() {
  return {
    commandId: "renderer-local-import-1",
    previousRevision: 10,
    revision: 11,
    changedEntityIds: [],
    changedBeltIds: [],
    topologyDirty: true,
  };
}

interface HarnessProps {
  readonly source: NativePlayerAuthorityCommandSource;
  readonly observation: NativeBlueprintImportAuthorityObservation;
  readonly membership: NativeBlueprintWorkspaceSource | null;
  readonly onConfirmed: (confirmation: NativeBlueprintImportConfirmation) => void;
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
  const transaction = useNativeBlueprintImportCommandTransaction({
    authority: props.observation,
    membershipSource: props.membership,
    authorityOwnedRef,
    commandInFlightRef,
    commandSourceRef,
    setCommandPending,
    rejectPlayerStateEdit: () => false,
    refreshAuthority: vi.fn(async () => undefined),
    setNotice,
    onConfirmed: props.onConfirmed,
    wait: props.wait,
  });
  return <>
    <output data-phase={transaction.pending?.phase ?? "none"} data-command-pending={commandPending}>
      {notice}
    </output>
    <button type="button" onClick={() => transaction.commit(context())}>导入</button>
  </>;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 24; index += 1) await Promise.resolve();
  });
}

describe("useNativeBlueprintImportCommandTransaction", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("dispatches the Rust prepared marker once and confirms exact library membership", async () => {
    const applyCommand = vi.fn(async (_command: SimulationCommandPatch) => receipt());
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1", runId: "run-1", baseRevision: 10,
      applyCommand, reconcileCommand: vi.fn(),
    };
    const confirmed = vi.fn();
    const render = (revision: number, membership: NativeBlueprintWorkspaceSource) => act(() => root.render(
      <Harness source={source} observation={authority(revision)} membership={membership}
        onConfirmed={confirmed} wait={async () => undefined} />,
    ));

    render(10, membershipSource(10));
    act(() => host.querySelector("button")!.click());
    await flush();
    expect(applyCommand).toHaveBeenCalledTimes(1);
    const command = applyCommand.mock.calls[0]![0];
    expect(command.topLevelChanges).toEqual([{
      path: ["blueprints", "intent"],
      operation: "set",
      value: context().preparedIntent,
    }]);
    expect(JSON.stringify(command)).not.toContain("交换原文");
    expect(host.querySelector("output")?.dataset.phase).toBe("awaiting-projection");

    const membershipReader = vi.fn(async (blueprintId: string) => ({
      sessionId: "session-1", runId: "run-1", revision: 11,
      registryFingerprint: "registry-a", blueprintId, present: true,
    }));
    render(11, membershipSource(11, membershipReader));
    await flush();
    expect(membershipReader).toHaveBeenCalledOnce();
    expect(membershipReader).toHaveBeenCalledWith("blueprint_41");
    expect(confirmed).toHaveBeenCalledOnce();
    expect(confirmed).toHaveBeenCalledWith({
      sessionId: "session-1",
      runId: "run-1",
      registryFingerprint: "registry-a",
      previousRevision: 10,
      ackRevision: 11,
      blueprintId: "blueprint_41",
      blueprintName: "蓝图 09",
      blueprintRevision: 1,
    });
    expect(host.querySelector("output")?.dataset.phase).toBe("none");
  });

  it("never resends an unknown transport result and performs exactly six read-only receipts", async () => {
    const applyCommand = vi.fn(async () => { throw new Error("lost response"); });
    const reconcileCommand = vi.fn(async () => ({
      status: "pending" as const, baseRevision: 10, currentRevision: 10,
    }));
    const waits: number[] = [];
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1", runId: "run-1", baseRevision: 10,
      applyCommand, reconcileCommand,
    };
    act(() => root.render(<Harness source={source} observation={authority()}
      membership={membershipSource(10)} onConfirmed={vi.fn()}
      wait={async (milliseconds) => { waits.push(milliseconds); }} />));
    act(() => host.querySelector("button")!.click());
    await flush();

    expect(applyCommand).toHaveBeenCalledOnce();
    expect(reconcileCommand).toHaveBeenCalledTimes(6);
    expect(waits).toEqual([100, 250, 500, 1_000, 2_000]);
    expect(host.querySelector("output")?.dataset.phase).toBe("blocked");
    expect(host.querySelector("output")?.dataset.commandPending).toBe("true");
  });

  it("unlocks a proven pre-dispatch failure and ignores a later second click until explicit retry", async () => {
    const applyCommand = vi.fn(async () => {
      throw new NativePlayerAuthorityCommandSourceError(
        "not sent", "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE", null,
      );
    });
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1", runId: "run-1", baseRevision: 10,
      applyCommand, reconcileCommand: vi.fn(),
    };
    act(() => root.render(<Harness source={source} observation={authority()}
      membership={membershipSource(10)} onConfirmed={vi.fn()} />));
    act(() => host.querySelector("button")!.click());
    await flush();
    expect(host.querySelector("output")?.dataset.phase).toBe("none");
    expect(host.querySelector("output")?.dataset.commandPending).toBe("false");
    expect(source.reconcileCommand).not.toHaveBeenCalled();
    expect(applyCommand).toHaveBeenCalledOnce();
  });

  it("retires an in-flight command on Worker lineage restart and ignores its late receipt", async () => {
    let resolve!: (value: ReturnType<typeof receipt>) => void;
    const applyCommand = vi.fn(() => new Promise<ReturnType<typeof receipt>>((done) => { resolve = done; }));
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1", runId: "run-1", baseRevision: 10,
      applyCommand, reconcileCommand: vi.fn(),
    };
    const confirmed = vi.fn();
    const render = (observation: NativeBlueprintImportAuthorityObservation) => act(() => root.render(
      <Harness source={source} observation={observation} membership={membershipSource(observation.revision)}
        onConfirmed={confirmed} />,
    ));
    render(authority());
    act(() => host.querySelector("button")!.click());
    await flush();
    expect(host.querySelector("output")?.dataset.phase).toBe("dispatching");
    render(authority(0, "session-2", "run-2"));
    await flush();
    expect(host.querySelector("output")?.dataset.phase).toBe("none");
    await act(async () => resolve(receipt()));
    await flush();
    expect(confirmed).not.toHaveBeenCalled();
    expect(applyCommand).toHaveBeenCalledOnce();
  });

  it("bounds missing post-ACK membership to six reads and keeps writes locked", async () => {
    const source: NativePlayerAuthorityCommandSource = {
      sessionId: "session-1", runId: "run-1", baseRevision: 10,
      applyCommand: vi.fn(async () => receipt()), reconcileCommand: vi.fn(),
    };
    const reader = vi.fn(async () => null);
    const render = (revision: number, membership: NativeBlueprintWorkspaceSource) => act(() => root.render(
      <Harness source={source} observation={authority(revision)} membership={membership}
        onConfirmed={vi.fn()} wait={async () => undefined} />,
    ));
    render(10, membershipSource(10));
    act(() => host.querySelector("button")!.click());
    await flush();
    render(11, membershipSource(11, reader));
    for (let index = 0; index < 5; index += 1) await flush();
    expect(reader).toHaveBeenCalledTimes(6);
    expect(source.applyCommand).toHaveBeenCalledOnce();
    expect(host.querySelector("output")?.dataset.phase).toBe("blocked");
    expect(host.querySelector("output")?.dataset.commandPending).toBe("true");
  });
});
