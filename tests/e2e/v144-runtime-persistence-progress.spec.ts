import { expect, test } from "@playwright/test";
import { createInitialState } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";

test("default save protection rejects edits without pausing a running autosave", async ({ page }) => {
  test.setTimeout(60_000);
  const offlineReport = page.getByRole("dialog", { name: "离线结算报告" });
  await page.addLocatorHandler(offlineReport, async () => {
    await offlineReport.getByRole("button", { name: "确认结算" }).click({ force: true });
  });
  const state = createInitialState(46_146);
  state.paused = false;
  state.settings.autosaveIntervalSeconds = 30;
  const raw = serializeEnvelope(state, Date.now());

  await page.addInitScript(({ saveRaw }) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-27-v1.2.2");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem("dsp-idle-network.save.allow-edits-during-save.v1", "false");
    localStorage.setItem("dsp-idle-network.save.v1", saveRaw);
    (window as typeof window & { __DSP_RUNTIME_TRANSITIONS__?: unknown }).__DSP_RUNTIME_TRANSITIONS__ = {
      enabled: true,
      events: [],
      active: {},
      counters: {},
    };

    const autosaveHandlers: TimerHandler[] = [];
    (window as typeof window & { __v146AutosaveHandlers?: TimerHandler[] }).__v146AutosaveHandlers = autosaveHandlers;
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 30_000) {
        autosaveHandlers.push(handler);
        return 0 as unknown as ReturnType<typeof window.setInterval>;
      }
      return nativeSetInterval(handler, timeout, ...args);
    }) as typeof window.setInterval;

    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const url = String(args[0]);
        const simulation = url.includes("simulation.worker") && (args[1] as WorkerOptions | undefined)?.name === "factory-simulation";
        const save = url.includes("save.worker");
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          const delay = simulation && message.kind === "checkpoint" ? 350 : save ? 900 : 0;
          const post = () => {
            if (transferOrOptions === undefined) nativePostMessage(message);
            else nativePostMessage(message, transferOrOptions);
          };
          if (delay > 0) window.setTimeout(post, delay);
          else post();
        }) as typeof worker.postMessage;
        return worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  }, { saveRaw: raw });

  await page.goto("/");
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 15_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "unavailable");
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  await operations.getByRole("button", { name: "立即保存" }).click();
  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "true", { timeout: 5_000 });
  await operations.getByLabel("关闭运营中心").click();
  await page.getByLabel("暂停模拟").click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");
  await expect(shell).toHaveAttribute("data-primary-save-rejected-edits", "1");
  await expect(page.locator(".game-notice")).toContainText("本次操作未应用");
  await expect(shell).toHaveAttribute("data-persistence-kind", "manual");
  await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 15_000 });
  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "false");

  await page.getByLabel("暂停模拟").click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");
  await page.getByLabel("继续模拟").click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");

  await page.evaluate(() => {
    const handlers = (window as typeof window & { __v146AutosaveHandlers?: TimerHandler[] }).__v146AutosaveHandlers ?? [];
    if (handlers.length === 0) throw new Error("autosave interval handler missing");
    for (const handler of handlers) {
      if (typeof handler === "function") handler();
    }
  });
  await expect(shell).toHaveAttribute("data-persistence-kind", "autosave", { timeout: 5_000 });
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");
  await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 15_000 });
  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "false");
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");
});

test("manual, autosave, and return publish ordered non-blocking persistence phases", async ({ page }) => {
  test.setTimeout(60_000);
  const state = createInitialState(44_145);
  state.paused = true;
  state.settings.autosaveIntervalSeconds = 30;
  // Use the real v46 envelope/checksum contract. A bare JSON object is
  // intentionally rejected by loadGame(), which would silently seed a fresh
  // (running) factory and make the Continue/Pause gate hang.
  const raw = serializeEnvelope(state, Date.now());

  await page.addInitScript(({ saveRaw }) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-27-v1.2.2");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    // This case intentionally resumes while the accelerated autosave may be
    // in flight. Opt into the documented durable-edit mode; the preceding
    // test covers the default protection mode and its rejected-edit contract.
    localStorage.setItem("dsp-idle-network.save.allow-edits-during-save.v1", "true");
    localStorage.setItem("dsp-idle-network.save.v1", saveRaw);
    (window as typeof window & { __DSP_RUNTIME_TRANSITIONS__?: unknown }).__DSP_RUNTIME_TRANSITIONS__ = {
      enabled: true,
      events: [],
      active: {},
      counters: {},
    };

    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const delay = timeout === 30_000 ? 1_500 : timeout;
      return nativeSetInterval(handler, delay, ...args);
    }) as typeof window.setInterval;

    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const url = String(args[0]);
        const simulation = url.includes("simulation.worker") && (args[1] as WorkerOptions | undefined)?.name === "factory-simulation";
        const save = url.includes("save.worker");
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          const delay = simulation && message.kind === "checkpoint" ? 300 : save ? 450 : 0;
          const post = () => {
            if (transferOrOptions === undefined) nativePostMessage(message);
            else nativePostMessage(message, transferOrOptions);
          };
          if (delay > 0) window.setTimeout(post, delay);
          else post();
        }) as typeof worker.postMessage;
        return worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  }, { saveRaw: raw });

  await page.goto("/");
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  await operations.getByRole("button", { name: "立即保存" }).click();
  await expect(shell).toHaveAttribute("data-persistence-kind", "manual");
  await expect(shell).toHaveAttribute("data-persistence-phase", "checkpoint");
  await expect(page.locator("[data-persistence-progress]")).toContainText("模拟检查点");
  await expect(shell).toHaveAttribute("data-persistence-phase", "serialize-write-readback", { timeout: 5_000 });
  await expect.poll(async () => {
    const text = await page.locator("[data-persistence-progress]").textContent();
    return text?.includes("序列化、写入并逐字复核") || text?.includes("存档已验证完成") || false;
  }).toBe(true);
  await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 5_000 });
  await expect(page.locator("[data-persistence-progress]")).toContainText("存档已验证完成");

  // Change the immutable state identity so the scheduled save cannot take the
  // unchanged-save fast path and must exercise the delayed save Worker. Keep
  // the simulation running: autosave is a persistence barrier, not a pause
  // command, and must preserve the user's running state after completion.
  const resume = page.getByLabel("继续模拟");
  if (await resume.isVisible()) {
    await resume.click();
  }
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");
  await expect.poll(() => page.evaluate(() => {
    const events = (window as typeof window & {
      __DSP_RUNTIME_TRANSITIONS__?: { events: Array<{ phase: string; detail?: { kind?: string; phase?: string } }> };
    }).__DSP_RUNTIME_TRANSITIONS__?.events ?? [];
    return events.filter((event) => event.phase === "persistence-phase" && event.detail?.kind === "autosave" && event.detail.phase === "complete").length;
  }), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");

  await page.getByTitle("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 10_000 });
  const phases = await page.evaluate(() => {
    const events = (window as typeof window & {
      __DSP_RUNTIME_TRANSITIONS__?: { events: Array<{ phase: string; detail?: { kind?: string; phase?: string } }> };
    }).__DSP_RUNTIME_TRANSITIONS__?.events ?? [];
    return events.filter((event) => event.phase === "persistence-phase" && event.detail?.kind)
      .map((event) => ({ kind: event.detail!.kind!, phase: event.detail!.phase! }));
  });
  const sequence = (kind: string) => phases.filter((entry) => entry.kind === kind).map((entry) => entry.phase);
  expect(sequence("manual")).toEqual(["checkpoint", "serialize-write-readback", "complete"]);
  expect(sequence("autosave")).toContain("checkpoint");
  expect(sequence("autosave")).toContain("serialize-write-readback");
  expect(sequence("autosave")).toContain("complete");
  expect(sequence("return")).toEqual(["checkpoint", "serialize-write-readback", "complete"]);
});
