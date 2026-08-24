import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(root, "app", "src", "main");

async function source(relativePath) {
  return readFile(path.join(app, relativePath), "utf8");
}

test("Android manifest retains player backup support with explicit rule files", async () => {
  const manifest = await source("AndroidManifest.xml");
  assert.match(manifest, /android:allowBackup="true"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(manifest, /android:fullBackupContent="@xml\/backup_rules"/);
});

test("cloud backup and device transfer use an IndexedDB-only allowlist", async () => {
  const legacyRules = await source("res/xml/backup_rules.xml");
  const modernRules = await source("res/xml/data_extraction_rules.xml");
  for (const [rules, expectedIncludes] of [[legacyRules, 1], [modernRules, 2]]) {
    const includes = [...rules.matchAll(/<include domain="([^"]+)" path="([^"]+)"\s*\/>/g)]
      .map((match) => ({ domain: match[1], path: match[2] }));
    assert.equal(includes.length, expectedIncludes);
    assert.deepEqual([...new Set(includes.map(({ domain, path }) => `${domain}:${path}`))], ["root:app_webview/Default/IndexedDB"]);
    assert.doesNotMatch(rules, /<exclude\b/);
    assert.doesNotMatch(rules, /<include[^>]+domain="(?:sharedpref|file|database|external|device_[^"]+)"/);
    assert.doesNotMatch(rules, /<include[^>]+path="[^"]*(?:Local Storage|Cookies|Cache|private-exports|dsp_secure_session)/);
  }
  assert.match(modernRules, /<cloud-backup disableIfNoEncryptionCapabilities="true">/);
  assert.equal((modernRules.match(/app_webview\/Default\/IndexedDB/g) ?? []).length, 2);
});

test("native bridge registers before WebView creation and stores sessions with Android Keystore AES-GCM", async () => {
  const activity = await source("java/cn/dsponline/network/MainActivity.java");
  assert.ok(activity.indexOf("registerPlugin(SecureSessionPlugin.class)") < activity.indexOf("super.onCreate(savedInstanceState)"));
  assert.ok(activity.indexOf("registerPlugin(AccountArchivePlugin.class)") < activity.indexOf("super.onCreate(savedInstanceState)"));
  assert.ok(activity.indexOf("registerPlugin(TextExportPlugin.class)") < activity.indexOf("super.onCreate(savedInstanceState)"));

  const store = await source("java/cn/dsponline/network/SecureSessionStore.java");
  assert.match(store, /AndroidKeyStore/);
  assert.match(store, /AES\/GCM\/NoPadding/);
  assert.match(store, /setRandomizedEncryptionRequired\(true\)/);
  assert.match(store, /commit\(\)/);
  assert.match(store, /SessionRecord verified = readRecord\(\)/);
  assert.doesNotMatch(store, /Log\.|System\.out|printStackTrace/);
});

test("secure HTTP bridge binds handles to HTTPS origin and never exposes a token getter", async () => {
  const protocol = await source("java/cn/dsponline/network/SecureSessionProtocol.java");
  const plugin = await source("java/cn/dsponline/network/SecureSessionPlugin.java");
  assert.match(protocol, /"https"\.equalsIgnoreCase/);
  assert.match(plugin, /store\.resolve\(supplied, origin\)/);
  assert.match(plugin, /data\.put\("token", created\.handle\)/);
  assert.match(plugin, /SECURE_SESSION_STORAGE_UNAVAILABLE|Secure session storage is unavailable|compatibility/);
  assert.doesNotMatch(plugin, /@PluginMethod[\s\S]{0,120}(?:getToken|readToken|resolveToken)/);
  assert.doesNotMatch(plugin, /Log\.|System\.out|printStackTrace/);
});

test("account archives use a fixed native HTTPS route, secure handle, bounded streaming, and FileProvider sharing", async () => {
  const protocol = await source("java/cn/dsponline/network/AccountArchiveProtocol.java");
  const plugin = await source("java/cn/dsponline/network/AccountArchivePlugin.java");
  const manifest = await source("AndroidManifest.xml");
  const paths = await source("res/xml/secure_export_paths.xml");

  assert.match(protocol, /ARCHIVE_PATH\s*=\s*"\/api\/account\/export\/archive"/);
  assert.match(protocol, /"https"\.equalsIgnoreCase/);
  assert.match(protocol, /byte\[\] buffer = new byte\[64 \* 1024\]/);
  assert.match(plugin, /sessionStore\.resolve\(handle, origin\)/);
  assert.match(plugin, /setRequestProperty\("Authorization", "Bearer " \+ token\)/);
  assert.match(plugin, /File\.createTempFile\("\.archive-", "\.part"/);
  assert.match(plugin, /output\.getFD\(\)\.sync\(\)/);
  assert.match(plugin, /Os\.rename\(/);
  assert.match(plugin, /FileProvider\.getUriForFile/);
  assert.match(plugin, /Intent\.FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(plugin, /postDelayed\(/);
  assert.match(plugin, /revokeUriPermission\(/);
  assert.match(manifest, /android:authorities="\$\{applicationId\}\.secureexportprovider"/);
  assert.match(manifest, /android:resource="@xml\/secure_export_paths"/);
  assert.match(paths, /<files-path name="private_exports" path="private-exports\/"\s*\/>/);
  assert.doesNotMatch(paths, /external-path|cache-path|path="\."/);
  assert.match(plugin, /getPackageName\(\) \+ "\.secureexportprovider"/);
  assert.match(plugin, /getFilesDir\(\)[\s\S]{0,100}private-exports\/account-archives/);
  assert.doesNotMatch(plugin, /Base64|readAllBytes|ByteBuffer\.allocate|Log\.|System\.out|printStackTrace/);
  assert.doesNotMatch(plugin, /call\.resolve\([^;]*(?:token|uri|absolutePath|path)/i);
});

test("Android WebView excludes generic filesystem readers and uses a bounded write-only text exporter", async () => {
  const config = await readFile(path.join(root, "..", "capacitor.config.ts"), "utf8");
  const packageJson = JSON.parse(await readFile(path.join(root, "..", "package.json"), "utf8"));
  let pluginManifest = null;
  try {
    pluginManifest = await readFile(path.join(app, "assets", "capacitor.plugins.json"), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const exporter = await source("java/cn/dsponline/network/TextExportPlugin.java");
  const settings = await readFile(path.join(root, "capacitor.settings.gradle"), "utf8");
  const build = await readFile(path.join(root, "app", "capacitor.build.gradle"), "utf8");
  assert.match(config, /includePlugins:\s*\[/);
  assert.doesNotMatch(config, /includePlugins:[\s\S]{0,500}@capacitor\/filesystem/);
  assert.doesNotMatch(config, /includePlugins:[\s\S]{0,500}@capacitor\/share/);
  const declaredPackages = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
  assert.equal(declaredPackages.some((name) => /^@capacitor\/(?:filesystem|share)$/.test(name)), false);
  if (pluginManifest !== null) assert.doesNotMatch(pluginManifest, /@capacitor\/(?:filesystem|share)/);
  assert.doesNotMatch(settings, /capacitor-(?:filesystem|share)/);
  assert.doesNotMatch(build, /capacitor-(?:filesystem|share)/);
  assert.match(exporter, /TextExportProtocol\.boundedUtf8/);
  assert.match(exporter, /TextExportProtocol\.boundedBase64/);
  assert.match(exporter, /exportBase64AndShare/);
  assert.match(exporter, /getFilesDir\(\), "private-exports"/);
  assert.doesNotMatch(exporter, /readFile|readdir|arrayBuffer/);
});

test("Android TypeScript archive bridge cannot pass raw tokens or archive bytes through WebView", async () => {
  const bridge = await readFile(path.join(root, "..", "src", "game", "androidAccountArchive.ts"), "utf8");
  assert.match(bridge, /sessionHandle: string/);
  assert.match(bridge, /DspAccountArchive/);
  assert.doesNotMatch(bridge, /authorization|Bearer|base64|arrayBuffer|Blob|Uint8Array/i);
});
