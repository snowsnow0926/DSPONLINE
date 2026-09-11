import { createHash } from "node:crypto";
import { access, copyFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
  args.set(key.slice(2), value);
  index += 1;
}

const releaseDirectory = path.resolve(root, args.get("release") || "release/download-site");
const templatePath = path.resolve(root, args.get("template") || "deploy/download-page-template.html");
const iconPath = path.resolve(root, args.get("icon") || "public/icon.svg");
const androidManifestPath = path.join(releaseDirectory, "downloads/android/stable.json");
const desktopManifestPath = path.join(releaseDirectory, "downloads/desktop/stable/release.json");
const desktopFeedPath = path.join(releaseDirectory, "downloads/desktop/stable/latest.yml");
const versionPath = path.join(releaseDirectory, "version.json");

const [version, android, desktop, desktopFeed, template] = await Promise.all([
  readFile(versionPath, "utf8").then(JSON.parse),
  readFile(androidManifestPath, "utf8").then(JSON.parse),
  readFile(desktopManifestPath, "utf8").then(JSON.parse),
  readFile(desktopFeedPath, "utf8"),
  readFile(templatePath, "utf8"),
]);

const yamlValue = (name) => new RegExp(`^${name}:\\s*['\\"]?([^'\\"\\r\\n]+)['\\"]?\\s*$`, "m").exec(desktopFeed)?.[1]?.trim() || "";
const requiredVersion = (value, label) => {
  // Keep the same version-name format accepted by the native update client.
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${label} must contain a valid version`);
  }
  return value;
};
const desktopVersion = requiredVersion(desktop.version, "Desktop release manifest version");
if ([...desktopFeed.matchAll(/^version:/gm)].length !== 1) {
  throw new Error("Desktop latest.yml must contain exactly one version");
}
const desktopFeedVersion = requiredVersion(yamlValue("version"), "Desktop latest.yml version");
if (desktopFeedVersion !== desktopVersion) throw new Error("Desktop latest.yml version does not match release manifest version");
const androidVersion = requiredVersion(android.versionName, "Android manifest versionName");
if (!Number.isSafeInteger(android.versionCode) || android.versionCode <= 0 || android.versionCode > 2_100_000_000) {
  throw new Error("Android manifest versionCode must be a positive Android-compatible integer");
}
const desktopFile = path.basename(yamlValue("path"));
const desktopRecord = desktop.files.find((file) => file.name === desktopFile);
if (!desktopFile || !desktopRecord) throw new Error("Desktop release manifest does not contain latest.yml artifact");
if (!android.apk?.url || !android.apk.url.endsWith(`/${path.basename(android.apk.url)}`)) throw new Error("Android release manifest has an invalid APK URL");
const androidFile = path.basename(android.apk.url);
const androidPath = path.join(releaseDirectory, "downloads/android", androidFile);
const desktopPath = path.join(releaseDirectory, "downloads/desktop/stable", desktopFile);
await Promise.all([access(androidPath), access(desktopPath)]);

const sha256 = async (filePath) => createHash("sha256").update(await readFile(filePath)).digest("hex");
const [androidStats, desktopStats, androidSha, desktopSha] = await Promise.all([
  stat(androidPath),
  stat(desktopPath),
  sha256(androidPath),
  sha256(desktopPath),
]);
if (androidStats.size !== Number(android.apk.size)) throw new Error("Android manifest size does not match APK");
if (desktopStats.size !== Number(desktopRecord.size)) throw new Error("Desktop manifest size does not match installer");
if (androidSha !== String(android.apk.sha256).toLowerCase()) throw new Error("Android manifest SHA-256 does not match APK");
if (desktopSha !== String(desktopRecord.sha256).toLowerCase()) throw new Error("Desktop manifest SHA-256 does not match installer");

const humanSize = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const escaped = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const requestedSummary = args.get("summary")?.trim();
if (requestedSummary && (requestedSummary.length < 8 || requestedSummary.length > 600)) {
  throw new Error("--summary must contain between 8 and 600 characters");
}
const notes = requestedSummary
  || `网页版 ${version.version}；Windows ${desktopVersion}；Android ${androidVersion}。完整改动与兼容性说明请查看应用内版本公告`;
const values = {
  __VERSION__: version.version,
  __BUILD_ID__: version.buildId,
  __DESKTOP_VERSION__: desktopVersion,
  __DESKTOP_SIZE_HUMAN__: humanSize(desktopStats.size),
  __DESKTOP_SIZE__: desktopStats.size,
  __DESKTOP_FILE__: desktopFile,
  __DESKTOP_SHA256__: desktopSha,
  __ANDROID_VERSION__: androidVersion,
  __ANDROID_SIZE_HUMAN__: humanSize(androidStats.size),
  __ANDROID_SIZE__: androidStats.size,
  __ANDROID_CODE__: android.versionCode,
  __ANDROID_FILE__: androidFile,
  __ANDROID_SHA256__: androidSha,
  __RELEASE_SUMMARY__: notes,
};
let page = template;
for (const [key, value] of Object.entries(values)) page = page.replaceAll(key, escaped(value));
if (page.includes("__VERSION__") || page.includes("__ANDROID_") || page.includes("__DESKTOP_")) throw new Error("Download page contains unresolved placeholders");
await Promise.all([
  writeFile(path.join(releaseDirectory, "index.html"), page, "utf8"),
  copyFile(iconPath, path.join(releaseDirectory, "icon.svg")),
]);
console.log(`Download page generated for ${version.version} at ${path.relative(root, path.join(releaseDirectory, "index.html"))}`);
