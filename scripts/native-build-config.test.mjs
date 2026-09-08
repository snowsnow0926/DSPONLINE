import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeBuildConfig } from "./native-build-config.mjs";
import { verifyBuiltPlatform } from "./verify-built-platform.mjs";

const official = {
  DSP_ANDROID_BUILD_PROFILE: "official",
  DSP_ANDROID_API_BASE_URL: "https://dsponline.cn/api",
  DSP_ANDROID_UPDATE_BASE_URL: "https://dsponline.cn/downloads/android",
  DSP_ANDROID_PUBLIC_ORIGIN: "https://dsponline.cn",
  DSP_RELEASE_CHANNEL: "stable",
};
test("official Android rejects each missing endpoint and invalid secure configuration", () => {
  for (const key of ["DSP_ANDROID_API_BASE_URL", "DSP_ANDROID_UPDATE_BASE_URL", "DSP_ANDROID_PUBLIC_ORIGIN"]) {
    for (const value of [undefined, "", " ", "http://example.test", "https://user:secret@example.test", "https://example.test?a=1", "https://example.test/#x"]) {
      assert.throws(() => nativeBuildConfig("android", { ...official, [key]: value }), new RegExp(key));
    }
  }
  assert.throws(() => nativeBuildConfig("android", { ...official, DSP_ANDROID_PUBLIC_ORIGIN: "https://example.test/path" }));
  assert.throws(() => nativeBuildConfig("android", { ...official, DSP_RELEASE_CHANNEL: "typo" }));
});
test("official endpoint map uses explicit configuration and channel", () => {
  assert.deepEqual(nativeBuildConfig("android", official), {
    VITE_APP_PLATFORM: "android", VITE_API_BASE_URL: "https://dsponline.cn/api",
    VITE_ANDROID_UPDATE_MANIFEST_URL: "https://dsponline.cn/downloads/android/stable.json",
    VITE_PUBLIC_APP_ORIGIN: "https://dsponline.cn", VITE_RELEASE_CHANNEL: "stable",
  });
  assert.equal(nativeBuildConfig("android", { ...official, DSP_RELEASE_CHANNEL: "beta" }).VITE_ANDROID_UPDATE_MANIFEST_URL,
    "https://dsponline.cn/downloads/android/beta.json");
});
test("community offline and desktop builds never acquire Android official endpoints", () => {
  assert.equal(nativeBuildConfig("android", {}).VITE_API_BASE_URL, "");
  const desktop = nativeBuildConfig("desktop", official);
  assert.equal(desktop.VITE_API_BASE_URL, "");
  assert.equal(desktop.VITE_ANDROID_UPDATE_MANIFEST_URL, "");
  assert.equal(desktop.VITE_PUBLIC_APP_ORIGIN, "");
  assert.equal(nativeBuildConfig("android", {}, "beta").VITE_RELEASE_CHANNEL, "beta");
});
test("protected official signer enables the fail-closed build profile", async () => {
  const helper = await readFile(new URL("../.codex/skills/develop-dspidle/scripts/invoke-protected-android-release.ps1", import.meta.url), "utf8");
  assert.match(helper, /\$childEnvironment = @\{\s*DSP_ANDROID_BUILD_PROFILE = 'official'/);
});
test("built-platform verification rejects the original empty bundle and missing update URL", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dsp-native-config-"));
  try {
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "version.json"), JSON.stringify({ platform: "android" }));
    const config = nativeBuildConfig("android", official);
    const urls = [config.VITE_API_BASE_URL, config.VITE_ANDROID_UPDATE_MANIFEST_URL, config.VITE_PUBLIC_APP_ORIGIN];
    const file = path.join(dir, "assets", "index.js");
    await writeFile(file, 'const cloudBase=null;');
    await assert.rejects(verifyBuiltPlatform("android", dir, urls), /missing/);
    await writeFile(file, `const cloudBase=${JSON.stringify(urls[0])};`);
    await assert.rejects(verifyBuiltPlatform("android", dir, urls), /missing/);
    await writeFile(file, `const configured=${JSON.stringify(urls)};`);
    await verifyBuiltPlatform("android", dir, urls);
    await assert.rejects(verifyBuiltPlatform("web", dir, urls), /mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
