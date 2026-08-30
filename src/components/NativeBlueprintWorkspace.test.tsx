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
import type { NativeBlueprintWorkspaceFrame } from "../game/nativeBlueprintWorkspaceStore";
import { NativeBlueprintWorkspace } from "./NativeBlueprintWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summaries: readonly DesktopNativeCoreBlueprintSummary[] = Object.freeze([
  { id: "mod:\u03a9/\ud83d\ude80", name: "\u6a21\u7ec4\u84dd\u56fe \u03a9", revision: 4, rotation: 90, mirror: "horizontal", counts: { entities: 2, belts: 1, resourceAnchors: 1, externalPorts: 1 }, detailStatus: "candidate" },
  { id: "builtin-second", name: "\u5185\u5efa\u84dd\u56fe B", revision: 2, rotation: 0, mirror: "none", counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 }, detailStatus: "candidate" },
]);

const queue: readonly DesktopNativeCoreBlueprintQueueRow[] = Object.freeze([
  { id: "queue-z", blueprintId: "builtin-second", blueprintVersionId: "version-z", blueprintRevision: 2, blueprintName: "\u540e\u5199\u5165\u4f46\u5148\u5b58\u50a8", planetId: "planet-z", planetName: "Z \u661f", position: { x: 8, y: 9 }, rotation: 270, mirror: "horizontal", queuedAt: 200, status: "waiting-fleet", counts: summaries[1].counts, semanticStatus: "catalog-backed", reservedConstructionTotal: 12, reservedFleetTotal: 2, placedEntityCount: 1, actionable: false },
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
  };
}

function frame(options: {
  selected?: boolean;
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
    sessionId: "session-a",
    runId: "run-a",
    revision: 47,
    registryFingerprint: "registry-a",
    selectedBlueprintId: selected ? library[0].id : null,
    library,
    libraryById: new Map(library.map((row) => [row.id, row])),
    libraryPage: options.libraryPage ?? { cursor: 0, totalCount: library.length, nextCursor: null },
    detail: projectedDetail,
    queue: queueRows,
    queuePage: options.queuePage ?? { cursor: 0, totalCount: queueRows.length, nextCursor: null },
  };
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
    } = {},
  ) {
    const onSelectBlueprint = callbacks.onSelectBlueprint ?? vi.fn<(blueprintId: string) => void>();
    const onLibraryCursorChange = callbacks.onLibraryCursorChange ?? vi.fn<(cursor: number) => void>();
    const onQueueCursorChange = callbacks.onQueueCursorChange ?? vi.fn<(cursor: number) => void>();
    act(() => root.render(<NativeBlueprintWorkspace
      open
      status={status}
      frame={value}
      onClose={() => undefined}
      onSelectBlueprint={onSelectBlueprint}
      onLibraryCursorChange={onLibraryCursorChange}
      onQueueCursorChange={onQueueCursorChange}
    />));
    return { onSelectBlueprint, onLibraryCursorChange, onQueueCursorChange };
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

  it.each([
    ["truncated", "\u84dd\u56fe\u89c4\u6a21\u8d85\u8fc7\u539f\u751f\u8be6\u60c5\u4e0a\u9650"],
    ["unsupported", "\u65e0\u6cd5\u8bc1\u660e\u8be5\u5185\u5efa / MOD \u84dd\u56fe\u8bed\u4e49"],
  ] as const)("shows %s as a safe summary without detail rows", (detailStatus, copy) => {
    renderWorkspace(frame({ detailStatus }));
    expect(host.querySelector(`[data-native-blueprint-detail-status='${detailStatus}']`)).not.toBeNull();
    expect(host.textContent).toContain(copy);
    expect(host.querySelector("[data-native-blueprint-entity-key]")).toBeNull();
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

  it("keeps the implementation detached from legacy state and mutation callbacks", () => {
    const source = readFileSync(resolve("src/components/NativeBlueprintWorkspace.tsx"), "utf8");
    expect(source).not.toMatch(/from\s+["'](?:\.\/BlueprintWorkspace|\.\.\/game\/(?:engine|types|content))["']/);
    expect(source).not.toMatch(/\bGameState\b|\bgame\./);
    expect(source).not.toMatch(/on(?:Capture|Import|Rename|Transform|Delete|Remove|Deploy|Place|Undo|Ghost|Fund|Cancel|Export)\b/);

    renderWorkspace(frame());
    const actions = new Set([...host.querySelectorAll<HTMLElement>("[data-native-blueprint-action]")].map((node) => node.dataset.nativeBlueprintAction));
    act(() => host.querySelector<HTMLButtonElement>("[data-native-blueprint-action='tab-queue']")!.click());
    for (const node of host.querySelectorAll<HTMLElement>("[data-native-blueprint-action]")) actions.add(node.dataset.nativeBlueprintAction);
    expect(actions).toEqual(new Set([
      "close", "tab-library", "tab-queue", "select",
      "page-library-prev", "page-library-next", "page-queue-prev", "page-queue-next",
    ]));
  });
});
