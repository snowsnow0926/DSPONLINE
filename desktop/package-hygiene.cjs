const fs = require("node:fs");
const path = require("node:path");
const { listPackage } = require("@electron/asar");

const CAPACITOR_ANDROID_BUILD_ENTRY = /(?:^|\/)node_modules\/@capacitor\/[^/]+\/android\/build(?:\/|$)/i;

function isForbiddenDesktopPackageEntry(entry) {
  return CAPACITOR_ANDROID_BUILD_ENTRY.test(String(entry).replaceAll("\\", "/"));
}

function listRelativeFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return files;
}

/**
 * Gradle writes generated classes and intermediates back into Capacitor's
 * package directories. Electron automatically follows production dependency
 * trees even when `build.files` is narrow, so a Windows build run after an
 * Android build could silently absorb tens of megabytes of those leftovers.
 */
function verifyDesktopPackageHygiene(asarPath, unpackedRoot = `${asarPath}.unpacked`) {
  if (!fs.existsSync(asarPath)) throw new Error(`桌面包缺少 ${asarPath}`);
  const asarEntries = listPackage(asarPath);
  const forbidden = [
    ...asarEntries.filter(isForbiddenDesktopPackageEntry),
    ...listRelativeFiles(unpackedRoot)
      .filter(isForbiddenDesktopPackageEntry)
      .map((entry) => `app.asar.unpacked/${entry}`),
  ];
  if (forbidden.length > 0) {
    throw new Error(`桌面包混入 Android 构建残留：${forbidden.slice(0, 8).join(", ")}`);
  }
  return { asarEntries: asarEntries.length, forbiddenEntries: 0 };
}

module.exports = {
  isForbiddenDesktopPackageEntry,
  verifyDesktopPackageHygiene,
};
