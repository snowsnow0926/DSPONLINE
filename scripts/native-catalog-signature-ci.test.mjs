import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./test-native-catalog-signature-ci.ps1', import.meta.url));
const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
const available = spawnSync(pwsh, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true, encoding: 'utf8', timeout: 10_000 }).status === 0;

test('catalog CI script parses without running certificate operations', { skip: !available }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-catalog-parser-'));
  try {
    const parser = path.join(temp, 'parse.ps1');
    fs.writeFileSync(parser, 'param([string]$Source)\n$taskTokens=$null; $taskErrors=$null\n[System.Management.Automation.Language.Parser]::ParseFile($Source,[ref]$taskTokens,[ref]$taskErrors) | Out-Null\nif ($taskErrors.Count -ne 0) { $taskErrors | ForEach-Object { Write-Error $_.Message }; exit 1 }\n');
    const result = spawnSync(pwsh, ['-NoProfile', '-File', parser, script], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('catalog certificate setup rejects local, self-hosted and unowned execution before any setup', { skip: !available }, () => {
  // Every invocation also lacks RUNNER_TEMP, so even a broken primary guard
  // cannot reach certificate creation on the developer machine.
  const baseline = { ...process.env, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_REPOSITORY: 'snowsnow0926/DSPONLINE' };
  delete baseline.RUNNER_TEMP;
  for (const override of [
    { GITHUB_ACTIONS: 'false' },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { RUNNER_OS: 'Linux' },
    { GITHUB_REPOSITORY: 'unowned/test' },
    {},
  ]) {
    const result = spawnSync(pwsh, ['-NoProfile', '-File', script], { windowsHide: true, encoding: 'utf8', timeout: 10_000, env: { ...baseline, ...override } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /CATALOG_TEST_CI_ONLY/);
  }
});

test('main helper signed fixture refuses local execution before fixture reads or writes', () => {
  const env = { ...process.env, GITHUB_ACTIONS: 'false' };
  delete env.RUNNER_TEMP;
  for (const phase of ['before-trust', 'trusted', 'after-trust-removal']) {
    const result = spawnSync(process.execPath, ['scripts/test-native-catalog-helper-ci.mjs', phase], {
      windowsHide: true, encoding: 'utf8', timeout: 10_000, env,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CATALOG_HELPER_TEST_CI_ONLY/);
  }
});
