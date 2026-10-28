import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.env.DSP_SMALL_CPU_PROBE !== '1') throw Error('Explicit low-impact runner required');
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const manifest = JSON.parse(readFileSync(process.env.DSP_SMALL_CPU_MANIFEST, 'utf8'));
const variant = process.env.DSP_SMALL_CPU_VARIANT;
if (!['baseline', 'candidate'].includes(variant)) throw Error('Unknown source variant');
const runtime = manifest.runtimes[variant];
const sources = Object.entries(runtime.files).map(([name, path]) => {
  const source = readFileSync(path, 'utf8');
  const hash = createHash('sha256').update(source).digest('hex');
  if (hash !== runtime.sourceHashes[name]) throw Error(`Frozen source mismatch: ${name}`);
  return { name, source, hash, id: `${root}/${name}`.toLowerCase() };
});
const normalize = (id) => {
  const plain = id.split('?')[0];
  return (plain.startsWith('file:') ? fileURLToPath(plain) : plain).replaceAll('\\', '/')
    .replace(/^\/@fs\//, '').replace(/^\/(?=[A-Za-z]:\/)/, '').toLowerCase();
};

export default {
  root,
  plugins: [{ name: 'bounded-cpu-verified-sources', enforce: 'pre', load(id) {
    const item = sources.find((source) => source.id === normalize(id));
    if (item) return `globalThis.__DSP_SMALL_CPU_SOURCES ??= {};\n` +
      `globalThis.__DSP_SMALL_CPU_SOURCES[${JSON.stringify(item.name)}] = ${JSON.stringify(item.hash)};\n` +
      `console.info(${JSON.stringify(`DSP_SMALL_CPU_SOURCE ${variant} ${item.name} ${item.hash}`)});\n${item.source}`;
  } }],
  test: { include: ['experiments/low-impact-engine-cpu/probe.ts'], environment: 'node', pool: 'forks',
    maxWorkers: 1, fileParallelism: false },
};
