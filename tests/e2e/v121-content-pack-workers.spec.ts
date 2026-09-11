import { expect, test } from "@playwright/test";

test("custom recipes run identically in main, realtime Worker, offline Worker, and belt input", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const packs = await import("/src/game/contentPacks.ts");
    const mods = await import("/src/game/mods.ts");
    const benchmark = await import("/src/game/benchmark.ts");
    const offlineSimulation = await import("/src/game/offlineSimulation.ts");
    const validation = mods.validateContentPack({
      formatVersion: 2,
      id: "worker_registry_regression",
      name: "Worker Registry Regression",
      version: "1.0.0",
      recipes: [{
        id: "worker_gravity_matrix_to_warpers",
        name: "Worker 引力矩阵制空间翘曲器",
        buildingId: "assembling_machine_mk1",
        duration: 10,
        inputs: [{ itemId: "gravity_matrix", amount: 1 }],
        outputs: [{ itemId: "space_warper", amount: 8 }],
      }],
    });
    if (!validation.valid) throw new Error("内容包夹具无效");
    const registry = packs.registerContentPack(packs.createContentPackRegistry(), validation).registry;
    const snapshot = packs.createContentPackRuntimeSnapshot(registry);
    packs.applyContentPackRuntimeSnapshot(snapshot);

    let initial = engine.createInitialState();
    initial.research.completedTechIds.push("space_warp");
    initial.construction.wind_turbine = 100;
    initial.construction.assembling_machine_mk1 = 3;
    initial.construction.storage_mk1 = 1;
    initial = engine.placeBuilding(initial, "wind_turbine", { x: -300, y: 0 }, 100);
    initial = engine.placeBuilding(initial, "storage_mk1", { x: 0, y: 300 });
    initial = engine.placeBuilding(initial, "assembling_machine_mk1", { x: 340, y: 0 });
    initial = engine.placeBuilding(initial, "assembling_machine_mk1", { x: 340, y: 300 });
    initial = engine.placeBuilding(initial, "assembling_machine_mk1", { x: 340, y: 600 });
    const storage = initial.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    const assemblers = initial.entities.filter((entity) => entity.buildingId === "assembling_machine_mk1");
    initial = engine.setEntityRecipe(initial, assemblers[0].id, "worker_gravity_matrix_to_warpers" as never);
    initial = engine.setEntityRecipe(initial, assemblers[1].id, "worker_gravity_matrix_to_warpers" as never);
    initial = engine.setEntityRecipe(initial, assemblers[2].id, "space_warper_from_gravity_matrix");
    initial.entities.find((entity) => entity.id === assemblers[0].id)!.inputs.gravity_matrix = 1;
    initial.entities.find((entity) => entity.id === assemblers[2].id)!.inputs.gravity_matrix = 1;
    const source = initial.entities.find((entity) => entity.id === storage.id)!;
    source.outputs.gravity_matrix = 1;
    source.storedItemId = "gravity_matrix";
    initial.belts.push({
      id: "worker_registry_belt",
      planetId: "home",
      source: storage.id,
      target: assemblers[1].id,
      itemId: "gravity_matrix",
      lanes: 1,
      tier: 1,
      sorterTier: 3,
      priority: 1,
      stackSize: 1,
      monitorEnabled: false,
      routeMode: "auto",
      progress: 0,
      totalTransferred: 0,
      congestion: 0,
      lastFlow: 0,
    });

    const runRealtime = (state: typeof initial) => new Promise<typeof initial>((resolve, reject) => {
      const worker = new Worker(new URL("/src/game/simulation.worker.ts", location.origin), { type: "module" });
      const timeout = window.setTimeout(() => { worker.terminate(); reject(new Error("实时 Worker 超时")); }, 10_000);
      worker.onerror = () => { window.clearTimeout(timeout); worker.terminate(); reject(new Error("实时 Worker 错误")); };
      worker.onmessage = (event) => {
        if (event.data.id !== 1) return;
        window.clearTimeout(timeout);
        worker.terminate();
        if (!event.data.state) reject(new Error(event.data.registryError ?? "实时 Worker 未返回状态"));
        else resolve(event.data.state);
      };
      worker.postMessage({ id: 1, state, simulationSeconds: 20, wallSeconds: 20, registryFingerprint: snapshot.fingerprint, registry: snapshot });
    });
    const runOffline = (state: typeof initial) => offlineSimulation.runOfflineSimulationInWorker(state, 20, { registry: snapshot });

    packs.applyContentPackRuntimeSnapshot(snapshot);
    const main = engine.advanceSimulation(structuredClone(initial), 20);
    const realtime = await runRealtime(structuredClone(initial));
    const offline = await runOffline(structuredClone(initial));
    const summarize = (state: typeof initial) => ({
      // Transferable JSON canonicalizes explicitly-present `undefined` fields
      // to absence; compare the exact persisted representation on every path.
      hash: benchmark.hashGameState(JSON.parse(JSON.stringify(state))),
      machines: assemblers.map((assembler) => {
        const entity = state.entities.find((candidate) => candidate.id === assembler.id)!;
        return { input: entity.inputs.gravity_matrix ?? 0, output: entity.outputs.space_warper ?? 0, progress: entity.progress };
      }),
      beltTransferred: state.belts.find((belt) => belt.id === "worker_registry_belt")?.totalTransferred ?? 0,
    });
    return { main: summarize(main), realtime: summarize(realtime), offline: summarize(offline) };
  });

  expect(result.main.machines).toEqual([
    expect.objectContaining({ input: 0, output: 8 }),
    expect.objectContaining({ input: 0, output: 8 }),
    expect.objectContaining({ input: 0, output: 8 }),
  ]);
  expect(result.main.beltTransferred).toBe(1);
  expect(result.realtime).toEqual(result.main);
  expect(result.offline).toEqual(result.main);
});

test("one persistent Worker applies an updated registry and stops using a disabled definition", async ({ page }) => {
  await page.goto("/");
  const outputs = await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const packs = await import("/src/game/contentPacks.ts");
    const mods = await import("/src/game/mods.ts");
    const createSnapshot = (version: string, amount: number) => {
      const validation = mods.validateContentPack({
        formatVersion: 2,
        id: "worker_registry_regression",
        name: "Worker Registry Regression",
        version,
        recipes: [{
          id: "worker_gravity_matrix_to_warpers",
          name: "Worker 引力矩阵制空间翘曲器",
          buildingId: "assembling_machine_mk1",
          duration: 10,
          inputs: [{ itemId: "gravity_matrix", amount: 1 }],
          outputs: [{ itemId: "space_warper", amount }],
        }],
      });
      return packs.createContentPackRuntimeSnapshot(packs.registerContentPack(packs.createContentPackRegistry(), validation).registry);
    };
    const v1 = createSnapshot("1.0.0", 8);
    const v2 = createSnapshot("2.0.0", 16);
    packs.applyContentPackRuntimeSnapshot(v1);
    let initial = engine.createInitialState();
    initial.construction.wind_turbine = 100;
    initial.construction.assembling_machine_mk1 = 1;
    initial = engine.placeBuilding(initial, "wind_turbine", { x: -300, y: 0 }, 100);
    initial = engine.placeBuilding(initial, "assembling_machine_mk1", { x: 0, y: 0 });
    const machineId = initial.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id;
    initial = engine.setEntityRecipe(initial, machineId, "worker_gravity_matrix_to_warpers" as never);
    const resetInput = () => {
      const state = structuredClone(initial);
      state.entities.find((entity) => entity.id === machineId)!.inputs.gravity_matrix = 1;
      return state;
    };
    const worker = new Worker(new URL("/src/game/simulation.worker.ts", location.origin), { type: "module" });
    const request = (id: number, state: typeof initial, snapshot: ReturnType<typeof createSnapshot>) => new Promise<typeof initial>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Worker 注册表更新超时")), 10_000);
      const listener = (event: MessageEvent) => {
        if (event.data.id !== id) return;
        worker.removeEventListener("message", listener);
        window.clearTimeout(timeout);
        if (!event.data.state) reject(new Error(event.data.registryError ?? "Worker 注册表更新失败"));
        else resolve(event.data.state);
      };
      worker.addEventListener("message", listener);
      worker.postMessage({ id, state, simulationSeconds: 20, wallSeconds: 20, registryFingerprint: snapshot.fingerprint, registry: snapshot });
    });
    const first = await request(1, resetInput(), v1);
    const updated = await request(2, resetInput(), v2);
    const disabled = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const removed = await request(3, resetInput(), disabled);
    worker.terminate();
    const output = (state: typeof initial) => state.entities.find((entity) => entity.id === machineId)!.outputs.space_warper ?? 0;
    return [output(first), output(updated), output(removed)];
  });

  expect(outputs).toEqual([8, 16, 0]);
});

test("realtime Worker receives custom items, buildings, recipes, and building overrides", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const packs = await import("/src/game/contentPacks.ts");
    const mods = await import("/src/game/mods.ts");
    const validation = mods.validateContentPack({
      formatVersion: 2,
      id: "worker_full_registry",
      name: "Worker Full Registry",
      version: "1.0.0",
      items: [{ id: "worker_alloy", name: "Worker 合金", kind: "solid" }],
      buildings: [{ id: "worker_fabricator", name: "Worker 制造机", costs: [{ itemId: "iron_ingot", amount: 2 }] }],
      recipes: [
        { id: "worker_alloy_recipe", name: "Worker 合金制造", buildingId: "worker_fabricator", duration: 2, inputs: [{ itemId: "iron_ingot", amount: 1 }], outputs: [{ itemId: "worker_alloy", amount: 1 }] },
        { id: "worker_override_recipe", name: "Worker 加速验证", buildingId: "arc_smelter", duration: 10, inputs: [{ itemId: "iron_ingot", amount: 1 }], outputs: [{ itemId: "worker_alloy", amount: 1 }] },
      ],
      buildingOverrides: [{ id: "arc_smelter", speed: 2, inputCapacity: 12_345, outputCapacity: 23_456 }],
    });
    if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join("；"));
    const snapshot = packs.createContentPackRuntimeSnapshot(packs.registerContentPack(packs.createContentPackRegistry(), validation).registry);
    packs.applyContentPackRuntimeSnapshot(snapshot);
    let state = engine.createInitialState();
    state.construction.wind_turbine = 100;
    state.construction.arc_smelter = 1;
    state.construction.worker_fabricator = 1;
    state = engine.placeBuilding(state, "wind_turbine", { x: -300, y: 0 }, 100);
    state = engine.placeBuilding(state, "worker_fabricator", { x: 0, y: 0 });
    state = engine.placeBuilding(state, "arc_smelter", { x: 340, y: 0 });
    const custom = state.entities.find((entity) => entity.buildingId === "worker_fabricator")!;
    const overridden = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = engine.setEntityRecipe(state, custom.id, "worker_alloy_recipe" as never);
    state = engine.setEntityRecipe(state, overridden.id, "worker_override_recipe" as never);
    state.entities.find((entity) => entity.id === custom.id)!.inputs.iron_ingot = 1;
    state.entities.find((entity) => entity.id === overridden.id)!.inputs.iron_ingot = 1;
    const worker = new Worker(new URL("/src/game/simulation.worker.ts", location.origin), { type: "module" });
    const completed = await new Promise<typeof state>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("完整注册表 Worker 超时")), 10_000);
      worker.onmessage = (event) => {
        if (event.data.id !== 1) return;
        window.clearTimeout(timeout);
        if (!event.data.state) reject(new Error(event.data.registryError ?? "完整注册表 Worker 失败"));
        else resolve(event.data.state);
      };
      worker.postMessage({ id: 1, state, simulationSeconds: 5, wallSeconds: 5, registryFingerprint: snapshot.fingerprint, registry: snapshot });
    });
    worker.terminate();
    return {
      customOutput: completed.entities.find((entity) => entity.id === custom.id)?.outputs.worker_alloy ?? 0,
      overrideOutput: completed.entities.find((entity) => entity.id === overridden.id)?.outputs.worker_alloy ?? 0,
    };
  });

  expect(result).toEqual({ customOutput: 1, overrideOutput: 1 });
});
