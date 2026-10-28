import { blueprintScaleFixture } from "../web-blueprint-scale/fixture";
import { createBlueprint, fundConstructionQueueEntry, placeBlueprint, queueBlueprint } from "../../src/game/engine";
import { parseBlueprintExchange, serializeBlueprintExchange } from "../../src/game/blueprintExchange";
import type { BlueprintDefinition, GameState } from "../../src/game/types";

const digest = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(JSON.stringify(value)),
))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function runBlueprintScale() {
  const base = (await (await fetch("/prepared.json")).json()).state as GameState;
  const fixture = blueprintScaleFixture({ ...base, constructionQueue: [], blueprintVersions: [] });
  const before = await digest(fixture.state);
  const samples = [];
  let blueprint: BlueprintDefinition | undefined;
  let captured: GameState | undefined;
  for (let index = 0; index < 3; index += 1) {
    const started = performance.now();
    const result = createBlueprint(fixture.state, fixture.entityIds, "规模边界");
    samples.push(performance.now() - started);
    captured = result;
    blueprint = result.blueprints.at(-1);
    if (!blueprint || blueprint.entities.length !== 4096 || blueprint.belts.length !== 8192) throw new Error("Incomplete capture");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const started = performance.now();
  const raw = serializeBlueprintExchange(blueprint!);
  const exportedAt = performance.now();
  const parsed = parseBlueprintExchange(raw);
  const parsedAt = performance.now();
  if (!parsed.valid || !parsed.blueprint || parsed.blueprint.entities.length !== 4096 || parsed.blueprint.belts.length !== 8192) {
    throw new Error("Incomplete exchange round trip");
  }
  if (before !== await digest(fixture.state)) throw new Error("Capture changed its caller");
  const source = { ...captured!, construction: { ...captured!.construction, storage_mk1: 4096, conveyor_belt_mk1: 8192 } };
  const sourceHash = await digest(source);
  let maximumX = 0;
  let maximumY = 0;
  for (const entity of source.entities) {
    maximumX = Math.max(maximumX, entity.position.x);
    maximumY = Math.max(maximumY, entity.position.y);
  }
  const position = { x: maximumX + 10_000, y: maximumY + 10_000 };
  async function placement(queued: boolean) {
    const started = performance.now();
    const order = queued ? queueBlueprint(source, blueprint!.id, position) : source;
    const queuedAt = performance.now();
    if (queued && order.constructionQueue.length !== 1) throw new Error("Queue was not created");
    const result = queued ? fundConstructionQueueEntry(order, order.constructionQueue[0].id) : placeBlueprint(source, blueprint!.id, position);
    const finished = performance.now();
    if (result.entities.length - source.entities.length !== 4096 || result.belts.length - source.belts.length !== 8192 ||
        result.construction.storage_mk1 !== 0 || result.construction.conveyor_belt_mk1 !== 0 || result.constructionQueue.length) {
      throw new Error("Incomplete large deployment or material settlement");
    }
    return { queueMs: queuedAt - started, deployOrFundMs: finished - queuedAt, totalMs: finished - started,
      fullStateSha256: await digest(result) };
  }
  const direct = await placement(false);
  const queue = await placement(true);
  if (sourceHash !== await digest(source) || before !== await digest(fixture.state)) throw new Error("Deployment changed its caller");
  return { scope: "Synthetic 4096-node/8192-line storage grid appended to a real endgame factory, empty lab queue and fixed construction stock; capture, complete exchange, direct deployment and queue funding measured separately with full output/caller hashes; no whole-UI or OS-memory qualification",
    captureSamplesMs: samples, exportMs: exportedAt - started, parseMs: parsedAt - exportedAt,
    serializedBytes: new TextEncoder().encode(raw).byteLength, nodes: blueprint!.entities.length,
    belts: blueprint!.belts.length, factoryEntities: fixture.state.entities.length,
    factoryBelts: fixture.state.belts.length, callerUnchanged: true,
    capturedBlueprintSha256: await digest(blueprint), canonicalExchangeBlueprintSha256: await digest(parsed.blueprint), direct, queue, forcedGc: false };
}

Object.assign(globalThis, { runBlueprintScale });
