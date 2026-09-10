import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const durableRuntimeEnabled = ["true", "1", "on"].includes(
  (process.env.VITE_DURABLE_RUNTIME_RECOVERY ?? "").trim().toLowerCase(),
);
test.skip(!durableRuntimeEnabled, "requires VITE_DURABLE_RUNTIME_RECOVERY=true");

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
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-09-08-v1.2.7");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
  });
});

test("durable finalize failure rebuilds the simulation Worker in-page and resume remains usable", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const tracker = { finalizeFailures: 1, injected: false };
    (window as typeof window & { __v146DurableRecoveryTracker?: typeof tracker }).__v146DurableRecoveryTracker = tracker;
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const isPersistence = String(args[0]).includes("simulationRuntimeRecoveryPersistence.worker") &&
          (args[1] as WorkerOptions | undefined)?.name === "runtime-recovery-persistence";
        if (!isPersistence) return worker;
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          if (message.type === "finalize" && tracker.finalizeFailures > 0) {
            tracker.finalizeFailures -= 1;
            tracker.injected = true;
            window.setTimeout(() => {
              worker.onerror?.(new ErrorEvent("error", { message: "injected durable finalize failure" }));
              worker.terminate();
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

  await page.getByLabel("暂停模拟").click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "true", { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __v146DurableRecoveryTracker?: { injected: boolean } }).__v146DurableRecoveryTracker?.injected ?? false,
  )).toBe(true);

  // The recovery path is asynchronous and deliberately keeps the game paused
  // until T1 and the replacement durable head have both been verified.
  await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 40_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active", { timeout: 40_000 });
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");
  await expect(page.locator(".game-notice")).not.toContainText("模拟 revision 与 durable recovery head 不一致");

  await page.getByLabel("继续模拟").click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending;
  }, { timeout: 20_000 }).toBe(false);
});

test("a recovery-head retry keeps verified T1 state after a second persistence Worker failure", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const tracker = { armFinalize: false, finalizeInjected: false, initializeInjected: false };
    (window as typeof window & { __v146RecoveryHeadRetryTracker?: typeof tracker }).__v146RecoveryHeadRetryTracker = tracker;
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const isPersistence = String(args[0]).includes("simulationRuntimeRecoveryPersistence.worker") &&
          (args[1] as WorkerOptions | undefined)?.name === "runtime-recovery-persistence";
        if (!isPersistence) return worker;
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          const failOnce = (label: string) => {
            window.setTimeout(() => {
              worker.onerror?.(new ErrorEvent("error", { message: `injected durable ${label} failure` }));
              worker.terminate();
            }, 0);
          };
          if (message.type === "finalize" && tracker.armFinalize && !tracker.finalizeInjected) {
            tracker.finalizeInjected = true;
            failOnce("finalize");
            return;
          }
          if (message.type === "initialize" && tracker.finalizeInjected && !tracker.initializeInjected) {
            tracker.initializeInjected = true;
            failOnce("initialize");
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
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active", { timeout: 20_000 });

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.getByRole("button", { name: "教程、版本与其他", exact: true }).first().click();
  const beforeDifficulty = await readRecoveryProof(page);
  await operations.getByRole("button", { name: "舒缓", exact: true }).click();
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending ? -1 : proof.commandCount;
  }).toBeGreaterThan(beforeDifficulty.commandCount);
  await operations.getByLabel("关闭运营中心").click();
  await page.evaluate(() => {
    const tracker = (window as typeof window & {
      __v146RecoveryHeadRetryTracker?: { armFinalize: boolean };
    }).__v146RecoveryHeadRetryTracker;
    if (!tracker) throw new Error("recovery retry tracker missing");
    tracker.armFinalize = true;
  });

  await page.getByLabel("暂停模拟").click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __v146RecoveryHeadRetryTracker?: { finalizeInjected: boolean; initializeInjected: boolean } })
      .__v146RecoveryHeadRetryTracker,
  )).toMatchObject({ finalizeInjected: true, initializeInjected: true });

  await page.getByLabel("继续模拟").click();
  await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 40_000 });
  await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
});

test("a verified T1 whose recovery-head rollover fails repairs itself after the save lock releases", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const tracker = { armInitialize: false, initializeInjected: false };
    (window as typeof window & { __v146PostT1RepairTracker?: typeof tracker }).__v146PostT1RepairTracker = tracker;
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const isPersistence = String(args[0]).includes("simulationRuntimeRecoveryPersistence.worker") &&
          (args[1] as WorkerOptions | undefined)?.name === "runtime-recovery-persistence";
        if (!isPersistence) return worker;
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          if (message.type === "initialize" && tracker.armInitialize && !tracker.initializeInjected) {
            tracker.initializeInjected = true;
            window.setTimeout(() => {
              worker.onerror?.(new ErrorEvent("error", { message: "injected post-T1 recovery-head failure" }));
              worker.terminate();
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
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active", { timeout: 20_000 });

  await page.getByLabel("暂停模拟").click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.getByRole("button", { name: "教程、版本与其他", exact: true }).first().click();
  await operations.getByRole("button", { name: "舒缓", exact: true }).click();
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending ? -1 : proof.commandCount;
  }).toBeGreaterThan(0);
  const beforeSave = await readRecoveryProof(page);

  await page.evaluate(() => {
    const tracker = (window as typeof window & {
      __v146PostT1RepairTracker?: { armInitialize: boolean };
    }).__v146PostT1RepairTracker;
    if (!tracker) throw new Error("post-T1 repair tracker missing");
    tracker.armInitialize = true;
  });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  await operations.getByRole("button", { name: "立即保存" }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __v146PostT1RepairTracker?: { initializeInjected: boolean } })
      .__v146PostT1RepairTracker?.initializeInjected ?? false,
  )).toBe(true);

  await expect.poll(async () => {
    try {
      const proof = await readRecoveryProof(page);
      return proof.identity.revision > beforeSave.identity.revision &&
        proof.sequence === 0 && !proof.pending && proof.finalized;
    } catch {
      return false;
    }
  }, { timeout: 40_000 }).toBe(true);
  await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 40_000 });
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");

  await operations.getByLabel("关闭运营中心").click();
  await page.getByLabel("继续模拟").click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 20_000 });
});

test("a running autosave resumes after a verified T1 recovery-head repair", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const tracker = { armInitialize: false, initializeInjected: false };
    (window as typeof window & { __v146AutosaveRepairTracker?: typeof tracker }).__v146AutosaveRepairTracker = tracker;
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const accelerated = timeout === 30_000 ? 2_000 : timeout;
      return nativeSetInterval(handler, accelerated, ...args);
    }) as typeof window.setInterval;
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const isPersistence = String(args[0]).includes("simulationRuntimeRecoveryPersistence.worker") &&
          (args[1] as WorkerOptions | undefined)?.name === "runtime-recovery-persistence";
        if (!isPersistence) return worker;
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          const failInitialize = message.type === "initialize" && tracker.armInitialize && !tracker.initializeInjected;
          if (failInitialize) {
            tracker.initializeInjected = true;
            window.setTimeout(() => {
              worker.onerror?.(new ErrorEvent("error", { message: "injected autosave recovery-head failure" }));
              worker.terminate();
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
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active", { timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");

  await page.evaluate(() => {
    const tracker = (window as typeof window & { __v146AutosaveRepairTracker?: { armInitialize: boolean } }).__v146AutosaveRepairTracker;
    if (!tracker) throw new Error("autosave repair tracker missing");
    tracker.armInitialize = true;
  });
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __v146AutosaveRepairTracker?: { initializeInjected: boolean } }).__v146AutosaveRepairTracker?.initializeInjected ?? false,
  ), { timeout: 30_000 }).toBe(true);
  await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 40_000 });
  await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 20_000 });
  await expect(page.locator(".save-emergency-warning")).toHaveCount(0);
});

test("experimental save edits stay durable when the primary write fails", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem("dsp-idle-network.save.allow-edits-during-save.v1", "true");
    const runtime = window as typeof window & {
      __v146ExperimentalSaveFault?: { enabled: boolean; remainingFailures: number; interceptedFailures: number };
    };
    runtime.__v146ExperimentalSaveFault = { enabled: false, remainingFailures: 0, interceptedFailures: 0 };

    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const workerOptions = args[1] as WorkerOptions | undefined;
        const isAuthoritativePersistenceWorker = workerOptions?.name === "authoritative-save-persistence" ||
          String(args[0]).includes("authoritativeSavePersistence.worker");
        if (!isAuthoritativePersistenceWorker) return worker;
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          const request = message as { id?: unknown; type?: unknown; payload?: unknown };
          const fault = runtime.__v146ExperimentalSaveFault;
          if (request.type === "commit" && typeof request.id === "number" &&
            request.payload instanceof ArrayBuffer && fault?.enabled && fault.remainingFailures > 0) {
            fault.remainingFailures -= 1;
            fault.interceptedFailures += 1;
            // The request never reaches the native Worker, so ownership remains
            // on this page. Return that exact buffer as the protocol requires.
            window.setTimeout(() => {
              worker.onmessage?.(new MessageEvent("message", {
                data: {
                  id: request.id,
                  type: "result",
                  result: {
                    ok: false,
                    reason: "quota",
                    message: "synthetic quota",
                    retryable: true,
                    degraded: false,
                  },
                  sourcePayloadTransfer: request.payload,
                },
              }));
            }, 2_500);
            return;
          }
          window.setTimeout(() => {
            if (transferOrOptions === undefined) nativePostMessage(message);
            else nativePostMessage(message, transferOrOptions);
          }, 0);
        }) as typeof worker.postMessage;
        return worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  });

  await page.goto("/?menu=1");
  await page.getByRole("button", { name: /开始游戏/ }).click();
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active", { timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");
  const beforeSave = await readRecoveryProof(page);

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  await page.evaluate(() => {
    const fault = (window as typeof window & {
      __v146ExperimentalSaveFault?: { enabled: boolean; remainingFailures: number };
    }).__v146ExperimentalSaveFault;
    if (!fault) throw new Error("experimental save fault control missing");
    fault.enabled = true;
    fault.remainingFailures = 2;
  });
  await operations.getByRole("button", { name: "立即保存" }).click();
  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "true", { timeout: 5_000 });

  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.getByRole("button", { name: "教程、版本与其他", exact: true }).first().click();
  await operations.getByRole("button", { name: "舒缓", exact: true }).click();
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");

  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  const warning = page.locator(".save-emergency-warning");
  await expect(warning).toBeVisible({ timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "false", { timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");
  expect(await page.evaluate(() => {
    const fault = (window as typeof window & {
      __v146ExperimentalSaveFault?: { remainingFailures: number; interceptedFailures: number };
    }).__v146ExperimentalSaveFault;
    return fault ? { remainingFailures: fault.remainingFailures, interceptedFailures: fault.interceptedFailures } : null;
  })).toEqual({ remainingFailures: 0, interceptedFailures: 2 });

  const downloadPromise = page.waitForEvent("download");
  await warning.getByRole("button", { name: "立即导出当前进度" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("experimental failed-save export path missing");
  const downloaded = await readFile(downloadPath);
  const exportedRaw = downloaded[0] === 0x1f && downloaded[1] === 0x8b
    ? gunzipSync(downloaded).toString("utf8")
    : downloaded.toString("utf8");
  const exported = JSON.parse(exportedRaw) as { state?: { settings?: { difficulty?: string }; paused?: boolean } };
  expect(exported.state?.settings?.difficulty).toBe("relaxed");
  expect(exported.state?.paused).toBe(false);

  await expect.poll(async () => {
    const proof = await readRecoveryProof(page);
    return proof.pending ? -1 : proof.commandCount;
  }, { timeout: 30_000 }).toBeGreaterThan(beforeSave.commandCount);

  await operations.getByLabel("关闭运营中心").click();
  const reloadedShell = await sealPagehideAndContinue(page);
  await expect(reloadedShell).toHaveAttribute("data-difficulty", "relaxed");
  await expect(reloadedShell).toHaveAttribute("data-simulation-worker", "active");
  await expect(reloadedShell).toHaveAttribute("data-simulation-paused", "false");
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
