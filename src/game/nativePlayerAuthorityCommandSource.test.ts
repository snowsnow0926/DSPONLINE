import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  DesktopBridge,
  DesktopNativeCoreCommandRequest,
  DesktopNativeCoreCommandResult,
  DesktopNativePlayerAuthorityClockState,
  DesktopNativePlayerAuthorityMacroState,
  DesktopNativePlayerAuthorityState,
} from "../desktop";
import {
  connectBelt,
  createInitialState,
  placeBuilding,
  setStationSlotItem,
} from "./engine";
import {
  createNativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import {
  createSimulationCommandPatch,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import { createNativeProjectedManualMineCommand } from "./nativeProjectedManualMiningCommands";
import { createNativeBlueprintRenameIntentCommand } from "./nativeBlueprintRenameIntentCommands";
import { createNativeBlueprintTransformIntentCommand } from "./nativeBlueprintTransformIntentCommands";
import { createNativeFactoryAutoLayoutCommand } from "./nativeFactoryAutoLayoutCommands";

function activeFrame(
  revision = 10,
  overrides: Partial<DesktopNativePlayerAuthorityClockState> = {},
): DesktopNativePlayerAuthorityClockState {
  return {
    schemaVersion: 1,
    phase: "active",
    sessionId: "core-command-a",
    runId: "run-command-a",
    revision,
    acknowledgedSequence: revision + 20,
    nextSequence: revision + 21,
    nextDeadlineMs: 50_000,
    inFlight: false,
    currentOperation: null,
    queuedCommands: 0,
    lastErrorCode: null,
    ...overrides,
  };
}

function postCommandFrame(frame: DesktopNativePlayerAuthorityClockState): DesktopNativePlayerAuthorityClockState {
  return activeFrame(frame.revision! + 1, {
    sessionId: frame.sessionId,
    runId: frame.runId,
    acknowledgedSequence: frame.acknowledgedSequence! + 1,
    nextSequence: frame.nextSequence! + 1,
    nextDeadlineMs: frame.nextDeadlineMs,
  });
}

function macroFrame(revision = 10): DesktopNativePlayerAuthorityMacroState {
  return {
    schemaVersion: 2,
    statusKind: "macro",
    phase: "macro-active",
    revision,
    acknowledgedSequence: revision + 20,
    nextSequence: revision + 21,
    nextDeadlineMs: 50_000,
    inFlight: false,
    currentOperation: null,
    simulationBudgetMilliseconds: 60_000,
    wallBudgetMilliseconds: 4_000,
    simulationProgressMilliseconds: 0,
    wallProgressMilliseconds: 0,
    pausedReason: "macro-window-active",
  };
}

function metadataPatch(baseRevision = 10): SimulationCommandPatch {
  return {
    protocolVersion: 1,
    baseRevision,
    topLevelChanges: [{ path: ["lastSavedAt"], operation: "set", value: 50_000 }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

function recipeIntentPatch(
  baseRevision = 10,
  entityId = "smelter-recipe-a",
): SimulationCommandPatch {
  return {
    protocolVersion: 1,
    baseRevision,
    topLevelChanges: [{
      path: ["entityRecipe", "intent"],
      operation: "set",
      value: { entityId, targetRecipeId: "copper_ingot" },
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

function recipeIntentReceipt(
  patch: SimulationCommandPatch,
  overrides: Partial<DesktopNativeCoreCommandResult> = {},
): DesktopNativeCoreCommandResult {
  const value = patch.topLevelChanges[0]?.value as { entityId: string };
  return {
    previousRevision: patch.baseRevision,
    revision: patch.baseRevision + 1,
    changedEntityIds: [value.entityId],
    changedBeltIds: [],
    topologyDirty: true,
    ...overrides,
  };
}

function receiptForPatch(
  patch: SimulationCommandPatch,
  topologyDirty: boolean,
  overrides: Partial<DesktopNativeCoreCommandResult> = {},
): DesktopNativeCoreCommandResult {
  const encoder = new TextEncoder();
  const stableUtf8Sort = (ids: string[]) => ids.sort((left, right) => {
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    const shared = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < shared; index += 1) {
      if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
    }
    return leftBytes.length - rightBytes.length;
  });
  const changedEntityIds = [
    ...patch.changedEntities.map((record) => record.id),
    ...patch.addedEntities.map((record) => record.value.id),
    ...patch.removedEntityIds,
  ];
  const changedBeltIds = [
    ...patch.changedBelts.map((record) => record.id),
    ...patch.addedBelts.map((record) => record.value.id),
    ...patch.removedBeltIds,
  ];
  return {
    previousRevision: patch.baseRevision,
    revision: patch.baseRevision + 1,
    changedEntityIds: stableUtf8Sort(changedEntityIds),
    changedBeltIds: stableUtf8Sort(changedBeltIds),
    topologyDirty,
    ...overrides,
  };
}

function sourceHarness(
  patch: SimulationCommandPatch,
  options: {
    frame?: DesktopNativePlayerAuthorityClockState;
    receipt?: unknown;
    postFrame?: DesktopNativePlayerAuthorityState;
    topologyDirty?: boolean;
  } = {},
) {
  const frame = options.frame ?? activeFrame(patch.baseRevision);
  let currentFrame: DesktopNativePlayerAuthorityState = frame;
  const getNativePlayerAuthorityState = vi.fn(async () => currentFrame);
  const applyNativeCoreCommand = vi.fn(async (_request: DesktopNativeCoreCommandRequest) => {
    currentFrame = options.postFrame ?? postCommandFrame(frame);
    return (options.receipt ?? receiptForPatch(
      patch,
      options.topologyDirty ?? patch.removedBeltIds.length > 0,
    )) as DesktopNativeCoreCommandResult;
  });
  const bridge = {
    getNativePlayerAuthorityState,
    applyNativeCoreCommand,
  } satisfies Pick<DesktopBridge, "getNativePlayerAuthorityState" | "applyNativeCoreCommand">;
  const source = createNativePlayerAuthorityCommandSource(bridge, frame);
  if (!source) throw new Error("test command source was not created");
  return {
    bridge,
    source,
    setFrame(next: DesktopNativePlayerAuthorityState) { currentFrame = next; },
  };
}

function stationSlotPatchFixture() {
  let empty = createInitialState(23_041);
  empty.research.completedTechIds.push("interstellar_logistics");
  empty.construction.interstellar_logistics_station = 1;
  empty.construction.storage_mk1 = 2;
  empty.construction.conveyor_belt_mk1 = 2;
  empty = placeBuilding(empty, "interstellar_logistics_station", { x: 0, y: 0 });
  empty = placeBuilding(empty, "storage_mk1", { x: -300, y: 0 });
  empty = placeBuilding(empty, "storage_mk1", { x: 300, y: 0 });
  const stationId = empty.entities.find(
    (entity) => entity.buildingId === "interstellar_logistics_station",
  )!.id;
  const [sourceStorage, targetStorage] = empty.entities.filter(
    (entity) => entity.buildingId === "storage_mk1",
  );
  sourceStorage.storedItemId = "iron_ore";
  sourceStorage.outputs.iron_ore = 100;
  targetStorage.storedItemId = "iron_ore";

  const assigned = setStationSlotItem(empty, stationId, 0, "iron_ore");
  const assignmentPatch = createSimulationCommandPatch(empty, assigned, 40);
  if (!assignmentPatch) throw new Error("station assignment fixture is empty");

  let configured = connectBelt(assigned, sourceStorage.id, stationId, "iron_ore");
  configured = connectBelt(configured, stationId, targetStorage.id, "iron_ore");
  if (configured.belts.length !== 2) throw new Error("station removal fixture belts were not created");
  const station = configured.entities.find((entity) => entity.id === stationId)!;
  station.inputs.iron_ore = 7;
  station.outputs.iron_ore = 11;
  const removed = setStationSlotItem(configured, stationId, 0, null);
  const removalPatch = createSimulationCommandPatch(configured, removed, 41);
  if (!removalPatch) throw new Error("station removal fixture is empty");

  return {
    stationId,
    assignmentPatch,
    removalPatch,
    removedBeltIds: configured.belts.map((belt) => belt.id).sort(),
  };
}

describe("native player-authority command source", () => {
  it("accepts the bounded topology-only receipt for Rust-derived factory layout", async () => {
    const patch = createNativeFactoryAutoLayoutCommand(10, ["smelter-a", "模组:建筑/甲"]);
    const receipt = receiptForPatch(patch, true);
    await expect(sourceHarness(patch, { receipt, topologyDirty: true }).source.applyCommand(patch))
      .resolves.toMatchObject({
        previousRevision: 10,
        revision: 11,
        changedEntityIds: [],
        changedBeltIds: [],
        topologyDirty: true,
      });
    await expect(sourceHarness(patch, {
      receipt: { ...receipt, changedEntityIds: ["smelter-a"] },
      topologyDirty: true,
    }).source.applyCommand(patch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
    });
  });

  it("accepts only the compact receipt for a Rust-derived special input port transition", async () => {
    const patch: SimulationCommandPatch = {
      protocolVersion: 1,
      baseRevision: 10,
      topLevelChanges: [],
      changedEntities: [{
        id: "delivery-a",
        changes: [{
          path: ["materialDeliverySlot", "intent"],
          operation: "set",
          value: { slotIndex: 0, mode: "disabled", itemId: null, confirmed: true },
        }],
      }],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    };
    const compact = receiptForPatch(patch, true);
    const accepted = sourceHarness(patch, { receipt: compact, topologyDirty: true });
    await expect(accepted.source.applyCommand(patch)).resolves.toMatchObject({
      changedEntityIds: ["delivery-a"],
      changedBeltIds: [],
      topologyDirty: true,
    });

    const forgedDerivedIds = sourceHarness(patch, {
      receipt: { ...compact, changedBeltIds: ["renderer-cannot-prove-this-belt"] },
      topologyDirty: true,
    });
    await expect(forgedDerivedIds.source.applyCommand(patch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
    });
  });

  it("accepts Galaxy export semantic receipts without renderer-derived inventory IDs", async () => {
    const manualDispatch: SimulationCommandPatch = {
      protocolVersion: 1,
      baseRevision: 10,
      topLevelChanges: [{
        path: ["galacticExports", "intent"],
        operation: "set",
        value: {
          type: "manual-dispatch",
          projectId: "universe_archive",
          requestedAmount: "1000",
        },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    };
    const compact = receiptForPatch(manualDispatch, true);
    await expect(sourceHarness(manualDispatch, {
      receipt: compact,
      topologyDirty: true,
    }).source.applyCommand(manualDispatch)).resolves.toMatchObject({
      changedEntityIds: [],
      changedBeltIds: [],
      topologyDirty: true,
    });
    await expect(sourceHarness(manualDispatch, {
      receipt: { ...compact, changedEntityIds: ["renderer-guessed-stock"] },
      topologyDirty: true,
    }).source.applyCommand(manualDispatch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
    });

    const exporterPause: SimulationCommandPatch = {
      ...manualDispatch,
      topLevelChanges: [],
      changedEntities: [{
        id: "exporter-a",
        changes: [{
          path: ["galacticExporter", "pauseIntent"],
          operation: "set",
          value: { paused: true },
        }],
      }],
    };
    const exporterReceipt = receiptForPatch(exporterPause, true);
    await expect(sourceHarness(exporterPause, {
      receipt: exporterReceipt,
      topologyDirty: true,
    }).source.applyCommand(exporterPause)).resolves.toMatchObject({
      changedEntityIds: ["exporter-a"],
      topologyDirty: true,
    });
    await expect(sourceHarness(exporterPause, {
      receipt: { ...exporterReceipt, changedEntityIds: [] },
      topologyDirty: true,
    }).source.applyCommand(exporterPause)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
    });
  });

  it("accepts the exact entity-recipe marker with its compact live receipt", async () => {
    const patch = recipeIntentPatch();
    const harness = sourceHarness(patch, { receipt: recipeIntentReceipt(patch) });

    await expect(harness.source.applyCommand(patch)).resolves.toMatchObject({
      previousRevision: 10,
      revision: 11,
      changedEntityIds: ["smelter-recipe-a"],
      changedBeltIds: [],
      topologyDirty: true,
    });
    expect(harness.bridge.applyNativeCoreCommand).toHaveBeenCalledOnce();
  });

  it("rejects incomplete or forged entity-recipe compact live receipts", async () => {
    const patch = recipeIntentPatch();
    const valid = recipeIntentReceipt(patch);
    const cases: DesktopNativeCoreCommandResult[] = [
      { ...valid, changedEntityIds: [] },
      { ...valid, changedEntityIds: ["aa-forged", "smelter-recipe-a"] },
      { ...valid, changedEntityIds: ["wrong-entity"] },
      { ...valid, changedBeltIds: ["forged-belt"] },
      { ...valid, topologyDirty: false },
    ];

    for (const receipt of cases) {
      const harness = sourceHarness(patch, { receipt });
      await expect(harness.source.applyCommand(patch)).rejects.toMatchObject({
        code: "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
        commandId: expect.stringMatching(/^renderer-local-/),
      });
      expect(harness.bridge.applyNativeCoreCommand).toHaveBeenCalledOnce();
    }
  });

  it("accepts only the exact entity-recipe marker shape for compact receipt derivation", async () => {
    const exact = recipeIntentPatch();
    const compactReceipt = recipeIntentReceipt(exact);
    const malformed: SimulationCommandPatch[] = [
      {
        ...exact,
        topLevelChanges: [{
          ...exact.topLevelChanges[0]!,
          value: {
            entityId: "smelter-recipe-a",
            targetRecipeId: "copper_ingot",
            refund: true,
          },
        }],
      },
      {
        ...exact,
        topLevelChanges: [{ path: ["entityRecipe", "intent", "extra"], operation: "set", value: {
          entityId: "smelter-recipe-a",
          targetRecipeId: "copper_ingot",
        } }],
      },
      {
        ...exact,
        topLevelChanges: [{ path: ["entityRecipe", "intent"], operation: "delete" }],
      },
      {
        ...exact,
        topLevelChanges: [{
          ...exact.topLevelChanges[0]!,
          value: { entityId: "bad\u0001entity", targetRecipeId: "copper_ingot" },
        }],
      },
      {
        ...exact,
        changedEntities: [{ id: "foreign-entity", changes: [{
          path: ["inputs", "iron_ore"],
          operation: "set",
          value: 1,
        }] }],
      },
    ];

    for (const patch of malformed) {
      const harness = sourceHarness(patch, { receipt: compactReceipt });
      await expect(harness.source.applyCommand(patch)).rejects.toMatchObject({
        code: "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
      });
    }
  });

  it("accepts and validates the compact entity-recipe committed reconciliation receipt", async () => {
    const patch = recipeIntentPatch();
    const frame = activeFrame();
    const valid = recipeIntentReceipt(patch);
    const committedBridge = {
      getNativePlayerAuthorityState: vi.fn(async () => frame),
      applyNativeCoreCommand: vi.fn(async () => valid),
      reconcileNativeCoreCommand: vi.fn(async () => ({ status: "committed" as const, receipt: valid })),
    } satisfies Pick<
      DesktopBridge,
      "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand"
    >;
    const source = createNativePlayerAuthorityCommandSource(committedBridge, frame)!;
    await expect(source.reconcileCommand(patch)).resolves.toEqual({
      status: "committed",
      receipt: valid,
    });

    const invalidReceipts: DesktopNativeCoreCommandResult[] = [
      { ...valid, changedEntityIds: [] },
      { ...valid, changedEntityIds: ["aa-forged", "smelter-recipe-a"] },
      { ...valid, changedEntityIds: ["wrong-entity"] },
      { ...valid, changedBeltIds: ["forged-belt"] },
      { ...valid, topologyDirty: false },
    ];
    for (const receipt of invalidReceipts) {
      const bridge = {
        getNativePlayerAuthorityState: vi.fn(async () => frame),
        applyNativeCoreCommand: vi.fn(async () => receipt),
        reconcileNativeCoreCommand: vi.fn(async () => ({ status: "committed" as const, receipt })),
      } satisfies Pick<
        DesktopBridge,
        "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand"
      >;
      await expect(
        createNativePlayerAuthorityCommandSource(bridge, frame)!.reconcileCommand(patch),
      ).rejects.toMatchObject({ code: "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID" });
      expect(bridge.applyNativeCoreCommand).not.toHaveBeenCalled();
    }
  });

  it("requires topologyDirty for the minimal blueprint rename marker", async () => {
    const patch = createNativeBlueprintRenameIntentCommand(10, "mod:opaque/rocket", "新蓝图名🚀");
    const accepted = sourceHarness(patch, {
      topologyDirty: true,
      receipt: receiptForPatch(patch, true),
    });
    await expect(accepted.source.applyCommand(patch)).resolves.toMatchObject({
      previousRevision: 10,
      revision: 11,
      changedEntityIds: [],
      changedBeltIds: [],
      topologyDirty: true,
    });
    const rejected = sourceHarness(patch, {
      topologyDirty: true,
      receipt: receiptForPatch(patch, false),
    });
    await expect(rejected.source.applyCommand(patch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
    });
  });

  it("requires the same compact empty-ID topology receipt for blueprint transform", async () => {
    const patch = createNativeBlueprintTransformIntentCommand(
      10,
      "mod:opaque/rocket",
      270,
      "horizontal",
    );
    const accepted = sourceHarness(patch, {
      topologyDirty: true,
      receipt: receiptForPatch(patch, true),
    });
    await expect(accepted.source.applyCommand(patch)).resolves.toMatchObject({
      previousRevision: 10,
      revision: 11,
      changedEntityIds: [],
      changedBeltIds: [],
      topologyDirty: true,
    });
    const rejected = sourceHarness(patch, {
      topologyDirty: true,
      receipt: receiptForPatch(patch, false),
    });
    await expect(rejected.source.applyCommand(patch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
    });
  });

  it("accepts one opaque manual-mining marker with the projected dirty receipt", async () => {
    const patch = createNativeProjectedManualMineCommand({
      baseRevision: 10,
      entityId: "MOD-矿脉/Ω",
    });
    const harness = sourceHarness(patch, { topologyDirty: true });

    const result = await harness.source.applyCommand(patch);

    expect(result).toMatchObject({
      previousRevision: 10,
      revision: 11,
      changedEntityIds: ["MOD-矿脉/Ω"],
      changedBeltIds: [],
      topologyDirty: true,
    });
    expect(harness.bridge.applyNativeCoreCommand).toHaveBeenCalledOnce();
  });

  it("forwards real station-slot assignment/removal intent without dropping refund or removed rows", async () => {
    const fixture = stationSlotPatchFixture();
    const assignmentItem = fixture.assignmentPatch.changedEntities
      .find((record) => record.id === fixture.stationId)?.changes
      .find((change) => change.path.join(".") === "stationSlots.0.itemId");
    expect(assignmentItem).toEqual({
      path: ["stationSlots", 0, "itemId"],
      operation: "set",
      value: "iron_ore",
    });

    const removalItem = fixture.removalPatch.changedEntities
      .find((record) => record.id === fixture.stationId)?.changes
      .find((change) => change.path.join(".") === "stationSlots.0.itemId");
    expect(removalItem).toEqual({
      path: ["stationSlots", 0, "itemId"],
      operation: "set",
      value: undefined,
    });
    expect(Object.hasOwn(removalItem!, "value")).toBe(true);
    expect(fixture.removalPatch.removedBeltIds.slice().sort()).toEqual(fixture.removedBeltIds);
    expect(fixture.removalPatch.topLevelChanges).toEqual(expect.arrayContaining([
      { path: ["construction", "conveyor_belt_mk1"], operation: "set", value: 2 },
      { path: ["tray", "iron_ore"], operation: "set", value: 118 },
    ]));

    for (const patch of [fixture.assignmentPatch, fixture.removalPatch]) {
      const expectedReceipt = receiptForPatch(patch, true);
      const harness = sourceHarness(patch, {
        topologyDirty: true,
        receipt: expectedReceipt,
      });
      const result = await harness.source.applyCommand(patch);
      expect(result).toMatchObject({
        previousRevision: patch.baseRevision,
        revision: patch.baseRevision + 1,
        changedEntityIds: expectedReceipt.changedEntityIds,
        changedBeltIds: expectedReceipt.changedBeltIds,
        topologyDirty: true,
      });
      expect(result.commandId).toMatch(/^renderer-local-[0-9a-z]+-[0-9a-z]+$/);
      expect(new TextEncoder().encode(result.commandId).byteLength).toBeLessThanOrEqual(96);
      expect(harness.bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
      const request = harness.bridge.applyNativeCoreCommand.mock.calls[0]![0];
      expect(Object.keys(request)).toEqual(["sessionId", "command"]);
      expect(request).not.toHaveProperty("commandId");
      if (patch === fixture.assignmentPatch) {
        expect(request.command).toEqual(patch);
      } else {
        const wireRemovalItem = (request.command as unknown as SimulationCommandPatch)
          .changedEntities.find((record) => record.id === fixture.stationId)?.changes
          .find((change) => change.path.join(".") === "stationSlots.0.itemId");
        expect(wireRemovalItem).toEqual({
          path: ["stationSlots", 0, "itemId"],
          operation: "delete",
        });
        expect(Object.hasOwn(wireRemovalItem!, "value")).toBe(false);
        expect(request.command.topLevelChanges).toEqual(patch.topLevelChanges);
        expect(request.command.removedBeltIds).toEqual(patch.removedBeltIds);
      }
    }
  });

  it("creates bounded unique renderer-local command IDs without exposing them as durable IDs", async () => {
    const firstPatch = metadataPatch(70);
    const secondPatch = metadataPatch(71);
    const first = await sourceHarness(firstPatch, { topologyDirty: false }).source.applyCommand(firstPatch);
    const second = await sourceHarness(secondPatch, { topologyDirty: false }).source.applyCommand(secondPatch);

    expect(first.commandId).not.toBe(second.commandId);
    expect(first.commandId.length).toBeLessThanOrEqual(96);
    expect(second.commandId.length).toBeLessThanOrEqual(96);
  });

  it("rejects pause lifecycle, extra keys, malformed IDs, duplicate rows, protocol forgery, and revision forgery before IPC", async () => {
    const cases: unknown[] = [
      {
        ...metadataPatch(),
        topLevelChanges: [{ path: ["paused"], operation: "set", value: true }],
      },
      { ...metadataPatch(), authority: "renderer" },
      { ...metadataPatch(), commandId: "renderer-forged-durable-id" },
      { ...metadataPatch(), protocolVersion: 2 },
      { ...metadataPatch(), baseRevision: 11 },
      {
        ...metadataPatch(),
        topLevelChanges: [{ path: ["stationSlots", 0], operation: "set", value: undefined }],
      },
      {
        ...metadataPatch(),
        topLevelChanges: [],
        changedEntities: [{ id: "entity-a", changes: [
          { path: ["inputs", "iron_ore"], operation: "set", value: 1 },
        ], ownerId: "renderer" }],
      },
      {
        ...metadataPatch(),
        topLevelChanges: [],
        changedEntities: [{ id: "bad\0entity", changes: [
          { path: ["inputs", "iron_ore"], operation: "set", value: 1 },
        ] }],
      },
      {
        ...metadataPatch(),
        topLevelChanges: [],
        changedEntities: [{ id: "entity-a", changes: [
          { path: ["inputs", "iron_ore"], operation: "set", value: 1 },
        ] }],
        removedEntityIds: ["entity-a"],
      },
    ];
    for (const malformed of cases) {
      const harness = sourceHarness(metadataPatch());
      await expect(harness.source.applyCommand(malformed as SimulationCommandPatch)).rejects.toMatchObject({
        code: expect.stringMatching(/INVALID|REVISION_MISMATCH/),
      });
      expect(harness.bridge.getNativePlayerAuthorityState).not.toHaveBeenCalled();
      expect(harness.bridge.applyNativeCoreCommand).not.toHaveBeenCalled();
    }
  });

  it("refuses forged/macro/busy initial frames", () => {
    const bridge = {
      getNativePlayerAuthorityState: vi.fn(),
      applyNativeCoreCommand: vi.fn(),
    } as unknown as Pick<DesktopBridge, "getNativePlayerAuthorityState" | "applyNativeCoreCommand">;
    expect(createNativePlayerAuthorityCommandSource(bridge, {
      ...activeFrame(),
      ownerId: "main-secret",
    } as DesktopNativePlayerAuthorityClockState)).toBeNull();
    expect(createNativePlayerAuthorityCommandSource(
      bridge,
      macroFrame() as unknown as DesktopNativePlayerAuthorityClockState,
    )).toBeNull();
    expect(createNativePlayerAuthorityCommandSource(bridge, activeFrame(10, {
      queuedCommands: 1,
    }))).toBeNull();
    expect(createNativePlayerAuthorityCommandSource(bridge, activeFrame(10, {
      phase: "uncertain",
      lastErrorCode: "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN",
    }))).toBeNull();
  });

  it("enforces one in-flight command and consumes the exact frame after success", async () => {
    const patch = metadataPatch();
    const frame = activeFrame();
    let current: DesktopNativePlayerAuthorityState = frame;
    let resolveApply!: (value: DesktopNativeCoreCommandResult) => void;
    const applyResult = new Promise<DesktopNativeCoreCommandResult>((resolve) => {
      resolveApply = resolve;
    });
    const bridge = {
      getNativePlayerAuthorityState: vi.fn(async () => current),
      applyNativeCoreCommand: vi.fn(async () => applyResult),
    } satisfies Pick<DesktopBridge, "getNativePlayerAuthorityState" | "applyNativeCoreCommand">;
    const source = createNativePlayerAuthorityCommandSource(bridge, frame)!;
    const first = source.applyCommand(patch);
    await vi.waitFor(() => expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1));
    await expect(source.applyCommand(patch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_BUSY",
    });
    current = postCommandFrame(frame);
    resolveApply(receiptForPatch(patch, false));
    await expect(first).resolves.toMatchObject({ revision: 11 });
    await expect(source.applyCommand(patch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
    });
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
  });

  it("fails before mutation when the pulled frame is stale, macro-v2, or uncertain", async () => {
    for (const pulled of [
      activeFrame(11, {
        acknowledgedSequence: 31,
        nextSequence: 32,
      }),
      macroFrame(),
      activeFrame(10, {
        phase: "uncertain",
        lastErrorCode: "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN",
      }),
    ] as DesktopNativePlayerAuthorityState[]) {
      const patch = metadataPatch();
      const harness = sourceHarness(patch);
      harness.setFrame(pulled);
      await expect(harness.source.applyCommand(patch)).rejects.toMatchObject({
        code: "NATIVE_PLAYER_AUTHORITY_COMMAND_FRAME_STALE",
      });
      expect(harness.bridge.applyNativeCoreCommand).not.toHaveBeenCalled();
      await expect(harness.source.applyCommand(patch)).rejects.toMatchObject({
        code: "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
      });
    }
  });

  it("poisons the source when preflight, dispatch, or postflight transport is uncertain", async () => {
    const patch = metadataPatch();
    const frame = activeFrame();
    const preflightFailureBridge = {
      getNativePlayerAuthorityState: vi.fn(async () => { throw new Error("clock pull lost"); }),
      applyNativeCoreCommand: vi.fn(async (_request: DesktopNativeCoreCommandRequest) =>
        receiptForPatch(patch, false)),
    } satisfies Pick<DesktopBridge, "getNativePlayerAuthorityState" | "applyNativeCoreCommand">;
    const preflightFailure = createNativePlayerAuthorityCommandSource(preflightFailureBridge, frame)!;
    await expect(preflightFailure.applyCommand(patch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_TRANSPORT_UNCERTAIN",
      commandId: null,
    });
    expect(preflightFailureBridge.applyNativeCoreCommand).not.toHaveBeenCalled();
    await expect(preflightFailure.applyCommand(patch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
    });

    const dispatchFailureBridge = {
      getNativePlayerAuthorityState: vi.fn(async () => frame),
      applyNativeCoreCommand: vi.fn(async () => { throw new Error("lost IPC reply"); }),
    } satisfies Pick<DesktopBridge, "getNativePlayerAuthorityState" | "applyNativeCoreCommand">;
    const dispatchFailure = createNativePlayerAuthorityCommandSource(dispatchFailureBridge, frame)!;
    await expect(dispatchFailure.applyCommand(patch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_TRANSPORT_UNCERTAIN",
      commandId: expect.stringMatching(/^renderer-local-/),
    });
    await expect(dispatchFailure.applyCommand(patch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
    });
    expect(dispatchFailureBridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);

    const postflightFailureBridge = {
      getNativePlayerAuthorityState: vi.fn()
        .mockResolvedValueOnce(frame)
        .mockRejectedValueOnce(new Error("clock pull lost")),
      applyNativeCoreCommand: vi.fn(async () => receiptForPatch(patch, false)),
    } as unknown as Pick<DesktopBridge, "getNativePlayerAuthorityState" | "applyNativeCoreCommand">;
    const postflightFailure = createNativePlayerAuthorityCommandSource(postflightFailureBridge, frame)!;
    await expect(postflightFailure.applyCommand(patch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_TRANSPORT_UNCERTAIN",
      commandId: expect.stringMatching(/^renderer-local-/),
    });
  });

  it("reconciles a lost response through the read-only main receipt path without resending", async () => {
    const patch = metadataPatch();
    const frame = activeFrame();
    const receipt = receiptForPatch(patch, false);
    const bridge = {
      getNativePlayerAuthorityState: vi.fn(async () => frame),
      applyNativeCoreCommand: vi.fn(async () => { throw new Error("lost IPC reply"); }),
      reconcileNativeCoreCommand: vi.fn(async () => ({ status: "committed" as const, receipt })),
    } satisfies Pick<
      DesktopBridge,
      "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand"
    >;
    const source = createNativePlayerAuthorityCommandSource(bridge, frame)!;
    await expect(source.applyCommand(patch)).rejects.toMatchObject({
      code: "NATIVE_PLAYER_AUTHORITY_COMMAND_TRANSPORT_UNCERTAIN",
    });
    await expect(source.reconcileCommand(patch)).resolves.toEqual({
      status: "committed",
      receipt,
    });
    expect(bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(bridge.reconcileNativeCoreCommand).toHaveBeenCalledTimes(1);
    expect(bridge.reconcileNativeCoreCommand).toHaveBeenCalledWith({
      sessionId: frame.sessionId,
      command: patch,
    });
  });

  it("fails closed for unavailable, absent, conflicting, or malformed reconciliation receipts", async () => {
    const patch = metadataPatch();
    const frame = activeFrame();
    const withoutBridge = sourceHarness(patch).source;
    await expect(withoutBridge.reconcileCommand(patch)).resolves.toEqual({ status: "unavailable" });

    for (const expected of [
      { status: "pending" as const, baseRevision: 10, currentRevision: 10 },
      { status: "not-committed" as const, baseRevision: 10, currentRevision: 10 },
      { status: "conflict" as const, baseRevision: 10, currentRevision: 12 },
    ]) {
      const bridge = {
        getNativePlayerAuthorityState: vi.fn(async () => frame),
        applyNativeCoreCommand: vi.fn(async () => receiptForPatch(patch, false)),
        reconcileNativeCoreCommand: vi.fn(async () => expected),
      } satisfies Pick<
        DesktopBridge,
        "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand"
      >;
      const source = createNativePlayerAuthorityCommandSource(bridge, frame)!;
      await expect(source.reconcileCommand(patch)).resolves.toEqual(expected);
      expect(bridge.applyNativeCoreCommand).not.toHaveBeenCalled();
    }

    const malformedBridge = {
      getNativePlayerAuthorityState: vi.fn(async () => frame),
      applyNativeCoreCommand: vi.fn(async () => receiptForPatch(patch, false)),
      reconcileNativeCoreCommand: vi.fn(async () => ({
        status: "committed" as const,
        receipt: { ...receiptForPatch(patch, false), revision: 99 },
      })),
    } satisfies Pick<
      DesktopBridge,
      "getNativePlayerAuthorityState" | "applyNativeCoreCommand" | "reconcileNativeCoreCommand"
    >;
    await expect(
      createNativePlayerAuthorityCommandSource(malformedBridge, frame)!.reconcileCommand(patch),
    ).rejects.toMatchObject({ code: "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID" });
  });

  it("rejects extra, discontinuous, forged, unstable, duplicate, or topology-mismatched receipts", async () => {
    const fixture = stationSlotPatchFixture();
    const patch = fixture.removalPatch;
    const valid = receiptForPatch(patch, true);
    const cases: unknown[] = [
      { ...valid, ownerId: "main-secret" },
      { ...valid, previousRevision: patch.baseRevision - 1 },
      { ...valid, revision: patch.baseRevision + 2 },
      { ...valid, changedEntityIds: ["forged-entity"] },
      { ...valid, changedBeltIds: [...valid.changedBeltIds].reverse() },
      { ...valid, changedBeltIds: [valid.changedBeltIds[0], valid.changedBeltIds[0]] },
      { ...valid, changedBeltIds: [...valid.changedBeltIds, "forged-belt"].sort() },
      { ...valid, topologyDirty: false },
    ];
    for (const receipt of cases) {
      const harness = sourceHarness(patch, { receipt, topologyDirty: true });
      await expect(harness.source.applyCommand(patch)).rejects.toMatchObject({
        code: "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
        commandId: expect.stringMatching(/^renderer-local-/),
      });
      expect(harness.bridge.applyNativeCoreCommand).toHaveBeenCalledTimes(1);
      await expect(harness.source.applyCommand(patch)).rejects.toMatchObject({
        code: "NATIVE_PLAYER_AUTHORITY_COMMAND_SOURCE_UNAVAILABLE",
      });
    }
  });

  it("accepts bounded Unicode opaque IDs only in UTF-8 stable receipt order", async () => {
    const patch: SimulationCommandPatch = {
      ...metadataPatch(88),
      topLevelChanges: [],
      changedEntities: ["MOD-物品/Ω", "MOD-\uE000", "MOD-𐀀"].map((id) => ({
        id,
        changes: [{ path: ["inputs", "iron_ore"], operation: "set", value: 1 }],
      })),
    };
    const result = await sourceHarness(patch, {
      topologyDirty: false,
      receipt: receiptForPatch(patch, false),
    }).source.applyCommand(patch);
    expect(result.changedEntityIds).toEqual(["MOD-物品/Ω", "MOD-\uE000", "MOD-𐀀"]);
  });

  it("contains no renderer GameState apply/commit fallback", () => {
    const source = readFileSync(resolve("src/game/nativePlayerAuthorityCommandSource.ts"), "utf8");
    expect(source).not.toMatch(/\bGameState\b/);
    expect(source).not.toMatch(/\bapplySimulationCommandPatch(?:Mutable)?\b/);
    expect(source).not.toMatch(/commitNativeCoreOperation|advanceNativeCore|checkpointNativeCore/);
  });
});
