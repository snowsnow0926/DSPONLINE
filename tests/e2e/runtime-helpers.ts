import { expect, type Page } from "@playwright/test";

/** Keep factory boot separate from the operation being checked afterwards. */
export async function waitForFactoryRuntimeReady(page: Page): Promise<void> {
  // The factory's loading shell already exists before Worker initialization.
  // Use the established 15-second factory startup budget, then retain each
  // operation's original timeout and assertions.
  await expect(page.locator(".game-shell")).toHaveAttribute(
    "data-simulation-worker", /^(active|fallback)$/, { timeout: 15_000 },
  );
}
