import { expect, test, type Page } from "@playwright/test";

const RELEASE_NOTE_ID = "2026-08-11-v1.0.38";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((releaseNoteId) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
  }, RELEASE_NOTE_ID);
});

test("save Worker returns a transferable verified sparse envelope", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const state = engine.createInitialState(1, false);
    const startedAt = performance.now();
    const saved = await storage.serializeEnvelopeInWorker(state, 1_786_377_600_000);
    const slotted = await storage.serializeEnvelopeInWorker(state, 1_786_377_600_001, "slot", undefined, 2);
    const slotWrite = await storage.saveGameSlotVerified(2, state);
    const snapshot = await storage.saveGameSnapshotVerified(state, "1.0.38 Worker 快照测试");
    const parsed = JSON.parse(saved.raw);
    const parsedSlot = JSON.parse(slotted.raw);
    const firstBelt = parsed.state.belts?.[0] ?? null;
    return {
      durationMs: performance.now() - startedAt,
      usedWorker: saved.usedWorker,
      verification: saved.verification,
      summary: saved.summary,
      valid: storage.inspectSave(saved.raw).valid,
      bytes: new TextEncoder().encode(saved.raw).byteLength,
      firstBelt,
      slotWorker: slotted.usedWorker,
      slotEnvelope: { kind: parsedSlot.kind, slot: parsedSlot.slot, mode: parsedSlot.mode },
      slotWriteSuccess: slotWrite.success,
      slotLoaded: storage.loadGameSlot(2, "normal")?.state.version ?? null,
      snapshot,
    };
  });
  expect(result.usedWorker).toBe(true);
  expect(result.verification).toMatchObject({ integrity: "valid", byteLength: result.bytes });
  expect(result.verification.payloadChecksum).toHaveLength(8);
  expect(result.verification.stateChecksum).toBe(result.summary?.stateChecksum);
  expect(result.valid).toBe(true);
  expect(result.firstBelt).toBeNull();
  expect(result.slotWorker).toBe(true);
  expect(result.slotEnvelope).toEqual({ kind: "slot", slot: 2, mode: "normal" });
  expect(result.slotWriteSuccess).toBe(true);
  expect(result.slotLoaded).toBe(46);
  expect(result.snapshot).toMatchObject({ reason: "1.0.38 Worker 快照测试", integrity: "valid", valid: true });
});

test("paused normal save can add exactly one second unipolar vein after snapshot and double confirmation", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/?menu=1");
  const seeded = await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const integrity = await import("/src/game/resourceIntegrity.ts");
    const storage = await import("/src/game/storage.ts");
    const state = engine.createInitialState(1, false);
    state.paused = true;
    const audit = integrity.auditUnipolarVeins(state);
    const saved = await storage.saveGameVerified(state);
    return { count: audit.observedTotal, saved: saved.success };
  });
  expect(seeded).toEqual({ count: 1, saved: true });
  await page.goto("/");
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "存档" }).click();
  const tool = operations.getByRole("region", { name: "单极磁石矿脉扩容工具" });
  await expect(tool).toContainText("当前数量 1");
  await tool.getByRole("button", { name: "备份后增加 1 个矿脉" }).click();
  await page.getByRole("button", { name: "继续确认" }).click();
  await page.getByRole("button", { name: "创建快照并增加" }).click();
  await expect(tool).toContainText("当前 2 个，硬上限 2", { timeout: 45_000 });
  await expect(tool.getByRole("button", { name: "备份后增加 1 个矿脉" })).toBeDisabled();

  const persisted = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const loaded = storage.loadGame("normal").state;
    const veins = loaded.entities.filter((entity) => entity.kind === "vein" && entity.resourceId === "unipolar_magnet");
    const added = veins.find((entity) => entity.id === "ashen_unipolar_secondary");
    return {
      count: veins.length,
      addedOutputs: added?.outputs.unipolar_magnet ?? -1,
      addedMiners: added?.minerCount ?? -1,
      snapshotReasons: storage.getSaveSnapshotSummaries("normal").map((snapshot) => snapshot.reason),
    };
  });
  expect(persisted).toMatchObject({ count: 2, addedOutputs: 0, addedMiners: 0 });
  expect(persisted.snapshotReasons).toContain("增加第二个单极磁石矿脉前");
});

function seedDenseCanvas() {
  return (releaseNoteId: string) => {
    const entities = Array.from({ length: 80 }, (_, index) => ({
      id: `v138-machine-${index}`,
      kind: "machine",
      planetId: "home",
      position: { x: (index % 10) * 310, y: Math.floor(index / 10) * 220 },
      interactionLocked: false,
      buildingId: "arc_smelter",
      recipeId: index < 40 ? "iron_ingot" : "steel",
      machineCount: 10,
      minerCount: 0,
      inputs: { iron_ore: 600 },
      outputs: { iron_ingot: 600 },
      progress: 0.4,
      utilization: 1,
      productionRate: 600,
    }));
    const belts = Array.from({ length: 1_600 }, (_, index) => ({
      id: `v138-belt-${String(index).padStart(4, "0")}`,
      planetId: "home",
      source: `v138-machine-${index % 40}`,
      target: `v138-machine-${40 + ((index * 7 + 1) % 40)}`,
      itemId: "iron_ingot",
      lanes: 2,
      tier: 1,
      sorterTier: 1,
      stackSize: 1,
      progress: (index % 10) / 10,
      priority: 1,
      totalTransferred: index * 20,
      lastFlow: index % 3 === 0 ? 12 : 4,
      congestion: 0.2,
    }));
    const state = {
      version: 46,
      nextId: 1,
      activePlanetId: "home",
      entities,
      belts,
      construction: {},
      tray: {},
      planetTrays: { home: {} },
      planetTrayItemLimits: { home: 1_000_000 },
      totalProduced: {},
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"], surveyProgressBySystem: { helios: 1 }, missions: [] },
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      settings: { theme: "dark", fontScale: 2, simulationSpeed: 1, autosaveIntervalSeconds: 120 },
      paused: true,
    };
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.endgame-extreme.v1", "true");
    localStorage.setItem("dsp-idle-network.endgame-extreme-ack.v1", "true");
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  };
}

async function sampleInteraction(page: Page, label: string, action: () => Promise<void>) {
  const sample = page.evaluate(async ({ label }) => {
    const frames: number[] = [];
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => longTasks.push(entry.duration)));
    try { observer.observe({ type: "longtask" }); } catch { /* optional */ }
    const startedAt = performance.now();
    let previous = startedAt;
    await new Promise<void>((resolve) => {
      const frame = (now: number) => {
        frames.push(now - previous);
        previous = now;
        if (now - startedAt >= 650) resolve();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    observer.disconnect();
    const ordered = [...frames].sort((left, right) => left - right);
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    return {
      label,
      frames: frames.length,
      p95Ms: ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0,
      maxFrameMs: ordered.at(-1) ?? 0,
      longTaskCount: longTasks.length,
      maxLongTaskMs: Math.max(0, ...longTasks),
      heapBytes: heap,
      domNodes: document.querySelectorAll(".react-flow__node").length,
      domEdges: document.querySelectorAll(".react-flow__edge").length,
    };
  }, { label });
  await Promise.all([sample, action()]);
  return sample;
}

test("bounded canvas matrix covers paused/running pan, zoom, selections, inspector, 200% desktop and mobile", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(seedDenseCanvas(), RELEASE_NOTE_ID);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const factory = page.locator(".factory-canvas");
  await expect(factory).toHaveAttribute("data-batch-renderer", "true");
  await expect(page.locator("canvas.canvas-belt-layer")).toHaveAttribute("data-segments", "1600");
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(300);
  const pane = page.locator(".react-flow__pane");
  const pan = async () => {
    const bounds = await pane.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    for (let index = 0; index < 8; index += 1) await page.mouse.wheel(index % 2 ? -18 : 18, index % 3 ? 8 : -8);
  };
  const metrics = [];
  const sourceHandle = await page.locator('.react-flow__node[data-id="v138-machine-0"] .react-flow__handle.source').first().boundingBox();
  expect(sourceHandle).not.toBeNull();
  metrics.push(await sampleInteraction(page, "select-belt", async () => {
    const point = { x: sourceHandle!.x + sourceHandle!.width + 8, y: sourceHandle!.y + sourceHandle!.height / 2 };
    await page.mouse.move(point.x, point.y);
    await expect.poll(() => page.locator(".react-flow__edge").count()).toBeGreaterThan(0);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
  }));
  metrics.push(await sampleInteraction(page, "paused-pan", pan));
  metrics.push(await sampleInteraction(page, "paused-zoom", async () => {
    await page.locator(".react-flow__controls-zoomin").click();
    await page.locator(".react-flow__controls-zoomout").click();
  }));
  metrics.push(await sampleInteraction(page, "select-building-open-inspector", async () => {
    await page.locator('.react-flow__node[data-id="v138-machine-0"]').click();
    await expect(page.locator(".inspector-panel")).toBeVisible();
  }));
  metrics.push(await sampleInteraction(page, "close-inspector", async () => {
    await page.getByLabel("边缘按钮：收起右侧检查器面板").click();
  }));
  await page.getByLabel("继续模拟").click();
  metrics.push(await sampleInteraction(page, "running-pan", pan));

  await page.setViewportSize({ width: 390, height: 844 });
  metrics.push(await sampleInteraction(page, "mobile-200%-pan", pan));
  expect(metrics.every((metric) => metric.frames > 5)).toBe(true);
  expect(metrics.every((metric) => metric.maxLongTaskMs < 1_500)).toBe(true);
  expect(metrics.every((metric) => metric.domNodes > 0)).toBe(true);
  console.info("V138_CANVAS_MATRIX", JSON.stringify(metrics));
});
