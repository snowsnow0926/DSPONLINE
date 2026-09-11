import { expect, test, type Page } from "@playwright/test";

async function readRecoveryProof(page: Page) {
  return page.evaluate(async () => {
    const local = await import("/src/game/localSaveStore.ts");
    const persistence = await import("/src/game/simulationRuntimeRecoveryPersistenceClient.ts");
    const identity = local.getPrimaryLocalSaveRecoveryIdentity("normal");
    const writer = local.getLocalSaveWriterStatus();
    if (!identity || writer.role !== "primary") throw new Error("verified primary/recovery writer missing");
    const read = await persistence.readSimulationRuntimeRecoveryInPersistenceWorker(identity, {
      ownerId: writer.writerId,
      fencingToken: writer.fencingToken,
    });
    if (!read.ok || !read.proof) throw new Error(read.ok ? "recovery proof missing" : read.message);
    const intents = [
      ...(read.recovery?.entries ?? []).flatMap((entry) => entry.kind === "atomic" ? [entry.intent] : []),
      ...(read.recovery?.pendingIntent ? [read.recovery.pendingIntent] : []),
    ];
    return {
      identity,
      sequence: read.proof.sequence,
      stateRevision: read.proof.stateRevision,
      pending: read.proof.pending,
      finalized: read.proof.finalized,
      commandCount: (read.recovery?.entries ?? []).reduce((count, entry) =>
        count + (entry.kind === "atomic" && entry.intent.command ? 1 : 0), 0) +
        (read.recovery?.pendingIntent?.command ? 1 : 0),
      viewportCommandCount: intents.filter((intent) => intent.command?.topLevelChanges.some((change) =>
        change.path[0] === "planetViewports")).length,
    };
  });
}

async function readStoredState(page: Page) {
  return page.evaluate(async () => {
    const local = await import("/src/game/localSaveStore.ts");
    await local.flushLocalSaveWrites();
    const raw = await local.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    if (!raw) throw new Error("persisted primary missing");
    return JSON.parse(raw).state;
  });
}

async function sealPagehideAndContinue(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    window.dispatchEvent(new CustomEvent("dsp-native-app-state", { detail: { isActive: false } }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /继续游戏/ }).click();
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active");
  return shell;
}

async function findBlankCanvasPoint(page: Page) {
  return page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return null;
    const bounds = pane.getBoundingClientRect();
    for (let y = bounds.top + 48; y < bounds.bottom - 48; y += 24) {
      for (let x = bounds.left + 48; x < bounds.right - 48; x += 24) {
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    return null;
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
  });
});

test("recovers a failed durable finalize in the current page before resume", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const tracker = { armed: false, finalizeFailures: 0 };
    (window as typeof window & { __v146DurableRepair?: typeof tracker }).__v146DurableRepair = tracker;
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const isPersistence = String(args[0]).includes("simulationRuntimeRecoveryPersistence.worker") &&
          (args[1] as WorkerOptions | undefined)?.name === "runtime-recovery-persistence";
        if (!isPersistence) return worker;
        const nativePostMessage = worker.postMessage.bind(worker);
        let failed = false;
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          if (!failed && tracker.armed && message.type === "finalize") {
            failed = true;
            tracker.finalizeFailures += 1;
            // Leave the staged intent in IndexedDB and fail the client before
            // the finalize response can be consumed by the page.
            window.setTimeout(() => {
              worker.terminate();
              worker.dispatchEvent(new ErrorEvent("error", { message: "injected durable finalize failure" }));
            }, 0);
            return;
          }
          if (transferOrOptions === undefined) nativePostMessage(message);
          else nativePostMessage(message, transferOrOptions);
        }) as typeof worker.postMessage;
        return worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  });

  await page.goto("/?menu=1");
  await page.getByRole("button", { name: /开始游戏/ }).click();
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active");
  await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 20_000 });

  const beforePause = await readRecoveryProof(page);
  await page.getByLabel("暂停模拟").click();
  await expect.poll(async () => (await readRecoveryProof(page)).sequence, { timeout: 20_000 })
    .toBeGreaterThan(beforePause.sequence);
  await page.evaluate(() => {
    (window as typeof window & { __v146DurableRepair?: { armed: boolean } }).__v146DurableRepair!.armed = true;
  });
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.getByRole("button", { name: "教程、版本与其他", exact: true }).first().click();
  await operations.getByRole("button", { name: "舒缓", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __v146DurableRepair?: { finalizeFailures: number } }
  ).__v146DurableRepair?.finalizeFailures ?? 0), { timeout: 20_000 }).toBe(1);
  await operations.getByLabel("关闭运营中心").click();
  await expect(page.getByLabel("继续模拟")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/durable 模拟 Worker 异常|durable 模拟回执/).first()).toBeVisible({ timeout: 20_000 });

  await page.getByLabel("继续模拟").click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 60_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 60_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active");
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
  const proof = await readRecoveryProof(page);
  expect(proof.pending).toBe(false);
  expect(proof.finalized).toBe(true);
});

test("running and paused UI commands drain through WAL before pagehide without promoting an emergency primary", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: /开始游戏/ }).click();
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active");
  const initialProof = await readRecoveryProof(page);

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.getByRole("button", { name: "教程、版本与其他", exact: true }).first().click();
  const relaxedDifficulty = operations.getByRole("button", { name: "舒缓", exact: true });
  await relaxedDifficulty.click();
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending ? -1 : proof.commandCount;
  }).toBeGreaterThan(initialProof.commandCount);
  const afterRunningEdit = await readRecoveryProof(page);

  await operations.getByLabel("关闭运营中心").click();
  const pause = page.getByLabel("暂停模拟");
  if (await pause.isVisible()) await pause.click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");
  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending ? -1 : proof.commandCount;
  }).toBeGreaterThan(afterRunningEdit.commandCount);

  // Two edits while the first durable command may still be in flight may be
  // coalesced, but the last visible value must be staged/finalized and survive
  // reload exactly once.
  const beforeRapidEdits = await readRecoveryProof(page);
  await page.getByLabel("打开设置").click();
  const pausedOperations = page.getByRole("dialog", { name: "运营中心" });
  await pausedOperations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await pausedOperations.getByRole("button", { name: "教程、版本与其他", exact: true }).first().click();
  await pausedOperations.getByRole("button", { name: "高压", exact: true }).click();
  await pausedOperations.getByRole("button", { name: "舒缓", exact: true }).click();
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending ? -1 : proof.commandCount;
  }).toBeGreaterThan(beforeRapidEdits.commandCount);
  await pausedOperations.getByLabel("关闭运营中心").click();

  const beforeHide = await readRecoveryProof(page);
  expect(beforeHide.sequence).toBeGreaterThanOrEqual(2);
  expect(beforeHide.pending).toBe(false);
  expect(beforeHide.finalized).toBe(true);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    // A native/visibility callback can already be queued behind pagehide.
    // The durable-active lifecycle guard must reject that late enqueue too.
    window.dispatchEvent(new CustomEvent("dsp-native-app-state", { detail: { isActive: false } }));
  });
  await page.waitForTimeout(250);
  const afterHideIdentity = await page.evaluate(async () => {
    const local = await import("/src/game/localSaveStore.ts");
    await local.flushLocalSaveWrites();
    return {
      identity: local.getPrimaryLocalSaveRecoveryIdentity("normal"),
      emergencyPayload: localStorage.getItem("dsp-idle-network.local-save-coordination.v1.emergency-mirror.normal.payload"),
      emergencyMetadata: localStorage.getItem("dsp-idle-network.local-save-coordination.v1.emergency-mirror.normal.metadata"),
    };
  });
  expect(afterHideIdentity.identity).toEqual(beforeHide.identity);
  expect(afterHideIdentity.emergencyPayload).toBeNull();
  expect(afterHideIdentity.emergencyMetadata).toBeNull();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active");
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");
});

test("undo, redo, viewport and galactic activity edits survive immediate pagehide/reload", async ({ page }) => {
  test.setTimeout(90_000);
  const activity = {
    enabled: true,
    status: "active",
    serverNow: Date.now(),
    id: "wal-pagehide-activity",
    revision: "1",
    startsAtMs: Date.now() - 1_000,
    endsAtMs: Date.now() + 86_400_000,
    openEnded: true,
    personalTargets: { universe_matrix: 10, solar_sail: 10, small_carrier_rocket: 10, antimatter_fuel_rod: 10 },
    globalTargets: { universe_matrix: 100, solar_sail: 100, small_carrier_rocket: 100, antimatter_fuel_rod: 100 },
    globalDelivered: { universe_matrix: 1, solar_sail: 1, small_carrier_rocket: 1, antimatter_fuel_rod: 1 },
  } as const;
  let activityRequestCount = 0;
  let activityResponse: "none" | "defer-active" | "active" = "none";
  let releaseActiveResponse: (() => void) | null = null;
  await page.route("**/api/public-status", async (route) => {
    activityRequestCount += 1;
    const shouldDefer = activityResponse === "defer-active";
    if (shouldDefer) {
      await new Promise<void>((resolve) => { releaseActiveResponse = resolve; });
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        timeZone: "Asia/Shanghai",
        today: "2026-08-15",
        uptimeSeconds: 1,
        players: { total: 1, today: 1, online: 1, onlineWindowSeconds: 120 },
        activity: activityResponse === "none" ? null : activity,
      }),
    });
  });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: /开始游戏/ }).click();
  let shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active");
  const pause = page.getByLabel("暂停模拟");
  if (await pause.isVisible()) await pause.click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");

  // Undo and redo are ordinary UI state replacements, not simulation internals.
  await page.getByLabel("打开设置").click();
  let operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.getByRole("button", { name: "教程、版本与其他", exact: true }).first().click();
  await operations.getByRole("button", { name: "舒缓", exact: true }).click();
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
  await operations.getByLabel("关闭运营中心").click();
  const beforeUndo = await readRecoveryProof(page);
  await page.getByLabel("撤销", { exact: true }).click();
  await expect(shell).toHaveAttribute("data-difficulty", "standard");
  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending ? -1 : proof.commandCount;
  }).toBeGreaterThan(beforeUndo.commandCount);
  shell = await sealPagehideAndContinue(page);
  await expect(shell).toHaveAttribute("data-difficulty", "standard");

  // A reload intentionally clears the in-memory history stack. Create a fresh
  // edit, undo it, and exercise redo before the next seal.
  await page.getByLabel("打开设置").click();
  operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.getByRole("button", { name: "教程、版本与其他", exact: true }).first().click();
  const beforeRedoSetup = await readRecoveryProof(page);
  await operations.getByRole("button", { name: "舒缓", exact: true }).click();
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
  await operations.getByLabel("关闭运营中心").click();
  // Let the first edit reach its finalized durable revision before undoing it.
  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending ? -1 : proof.commandCount;
  }).toBeGreaterThan(beforeRedoSetup.commandCount);
  await expect.poll(async () => {
    const [runtimeSequence, runtimeRevision] = await Promise.all([
      shell.getAttribute("data-runtime-recovery-sequence"),
      shell.getAttribute("data-runtime-recovery-revision"),
    ]);
    return [runtimeSequence, runtimeRevision].join(":");
  }).not.toBe("-1:-1");
  await page.getByLabel("撤销", { exact: true }).click();
  await expect(shell).toHaveAttribute("data-difficulty", "standard");
  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending ? -1 : proof.commandCount;
  }).toBeGreaterThan(beforeRedoSetup.commandCount);
  const beforeRedo = await readRecoveryProof(page);
  await page.getByLabel("重做", { exact: true }).click();
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending ? -1 : proof.commandCount;
  }).toBeGreaterThan(beforeRedo.commandCount);
  shell = await sealPagehideAndContinue(page);
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");

  // Viewport persistence is debounced, then represented as a durable command.
  const viewportBefore = (await readStoredState(page)).planetViewports.home;
  const point = await findBlankCanvasPoint(page);
  expect(point).not.toBeNull();
  const beforeViewportProof = await readRecoveryProof(page);
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.down();
  await page.mouse.move(point!.x + 96, point!.y + 48, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending ? -1 : proof.viewportCommandCount;
  }, { timeout: 10_000 }).toBeGreaterThan(beforeViewportProof.viewportCommandCount);
  shell = await sealPagehideAndContinue(page);
  const viewportAfter = (await readStoredState(page)).planetViewports.home;
  expect(viewportAfter).not.toEqual(viewportBefore);

  // Public activity synchronization is also a GameState edit and must use the
  // same WAL path before pagehide. Hold the fetch until this session has a
  // known recovery head, then release a new remote state exactly once.
  activityResponse = "defer-active";
  activityRequestCount = 0;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /继续游戏/ }).click();
  shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active");
  await expect.poll(() => releaseActiveResponse !== null).toBe(true);
  const beforeActivity = await readRecoveryProof(page);
  activityResponse = "active";
  releaseActiveResponse!();
  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending ? -1 : proof.commandCount;
  }, { timeout: 10_000 }).toBeGreaterThan(beforeActivity.commandCount);
  activityResponse = "none";
  shell = await sealPagehideAndContinue(page);
  await expect.poll(async () => (await readStoredState(page)).endgame.constructionActivity.activityId)
    .toBe(activity.id);
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active");
});

