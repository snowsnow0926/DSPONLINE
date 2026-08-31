import { describe, expect, it, vi } from "vitest";
import type {
  DesktopNativeCoreBlueprintDetail,
  DesktopNativeCoreBlueprintQueueRow,
  DesktopNativeCoreBlueprintSummary,
  DesktopNativeCoreBlueprintWorkspaceResult,
  DesktopNativeCoreBlueprintWorkspaceSection,
} from "../desktop";
import {
  NATIVE_BLUEPRINT_PAGE_ROWS,
  NativeBlueprintWorkspaceStore,
  createNativePlayerAuthorityBlueprintWorkspaceSource,
  nativeBlueprintRenameIdentityMatchesFrame,
  nativeBlueprintTransformBindingMatchesFrame,
  selectNativeBlueprintTransformBinding,
  selectNativeBlueprintWorkspaceFrame,
  type NativeBlueprintWorkspaceIdentity,
  type NativeBlueprintWorkspaceSource,
} from "./nativeBlueprintWorkspaceStore";

const IDENTITY: NativeBlueprintWorkspaceIdentity = Object.freeze({
  sessionId: "authority-session",
  runId: "authority-run",
  revision: 17,
  registryFingerprint: "builtin:blueprint-test",
});

const LIMITS = Object.freeze({
  pageRows: 32 as const,
  sourceRows: 4_096 as const,
  detailEntities: 512 as const,
  detailBelts: 1_024 as const,
  detailResourceAnchors: 256 as const,
  detailExternalPorts: 256 as const,
  projectionBytes: 1_048_576 as const,
  opaqueIdBytes: 512 as const,
  nameBytes: 256 as const,
});

function summary(id: string, name = id): DesktopNativeCoreBlueprintSummary {
  return {
    id,
    name,
    revision: 1,
    rotation: 0,
    mirror: "none",
    counts: { entities: 0, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    detailStatus: "candidate",
  };
}

function detail(value: DesktopNativeCoreBlueprintSummary): DesktopNativeCoreBlueprintDetail {
  return {
    summary: value,
    status: "supported",
    unsupportedReason: null,
    entities: [],
    belts: [],
    resourceAnchors: [],
    externalPorts: [],
  };
}

function queueRow(id: string, blueprint: DesktopNativeCoreBlueprintSummary): DesktopNativeCoreBlueprintQueueRow {
  return {
    id,
    blueprintId: blueprint.id,
    blueprintVersionId: null,
    blueprintRevision: blueprint.revision,
    blueprintName: blueprint.name,
    planetId: "planet-home",
    planetName: "母星",
    position: { x: 10, y: -5 },
    rotation: 0,
    mirror: "none",
    queuedAt: 1_000,
    status: "pending-materials",
    counts: blueprint.counts,
    semanticStatus: "catalog-backed",
    reservedConstructionTotal: 0,
    reservedFleetTotal: 0,
    placedEntityCount: 0,
    actionable: false,
  };
}

function projection(
  identity: NativeBlueprintWorkspaceIdentity,
  section: DesktopNativeCoreBlueprintWorkspaceSection,
  blueprintId: string | null,
  cursor: number,
  rows: DesktopNativeCoreBlueprintWorkspaceResult["page"]["rows"],
  counts: { library: number; queue: number },
  totalCount: number,
  overrides: Partial<DesktopNativeCoreBlueprintWorkspaceResult> = {},
): DesktopNativeCoreBlueprintWorkspaceResult {
  const pageCursor = totalCount === 0 ? 0
    : cursor < totalCount ? cursor
      : Math.floor((totalCount - 1) / NATIVE_BLUEPRINT_PAGE_ROWS) * NATIVE_BLUEPRINT_PAGE_ROWS;
  const nextCursor = pageCursor + rows.length < totalCount ? pageCursor + rows.length : null;
  return {
    schemaVersion: 1,
    projectionType: "blueprint-workspace-v1",
    source: "native-core",
    revision: identity.revision,
    stateVersion: 47,
    registryFingerprint: identity.registryFingerprint,
    readOnly: true,
    request: {
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      section,
      blueprintId,
      cursor,
      limit: NATIVE_BLUEPRINT_PAGE_ROWS,
    },
    counts,
    page: {
      cursor: pageCursor,
      limit: NATIVE_BLUEPRINT_PAGE_ROWS,
      totalCount,
      rows,
      nextCursor,
      truncated: nextCursor !== null,
    },
    limits: { ...LIMITS },
    ...overrides,
  };
}

function fixtureSource(
  identity: NativeBlueprintWorkspaceIdentity,
  library: readonly DesktopNativeCoreBlueprintSummary[],
  queue: readonly DesktopNativeCoreBlueprintQueueRow[],
  details = new Map(library.map((row) => [row.id, detail(row)])),
  calls: string[] = [],
): NativeBlueprintWorkspaceSource {
  const counts = { library: library.length, queue: queue.length };
  return {
    boundIdentity: identity,
    async readVerifiedBlueprintPage(section, blueprintId, cursor) {
      calls.push(`${section}:${blueprintId ?? "-"}:${cursor}`);
      if (section === "detail") {
        const row = blueprintId ? details.get(blueprintId) : undefined;
        return projection(identity, section, blueprintId, cursor, row ? [row] : [], counts, row ? 1 : 0);
      }
      const sourceRows = section === "library" ? library : queue;
      const pageCursor = sourceRows.length === 0 ? 0
        : cursor < sourceRows.length ? cursor
          : Math.floor((sourceRows.length - 1) / NATIVE_BLUEPRINT_PAGE_ROWS) * NATIVE_BLUEPRINT_PAGE_ROWS;
      return projection(
        identity,
        section,
        null,
        cursor,
        sourceRows.slice(pageCursor, pageCursor + NATIVE_BLUEPRINT_PAGE_ROWS),
        counts,
        sourceRows.length,
      );
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("NativeBlueprintWorkspaceStore", () => {
  it("reads one stable persisted-order page per section plus one selected detail without mutation", async () => {
    const library = Array.from({ length: 35 }, (_, index) =>
      summary(`bp-${String(index).padStart(3, "0")}`, index === 34 ? "蓝图 Ω" : `Blueprint ${index}`));
    const queue = [queueRow("queue-later", library[34]), queueRow("queue-earlier", library[0])];
    queue[0].queuedAt = 9_000;
    queue[1].queuedAt = 1;
    const calls: string[] = [];
    const sourceValue = fixtureSource(IDENTITY, library, queue, undefined, calls);
    const before = JSON.stringify({ library, queue });
    const store = new NativeBlueprintWorkspaceStore();

    await expect(store.refresh(sourceValue, IDENTITY, library[34].id, 32, 0)).resolves.toBe("committed");

    const frame = selectNativeBlueprintWorkspaceFrame(store.getSnapshot(), IDENTITY);
    expect(frame?.library.map((row) => row.id)).toEqual(library.slice(32).map((row) => row.id));
    expect(frame?.libraryPage).toEqual({ cursor: 32, totalCount: 35, nextCursor: null });
    expect(frame?.queue.map((row) => row.id)).toEqual(["queue-later", "queue-earlier"]);
    expect(frame?.queuePage).toEqual({ cursor: 0, totalCount: 2, nextCursor: null });
    expect(frame?.selectedBlueprintId).toBe("bp-034");
    expect(frame?.detail?.summary.name).toBe("蓝图 Ω");
    expect(frame?.readOnly).toBe(true);
    expect(calls).toEqual(["library:-:32", "queue:-:0", "detail:bp-034:0"]);
    expect(JSON.stringify({ library, queue })).toBe(before);
  });

  it("normalizes a removed selection to null and never asks for unrelated detail", async () => {
    const library = [summary("bp-present")];
    const calls: string[] = [];
    const store = new NativeBlueprintWorkspaceStore();
    await expect(store.refresh(fixtureSource(IDENTITY, library, [], undefined, calls), IDENTITY, "bp-removed"))
      .resolves.toBe("committed");
    expect(store.getSnapshot().frame?.selectedBlueprintId).toBeNull();
    expect(store.getSnapshot().frame?.detail).toBeNull();
    expect(calls.some((call) => call.startsWith("detail:"))).toBe(false);
  });

  it("refetches a changed UI cursor within the same authority revision", async () => {
    const library = Array.from({ length: 35 }, (_, index) => summary(`bp-${index}`));
    const calls: string[] = [];
    const sourceValue = fixtureSource(IDENTITY, library, [], undefined, calls);
    const store = new NativeBlueprintWorkspaceStore();
    await expect(store.refresh(sourceValue, IDENTITY, null, 0, 0)).resolves.toBe("committed");
    await expect(store.refresh(sourceValue, IDENTITY, null, 32, 0)).resolves.toBe("committed");
    expect(store.getSnapshot().frame?.libraryPage.cursor).toBe(32);
    expect(store.getSnapshot().frame?.library.map((row) => row.id)).toEqual(["bp-32", "bp-33", "bp-34"]);
    expect(calls).toEqual(["library:-:0", "queue:-:0", "library:-:32", "queue:-:0"]);
  });

  it("rejects header drift and duplicate IDs within the bounded current page", async () => {
    const duplicateRows = [summary("bp-duplicate"), summary("bp-duplicate")];
    const duplicate = projection(IDENTITY, "library", null, 0, duplicateRows, {
      library: 2,
      queue: 0,
    }, 2);
    const duplicateSource: NativeBlueprintWorkspaceSource = {
      boundIdentity: IDENTITY,
      readVerifiedBlueprintPage: async (section) => section === "library"
        ? duplicate
        : projection(IDENTITY, "queue", null, 0, [], { library: 2, queue: 0 }, 0),
    };
    const duplicateStore = new NativeBlueprintWorkspaceStore();
    await expect(duplicateStore.refresh(duplicateSource, IDENTITY, null)).resolves.toBe("unavailable");

    const driftStore = new NativeBlueprintWorkspaceStore();
    const ordinary = fixtureSource(IDENTITY, [summary("bp")], []);
    const driftSource: NativeBlueprintWorkspaceSource = {
      boundIdentity: IDENTITY,
      readVerifiedBlueprintPage: async (section, blueprintId, cursor) => {
        const page = await ordinary.readVerifiedBlueprintPage(section, blueprintId, cursor);
        return section === "queue" && page ? { ...page, counts: { ...page.counts, library: 2 } } : page;
      },
    };
    await expect(driftStore.refresh(driftSource, IDENTITY, null)).resolves.toBe("unavailable");
  });

  it("rejects contradictory semantics while accepting an explicit byte-budget truncation", async () => {
    const selected = summary("bp-selected", "Library name");
    const contradictory = detail({ ...selected, name: "Contradictory detail name" });
    const detailStore = new NativeBlueprintWorkspaceStore();
    await expect(detailStore.refresh(
      fixtureSource(IDENTITY, [selected], [], new Map([[selected.id, contradictory]])),
      IDENTITY,
      selected.id,
    )).resolves.toBe("unavailable");

    const forgedQueue = { ...queueRow("queue-forged", selected), counts: null };
    const queueStore = new NativeBlueprintWorkspaceStore();
    await expect(queueStore.refresh(
      fixtureSource(IDENTITY, [selected], [forgedQueue]),
      IDENTITY,
      null,
    )).resolves.toBe("unavailable");

    const byteTruncated: DesktopNativeCoreBlueprintDetail = {
      summary: selected,
      status: "truncated",
      unsupportedReason: "projection-byte-budget-exceeded",
      entities: [],
      belts: [],
      resourceAnchors: [],
      externalPorts: [],
    };
    const byteStore = new NativeBlueprintWorkspaceStore();
    await expect(byteStore.refresh(
      fixtureSource(IDENTITY, [selected], [], new Map([[selected.id, byteTruncated]])),
      IDENTITY,
      selected.id,
    )).resolves.toBe("committed");
  });

  it("supersedes an in-flight selection when the authority run and revision change", async () => {
    const oldBlueprint = summary("bp-old");
    const oldDetail = deferred<DesktopNativeCoreBlueprintWorkspaceResult | null>();
    const oldBase = fixtureSource(IDENTITY, [oldBlueprint], []);
    const oldSource: NativeBlueprintWorkspaceSource = {
      boundIdentity: IDENTITY,
      readVerifiedBlueprintPage: async (section, blueprintId, cursor) => section === "detail"
        ? oldDetail.promise
        : oldBase.readVerifiedBlueprintPage(section, blueprintId, cursor),
    };
    const store = new NativeBlueprintWorkspaceStore();
    const oldRefresh = store.refresh(oldSource, IDENTITY, oldBlueprint.id);

    const nextIdentity = { ...IDENTITY, runId: "authority-run-next", revision: 18 };
    const nextBlueprint = summary("bp-next");
    await expect(store.refresh(fixtureSource(nextIdentity, [nextBlueprint], []), nextIdentity, nextBlueprint.id))
      .resolves.toBe("committed");
    oldDetail.resolve(projection(
      IDENTITY,
      "detail",
      oldBlueprint.id,
      0,
      [detail(oldBlueprint)],
      { library: 1, queue: 0 },
      1,
    ));
    await expect(oldRefresh).resolves.toBe("superseded");
    expect(store.getSnapshot().frame).toMatchObject({
      runId: "authority-run-next",
      revision: 18,
      selectedBlueprintId: "bp-next",
    });
  });

  it("keeps 4096+4096 active-revision frames to at most three IPC reads and two bounded pages", async () => {
    const store = new NativeBlueprintWorkspaceStore();
    for (let revision = 18; revision <= 22; revision += 1) {
      const identity = { ...IDENTITY, revision };
      const calls: string[] = [];
      const counts = { library: 4_096, queue: 4_096 };
      const sourceValue: NativeBlueprintWorkspaceSource = {
        boundIdentity: identity,
        async readVerifiedBlueprintPage(section, blueprintId, cursor) {
          calls.push(`${section}:${blueprintId ?? "-"}:${cursor}`);
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (section === "detail") {
            const row = summary(blueprintId!);
            return projection(identity, section, blueprintId, cursor, [detail(row)], counts, 1);
          }
          const pageCursor = cursor < 4_096 ? cursor : 4_064;
          if (section === "library") {
            const rows = Array.from({ length: 32 }, (_, offset) => summary(`bp-${pageCursor + offset}`));
            return projection(identity, section, null, cursor, rows, counts, 4_096);
          }
          const rows = Array.from({ length: 32 }, (_, offset) => {
            const blueprint = summary(`bp-${pageCursor + offset}`);
            return queueRow(`queue-${pageCursor + offset}`, blueprint);
          });
          return projection(identity, section, null, cursor, rows, counts, 4_096);
        },
      };
      await expect(store.refresh(sourceValue, identity, "bp-4095", 4_096, 4_096))
        .resolves.toBe("committed");
      const frame = store.getSnapshot().frame;
      expect(calls).toHaveLength(3);
      expect(frame?.library).toHaveLength(32);
      expect(frame?.queue).toHaveLength(32);
      expect(frame?.libraryById.size).toBe(32);
      expect(frame?.libraryPage).toEqual({ cursor: 4_064, totalCount: 4_096, nextCursor: null });
      expect(frame?.queuePage).toEqual({ cursor: 4_064, totalCount: 4_096, nextCursor: null });
      expect(frame?.revision).toBe(revision);
      expect(frame?.selectedBlueprintId).toBe("bp-4095");
    }
  });

  it("binds bridge reads to the exact revision and rejects stale projection identity", async () => {
    const row = summary("bp");
    const valid = projection(IDENTITY, "library", null, 0, [row], { library: 1, queue: 0 }, 1);
    const reader = vi.fn().mockResolvedValue(valid);
    const sourceValue = createNativePlayerAuthorityBlueprintWorkspaceSource({
      getNativeCoreBlueprintWorkspace: reader,
    }, IDENTITY);
    await expect(sourceValue?.readVerifiedBlueprintPage("library", null, 0)).resolves.toEqual(valid);
    expect(reader).toHaveBeenCalledWith({
      sessionId: IDENTITY.sessionId,
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
      section: "library",
      blueprintId: null,
      cursor: 0,
      limit: 32,
    });

    reader.mockResolvedValueOnce({ ...valid, revision: IDENTITY.revision + 1 });
    await expect(sourceValue?.readVerifiedBlueprintPage("library", null, 0)).resolves.toBeNull();
  });

  it("fails closed for a mismatched source identity", async () => {
    const store = new NativeBlueprintWorkspaceStore();
    const wrong = fixtureSource({ ...IDENTITY, sessionId: "other" }, [], []);
    await expect(store.refresh(wrong, IDENTITY, null)).resolves.toBe("unavailable");
    expect(store.getSnapshot().status).toBe("unavailable");
  });

  it("keeps rename row identity stable across global revisions but rejects lineage or row drift", async () => {
    const row = { ...summary("bp-selected", "当前名称"), revision: 4 };
    const store = new NativeBlueprintWorkspaceStore();
    await expect(store.refresh(fixtureSource(IDENTITY, [row], []), IDENTITY, row.id))
      .resolves.toBe("committed");
    const frame = store.getSnapshot().frame;
    const identity = {
      sessionId: IDENTITY.sessionId,
      runId: IDENTITY.runId,
      registryFingerprint: IDENTITY.registryFingerprint,
      blueprintId: row.id,
      currentName: row.name,
      currentRevision: row.revision,
    };
    expect(nativeBlueprintRenameIdentityMatchesFrame(identity, frame)).toBe(true);
    expect(nativeBlueprintRenameIdentityMatchesFrame(identity, frame && { ...frame, revision: 18 })).toBe(true);
    for (const drift of [
      { sessionId: "other-session" },
      { runId: "other-run" },
      { registryFingerprint: "other-registry" },
      { blueprintId: "other-blueprint" },
      { currentName: "过期名称" },
      { currentRevision: 5 },
    ]) {
      expect(nativeBlueprintRenameIdentityMatchesFrame({ ...identity, ...drift }, frame)).toBe(false);
    }
  });

  it("binds transform to the exact selected global and row revision", async () => {
    const row = {
      ...summary("mod:opaque/selected", "不透明蓝图"),
      revision: 4,
      rotation: 270 as const,
      mirror: "horizontal" as const,
      detailStatus: "truncated" as const,
      counts: { entities: 513, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    };
    const store = new NativeBlueprintWorkspaceStore();
    const details = new Map([[row.id, {
      summary: row,
      status: "truncated" as const,
      unsupportedReason: "detail-limits-exceeded" as const,
      entities: [],
      belts: [],
      resourceAnchors: [],
      externalPorts: [],
    }]]);
    await expect(store.refresh(fixtureSource(IDENTITY, [row], [], details), IDENTITY, row.id))
      .resolves.toBe("committed");
    const frame = store.getSnapshot().frame;
    const binding = selectNativeBlueprintTransformBinding(frame);
    expect(binding).toEqual({
      sessionId: IDENTITY.sessionId,
      runId: IDENTITY.runId,
      revision: IDENTITY.revision,
      registryFingerprint: IDENTITY.registryFingerprint,
      blueprintId: row.id,
      currentRowRevision: 4,
      currentRotation: 270,
      currentMirror: "horizontal",
    });
    expect(nativeBlueprintTransformBindingMatchesFrame(binding!, frame)).toBe(true);
    for (const drift of [
      { revision: 18 },
      { registryFingerprint: "other-registry" },
      { blueprintId: "other-blueprint" },
      { currentRowRevision: 5 },
      { currentRotation: 0 as const },
      { currentMirror: "none" as const },
    ]) {
      expect(nativeBlueprintTransformBindingMatchesFrame({ ...binding!, ...drift }, frame)).toBe(false);
    }
    expect(selectNativeBlueprintTransformBinding(frame && {
      ...frame,
      selectedBlueprintId: null,
    })).toBeNull();
  });
});
