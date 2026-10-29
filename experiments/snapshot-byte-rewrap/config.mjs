import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.env.DSP_SNAPSHOT_PROBE !== '1') throw Error('Explicit private snapshot runner required');
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const manifest = JSON.parse(readFileSync(process.env.DSP_SNAPSHOT_MANIFEST, 'utf8'));
const variant = process.env.DSP_SNAPSHOT_VARIANT;
if (!['baseline', 'candidate'].includes(variant)) throw Error('Unknown snapshot source variant');
const runtime = manifest.runtimes[variant];
const normalize = id => {
  const plain = id.split('?')[0];
  return (plain.startsWith('file:') ? fileURLToPath(plain) : plain).replaceAll('\\', '/').replace(/^\/@fs\//, '')
    .replace(/^\/(?=[A-Za-z]:\/)/, '').toLowerCase();
};
const sources = Object.entries(runtime.files).map(([name, path]) => {
  const source = readFileSync(path, 'utf8');
  const hash = createHash('sha256').update(source).digest('hex');
  if (hash !== runtime.sourceHashes[name]) throw Error(`Frozen snapshot source mismatch: ${name}`);
  return { name, source, hash, id: normalize(`${root}/${name}`) };
});

export default {
  root,
  plugins: [{ name: 'verified-snapshot-source-pair', enforce: 'pre', load(id) {
    const item = sources.find(source => source.id === normalize(id));
    if (item) return `globalThis.__DSP_SNAPSHOT_SOURCES ??= {};\n` +
      `globalThis.__DSP_SNAPSHOT_SOURCES[${JSON.stringify(item.name)}] = ${JSON.stringify(item.hash)};\n${item.source}`;
  } }],
  test: { include: ['experiments/snapshot-byte-rewrap/probe.ts'], environment: 'node', pool: 'forks',
    maxWorkers: 1, fileParallelism: false, testTimeout: 180_000,
    execArgv: ['--expose-gc', '--max-old-space-size=4096'] },
};
