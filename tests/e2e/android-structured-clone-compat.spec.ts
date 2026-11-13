import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const removeCloneApis = `delete globalThis.structuredClone; delete globalThis.PerformanceMark;
  delete ArrayBuffer.prototype.transfer; delete ArrayBuffer.prototype.transferToFixedLength;`;
const removeCollectionApis = `delete Array.prototype.at; delete Object.hasOwn;`;

async function readPrimary(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string | null>((resolve, reject) => {
        const transaction = database.transaction("records", "readonly");
        const request = transaction.objectStore("records").get("dsp-idle-network.save.v1");
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  });
}

for (const profile of ["native", "clone-absent", "worker-at-absent", "legacy-runtime"] as const) {
  test(`new factory, Worker commands and save reopen with ${profile}`, async ({ page }) => {
    const missingApi = profile === "clone-absent" || profile === "legacy-runtime";
    const missingCollections = profile === "legacy-runtime";
    const workerPrelude = profile === "worker-at-absent" ? "delete Array.prototype.at;"
      : `${missingApi ? removeCloneApis : ""}\n${missingCollections ? removeCollectionApis : ""}`;
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(({ missingApi, missingCollections, profile }) => {
      const scope = globalThis as typeof globalThis & { originalStructuredClone?: typeof structuredClone };
      scope.originalStructuredClone = scope.structuredClone;
      localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-14-v1.3.14");
      localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
      if (missingCollections) {
        Reflect.deleteProperty(Array.prototype, "at");
        Reflect.deleteProperty(Object, "hasOwn");
      }
      if (missingApi) {
        Reflect.deleteProperty(scope, "structuredClone");
        Reflect.deleteProperty(scope, "PerformanceMark");
        Reflect.deleteProperty(ArrayBuffer.prototype, "transfer");
        Reflect.deleteProperty(ArrayBuffer.prototype, "transferToFixedLength");
      }
      if (profile === "native") return;
      const NativeWorker = Worker;
      scope.Worker = class extends NativeWorker {
        constructor(url: string | URL, options: WorkerOptions = {}) {
          const target = new URL(url, location.href);
          target.searchParams.set("structuredCloneCompatProbe", options.type === "module" ? "module" : "classic");
          super(target, options);
        }
      };
    }, { missingApi, missingCollections, profile });
    await page.context().route("**/__missing_clone_runtime__.js", route => route.fulfill({
      status: 200, contentType: "text/javascript", body: workerPrelude,
    }));
    await page.context().route("**/*structuredCloneCompatProbe=*", async route => {
      const response = await route.fetch();
      const source = await response.text();
      const target = new URL(route.request().url());
      const prefix = target.searchParams.get("structuredCloneCompatProbe") === "module"
        ? `import ${JSON.stringify(new URL("/__missing_clone_runtime__.js", target).href)};`
        : workerPrelude;
      await route.fulfill({ response, contentType: "text/javascript", body: `${prefix}\n${source}` });
    });
    await page.route("**/api/**", route => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
    await page.goto("/?menu=1");
    await expect(page.getByRole("button", { name: "建立工厂", exact: true })).toBeVisible();
    expect(await page.evaluate(() => typeof structuredClone)).toBe("function");
    expect(await page.evaluate(() => typeof Array.prototype.at)).toBe("function");
    expect(await page.evaluate(() => typeof Object.hasOwn)).toBe("function");
    if (!missingApi) {
      expect(await page.evaluate(() => {
        const scope = globalThis as typeof globalThis & { originalStructuredClone?: typeof structuredClone };
        return scope.structuredClone === scope.originalStructuredClone;
      })).toBe(true);
    }
    await page.getByRole("button", { name: "建立工厂", exact: true }).click();
    await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("structuredClone is not defined", { exact: true })).toHaveCount(0);
    await expect.poll(async () => {
      const workers = await Promise.all(page.workers().map(worker => worker.evaluate(() => ({
        name, clone: typeof structuredClone, at: typeof Array.prototype.at, hasOwn: typeof Object.hasOwn,
      })).catch(() => null)));
      return workers.some(worker => worker?.name === "factory-simulation" &&
        worker.clone === "function" && worker.at === "function" && worker.hasOwn === "function");
    }, { timeout: 20_000 }).toBe(true);
    await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-worker", "active");
    const pause = page.getByRole("button", { name: "暂停模拟", exact: true });
    if (await pause.isVisible()) await pause.click();
    await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-paused", "true");
    await page.getByRole("button", { name: "采集", exact: true }).first().click({ clickCount: 3 });
    await expect(page.getByRole("button", { name: "铁矿石 3", exact: true })).toBeVisible();
    await page.waitForTimeout(5_000);
    await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-worker", "active");
    await expect(page.locator(".interaction-event-feed")).not.toContainText("is not a function");
    const more = page.getByRole("navigation", { name: "手机主导航" }).getByRole("button", { name: "更多", exact: true });
    if (await more.isVisible()) {
      await more.click();
      await page.getByRole("button", { name: /^保存并返回主菜单/ }).click();
      await page.getByRole("alertdialog", { name: "保存并返回主菜单", exact: true })
        .getByRole("button", { name: "保存并返回", exact: true }).click();
    } else {
      await page.getByTitle("保存并返回主菜单", { exact: true }).click();
    }
    await expect(page.locator(".start-menu")).toBeVisible({ timeout: 30_000 });
    const saved = await readPrimary(page);
    expect(saved?.length).toBeGreaterThan(100);
    expect(JSON.parse(saved!).state.entities.find((entity: {resourceId?: string}) => entity.resourceId === "iron_ore").outputs.iron_ore).toBe(3);
    await page.reload();
    await expect(page.locator(".start-menu")).toBeVisible({ timeout: 30_000 });
    expect(await readPrimary(page)).toBe(saved);
    await page.getByRole("button", { name: "进入工厂", exact: true }).click();
    await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "铁矿石 3", exact: true })).toBeVisible();
  });
}
