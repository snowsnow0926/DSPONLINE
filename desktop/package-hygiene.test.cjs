const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPackage } = require("@electron/asar");

const {
  isForbiddenDesktopPackageEntry,
  verifyDesktopPackageHygiene,
} = require("./package-hygiene.cjs");

test("classifies only generated Capacitor Android build trees as forbidden", () => {
  assert.equal(isForbiddenDesktopPackageEntry("/node_modules/@capacitor/app/android/build/intermediates/classes.jar"), true);
  assert.equal(isForbiddenDesktopPackageEntry("node_modules\\@capacitor\\core\\android\\build\\tmp\\x"), true);
  assert.equal(isForbiddenDesktopPackageEntry("/node_modules/@capacitor/app/android/src/main/AndroidManifest.xml"), false);
  assert.equal(isForbiddenDesktopPackageEntry("/desktop/build/icon.png"), false);
});

test("accepts a clean asar and rejects residue in packed or unpacked dependency trees", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-package-hygiene-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cleanSource = path.join(root, "clean");
  fs.mkdirSync(cleanSource, { recursive: true });
  fs.writeFileSync(path.join(cleanSource, "package.json"), "{}");
  const cleanAsar = path.join(root, "clean.asar");
  await createPackage(cleanSource, cleanAsar);
  assert.deepEqual(verifyDesktopPackageHygiene(cleanAsar), { asarEntries: 1, forbiddenEntries: 0 });

  const dirtySource = path.join(root, "dirty");
  const dirtyPath = path.join(dirtySource, "node_modules", "@capacitor", "app", "android", "build", "classes.bin");
  fs.mkdirSync(path.dirname(dirtyPath), { recursive: true });
  fs.writeFileSync(dirtyPath, "generated");
  const dirtyAsar = path.join(root, "dirty.asar");
  await createPackage(dirtySource, dirtyAsar);
  assert.throws(() => verifyDesktopPackageHygiene(dirtyAsar), /Android 构建残留/);

  const unpackedPath = path.join(cleanAsar + ".unpacked", "node_modules", "@capacitor", "core", "android", "build", "tmp.bin");
  fs.mkdirSync(path.dirname(unpackedPath), { recursive: true });
  fs.writeFileSync(unpackedPath, "generated");
  assert.throws(() => verifyDesktopPackageHygiene(cleanAsar), /Android 构建残留/);
});
