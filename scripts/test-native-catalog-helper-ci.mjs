// TEST_ONLY actual helper/main verification. Called only inside the disposable
// Windows certificate lifecycle; does not create or modify certificate stores.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createWindowsCatalogVerifier, readAuthenticatedCatalogMember } = require('../desktop/native-catalog-verifier.cjs');
const phase = process.argv[2];
const fixture = process.env.DSP_CATALOG_TEST_ROOT;
const pin = process.env.DSP_CATALOG_TEST_PUBLISHER_SHA256;
const runnerTemp = process.env.RUNNER_TEMP;
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true'
    || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows'
    || process.env.GITHUB_REPOSITORY !== 'snowsnow0926/DSPONLINE'
    || !['before-trust', 'trusted', 'after-trust-removal'].includes(phase)
    || !runnerTemp || !fixture || path.dirname(fixture) !== path.resolve(runnerTemp)
    || !/^dsp-catalog-test-[a-f0-9]{32}$/.test(path.basename(fixture))
    || !/^[a-f0-9]{64}$/.test(pin ?? '')) throw new Error('CATALOG_HELPER_TEST_CI_ONLY');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = path.resolve('native/target/release/dsp-catalog-verifier.exe');
const executableSha256 = hash(fs.readFileSync(source));
const valid = path.join(fixture, 'valid');
const unrelated = path.join(fixture, 'unrelated');
for (const root of [valid, unrelated]) {
  const directory = path.join(root, 'native');
  const executable = path.join(directory, 'dsp-catalog-verifier.exe');
  if (phase === 'before-trust') {
    fs.mkdirSync(directory); // Existing directories are an unexpected fixture reuse.
    fs.copyFileSync(source, executable, fs.constants.COPYFILE_EXCL);
  }
  assert.equal(hash(fs.readFileSync(executable)), executableSha256);
}
const verifier = (root, pins = [pin]) => createWindowsCatalogVerifier({
  installationRoot: root, executableSha256, publisherCertificateSha256: pins,
});
let checks = 0;
if (phase !== 'trusted') {
  for (const root of [valid, unrelated]) {
    await assert.rejects(verifier(root).authenticate(), (error) => error.code === 'trust-rejected');
    checks++;
  }
} else {
  const member = path.join(valid, 'native-qualification', 'qualification.json');
  const catalog = path.join(valid, 'native-qualification', 'qualification.cat');
  const originalMember = fs.readFileSync(member);
  const originalCatalog = fs.readFileSync(catalog);
  const actual = readAuthenticatedCatalogMember(await verifier(valid).authenticate());
  assert.deepEqual(actual.memberBytes, originalMember);
  assert.equal(actual.memberSha256, hash(originalMember));
  assert.equal(actual.catalogSha256, hash(originalCatalog));
  assert.equal(actual.publisherCertificateSha256, pin);
  checks++;
  const wrongPin = (pin[0] === '0' ? '1' : '0') + pin.slice(1);
  await assert.rejects(verifier(valid, [wrongPin]).authenticate(), (error) => error.code === 'publisher-mismatch');
  checks++;
  assert.equal(readAuthenticatedCatalogMember(await verifier(valid, [wrongPin, pin]).authenticate()).publisherCertificateSha256, pin);
  checks++;
  const other = readAuthenticatedCatalogMember(await verifier(unrelated).authenticate());
  assert.deepEqual(other.memberBytes, fs.readFileSync(path.join(unrelated, 'native-qualification', 'qualification.json')));
  checks++;
  try {
    fs.writeFileSync(member, Buffer.from('{"kind":"tampered-TEST_ONLY","version":2}'));
    await assert.rejects(verifier(valid).authenticate(), (error) => error.code === 'trust-rejected');
    assert.deepEqual(actual.memberBytes, originalMember);
    checks++;
    fs.writeFileSync(member, originalMember);
    fs.writeFileSync(catalog, fs.readFileSync(path.join(unrelated, 'native-qualification', 'qualification.cat')));
    await assert.rejects(verifier(valid).authenticate(), (error) => error.code === 'trust-rejected');
    checks++;
    const damaged = Buffer.from(originalCatalog);
    damaged[damaged.length - 1] ^= 0x80;
    fs.writeFileSync(catalog, damaged);
    await assert.rejects(verifier(valid).authenticate(), (error) => error.code === 'trust-rejected');
    checks++;
  } finally {
    fs.writeFileSync(member, originalMember);
    fs.writeFileSync(catalog, originalCatalog);
  }
  assert.deepEqual(readAuthenticatedCatalogMember(await verifier(valid).authenticate()).memberBytes, originalMember);
  checks++;
}
console.log(JSON.stringify({ kind: 'DSP_CATALOG_MAIN_HELPER_TEST_ONLY', phase, checks,
  executableSha256, authorityEligible: false, status: 'PASS' }));
