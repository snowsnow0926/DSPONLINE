// Bootstrap only: use the same stable channel, without skipping browser tests.
import { chromium } from '@playwright/test';
if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true'
    || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('CI_CHROME_PROBE_REQUIRES_DISPOSABLE_LINUX_RUNNER');
}
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true,
    timeout: 30_000, args: ['--mute-audio'] });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>CI Chrome probe</title><p>ready</p>');
  if (await page.title() !== 'CI Chrome probe') throw new Error('CI_CHROME_PROBE_PAGE_FAILED');
  console.log(JSON.stringify({ kind: 'ci-chrome-bootstrap', channel: 'chrome',
    version: browser.version(), headless: true, muted: true, status: 'PASS' }));
} finally {
  await browser?.close();
}
