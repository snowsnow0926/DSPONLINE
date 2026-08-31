// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopNativeCoreBlueprintDetail,
  DesktopNativeCoreBlueprintQueueRow,
  DesktopNativeCoreBlueprintSummary,
} from "../desktop";
import type {
  NativeBlueprintDeleteBinding,
  NativeBlueprintEnqueueSelectionBinding,
  NativeBlueprintMirror,
  NativeBlueprintRecipeOverrideBinding,
  NativeBlueprintRenameIdentity,
  NativeBlueprintRotation,
  NativeBlueprintTransformBinding,
  NativeBlueprintWorkspaceFrame,
  NativeBlueprintWorkspaceIdentity,
  NativeConstructionQueueCancelBinding,
  NativeConstructionQueueDeployBinding,
  NativeConstructionQueueFundBinding,
  NativeConstructionQueueFundScope,
} from "../game/nativeBlueprintWorkspaceStore";
import type { NativeBlueprintTransformPendingCommand } from "../game/nativeBlueprintTransformCommandReconciliation";
import type { NativeBlueprintRecipeOverridePendingCommand } from "../game/nativeBlueprintRecipeOverrideCommandReconciliation";
import type { NativeBlueprintDeletePendingCommand } from "../game/nativeBlueprintDeleteCommandReconciliation";
import type { NativeConstructionQueueCancelPendingCommand } from "../game/nativeConstructionQueueCancelCommandReconciliation";
import type { NativeConstructionQueueFundPendingCommand } from "../game/nativeConstructionQueueFundCommandReconciliation";
import type { NativeConstructionQueueDeployPendingCommand } from "../game/nativeConstructionQueueDeployCommandReconciliation";
import type { NativeBlueprintEnqueuePendingCommand } from "../game/nativeBlueprintEnqueueCommandReconciliation";
import type {
  NativeBlueprintRenamePendingIdentity,
  NativeBlueprintRenameResolution,
  NativeBlueprintRenameSubmitOutcome,
} from "../game/nativeBlueprintRenameWorkflow";
import { NativeBlueprintWorkspace } from "./NativeBlueprintWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summaries: readonly DesktopNativeCoreBlueprintSummary[] = Object.freeze([
  { id: "mod:\u03a9/\ud83d\ude80", name: "\u6a21\u7ec4\u84dd\u56fe \u03a9", revision: 4, rotation: 90, mirror: "horizontal", counts: { entities: 2, belts: 1, resourceAnchors: 1, externalPorts: 1 }, detailStatus: "candidate" },
  { id: "builtin-second", name: "\u5185\u5efa\u84dd\u56fe B", revision: 2, rotation: 0, mirror: "none", counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 }, detailStatus: "candidate" },
]);

const queue: readonly DesktopNativeCoreBlueprintQueueRow[] = Object.freeze([
  { id: "queue-z", blueprintId: "builtin-second", blueprintVersionId: "version-z", blueprintRevision: 2, blueprintName: "\u540e\u5199\u5165\u4f46\u5148\u5b58\u50a8", planetId: "planet-z", planetName: "Z \u661f", position: { x: 8, y: 9 }, rotation: 270, mirror: "horizontal", queuedAt: 200, status: "pending-materials", counts: summaries[1].counts, semanticStatus: "catalog-backed", reservedConstructionTotal: 12, reservedFleetTotal: 0, placedEntityCount: 0, actionable: true },
  { id: "queue-a", blueprintId: "mod:\u03a9/\ud83d\ude80", blueprintVersionId: null, blueprintRevision: 4, blueprintName: "\u5148\u5199\u5165\u4f46\u540e\u5b58\u50a8", planetId: "planet-a", planetName: null, position: { x: 1, y: 2 }, rotation: 0, mirror: "none", queuedAt: 100, status: "pending-materials", counts: null, semanticStatus: "unsupported", reservedConstructionTotal: 0, reservedFleetTotal: 0, placedEntityCount: 0, actionable: false },
]);

function detail(status: DesktopNativeCoreBlueprintDetail["status"] = "supported"): DesktopNativeCoreBlueprintDetail {
  const summary = status === "truncated"
    ? { ...summaries[0], counts: { entities: 513, belts: 1, resourceAnchors: 1, externalPorts: 1 }, detailStatus: "truncated" as const }
    : summaries[0];
  return {
    summary,
    status,
    unsupportedReason: status === "supported" ? null : status === "truncated" ? "detail-limits-exceeded" : "unproven-catalog-semantics",
    entities: status === "supported" ? [
      { key: "entity-z", buildingId: "mod:assembler", buildingLabel: "\u6a21\u7ec4\u7ec4\u88c5\u673a", offset: { x: 1, y: 2 }, machineCount: 3, recipeId: "mod:recipe", operationEnabledOnDeploy: null },
      { key: "entity-a", buildingId: "assembler", buildingLabel: "\u7ec4\u88c5\u673a", offset: { x: 3, y: 4 }, machineCount: 1, recipeId: null, operationEnabledOnDeploy: null },
    ] : [],
    belts: status === "supported" ? [{ key: "belt-z", sourceKey: "entity-z", targetKey: "entity-a", itemId: "mod:item", lanes: 2, tier: 3 }] : [],
    resourceAnchors: status === "supported" ? [{ key: "anchor-z", resourceId: "mod:ore", extractorBuildingId: "mod:miner", offset: { x: 5, y: 6 }, minerCount: 2 }] : [],
    externalPorts: status === "supported" ? [{ key: "port-z", entityKey: "entity-a", direction: "output", itemId: "mod:item", offset: { x: 7, y: 8 } }] : [],
    recipeOverrideGroups: status === "supported" ? [{
      sourceRecipeId: "mod:recipe",
      targetRecipeId: "mod:recipe",
      options: [
        { id: "mod:recipe", name: "模组配方" },
        { id: "mod:recipe-fast", name: "高速模组配方" },
      ],
    }] : [],
  };
}

function frame(options: {
  selected?: boolean;
  sessionId?: string;
  runId?: string;
  revision?: number;
  registryFingerprint?: string;
  detailStatus?: DesktopNativeCoreBlueprintDetail["status"];
  library?: readonly DesktopNativeCoreBlueprintSummary[];
  queue?: readonly DesktopNativeCoreBlueprintQueueRow[];
  libraryPage?: { cursor: number; totalCount: number; nextCursor: number | null };
  queuePage?: { cursor: number; totalCount: number; nextCursor: number | null };
} = {}): NativeBlueprintWorkspaceFrame {
  const selected = options.selected ?? true;
  const projectedDetail = selected ? detail(options.detailStatus) : null;
  const library = options.library ?? (projectedDetail?.status === "truncated"
    ? Object.freeze([projectedDetail.summary, summaries[1]])
    : summaries);
  const queueRows = options.queue ?? queue;
  return {
    source: "native-core",
    readOnly: true,
    sessionId: options.sessionId ?? "session-a",
    runId: options.runId ?? "run-a",
    revision: options.revision ?? 47,
    registryFingerprint: options.registryFingerprint ?? "registry-a",
    selectedBlueprintId: selected ? library[0].id : null,
    library,
    libraryById: new Map(library.map((row) => [row.id, row])),
    libraryPage: options.libraryPage ?? { cursor: 0, totalCount: library.length, nextCursor: null },
    detail: projectedDetail,
    queue: queueRows,
    queuePage: options.queuePage ?? { cursor: 0, totalCount: queueRows.length, nextCursor: null },
  };
}

const renameIdentity: NativeBlueprintRenameIdentity = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  registryFingerprint: "registry-a",
  blueprintId: "mod:Ω/🚀",
  currentName: "模组蓝图 Ω",
  currentRevision: 4,
});

function pendingRename(
  phase: NativeBlueprintRenamePendingIdentity["phase"],
  options: Partial<NativeBlueprintRenamePendingIdentity> = {},
): NativeBlueprintRenamePendingIdentity {
  return Object.freeze({
    ...renameIdentity,
    submissionId: 9,
    commandRevision: 47,
    targetName: "新模组名🚀",
    phase,
    expectedRevision: phase === "awaiting-projection" ? 48 : null,
    conflictReason: phase === "conflict" ? "projection-mismatch" : null,
    ...options,
  });
}

function renameResolution(
  status: NativeBlueprintRenameResolution["status"],
  options: Partial<NativeBlueprintRenameResolution> = {},
): NativeBlueprintRenameResolution {
  return Object.freeze({
    ...renameIdentity,
    status,
    submissionId: 9,
    commandRevision: 47,
    targetName: "新模组名🚀",
    expectedRevision: status === "confirmed" ? 48 : null,
    ...options,
  });
}

function replaceInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("NativeBlueprintWorkspace", () => {
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

  function renderWorkspace(
    value: NativeBlueprintWorkspaceFrame | null,
    status: "empty" | "loading" | "ready" | "unavailable" = "ready",
    callbacks: {
      onSelectBlueprint?: (blueprintId: string) => void;
      onLibraryCursorChange?: (cursor: number) => void;
      onQueueCursorChange?: (cursor: number) => void;
      onSubmitRenameIntent?: (
        identity: NativeBlueprintRenameIdentity,
        name: string,
      ) => NativeBlueprintRenameSubmitOutcome;
      onSubmitTransformIntent?: (
        binding: NativeBlueprintTransformBinding,
        rotation: NativeBlueprintRotation,
        mirror: NativeBlueprintMirror,
      ) => boolean;
      onSubmitRecipeOverrideIntent?: (
        binding: NativeBlueprintRecipeOverrideBinding,
        targetRecipeId: string,
      ) => boolean;
      onSubmitDeleteIntent?: (binding: NativeBlueprintDeleteBinding) => boolean;
      onSubmitQueueCancelIntent?: (binding: NativeConstructionQueueCancelBinding) => boolean;
      onSubmitQueueFundIntent?: (
        binding: NativeConstructionQueueFundBinding,
        scope: NativeConstructionQueueFundScope,
      ) => boolean;
      onSubmitQueueDeployIntent?: (binding: NativeConstructionQueueDeployBinding) => boolean;
      onBeginQueuePlacement?: (binding: NativeBlueprintEnqueueSelectionBinding) => boolean;
      pendingIdentity?: NativeBlueprintRenamePendingIdentity | null;
      transformPending?: NativeBlueprintTransformPendingCommand | null;
      recipeOverridePending?: NativeBlueprintRecipeOverridePendingCommand | null;
      deletePending?: NativeBlueprintDeletePendingCommand | null;
      queueCancelPending?: NativeConstructionQueueCancelPendingCommand | null;
      queueFundPending?: NativeConstructionQueueFundPendingCommand | null;
      queueDeployPending?: NativeConstructionQueueDeployPendingCommand | null;
      enqueuePending?: NativeBlueprintEnqueuePendingCommand | null;
      latestIdentity?: NativeBlueprintWorkspaceIdentity | null;
      resolution?: NativeBlueprintRenameResolution | null;
      onConsumeRenameResolution?: (submissionId: number) => void;
      commandPending?: boolean;
      open?: boolean;
    } = {},
  ) {
    const onSelectBlueprint = callbacks.onSelectBlueprint ?? vi.fn<(blueprintId: string) => void>();
    const onLibraryCursorChange = callbacks.onLibraryCursorChange ?? vi.fn<(cursor: number) => void>();
    const onQueueCursorChange = callbacks.onQueueCursorChange ?? vi.fn<(cursor: number) => void>();
    const onSubmitRenameIntent = callbacks.onSubmitRenameIntent ??
      vi.fn<(identity: NativeBlueprintRenameIdentity, name: string) => NativeBlueprintRenameSubmitOutcome>()
        .mockReturnValue(Object.freeze({
          status: "accepted",
          submissionId: 1,
          commandRevision: value?.revision ?? 47,
        }));
    const onSubmitTransformIntent = callbacks.onSubmitTransformIntent ??
      vi.fn<(binding: NativeBlueprintTransformBinding, rotation: NativeBlueprintRotation,
        mirror: NativeBlueprintMirror) => boolean>().mockReturnValue(true);
    const onSubmitRecipeOverrideIntent = callbacks.onSubmitRecipeOverrideIntent ??
      vi.fn<(binding: NativeBlueprintRecipeOverrideBinding, targetRecipeId: string) => boolean>()
        .mockReturnValue(true);
    const onSubmitDeleteIntent = callbacks.onSubmitDeleteIntent ??
      vi.fn<(binding: NativeBlueprintDeleteBinding) => boolean>().mockReturnValue(true);
    const onSubmitQueueCancelIntent = callbacks.onSubmitQueueCancelIntent ??
      vi.fn<(binding: NativeConstructionQueueCancelBinding) => boolean>().mockReturnValue(true);
    const onSubmitQueueFundIntent = callbacks.onSubmitQueueFundIntent ??
      vi.fn<(binding: NativeConstructionQueueFundBinding, scope: NativeConstructionQueueFundScope) => boolean>()
        .mockReturnValue(true);
    const onSubmitQueueDeployIntent = callbacks.onSubmitQueueDeployIntent ??
      vi.fn<(binding: NativeConstructionQueueDeployBinding) => boolean>().mockReturnValue(true);
    const onBeginQueuePlacement = callbacks.onBeginQueuePlacement ??
      vi.fn<(binding: NativeBlueprintEnqueueSelectionBinding) => boolean>().mockReturnValue(true);
    const onConsumeRenameResolution = callbacks.onConsumeRenameResolution ?? vi.fn<(submissionId: number) => void>();
    const latestIdentity = callbacks.latestIdentity === undefined && value
      ? {
        sessionId: value.sessionId,
        runId: value.runId,
        revision: value.revision,
        registryFingerprint: value.registryFingerprint,
      }
      : callbacks.latestIdentity ?? null;
    act(() => root.render(<NativeBlueprintWorkspace
      open={callbacks.open ?? true}
      status={status}
      frame={value}
      latestIdentity={latestIdentity}
      onClose={() => undefined}
      onSelectBlueprint={onSelectBlueprint}
      onLibraryCursorChange={onLibraryCursorChange}
      onQueueCursorChange={onQueueCursorChange}
      onSubmitRenameIntent={onSubmitRenameIntent}
      onSubmitTransformIntent={onSubmitTransformIntent}
      onSubmitRecipeOverrideIntent={onSubmitRecipeOverrideIntent}
      onSubmitDeleteIntent={onSubmitDeleteIntent}
      onSubmitQueueCancelIntent={onSubmitQueueCancelIntent}
      onSubmitQueueFundIntent={onSubmitQueueFundIntent}
      onSubmitQueueDeployIntent={onSubmitQueueDeployIntent}
      onBeginQueuePlacement={onBeginQueuePlacement}
      pendingIdentity={callbacks.pendingIdentity ?? null}
      transformPending={callbacks.transformPending ?? null}
      recipeOverridePending={callbacks.recipeOverridePending ?? null}
      deletePending={callbacks.deletePending ?? null}
      queueCancelPending={callbacks.queueCancelPending ?? null}
      queueFundPending={callbacks.queueFundPending ?? null}
      queueDeployPending={callbacks.queueDeployPending ?? null}
      enqueuePending={callbacks.enqueuePending ?? null}
      resolution={callbacks.resolution ?? null}
      onConsumeRenameResolution={onConsumeRenameResolution}
      commandPending={callbacks.commandPending ?? false}
    />));
    return {
      onSelectBlueprint,
      onLibraryCursorChange,
      onQueueCursorChange,
      onSubmitRenameIntent,
      onSubmitTransformIntent,
      onSubmitRecipeOverrideIntent,
      onSubmitDeleteIntent,
      onSubmitQueueCancelIntent,
      onSubmitQueueDeployIntent,
      onBeginQueuePlacement,
      onConsumeRenameResolution,
    };
  }

  it("renders current library and queue pages in persisted order and emits only read cursors or selection", () => {
    const library = Object.freeze([
      ...summaries,
      ...Array.from({ length: 30 }, (_, index) => ({ ...summaries[1], id: `page-row-${index}` })),
    ]);
    const callbacks = renderWorkspace(frame({
      selected: false,
      library,
      libraryPage: { cursor: 0, totalCount: 34, nextCursor: 32 },
      queuePage: { cursor: 32, totalCount: 34, nextCursor: null },
    }));
    expect([...host.querySelectorAll("[data-native-blueprint-library-id]")].map((node) => node.getAttribute("data-native-blueprint-library-id"))).toEqual(library.map((row) => row.id));
    expect(host.querySelector("[data-native-blueprint-page-range='library']")?.textContent).toContain("第 1–32 项 / 共 34 项");
    expect(host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='page-library-prev']")?.disabled).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='page-library-next']")!.click());
    expect(callbacks.onLibraryCursorChange).toHaveBeenCalledWith(32);
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-select='builtin-second']")!.click());
    expect(callbacks.onSelectBlueprint).toHaveBeenCalledWith("builtin-second");

    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='tab-queue']")!.click());
    expect([...host.querySelectorAll("[data-native-blueprint-queue-id]")].map((node) => node.getAttribute("data-native-blueprint-queue-id"))).toEqual(["queue-z", "queue-a"]);
    expect(host.querySelector("[data-native-blueprint-page-range='queue']")?.textContent).toContain("第 33–34 项 / 共 34 项");
    expect(host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='page-queue-next']")?.disabled).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='page-queue-prev']")!.click());
    expect(callbacks.onQueueCursorChange).toHaveBeenCalledWith(0);
    expect(host.textContent).toContain("Z \u661f");
    expect(host.textContent).toContain("\u8bed\u4e49\u672a\u8bc1\u660e");
    expect(host.textContent).toContain("\u4e0d\u4ee3\u8868\u53ef\u90e8\u7f72");
    const deploy = host.querySelector<HTMLButtonElement>("[data-native-blueprint-queue-deploy='queue-z']")!;
    expect(deploy.textContent).toContain("开始建造");
    expect(deploy.disabled).toBe(false);
    act(() => deploy.click());
    expect(callbacks.onSubmitQueueDeployIntent).toHaveBeenCalledWith({
      sessionId: "session-a",
      runId: "run-a",
      revision: 47,
      registryFingerprint: "registry-a",
      queueEntryId: "queue-z",
      queueTotalCount: 34,
      queuePageCursor: 32,
      blueprintRevision: 2,
      status: "pending-materials",
      semanticStatus: "catalog-backed",
      counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 },
      actionable: true,
    });
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-queue-cancel='queue-z']")!.click());
    expect(callbacks.onSubmitQueueCancelIntent).toHaveBeenCalledWith({
      sessionId: "session-a",
      runId: "run-a",
      revision: 47,
      registryFingerprint: "registry-a",
      queueEntryId: "queue-z",
      queueTotalCount: 34,
    });
  });

  it("does not render start-build unless the Rust queue row is explicitly actionable", () => {
    renderWorkspace(frame({
      queue: queue.map((row) => ({ ...row, actionable: false })),
    }));
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='tab-queue']")!.click());
    expect(host.querySelector("[data-native-blueprint-action='deploy-queue']")).toBeNull();
    expect(host.textContent).toContain("只有 Rust 明确证明可原子部署");
  });

  it("shows the selected supported detail with opaque ids and child order intact", () => {
    renderWorkspace(frame());
    expect(host.querySelector("[data-native-blueprint-detail-status='supported']")).not.toBeNull();
    expect([...host.querySelectorAll("[data-native-blueprint-entity-key]")].map((node) => node.getAttribute("data-native-blueprint-entity-key"))).toEqual(["entity-z", "entity-a"]);
    expect(host.textContent).toContain("\u6a21\u7ec4\u7ec4\u88c5\u673a");
    expect(host.textContent).toContain("mod:recipe");
    expect(host.querySelector("[data-native-blueprint-belt-key='belt-z']")).not.toBeNull();
    expect(host.querySelector("[data-native-blueprint-anchor-key='anchor-z']")).not.toBeNull();
    expect(host.querySelector("[data-native-blueprint-port-key='port-z']")).not.toBeNull();
  });

  it("submits one Rust-derived recipe target from the exact selected detail group and locks while pending", () => {
    const onSubmitRecipeOverrideIntent = vi.fn<(
      binding: NativeBlueprintRecipeOverrideBinding,
      targetRecipeId: string,
    ) => boolean>().mockReturnValue(true);
    const selected = frame();
    renderWorkspace(selected, "ready", { onSubmitRecipeOverrideIntent });
    const picker = host.querySelector<HTMLSelectElement>(
      "[data-native-blueprint-recipe-target='mod:recipe']",
    )!;
    expect([...picker.options].map((option) => option.value)).toEqual([
      "mod:recipe",
      "mod:recipe-fast",
    ]);
    act(() => {
      picker.value = "mod:recipe-fast";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSubmitRecipeOverrideIntent).toHaveBeenCalledOnce();
    expect(onSubmitRecipeOverrideIntent).toHaveBeenCalledWith({
      sessionId: "session-a",
      runId: "run-a",
      revision: 47,
      registryFingerprint: "registry-a",
      blueprintId: "mod:Ω/🚀",
      currentRowRevision: 4,
      sourceRecipeId: "mod:recipe",
      currentTargetRecipeId: "mod:recipe",
    }, "mod:recipe-fast");
    expect(picker.value).toBe("mod:recipe");

    const recipeOverridePending = Object.freeze({
      token: 1,
      sessionId: "session-a",
      runId: "run-a",
      revision: 47,
      registryFingerprint: "registry-a",
      blueprintId: "mod:Ω/🚀",
      currentRowRevision: 4,
      sourceRecipeId: "mod:recipe",
      currentTargetRecipeId: "mod:recipe",
      targetRecipeId: "mod:recipe-fast",
      phase: "reconciling",
      receipt: null,
      blockedReason: null,
      source: {},
      command: {},
    }) as unknown as NativeBlueprintRecipeOverridePendingCommand;
    renderWorkspace(selected, "ready", {
      onSubmitRecipeOverrideIntent,
      recipeOverridePending,
    });
    expect(host.querySelector<HTMLSelectElement>(
      "[data-native-blueprint-recipe-target='mod:recipe']",
    )?.disabled).toBe(true);
    expect(host.textContent).toContain("蓝图配方结果不确定");
  });

  it.each([
    ["truncated", "\u84dd\u56fe\u89c4\u6a21\u8d85\u8fc7\u539f\u751f\u8be6\u60c5\u4e0a\u9650"],
    ["unsupported", "\u65e0\u6cd5\u8bc1\u660e\u8be5\u5185\u5efa / MOD \u84dd\u56fe\u8bed\u4e49"],
  ] as const)("shows %s as a safe summary without detail rows", (detailStatus, copy) => {
    renderWorkspace(frame({ detailStatus }));
    expect(host.querySelector(`[data-native-blueprint-detail-status='${detailStatus}']`)).not.toBeNull();
    expect(host.textContent).toContain(copy);
    expect(host.querySelector("[data-native-blueprint-entity-key]")).toBeNull();
    expect(host.querySelector("[data-native-blueprint-recipe-target]")).toBeNull();
  });

  it("enters canvas placement only from a Rust-supported selected detail", () => {
    const onBeginQueuePlacement = vi.fn<(
      binding: NativeBlueprintEnqueueSelectionBinding,
    ) => boolean>().mockReturnValue(true);
    renderWorkspace(frame(), "ready", { onBeginQueuePlacement });
    const button = host.querySelector<HTMLButtonElement>(
      "[data-native-blueprint-action='begin-enqueue-placement']",
    )!;
    expect(button.textContent).toContain("加入待建施工");
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(onBeginQueuePlacement).toHaveBeenCalledWith({
      sessionId: "session-a",
      runId: "run-a",
      registryFingerprint: "registry-a",
      blueprintId: "mod:Ω/🚀",
      blueprintName: "模组蓝图 Ω",
      currentRowRevision: 4,
    });

    for (const detailStatus of ["unsupported", "truncated"] as const) {
      renderWorkspace(frame({ detailStatus }), "ready", { onBeginQueuePlacement });
      expect(host.querySelector<HTMLButtonElement>(
        "[data-native-blueprint-action='begin-enqueue-placement']",
      )?.disabled).toBe(true);
    }
    expect(onBeginQueuePlacement).toHaveBeenCalledTimes(1);
  });

  it("preserves one focused IME draft from active N through inFlight to active N+1 and submits once", () => {
    const onSubmitRenameIntent = vi.fn<(
      identity: NativeBlueprintRenameIdentity,
      name: string,
    ) => NativeBlueprintRenameSubmitOutcome>().mockReturnValue(Object.freeze({
      status: "accepted",
      submissionId: 9,
      commandRevision: 48,
    }));
    const callbacks = { onSubmitRenameIntent };
    renderWorkspace(frame({ detailStatus: "unsupported", revision: 47 }), "ready", callbacks);
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='begin-rename']")!.click());
    const input = host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")!;
    act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        .call(input, "  新模组名🚀 \uFEFF");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    expect(document.activeElement).toBe(input);

    renderWorkspace(null, "loading", {
      ...callbacks,
      commandPending: true,
      latestIdentity: {
        sessionId: "session-a",
        runId: "run-a",
        revision: 48,
        registryFingerprint: "registry-a",
      },
    });
    expect(host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")).toBe(input);
    expect(input.value).toBe("  新模组名🚀 \uFEFF");
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    act(() => host.querySelector<HTMLFormElement>("[data-native-blueprint-rename-form]")!.requestSubmit());
    expect(onSubmitRenameIntent).not.toHaveBeenCalled();

    renderWorkspace(frame({ detailStatus: "unsupported", revision: 48 }), "ready", callbacks);
    expect(host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")).toBe(input);
    expect(input.value).toBe("  新模组名🚀 \uFEFF");
    expect(document.activeElement).toBe(input);
    const form = host.querySelector<HTMLFormElement>("[data-native-blueprint-rename-form]")!;
    act(() => {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      form.requestSubmit();
      form.requestSubmit();
    });
    expect(onSubmitRenameIntent).toHaveBeenCalledTimes(1);
    expect(onSubmitRenameIntent).toHaveBeenCalledWith({
      sessionId: "session-a",
      runId: "run-a",
      registryFingerprint: "registry-a",
      blueprintId: "mod:Ω/🚀",
      currentName: "模组蓝图 Ω",
      currentRevision: 4,
    }, "新模组名🚀");
    expect(input.dataset.nativeBlueprintCommandRevision).toBe("48");
    expect(input.disabled).toBe(true);
  });

  it("keeps the same editable draft when the synchronous submission gate rejects", () => {
    const onSubmitRenameIntent = vi.fn<(
      identity: NativeBlueprintRenameIdentity,
      name: string,
    ) => NativeBlueprintRenameSubmitOutcome>().mockReturnValue(Object.freeze({
      status: "rejected",
      reason: "gate",
    }));
    renderWorkspace(frame(), "ready", { onSubmitRenameIntent });
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='begin-rename']")!.click());
    const input = host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")!;
    const form = host.querySelector<HTMLFormElement>("[data-native-blueprint-rename-form]")!;
    act(() => {
      replaceInputValue(input, "同步拒绝草稿");
      form.requestSubmit();
    });
    expect(onSubmitRenameIntent).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")).toBe(input);
    expect(input.value).toBe("同步拒绝草稿");
    expect(input.disabled).toBe(false);
    expect(host.textContent).toContain("写入口未接受本次提交；草稿已保留");
  });

  it("restores the same draft after a definite pre-ACK failure", () => {
    const onSubmitRenameIntent = vi.fn<(
      identity: NativeBlueprintRenameIdentity,
      name: string,
    ) => NativeBlueprintRenameSubmitOutcome>().mockReturnValue(Object.freeze({
      status: "accepted",
      submissionId: 9,
      commandRevision: 47,
    }));
    const onConsumeRenameResolution = vi.fn<(submissionId: number) => void>();
    const callbacks = { onSubmitRenameIntent, onConsumeRenameResolution };
    renderWorkspace(frame(), "ready", callbacks);
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='begin-rename']")!.click());
    const input = host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")!;
    act(() => {
      replaceInputValue(input, "失败仍保留");
      host.querySelector<HTMLFormElement>("[data-native-blueprint-rename-form]")!.requestSubmit();
    });
    expect(input.disabled).toBe(true);

    renderWorkspace(frame(), "ready", {
      ...callbacks,
      pendingIdentity: pendingRename("awaiting-ack", { targetName: "失败仍保留" }),
      commandPending: true,
    });
    expect(host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")).toBe(input);
    renderWorkspace(frame(), "ready", {
      ...callbacks,
      resolution: renameResolution("definite-failure", { targetName: "失败仍保留" }),
      commandPending: false,
    });
    expect(host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")).toBe(input);
    expect(input.value).toBe("失败仍保留");
    expect(input.disabled).toBe(false);
    expect(host.textContent).toContain("durable ACK 前明确失败");
    expect(onConsumeRenameResolution).toHaveBeenCalledWith(9);
  });

  it("keeps ACK-before-projection pending and closes only after the exact projected row", () => {
    const onSubmitRenameIntent = vi.fn<(
      identity: NativeBlueprintRenameIdentity,
      name: string,
    ) => NativeBlueprintRenameSubmitOutcome>().mockReturnValue(Object.freeze({
      status: "accepted",
      submissionId: 9,
      commandRevision: 47,
    }));
    const onConsumeRenameResolution = vi.fn<(submissionId: number) => void>();
    const callbacks = { onSubmitRenameIntent, onConsumeRenameResolution };
    renderWorkspace(frame(), "ready", callbacks);
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='begin-rename']")!.click());
    const input = host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")!;
    act(() => {
      replaceInputValue(input, "新模组名🚀");
      host.querySelector<HTMLFormElement>("[data-native-blueprint-rename-form]")!.requestSubmit();
    });
    renderWorkspace(frame(), "ready", {
      ...callbacks,
      pendingIdentity: pendingRename("awaiting-projection"),
      commandPending: false,
      latestIdentity: { sessionId: "session-a", runId: "run-a", revision: 48, registryFingerprint: "registry-a" },
    });
    expect(host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")).toBe(input);
    expect(input.disabled).toBe(true);
    expect(host.textContent).toContain("等待 revision 48 精确投影");

    const renamed = Object.freeze({ ...summaries[0], name: "新模组名🚀", revision: 5 });
    renderWorkspace(frame({ revision: 48, library: [renamed, summaries[1]] }), "ready", {
      ...callbacks,
      resolution: renameResolution("confirmed"),
    });
    expect(host.querySelector("[data-native-blueprint-rename-form]")).toBeNull();
    expect(onConsumeRenameResolution).toHaveBeenCalledWith(9);
  });

  it("keeps a wrong projection conflict visible and fail-closed", () => {
    const onSubmitRenameIntent = vi.fn<(
      identity: NativeBlueprintRenameIdentity,
      name: string,
    ) => NativeBlueprintRenameSubmitOutcome>().mockReturnValue(Object.freeze({
      status: "accepted",
      submissionId: 9,
      commandRevision: 47,
    }));
    const callbacks = { onSubmitRenameIntent };
    renderWorkspace(frame(), "ready", callbacks);
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='begin-rename']")!.click());
    const input = host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")!;
    act(() => {
      replaceInputValue(input, "新模组名🚀");
      host.querySelector<HTMLFormElement>("[data-native-blueprint-rename-form]")!.requestSubmit();
    });
    const wrong = Object.freeze({ ...summaries[0], name: "错误投影", revision: 5 });
    renderWorkspace(frame({ revision: 48, library: [wrong, summaries[1]] }), "ready", {
      ...callbacks,
      pendingIdentity: pendingRename("conflict"),
    });
    expect(host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")).toBe(input);
    expect(input.disabled).toBe(true);
    expect(host.querySelector("[role='alert']")?.textContent).toContain("权威对账冲突");
  });

  it("keeps an uncertain submission locked and never resends it", () => {
    const onSubmitRenameIntent = vi.fn<(
      identity: NativeBlueprintRenameIdentity,
      name: string,
    ) => NativeBlueprintRenameSubmitOutcome>().mockReturnValue(Object.freeze({
      status: "accepted",
      submissionId: 9,
      commandRevision: 47,
    }));
    const callbacks = { onSubmitRenameIntent };
    renderWorkspace(frame(), "ready", callbacks);
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='begin-rename']")!.click());
    const input = host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")!;
    act(() => {
      replaceInputValue(input, "新模组名🚀");
      host.querySelector<HTMLFormElement>("[data-native-blueprint-rename-form]")!.requestSubmit();
    });
    renderWorkspace(frame({ revision: 48 }), "ready", {
      ...callbacks,
      pendingIdentity: pendingRename("uncertain"),
    });
    const form = host.querySelector<HTMLFormElement>("[data-native-blueprint-rename-form]")!;
    act(() => form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })));
    expect(onSubmitRenameIntent).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")).toBe(input);
    expect(input.disabled).toBe(true);
    expect(host.textContent).toContain("禁止自动重发");
  });

  it("retains the draft and clears an interrupted IME composition while temporarily hidden", () => {
    const onSubmitRenameIntent = vi.fn<(
      identity: NativeBlueprintRenameIdentity,
      name: string,
    ) => NativeBlueprintRenameSubmitOutcome>().mockReturnValue(Object.freeze({
      status: "accepted",
      submissionId: 12,
      commandRevision: 47,
    }));
    renderWorkspace(frame(), "ready", { onSubmitRenameIntent });
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='begin-rename']")!.click());
    const input = host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")!;
    act(() => {
      replaceInputValue(input, "输入法中的草稿");
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    expect(host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='submit-rename']")?.disabled).toBe(true);

    renderWorkspace(frame(), "ready", { onSubmitRenameIntent, open: false });
    expect(host.querySelector("[data-native-blueprint-rename-form]")).toBeNull();
    renderWorkspace(frame(), "ready", { onSubmitRenameIntent, open: true });

    const restored = host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")!;
    expect(restored.value).toBe("输入法中的草稿");
    expect(host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='submit-rename']")?.disabled).toBe(false);
    act(() => host.querySelector<HTMLFormElement>("[data-native-blueprint-rename-form]")!.requestSubmit());
    expect(onSubmitRenameIntent).toHaveBeenCalledOnce();
  });

  it.each([
    ["lineage", frame({ runId: "other-run", revision: 48 }), "session / run / registry 已变化"],
    ["row", frame({
      revision: 48,
      library: [{ ...summaries[0], name: "他处已改名", revision: 5 }, summaries[1]],
    }), "目标蓝图名称或行 revision 已变化"],
  ] as const)("latches %s drift as an explicit pre-submit conflict", (_kind, driftedFrame, copy) => {
    renderWorkspace(frame(), "ready");
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='begin-rename']")!.click());
    const input = host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")!;
    act(() => replaceInputValue(input, "漂移草稿"));
    renderWorkspace(driftedFrame, "ready");
    expect(host.querySelector<HTMLInputElement>("[data-native-blueprint-rename-input]")).toBe(input);
    expect(input.value).toBe("漂移草稿");
    expect(input.disabled).toBe(true);
    expect(host.querySelector("[role='alert']")?.textContent).toContain(copy);

    renderWorkspace(frame({ revision: 49 }), "ready");
    expect(input.disabled).toBe(true);
  });

  it("locks selection, pagination and resubmission until durable ACK receives a same-lineage projection", () => {
    const pending: NativeBlueprintRenamePendingIdentity = Object.freeze({
      sessionId: "session-a",
      runId: "run-a",
      registryFingerprint: "registry-a",
      blueprintId: "mod:Ω/🚀",
      currentName: "模组蓝图 Ω",
      currentRevision: 4,
      submissionId: 1,
      commandRevision: 47,
      targetName: "等待确认名",
      phase: "awaiting-projection",
      expectedRevision: 48,
      conflictReason: null,
    });
    const lockedLibrary = Object.freeze([
      ...summaries,
      ...Array.from({ length: 30 }, (_, index) => ({ ...summaries[1], id: `locked-row-${index}` })),
    ]);
    const callbacks = renderWorkspace(frame({
      library: lockedLibrary,
      libraryPage: { cursor: 0, totalCount: 34, nextCursor: 32 },
    }), "ready", { pendingIdentity: pending, commandPending: false });
    expect(host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='page-library-next']")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[data-native-blueprint-select='builtin-second']")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='begin-rename']")?.disabled).toBe(true);
    expect(host.textContent).toContain("revision 48");
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-select='builtin-second']")!.click());
    expect(callbacks.onSelectBlueprint).not.toHaveBeenCalled();
  });

  it("submits explicit target-state transforms from the exact selected MOD row without optimistic UI", () => {
    const onSubmitTransformIntent = vi.fn<(
      binding: NativeBlueprintTransformBinding,
      rotation: NativeBlueprintRotation,
      mirror: NativeBlueprintMirror,
    ) => boolean>().mockReturnValue(true);
    const selected = frame({ detailStatus: "unsupported", revision: 47 });
    renderWorkspace(selected, "ready", { onSubmitTransformIntent });

    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='rotate-transform']")!.click());
    expect(onSubmitTransformIntent).toHaveBeenNthCalledWith(1, {
      sessionId: "session-a",
      runId: "run-a",
      revision: 47,
      registryFingerprint: "registry-a",
      blueprintId: "mod:Ω/🚀",
      currentRowRevision: 4,
      currentRotation: 90,
      currentMirror: "horizontal",
    }, 180, "horizontal");
    // The renderer does not update the visible target until Rust projects a
    // new row revision.
    expect(host.querySelector("[data-native-blueprint-library-id]")?.textContent)
      .toContain("r4 · 90° · 水平镜像");

    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='mirror-transform']")!.click());
    expect(onSubmitTransformIntent).toHaveBeenNthCalledWith(2, expect.any(Object), 90, "none");

    const transformPending = Object.freeze({
      token: 1,
      sessionId: "session-a",
      runId: "run-a",
      revision: 47,
      registryFingerprint: "registry-a",
      blueprintId: "mod:Ω/🚀",
      currentRowRevision: 4,
      currentRotation: 90,
      currentMirror: "horizontal",
      targetRotation: 180,
      targetMirror: "horizontal",
      phase: "reconciling",
      receipt: null,
      blockedReason: null,
      source: {},
      command: {},
    }) as unknown as NativeBlueprintTransformPendingCommand;
    renderWorkspace(selected, "ready", { onSubmitTransformIntent, transformPending });
    expect(host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='rotate-transform']")?.disabled)
      .toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='mirror-transform']")?.disabled)
      .toBe(true);
    expect(host.textContent).toContain("六次有界只读对账");
  });

  it("submits one exact selected-row delete without removing the row optimistically", () => {
    const onSubmitDeleteIntent = vi.fn<(binding: NativeBlueprintDeleteBinding) => boolean>()
      .mockReturnValue(true);
    const selected = frame({ detailStatus: "unsupported", revision: 47 });
    renderWorkspace(selected, "ready", { onSubmitDeleteIntent });

    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='delete-blueprint']")!
      .click());
    expect(onSubmitDeleteIntent).toHaveBeenCalledWith({
      sessionId: "session-a",
      runId: "run-a",
      revision: 47,
      registryFingerprint: "registry-a",
      blueprintId: "mod:Ω/🚀",
      currentRowRevision: 4,
      libraryTotalCount: 2,
    });
    expect([...host.querySelectorAll<HTMLElement>("[data-native-blueprint-library-id]")]
      .some((node) => node.dataset.nativeBlueprintLibraryId === "mod:Ω/🚀")).toBe(true);
    expect(host.textContent).toContain("名称、方向、配方、入队与删除由 Rust 权威提交");

    const deletePending = Object.freeze({
      token: 1,
      sessionId: "session-a",
      runId: "run-a",
      revision: 47,
      registryFingerprint: "registry-a",
      blueprintId: "mod:Ω/🚀",
      currentRowRevision: 4,
      libraryTotalCount: 2,
      phase: "reconciling",
      receipt: null,
      blockedReason: null,
      source: {},
      command: {},
    }) as unknown as NativeBlueprintDeletePendingCommand;
    renderWorkspace(selected, "ready", { onSubmitDeleteIntent, deletePending });
    expect(host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='delete-blueprint']")?.disabled)
      .toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='rotate-transform']")?.disabled)
      .toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='begin-rename']")?.disabled)
      .toBe(true);
    expect(host.textContent).toContain("蓝图删除结果不确定");
  });

  it("fails closed while loading or when a ready frame has stale selection identity", () => {
    const retained = frame();
    renderWorkspace(retained, "loading");
    expect(host.querySelector("[data-native-blueprint-read-status='loading']")).not.toBeNull();
    expect(host.querySelector("[data-native-blueprint-library-id]")).toBeNull();
    expect(host.textContent).toContain("\u53ea\u6709\u5b8c\u6574\u4e14\u8eab\u4efd\u4e00\u81f4\u7684\u5206\u9875\u4f1a\u8fdb\u5165\u754c\u9762");

    const stale = { ...retained, selectedBlueprintId: "missing-blueprint" };
    renderWorkspace(stale, "ready");
    expect(host.querySelector("[data-native-blueprint-read-status='unavailable']")).not.toBeNull();
    expect(host.textContent).toContain("\u4e0d\u4f1a\u8bfb\u53d6\u6216\u663e\u793a JavaScript \u4e2d\u7684\u65e7\u84dd\u56fe\u6570\u636e");
  });

  it("keeps the implementation detached from legacy state and exposes only bounded semantic intents", () => {
    const source = readFileSync(resolve("src/components/NativeBlueprintWorkspace.tsx"), "utf8");
    expect(source).not.toMatch(/from\s+["'](?:\.\/BlueprintWorkspace|\.\.\/game\/(?:engine|types|content))["']/);
    expect(source).not.toMatch(/\bGameState\b|\bgame\./);
    expect(source).not.toMatch(/on(?:Capture|Import|Transform|Delete|Remove|Deploy|Place|Undo|Ghost|Fund|Cancel|Export)\b/);
    expect(source).toMatch(/onSubmitRenameIntent/);
    expect(source).toMatch(/onSubmitTransformIntent/);
    expect(source).toMatch(/onSubmitRecipeOverrideIntent/);
    expect(source).toMatch(/onSubmitDeleteIntent/);
    expect(source).toMatch(/onSubmitQueueCancelIntent/);
    expect(source).toMatch(/onSubmitQueueDeployIntent/);
    expect(source).toMatch(/onBeginQueuePlacement/);
    expect(source).not.toMatch(/onBlur=|onKeyDown=/);

    renderWorkspace(frame());
    const actions = new Set([...host.querySelectorAll<HTMLElement>("[data-native-blueprint-action]")].map((node) => node.dataset.nativeBlueprintAction));
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='tab-queue']")!.click());
    for (const node of host.querySelectorAll<HTMLElement>("[data-native-blueprint-action]")) actions.add(node.dataset.nativeBlueprintAction);
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='tab-library']")!.click());
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='begin-rename']")!.click());
    for (const node of host.querySelectorAll<HTMLElement>("[data-native-blueprint-action]")) actions.add(node.dataset.nativeBlueprintAction);
    expect(actions).toEqual(new Set([
      "close", "tab-library", "tab-queue", "select",
      "begin-rename", "cancel-rename", "submit-rename",
      "rotate-transform", "mirror-transform", "begin-enqueue-placement", "delete-blueprint",
      "deploy-queue", "cancel-queue", "page-library-prev", "page-library-next", "page-queue-prev", "page-queue-next",
    ]));
  });
});
