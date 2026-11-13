import {expect, test} from "@playwright/test";

test("repeated runtime errors stop recovery and retain the verified primary and visible inventory", async ({page}) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-14-v1.3.14");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    const tracker = {enabled: false, workers: 0, failures: 0};
    (window as typeof window & {runtimeFailureProbe?: typeof tracker}).runtimeFailureProbe = tracker;
    const NativeWorker = Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        if ((args[1] as WorkerOptions | undefined)?.name !== "factory-simulation") return worker;
        tracker.workers++;
        const nativePost = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transfer?: Transferable[]) => {
          if (tracker.enabled && !message.stateTransfer) {
            tracker.failures++;
            setTimeout(() => worker.dispatchEvent(new MessageEvent("message", {
              data: {id: message.id, runtimeError: {message: "persistent synthetic runtime failure", recoverable: true}},
            })), 0);
            return;
          }
          if (transfer === undefined) nativePost(message);
          else nativePost(message, transfer);
        }) as typeof worker.postMessage;
        return worker;
      },
    });
  });
  await page.route("**/api/**", route => route.fulfill({status: 503, contentType: "application/json", body: "{}"}));
  await page.goto("/?menu=1");
  await page.getByRole("button", {name: "建立工厂", exact: true}).click();
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  for (let index = 0; index < 3; index++) await page.getByRole("button", {name: "采集", exact: true}).first().click();
  await expect(page.getByRole("button", {name: "铁矿石 3", exact: true})).toBeVisible();
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", {name: "运营中心"});
  await operations.locator(".operations-tabs").getByRole("tab", {name: "存档"}).click();
  await operations.getByRole("button", {name: "立即保存", exact: true}).click();
  await expect(page.locator(".game-notice")).toContainText("主存档已保存");
  await operations.getByLabel("关闭运营中心").click();
  const readPrimary = () => page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.flushLocalSaveWrites();
    return store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
  });
  const primary = await readPrimary();
  expect(primary?.length).toBeGreaterThan(100);
  const initialWorkerCount = await page.evaluate(() =>
    (window as typeof window & {runtimeFailureProbe?: {workers: number}}).runtimeFailureProbe!.workers);
  await page.evaluate(() => {
    const tracker = (window as typeof window & {runtimeFailureProbe?: {enabled: boolean}}).runtimeFailureProbe!;
    tracker.enabled = true;
  });
  await expect(page.locator(".game-notice")).toContainText("连续恢复失败", {timeout: 20_000});
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");
  await expect(shell).toHaveAttribute("data-simulation-worker", "fallback");
  const readProbe = () => page.evaluate(() => {
    const tracker = (window as typeof window & {runtimeFailureProbe?: {workers: number; failures: number}}).runtimeFailureProbe!;
    return {workers: tracker.workers, failures: tracker.failures};
  });
  const stopped = await readProbe();
  expect(stopped).toEqual({workers: initialWorkerCount + 3, failures: 4});
  await page.waitForTimeout(5_000);
  expect(await readProbe()).toEqual(stopped);
  await expect(page.getByRole("button", {name: "铁矿石 3", exact: true})).toBeVisible();
  expect(await readPrimary()).toBe(primary);
});
