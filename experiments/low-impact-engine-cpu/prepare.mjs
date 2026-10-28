import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [baselineRef, candidateRef, output, windowText = '960'] = process.argv.slice(2);
const steps = Number(windowText);
if (!baselineRef || !candidateRef || !output || !isAbsolute(output) || ![120, 960, 7680].includes(steps)) {
  throw Error('Usage: node prepare.mjs BASELINE_REF CANDIDATE_REF ABSOLUTE_NEW_OUTPUT 120|960|7680');
}
if (process.platform === 'win32' && !/^D:[\\/]/i.test(output)) throw Error('Diagnostic output must stay on D:');
const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root });
const baseline = git('rev-parse', '--verify', `${baselineRef}^{commit}`).toString().trim();
const candidate = git('rev-parse', '--verify', `${candidateRef}^{commit}`).toString().trim();
const runtimeFiles = ['src/game/engine.ts', 'src/game/recursiveCrafting.ts'];
const runtimeDiff = (a, b) => git('diff', '--name-only', a, ...(b ? [b] : []), '--', 'src').toString().trim().split(/\r?\n/)
  .filter((name) => name && !/\.test\.tsx?$/.test(name));
if (runtimeDiff(baseline, candidate).some((name) => !runtimeFiles.includes(name)) ||
  runtimeDiff(candidate, '').some((name) => !runtimeFiles.includes(name))) {
  throw Error('Other runtime sources differ; this two-module comparison would be incomplete');
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
mkdirSync(output);
const manifest = {
  scope: 'Explicit bounded synthetic CPU diagnostic; no large save, browser, game build or real time-warp protocol',
  plan: ['baseline', 'candidate', 'candidate', 'baseline'], maxEntities: 200, warmSteps: 40,
  measuredSteps: steps, ...(steps === 7680 ? { cases: ['idle'] } : {}),
  probeSha256: hash(readFileSync(new URL('./probe.ts', import.meta.url))),
  configSha256: hash(readFileSync(new URL('./config.mjs', import.meta.url))), runtimes: {},
};
for (const [variant, commit] of [['baseline', baseline], ['candidate', candidate]]) {
  const folder = join(output, variant);
  mkdirSync(folder);
  const files = {}, sourceHashes = {};
  for (const name of runtimeFiles) {
    const body = git('show', `${commit}:${name}`);
    files[name] = join(folder, name.split('/').at(-1));
    sourceHashes[name] = hash(body);
    writeFileSync(files[name], body, { flag: 'wx' });
  }
  manifest.runtimes[variant] = { commit, files, sourceHashes };
}
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ baseline, candidate, measuredSteps: steps, sourcePlan: manifest.plan }));
