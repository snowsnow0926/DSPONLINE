import { expect, test } from "@playwright/test";

for (const kind of ["stable-event", "long-press"] as const) {
  test(`${kind} releases the initial render payload after later committed renders`, async ({ page, context }) => {
    await page.route("**/__callback_retention.html", route => route.fulfill({ contentType: "text/html", body:
      '<!doctype html><html><body><script type="module" src="/tests/e2e/fixtures/callbackRetention.tsx"></script></body></html>' }));
    await page.goto("/__callback_retention.html");
    await page.waitForFunction(() => Boolean(window.__callbackRetention));
    await page.evaluate(value => window.__callbackRetention.mount(value), kind);
    // React may keep the immediately previous fiber. Several commits remove
    // that legitimate retention before checking the hook's stable closures.
    for (let i = 0; i < 4; i += 1) await page.evaluate(() => window.__callbackRetention.advance());
    const cdp = await context.newCDPSession(page);
    try {
      for (let i = 0; i < 2; i += 1) {
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
        await cdp.send("HeapProfiler.collectGarbage");
      }
    } finally { await cdp.detach(); }
    const observed = await page.evaluate(() => window.__callbackRetention.inspect());
    await test.info().attach("callback-retention", { body: JSON.stringify(observed), contentType: "application/json" });
    expect(observed.identityStable).toBe(true);
    expect(observed.latestValue).toBe(4);
    expect(observed.retainedOriginalValue).toBe(4);
    expect(observed.initialPayloadAlive).toBe(false);
  });
}
