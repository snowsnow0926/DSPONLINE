// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopBridge,
  DesktopNativeCoreCommandResult,
  DesktopNativePlayerAuthorityClockState,
} from "../desktop";
import { NativeFactoryInspectorPanel } from "../components/NativeFactoryInspectorPanel";
import type {
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  SelectedEntityReadModel,
} from "./factoryReadModels";
import type { NativeProjectedEntityConfigurationBinding } from "./nativeProjectedEntityConfigurationCommands";
import type { NativeEntityRecipeAuthorityObservation } from "./nativeEntityRecipeCommandReconciliation";
import type { NativeProjectedEntityRecipeBinding } from "./nativeProjectedEntityRecipeCommands";
import {
  createNativePlayerAuthorityCommandSource,
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type { FactoryEntity, RecipeId } from "./types";
import { useNativeEntityRecipeCommandTransaction } from "./useNativeEntityRecipeCommandTransaction";

function frame(
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
    acknowledgedSequence: revision + 20,
    nextSequence: revision + 21,
    nextDeadlineMs: 50_000,
    inFlight: false,
    currentOperation: null,
    queuedCommands: 0,
    lastErrorCode: null,
  };
}

function projectedEntity(recipeId: RecipeId = "iron_ingot"): FactoryEntity {
  return {
    id: "smelter-a",
    planetId: "home",
    kind: "machine",
    position: { x: 1, y: 2 },
    interactionLocked: false,
    buildingId: "arc_smelter",
    recipeId,
    powerPriority: 2,
    routingCursor: 0,
    machineCount: 1,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    utilization: 0,
    productionRate: 0,
  };
}

function recipeBinding(
  revision = 10,
  recipeId: RecipeId = "iron_ingot",
  sessionId = "session-1",
  runId = "run-1",
): NativeProjectedEntityRecipeBinding {
  return {
    sessionId,
    runId,
    revision,
    registryFingerprint: "7df8cf3a",
    activePlanetId: "home",
    entity: projectedEntity(recipeId),
  };
}

function authority(
  revision = 10,
  sessionId = "session-1",
  runId = "run-1",
): NativeEntityRecipeAuthorityObservation {
  return { sessionId, runId, revision };
}

function selectedEntity(entity: FactoryEntity): SelectedEntityReadModel {
  return {
    entityId: entity.id,
    planetId: entity.planetId,
    kind: entity.kind,
    position: entity.position,
    interactionLocked: entity.interactionLocked,
    buildingId: entity.buildingId ?? null,
    resourceId: entity.resourceId ?? null,
    recipeId: entity.recipeId ?? null,
    storedItemId: entity.storedItemId ?? null,
    fuelItemId: entity.fuelItemId ?? null,
    machineCount: entity.machineCount,
    minerCount: entity.minerCount,
    progress: entity.progress,
    utilization: entity.utilization,
    productionRate: entity.productionRate,
    powerFactor: entity.powerFactor ?? null,
    inputItems: { rows: [], totalCount: 0, truncated: false },
    outputItems: { rows: [], totalCount: 0, truncated: false },
    stationConfiguration: null,
  };
}

function inspector(binding: NativeProjectedEntityRecipeBinding): FactoryInspectorSummaryReadModel {
  return {
    schema: "factory-read-model-v1",
    source: "native-core",
    revision: binding.revision,
    activePlanetId: binding.activePlanetId,
    entity: selectedEntity(binding.entity),
    belt: null,
  };
}

function multi(binding: NativeProjectedEntityRecipeBinding): FactoryMultiSelectionSummaryReadModel {
  const entity = selectedEntity(binding.entity);
  return {
    schema: "factory-read-model-v1",
    source: "native-core",
    revision: binding.revision,
    activePlanetId: binding.activePlanetId,
    projectionIdentity: {
      sessionId: binding.sessionId,
      runId: binding.runId,
      revision: binding.revision,
      planetId: binding.activePlanetId,
    },
    requestedEntityCount: 1,
    requestedBeltCount: 0,
    entityRows: { rows: [entity], totalCount: 1, truncated: false },
    beltRows: { rows: [], totalCount: 0, truncated: false },
  };
}

function configuration(
  binding: NativeProjectedEntityRecipeBinding,
): NativeProjectedEntityConfigurationBinding {
  return {
    sessionId: binding.sessionId,
    runId: binding.runId,
    revision: binding.revision,
    activePlanetId: binding.activePlanetId,
    entity: binding.entity,
  };
}

function committedReceipt(): DesktopNativeCoreCommandResult {
  return {
    previousRevision: 10,
    revision: 11,
    changedEntityIds: ["smelter-a"],
    changedBeltIds: [],
    topologyDirty: true,
  };
}

type ReconciliationOutcome =
  | { status: "pending" | "not-committed" | "conflict"; baseRevision: number; currentRevision: number }
  | { status: "committed"; receipt: ReturnType<typeof committedReceipt> };

function lostResponseSource(outcomes: ReconciliationOutcome[]) {
  const active = frame();
  const bridge = {
    getNativePlayerAuthorityState: vi.fn(async () => active),
    applyNativeCoreCommand: vi.fn(async () => {
      throw new Error("renderer response lost after dispatch");
    }),
    reconcileNativeCoreCommand: vi.fn(async () => outcomes.shift() ?? {
      status: "pending" as const,
      baseRevision: 10,
      currentRevision: 10,
    }),
  } satisfies Pick<
    DesktopBridge,
    "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand"
  >;
  return {
    bridge,
    source: createNativePlayerAuthorityCommandSource(bridge, active)!,
  };
}

interface HarnessProps {
  readonly source: NativePlayerAuthorityCommandSource;
  readonly authority: NativeEntityRecipeAuthorityObservation | null;
  readonly projection: NativeProjectedEntityRecipeBinding;
  readonly refresh: () => Promise<void>;
  readonly invalidate: () => void;
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
  const transaction = useNativeEntityRecipeCommandTransaction({
    authority: props.authority,
    projection: props.projection,
    authorityOwnedRef,
    commandInFlightRef,
    commandSourceRef,
    setCommandPending,
    rejectPlayerStateEdit: () => false,
    invalidateProjection: props.invalidate,
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
    <NativeFactoryInspectorPanel
      inspector={inspector(props.projection)}
      multiSelection={multi(props.projection)}
      entityConfiguration={configuration(props.projection)}
      entityRecipeBinding={props.projection}
      pending={commandPending || transaction.pending !== null}
      onEntityLockChange={vi.fn()}
      onRemoveEntity={vi.fn()}
      onStackCountChange={vi.fn()}
      onEntityPowerPriorityChange={vi.fn()}
      onSplitterDistributionModeChange={vi.fn()}
      onEnergyExchangerModeChange={vi.fn()}
      onFuelItemChange={vi.fn()}
      onEntityRecipeChange={(_entityId, targetRecipeId) => {
        transaction.commit(props.projection, targetRecipeId);
      }}
      onBlackHolePausedChange={vi.fn()}
      onBeltLaneCountChange={vi.fn()}
      onBeltPriorityChange={vi.fn()}
      onRemoveBelt={vi.fn()}
    />
  </>;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

function chooseCopperRecipe(host: HTMLElement): void {
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')!;
  act(() => {
    select.value = "copper_ingot";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
    .find((button) => button.textContent === "确认更换配方")!;
  act(() => confirm.click());
}

describe("useNativeEntityRecipeCommandTransaction", () => {
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

  it("dispatches once, reconciles a lost response read-only, and unlocks only at the exact target projection", async () => {
    const { bridge, source } = lostResponseSource([
      { status: "pending", baseRevision: 10, currentRevision: 10 },
      { status: "committed", receipt: committedReceipt() },
    ]);
    const refresh = vi.fn(async () => { throw new Error("reconciled refresh offline"); });
    const invalidate = vi.fn();
    const wait = vi.fn(async () => undefined);
    const render = (
      currentAuthority: NativeEntityRecipeAuthorityObservation,
      projection: NativeProjectedEntityRecipeBinding,
    ) => act(() => root.render(<Harness
      source={source}
      authority={currentAuthority}
      projection={projection}
      refresh={refresh}
      invalidate={invalidate}
      wait={wait}
    />));

    render(authority(), recipeBinding());
    chooseCopperRecipe(host);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.disabled)
      .toBe(true);
    await flushAsyncWork();

    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(bridge.reconcileNativeCoreCommand).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("awaiting-projection");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.value)
      .toBe("iron_ingot");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.disabled)
      .toBe(true);

    // The authority may tick beyond the exact receipt before its bounded UI
    // pages arrive. revision 12 is valid because it contains the exact target.
    render(authority(12), recipeBinding(12, "copper_ingot"));
    await flushAsyncWork();
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("none");
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-command-pending"))
      .toBe("false");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.disabled)
      .toBe(false);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.value)
      .toBe("copper_ingot");
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it("unlocks a proven non-commit but keeps a conflict locked without resending", async () => {
    const refresh = vi.fn(async () => undefined);
    const wait = vi.fn(async () => undefined);

    const absent = lostResponseSource([{
      status: "not-committed",
      baseRevision: 10,
      currentRevision: 10,
    }]);
    act(() => root.render(<Harness
      source={absent.source}
      authority={authority()}
      projection={recipeBinding()}
      refresh={refresh}
      invalidate={vi.fn()}
      wait={wait}
    />));
    chooseCopperRecipe(host);
    await flushAsyncWork();
    expect(absent.bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(absent.bridge.reconcileNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("none");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.disabled)
      .toBe(false);

    const conflict = lostResponseSource([{
      status: "conflict",
      baseRevision: 10,
      currentRevision: 12,
    }]);
    act(() => root.render(<Harness
      source={conflict.source}
      authority={authority()}
      projection={recipeBinding()}
      refresh={refresh}
      invalidate={vi.fn()}
      wait={wait}
    />));
    chooseCopperRecipe(host);
    await flushAsyncWork();
    expect(conflict.bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(conflict.bridge.reconcileNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("blocked");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.disabled)
      .toBe(true);

    // Even a later matching projection cannot erase an already proven
    // conflict in the same lineage.
    act(() => root.render(<Harness
      source={conflict.source}
      authority={authority(12)}
      projection={recipeBinding(12, "copper_ingot")}
      refresh={refresh}
      invalidate={vi.fn()}
      wait={wait}
    />));
    await flushAsyncWork();
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("blocked");
    expect(conflict.bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it("ends an old dispatch on explicit session/run handoff and ignores its late rejection", async () => {
    let rejectApply!: (reason: unknown) => void;
    const apply = new Promise<never>((_resolve, reject) => { rejectApply = reject; });
    const initial = frame();
    const bridge = {
      getNativePlayerAuthorityState: vi.fn(async () => initial),
      applyNativeCoreCommand: vi.fn(() => apply),
      reconcileNativeCoreCommand: vi.fn(),
    } satisfies Pick<
      DesktopBridge,
      "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand"
    >;
    const oldSource = createNativePlayerAuthorityCommandSource(bridge, initial)!;
    const refresh = vi.fn(async () => undefined);
    const wait = vi.fn(async () => undefined);

    act(() => root.render(<Harness
      source={oldSource}
      authority={authority()}
      projection={recipeBinding()}
      refresh={refresh}
      invalidate={vi.fn()}
      wait={wait}
    />));
    chooseCopperRecipe(host);
    await flushAsyncWork();
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("dispatching");

    act(() => root.render(<Harness
      source={oldSource}
      authority={authority(0, "session-2", "run-2")}
      projection={recipeBinding(0, "iron_ingot", "session-2", "run-2")}
      refresh={refresh}
      invalidate={vi.fn()}
      wait={wait}
    />));
    await flushAsyncWork();
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("none");
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-command-pending"))
      .toBe("false");

    rejectApply(new Error("late old-session response"));
    await flushAsyncWork();
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(bridge.reconcileNativeCoreCommand).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("none");
  });

  it("does not misclassify a rejected post-commit refresh as a mutation failure", async () => {
    const initial = frame();
    const bridge = {
      getNativePlayerAuthorityState: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(frame(11)),
      applyNativeCoreCommand: vi.fn(async () => committedReceipt()),
      reconcileNativeCoreCommand: vi.fn(),
    } satisfies Pick<
      DesktopBridge,
      "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand"
    >;
    const source = createNativePlayerAuthorityCommandSource(bridge, initial)!;
    const refresh = vi.fn(async () => { throw new Error("clock refresh offline"); });

    act(() => root.render(<Harness
      source={source}
      authority={authority()}
      projection={recipeBinding()}
      refresh={refresh}
      invalidate={vi.fn()}
      wait={vi.fn(async () => undefined)}
    />));
    chooseCopperRecipe(host);
    await flushAsyncWork();
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(bridge.reconcileNativeCoreCommand).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("awaiting-projection");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.disabled)
      .toBe(true);

    act(() => root.render(<Harness
      source={source}
      authority={authority(12)}
      projection={recipeBinding(12, "copper_ingot")}
      refresh={refresh}
      invalidate={vi.fn()}
    />));
    await flushAsyncWork();
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("none");
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it("uses the real source null command ID only for a bridge-proven pre-dispatch failure", async () => {
    const initial = frame();
    const bridge = {
      getNativePlayerAuthorityState: vi.fn(async () => { throw new Error("preflight clock lost"); }),
      applyNativeCoreCommand: vi.fn(async () => committedReceipt()),
      reconcileNativeCoreCommand: vi.fn(),
    } satisfies Pick<
      DesktopBridge,
      "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand"
    >;
    const source = createNativePlayerAuthorityCommandSource(bridge, initial)!;

    act(() => root.render(<Harness
      source={source}
      authority={authority()}
      projection={recipeBinding()}
      refresh={vi.fn(async () => undefined)}
      invalidate={vi.fn()}
    />));
    chooseCopperRecipe(host);
    await flushAsyncWork();
    expect(bridge.getNativePlayerAuthorityState).toHaveBeenCalledTimes(1);
    expect(bridge.applyNativeCoreCommand).not.toHaveBeenCalled();
    expect(bridge.reconcileNativeCoreCommand).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("none");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.disabled)
      .toBe(false);
  });

  it("catches synchronous source failures and unlocks only a proven pre-dispatch failure", async () => {
    const refresh = vi.fn(async () => undefined);
    const wait = vi.fn(async () => undefined);
    const base = lostResponseSource([]).source;
    const provenApply = vi.fn((): Promise<never> => {
      throw new NativePlayerAuthorityCommandSourceError(
        "preflight unavailable",
        "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
        null,
      );
    });
    const provenReconcile = vi.fn(base.reconcileCommand);
    const provenSource: NativePlayerAuthorityCommandSource = Object.freeze({
      sessionId: base.sessionId,
      runId: base.runId,
      baseRevision: base.baseRevision,
      applyCommand: provenApply,
      reconcileCommand: provenReconcile,
    });

    act(() => root.render(<Harness
      source={provenSource}
      authority={authority()}
      projection={recipeBinding()}
      refresh={refresh}
      invalidate={vi.fn()}
      wait={wait}
    />));
    chooseCopperRecipe(host);
    await flushAsyncWork();
    expect(provenApply).toHaveBeenCalledTimes(1);
    expect(provenReconcile).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("none");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.disabled)
      .toBe(false);

    const unknownApply = vi.fn((): Promise<never> => {
      throw new Error("unknown synchronous source failure");
    });
    const unknownReconcile = vi.fn(async () => ({
      status: "conflict" as const,
      baseRevision: 10,
      currentRevision: 12,
    }));
    const unknownSource: NativePlayerAuthorityCommandSource = Object.freeze({
      sessionId: base.sessionId,
      runId: base.runId,
      baseRevision: base.baseRevision,
      applyCommand: unknownApply,
      reconcileCommand: unknownReconcile,
    });

    act(() => root.render(<Harness
      source={unknownSource}
      authority={authority()}
      projection={recipeBinding()}
      refresh={refresh}
      invalidate={vi.fn()}
      wait={wait}
    />));
    chooseCopperRecipe(host);
    await flushAsyncWork();
    expect(unknownApply).toHaveBeenCalledTimes(1);
    expect(unknownReconcile).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="transaction"]')?.getAttribute("data-phase"))
      .toBe("blocked");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Windows 原生生产配方"]')?.disabled)
      .toBe(true);
  });
});
