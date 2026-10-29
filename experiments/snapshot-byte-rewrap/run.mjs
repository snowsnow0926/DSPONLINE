import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const i = arg.indexOf('='); if (!arg.startsWith('--') || i < 0) throw Error('Use --name=value');
  return [arg.slice(2, i), arg.slice(i + 1)];
}));
const output = resolve(args.output ?? '');
if (!args.output || !/^D:[\\/]/i.test(output)) throw Error('Explicit private output on D required');
if (!args.fixture || !/^[a-f0-9]{64}$/.test(args['fixture-sha256'] ?? '')) throw Error('Explicit read-only fixture and hash required');
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
const baseline = git('rev-parse', '--verify', `${args['baseline-ref']}^{commit}`);
const head = git('rev-parse', 'HEAD');
const files = ['src/game/authoritativeSnapshotRewrap.ts', 'src/game/saveTransfer.ts'];
const changed = git('diff', '--name-only', baseline, '--', 'src').split(/\r?\n/).filter(p => p && !p.endsWith('.test.ts'));
if (JSON.stringify(changed.sort()) !== JSON.stringify([...files].sort())) throw Error(`Uncovered production delta: ${changed}`);
mkdirSync(output);
const hash = value => createHash('sha256').update(value).digest('hex');
const runtimes = {};
for (const variant of ['baseline', 'candidate']) {
  const dir = `${output}/${variant}`; mkdirSync(dir);
  const sources = {}; const sourceHashes = {};
  for (const name of files) {
    const source = variant === 'baseline' ? execFileSync('git', ['show', `${baseline}:${name}`], { cwd: root }) : readFileSync(resolve(root, name));
    const path = `${dir}/${name.split('/').at(-1)}`; writeFileSync(path, source);
    sources[name] = path; sourceHashes[name] = hash(source);
  }
  runtimes[variant] = { ref: variant === 'baseline' ? baseline : head, files: sources, sourceHashes };
}
const fixtureBytes = readFileSync(args.fixture);
if (hash(fixtureBytes) !== args['fixture-sha256']) throw Error('Original fixture changed');
const manifest = { schema: 1, sourceHead: head, baseline, productionDelta: changed,
  workingTree: git('status', '--porcelain'), diagnosticOnly: true, runtimes,
  fixture: { path: resolve(args.fixture), byteLength: fixtureBytes.byteLength, sha256: hash(fixtureBytes) } };
const manifestPath = `${output}/manifest.json`;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const plan = ['raw', 'gzip'].flatMap(transport => ['baseline', 'candidate', 'candidate', 'baseline'].map(variant => ({ transport, variant })));
const available = () => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory*1KB/1GB'], { encoding: 'utf8' }).trim());
const results = [];
for (const [index, run] of plan.entries()) {
  if (git('rev-parse', 'HEAD') !== head) throw Error('Source HEAD changed');
  const before = available();
  await new Promise(resolve => setTimeout(resolve, 5000));
  const after = available();
  if (!Number.isFinite(before) || !Number.isFinite(after) || Math.min(before, after) < 12) throw Error(`12 GiB headroom required: ${before}, ${after}`);
  const name = `${String(index + 1).padStart(2, '0')}-${run.transport}-${run.variant}`;
  const resultPath = `${output}/${name}.json`;
  const started = new Date().toISOString();
  const child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'experiments/snapshot-byte-rewrap/config.mjs'], {
    cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, DSP_SNAPSHOT_PROBE: '1', DSP_SNAPSHOT_MANIFEST: manifestPath,
      DSP_SNAPSHOT_VARIANT: run.variant, DSP_SNAPSHOT_TRANSPORT: run.transport, DSP_SNAPSHOT_RESULT: resultPath },
  });
  writeFileSync(`${output}/${name}.log`, `${child.stdout ?? ''}${child.stderr ?? ''}`);
  const exit = { ...run, startUtc: started, endUtc: new Date().toISOString(), exitCode: child.status,
    signal: child.signal, error: child.error?.message ?? null, beforeGiB: before, afterGiB: after };
  writeFileSync(`${output}/${name}-exit.json`, JSON.stringify(exit, null, 2));
  if (child.status !== 0) throw Error(`Snapshot probe failed; retained ${name}.log`);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  results.push({ name, resultPath, ...exit, fullBytesExact: result.fullBytesExact,
    inputUnchanged: result.inputUnchanged, snapshotPayloadSha256: result.snapshotPayloadSha256,
    cpuMs: result.cpuMs, wallMs: result.wallMs, sampledPeakRss: result.sampledPeakRss });
  console.log(JSON.stringify(results.at(-1)));
}
if (new Set(results.map(r => r.snapshotPayloadSha256)).size !== 1 || !results.every(r => r.fullBytesExact && r.inputUnchanged)) throw Error('Real snapshot output mismatch');
writeFileSync(`${output}/comparison.json`, JSON.stringify({ schema: 1, sourceHead: head, baseline,
  diagnosticOnly: true, forcedGcBeforeOperation: true, naturalWebAcceptance: false,
  allEightFullBytesExact: true, allInputUnchanged: true, results }, null, 2));
