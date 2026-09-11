import { expect, test } from "@playwright/test";
import { createInitialState } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";

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
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem("dsp-idle-network.save.v1", saveRaw);
    (window as typeof window & { __DSP_RUNTIME_TRANSITIONS__?: unknown }).__DSP_RUNTIME_TRANSITIONS__ = {
      enabled: true,
      events: [],
      active: {},
      counters: {},
    };

    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const delay = timeout === 30_000 ? 3_500 : timeout;
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
  await expect(page.locator("[data-persistence-progress]")).toContainText("序列化、写入并逐字复核");
  await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 5_000 });
  await expect(page.locator("[data-persistence-progress]")).toContainText("存档已验证完成");

  // Change the immutable state identity so the scheduled save cannot take the
  // unchanged-save fast path and must exercise the delayed save Worker.
  // Legacy direct-bypass loads intentionally resume the factory after
  // migration, even when the serialized fixture carried `paused: true`.
  // Normalize both states without waiting on a label that is not rendered.
  const resume = page.getByLabel("继续模拟");
  const pause = page.getByLabel("暂停模拟");
  if (await resume.isVisible()) {
    await resume.click();
    await expect(pause).toBeVisible();
    await pause.click();
  } else {
    await expect(pause).toBeVisible();
    await pause.click();
  }
  await expect.poll(() => page.evaluate(() => {
    const events = (window as typeof window & {
      __DSP_RUNTIME_TRANSITIONS__?: { events: Array<{ phase: string; detail?: { kind?: string; phase?: string } }> };
    }).__DSP_RUNTIME_TRANSITIONS__?.events ?? [];
    return events.some((event) => event.phase === "persistence-phase" && event.detail?.kind === "autosave" && event.detail.phase === "complete");
  }), { timeout: 10_000 }).toBe(true);

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

