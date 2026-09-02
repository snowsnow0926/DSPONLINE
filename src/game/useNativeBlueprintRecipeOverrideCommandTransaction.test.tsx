// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopBridge,
  DesktopNativePlayerAuthorityClockState,
} from "../desktop";
import type {
  NativeBlueprintRecipeOverrideAuthorityObservation,
} from "./nativeBlueprintRecipeOverrideCommandReconciliation";
import {
  createNativePlayerAuthorityCommandSource,
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintRecipeOverrideBinding,
  NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";
import { useNativeBlueprintRecipeOverrideCommandTransaction } from "./useNativeBlueprintRecipeOverrideCommandTransaction";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_RECIPE_ID = "recipe:iron-ingot";
const TARGET_RECIPE_ID = "recipe:steel";
const OTHER_SOURCE_RECIPE_ID = "recipe:copper-ingot";
const OTHER_TARGET_RECIPE_ID = "recipe:copper-wire";

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
  currentTargetRecipeId = SOURCE_RECIPE_ID,
  sessionId = "session-1",
  runId = "run-1",
): NativeBlueprintRecipeOverrideBinding {
  return {
    sessionId,
    runId,
    revision,
    registryFingerprint: "registry-a",
    blueprintId: "mod:opaque/rocket",
    currentRowRevision: rowRevision,
    sourceRecipeId: SOURCE_RECIPE_ID,
    currentTargetRecipeId,
  };
}

function frame(value: NativeBlueprintRecipeOverrideBinding): NativeBlueprintWorkspaceFrame {
  const row = {
    id: value.blueprintId,
    name: "多配方蓝图",
    revision: value.currentRowRevision,
    rotation: 90 as const,
    mirror: "horizontal" as const,
    counts: { entities: 2, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    detailStatus: "candidate" as const,
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
    detail: {
      summary: row,
      status: "supported",
      unsupportedReason: null,
      entities: [{
        key: "entity-a",
        buildingId: "assembler",
        buildingLabel: "制造台",
        offset: { x: 0, y: 0 },
        machineCount: 1,
        recipeId: SOURCE_RECIPE_ID,
        operationEnabledOnDeploy: true,
      }, {
        key: "entity-b",
        buildingId: "assembler",
        buildingLabel: "制造台",
        offset: { x: 1, y: 0 },
        machineCount: 1,
        recipeId: OTHER_SOURCE_RECIPE_ID,
        operationEnabledOnDeploy: true,
      }],
      belts: [],
      resourceAnchors: [],
      externalPorts: [],
      recipeOverrideGroups: [{
        sourceRecipeId: SOURCE_RECIPE_ID,
        targetRecipeId: value.currentTargetRecipeId,
        options: [
          { id: SOURCE_RECIPE_ID, name: "铁块" },
          { id: TARGET_RECIPE_ID, name: "钢材" },
        ],
      }, {
        sourceRecipeId: OTHER_SOURCE_RECIPE_ID,
        targetRecipeId: OTHER_SOURCE_RECIPE_ID,
        options: [
          { id: OTHER_SOURCE_RECIPE_ID, name: "铜块" },
          { id: OTHER_TARGET_RECIPE_ID, name: "铜线" },
        ],
      }],
    },
    queue: [],
    queuePage: { cursor: 0, totalCount: 0, nextCursor: null },
  };
}

function authority(
  value: NativeBlueprintRecipeOverrideBinding,
): NativeBlueprintRecipeOverrideAuthorityObservation {
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
  readonly current: NativeBlueprintRecipeOverrideBinding;
  readonly observation: NativeBlueprintRecipeOverrideAuthorityObservation;
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
  const transaction = useNativeBlueprintRecipeOverrideCommandTransaction({
    authority: props.observation,
    frame: frame(props.current),
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
      onClick={() => transaction.commit(props.current, TARGET_RECIPE_ID)}
    >覆盖配方</button>
  </>;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

describe("useNativeBlueprintRecipeOverrideCommandTransaction", () => {
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

  it("dispatches once, reconciles read-only, and confirms source A from a multi-group frame", async () => {
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
    const render = (value: NativeBlueprintRecipeOverrideBinding) => act(() => root.render(<Harness
      source={source}
      current={value}
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

    render(binding(12, 5, TARGET_RECIPE_ID));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("false");
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it("unlocks a proven non-commit but keeps uncertainty locked without resending", async () => {
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
      current={binding()}
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
      current={binding()}
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

  it("retires an old blocked transaction only when session/run changes", async () => {
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
    const render = (value: NativeBlueprintRecipeOverrideBinding) => act(() => root.render(<Harness
      source={source}
      current={value}
      observation={authority(value)}
      refresh={vi.fn(async () => undefined)}
      wait={vi.fn(async () => undefined)}
    />));
    render(binding());
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("blocked");

    render(binding(0, 4, SOURCE_RECIPE_ID, "session-2", "run-2"));
    await flushAsyncWork();
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-phase"))
      .toBe("none");
    expect(host.querySelector("[data-testid='transaction']")?.getAttribute("data-command-pending"))
      .toBe("false");
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
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
      current={binding()}
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

  it("fails closed before pending or apply at the safe revision limit", async () => {
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
      current={exhaustedBinding}
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
