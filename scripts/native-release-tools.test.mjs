import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const nativeVersionProperties = Object.fromEntries((await readFile(path.join(root, "android", "native-version.properties"), "utf8"))
  .trim().split(/\r?\n/).map((line) => line.split("=", 2)));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function downloadPageFixture(temporary, {
  webVersion = packageVersion,
  androidVersion = webVersion,
  androidCode = Number(nativeVersionProperties.VERSION_CODE),
  desktopVersion = webVersion,
} = {}) {
  const androidDirectory = path.join(temporary, "downloads", "android");
  const desktopDirectory = path.join(temporary, "downloads", "desktop", "stable");
  await mkdir(androidDirectory, { recursive: true });
  await mkdir(desktopDirectory, { recursive: true });
  const apk = Buffer.from("apk fixture");
  const installer = Buffer.from("windows installer fixture");
  const installerName = `dsp-idle-${desktopVersion}-x64-setup.exe`;
  const apkName = `dsp-idle-${androidVersion}-${androidCode}.apk`;
  const desktopFeed = `version: ${desktopVersion}\npath: ${installerName}\n`;
  const android = {
    versionName: androidVersion,
    versionCode: androidCode,
    apk: { url: `https://download.example.test/downloads/android/${apkName}`, sha256: sha256(apk), size: apk.byteLength },
  };
  const desktop = {
    version: desktopVersion,
    files: [{ name: "latest.yml", sha256: sha256(Buffer.from(desktopFeed)), size: Buffer.byteLength(desktopFeed) },
      { name: installerName, sha256: sha256(installer), size: installer.byteLength }],
  };
  await writeFile(path.join(androidDirectory, apkName), apk);
  await writeFile(path.join(desktopDirectory, installerName), installer);
  await writeFile(path.join(desktopDirectory, "latest.yml"), desktopFeed);
  await writeFile(path.join(temporary, "version.json"), JSON.stringify({ version: webVersion, buildId: "test-build" }));
  await writeFile(path.join(androidDirectory, "stable.json"), JSON.stringify(android));
  await writeFile(path.join(desktopDirectory, "release.json"), JSON.stringify(desktop));
  return { androidDirectory, desktopDirectory, android, desktop, desktopFeed, apk, installer, apkName, installerName };
}

test("native feed generator creates bounded Android and desktop update feeds", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "dsp-native-feed-"));
  try {
    const apk = path.join(temporary, "app-debug.apk");
    const desktopSource = path.join(temporary, "desktop-source");
    const output = path.join(temporary, "feed");
    await writeFile(apk, Buffer.from("debug apk fixture"));
    await mkdir(desktopSource);
    await writeFile(path.join(desktopSource, "dsp-idle-1.0.1-x64-setup.exe"), Buffer.from("desktop fixture"));
    await writeFile(path.join(desktopSource, "latest.yml"), "version: 1.0.1\npath: dsp-idle-1.0.1-x64-setup.exe\nsha512: fixture\n");
    await execFileAsync(process.execPath, [
      path.join(root, "scripts", "create-native-update-manifests.mjs"),
      "--channel", "stable",
      "--base-url", "https://dsponline.cn/downloads/",
      "--android-apk", apk,
      "--allow-debug", "true",
      "--desktop-source", desktopSource,
      "--output", output,
      "--notes", "原生测试|更新机制",
    ], { cwd: root });

    const android = JSON.parse(await readFile(path.join(output, "android", "stable.json"), "utf8"));
    assert.equal(android.packageId, "cn.dsponline.network");
    assert.equal(android.versionName, packageVersion);
    assert.equal(android.apk.url, `https://dsponline.cn/downloads/android/dsp-idle-${packageVersion}-${nativeVersionProperties.VERSION_CODE}.apk`);
    assert.match(android.apk.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(android.notes, ["原生测试", "更新机制"]);

    const desktop = JSON.parse(await readFile(path.join(output, "desktop", "stable", "release.json"), "utf8"));
    assert.equal(desktop.channel, "stable");
    assert.equal(desktop.version, packageVersion);
    assert.deepEqual(desktop.files.map((file) => file.name), ["latest.yml", "dsp-idle-1.0.1-x64-setup.exe"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("native feed generator refuses a debug APK by default", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "dsp-native-feed-reject-"));
  try {
    const apk = path.join(temporary, "app-debug.apk");
    await writeFile(apk, Buffer.from("debug apk fixture"));
    await assert.rejects(execFileAsync(process.execPath, [
      path.join(root, "scripts", "create-native-update-manifests.mjs"),
      "--base-url", "https://updates.example.test/downloads/",
      "--android-apk", apk,
      "--output", path.join(temporary, "feed"),
    ], { cwd: root }), /Refusing to publish a debug-signed or unsigned APK/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("native feed generator requires an explicit update base URL", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "dsp-native-feed-base-url-"));
  try {
    const apk = path.join(temporary, "app-debug.apk");
    await writeFile(apk, Buffer.from("debug apk fixture"));
    await assert.rejects(execFileAsync(process.execPath, [
      path.join(root, "scripts", "create-native-update-manifests.mjs"),
      "--android-apk", apk,
      "--allow-debug", "true",
      "--output", path.join(temporary, "feed"),
    ], { cwd: root, env: { ...process.env, DSP_NATIVE_UPDATE_BASE_URL: "" } }), /base-url.*required/i);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("static download page generator validates manifests and renders current packages", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "dsp-download-page-"));
  try {
    const { desktopDirectory, apk, installer } = await downloadPageFixture(temporary);

    const releaseSummary = `${packageVersion} 测试摘要：普通与速通存档保持隔离`;
    await execFileAsync(process.execPath, [
      path.join(root, "scripts", "create-download-site.mjs"),
      "--release", temporary,
      "--summary", releaseSummary,
    ], { cwd: root });
    const page = await readFile(path.join(temporary, "index.html"), "utf8");
    assert.match(page, new RegExp(`下载 Windows ${packageVersion}`));
    assert.match(page, new RegExp(`下载 Android ${packageVersion}`));
    assert.match(page, new RegExp(sha256(installer)));
    assert.match(page, new RegExp(sha256(apk)));
    assert.match(page, new RegExp(releaseSummary));
    assert.match(page, /<link rel="icon" href="\/icon\.svg" type="image\/svg\+xml" \/>/);
    assert.deepEqual(
      await readFile(path.join(temporary, "icon.svg")),
      await readFile(path.join(root, "public", "icon.svg")),
    );

    const mismatched = JSON.parse(await readFile(path.join(desktopDirectory, "release.json"), "utf8"));
    mismatched.files[1].sha256 = "0".repeat(64);
    await writeFile(path.join(desktopDirectory, "release.json"), JSON.stringify(mismatched));
    await assert.rejects(execFileAsync(process.execPath, [
      path.join(root, "scripts", "create-download-site.mjs"),
      "--release", temporary,
    ], { cwd: root }), /Desktop manifest SHA-256 does not match installer/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("static download page renders independent platform versions without rewriting packages or feeds", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "dsp-download-platform-versions-"));
  try {
    const fixture = await downloadPageFixture(temporary, {
      webVersion: "1.2.7", androidVersion: "1.2.7", androidCode: 1002007, desktopVersion: "1.2.6",
    });
    const protectedFiles = [
      path.join(fixture.desktopDirectory, fixture.installerName),
      path.join(fixture.desktopDirectory, "latest.yml"),
      path.join(fixture.desktopDirectory, "release.json"),
      path.join(fixture.androidDirectory, fixture.apkName),
      path.join(fixture.androidDirectory, "stable.json"),
    ];
    const before = await Promise.all(protectedFiles.map((file) => readFile(file)));
    await execFileAsync(process.execPath, [
      path.join(root, "scripts", "create-download-site.mjs"), "--release", temporary,
    ], { cwd: root });
    const page = await readFile(path.join(temporary, "index.html"), "utf8");
    assert.match(page, /网页版当前版本 <strong>1\.2\.7<\/strong>/);
    assert.match(page, /<dt>版本<\/dt><dd>1\.2\.6<\/dd>/);
    assert.match(page, /下载 Windows 1\.2\.6/);
    assert.doesNotMatch(page, /下载 Windows 1\.2\.7/);
    assert.match(page, /<dt>版本<\/dt><dd>1\.2\.7（1002007）<\/dd>/);
    assert.match(page, /下载 Android 1\.2\.7/);
    assert.match(page, /href="\/downloads\/desktop\/stable\/dsp-idle-1\.2\.6-x64-setup\.exe"/);
    assert.match(page, /href="\/downloads\/android\/dsp-idle-1\.2\.7-1002007\.apk"/);
    assert.deepEqual(await Promise.all(protectedFiles.map((file) => readFile(file))), before);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("static download page rejects missing, invalid or inconsistent manifest versions before replacing the page", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "dsp-download-invalid-versions-"));
  try {
    const fixture = await downloadPageFixture(temporary);
    const androidPath = path.join(fixture.androidDirectory, "stable.json");
    const desktopPath = path.join(fixture.desktopDirectory, "release.json");
    const feedPath = path.join(fixture.desktopDirectory, "latest.yml");
    const pagePath = path.join(temporary, "index.html");
    await writeFile(pagePath, "previous generated page");
    const cases = [
      { target: "desktop", field: "version", value: undefined, error: /Desktop release manifest version must contain a valid version/ },
      { target: "desktop", field: "version", value: "not-a-version", error: /Desktop release manifest version must contain a valid version/ },
      { feed: `path: ${fixture.installerName}\n`, error: /latest.yml must contain exactly one version/ },
      { feed: `version: 9.9.9\npath: ${fixture.installerName}\n`, error: /latest.yml version does not match release manifest version/ },
      { feed: `version: ${packageVersion}\nversion: 9.9.9\npath: ${fixture.installerName}\n`, error: /latest.yml must contain exactly one version/ },
      ...[undefined, "", "1.2", "<script>", 127].map((value) => ({
        target: "android", field: "versionName", value, error: /Android manifest versionName must contain a valid version/,
      })),
      ...[undefined, "1002007", 0, -1, 1.5, 2_100_000_001].map((value) => ({
        target: "android", field: "versionCode", value, error: /Android manifest versionCode must be a positive Android-compatible integer/,
      })),
    ];
    for (const scenario of cases) {
      const android = structuredClone(fixture.android);
      const desktop = structuredClone(fixture.desktop);
      if (scenario.target) {
        const manifest = scenario.target === "android" ? android : desktop;
        if (scenario.value === undefined) delete manifest[scenario.field];
        else manifest[scenario.field] = scenario.value;
      }
      await writeFile(androidPath, JSON.stringify(android));
      await writeFile(desktopPath, JSON.stringify(desktop));
      await writeFile(feedPath, scenario.feed ?? fixture.desktopFeed);
      await assert.rejects(execFileAsync(process.execPath, [
        path.join(root, "scripts", "create-download-site.mjs"), "--release", temporary,
      ], { cwd: root }), scenario.error);
      assert.equal(await readFile(pagePath, "utf8"), "previous generated page");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Windows performance package smoke uses an explicit bounded temporary profile and exact process IDs", async () => {
  const source = await readFile(path.join(root, "scripts", "smoke-windows-performance-package.ps1"), "utf8");
  assert.match(source, /DSP_PERFORMANCE_SMOKE_ISOLATION/);
  assert.match(source, /DSP_PERFORMANCE_SMOKE_APP_DATA_ROOT/);
  assert.match(source, /dspidle-performance-smoke-/);
  assert.match(source, /Start-Process[^\n]+-WindowStyle Hidden[^\n]+-PassThru/);
  assert.match(source, /\$ResidualProcessIds = @\(if \(\$null -ne \$StartedProcess\)/);
  assert.match(source, /Stop-Process -Id/);
  assert.match(source, /Remove-Item -LiteralPath \$FinalSmokeRoot -Recurse -Force/);
  assert.doesNotMatch(source, /taskkill|Stop-Process\s+-(?:Name|ProcessName)|Remove-Item\s+[^\n]*\*/i);
});
