import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supportedPlatforms = new Set(["web", "desktop", "android"]);

export async function verifyBuiltPlatform(expectedPlatform, distRoot = path.resolve("dist")) {
  if (!supportedPlatforms.has(expectedPlatform)) {
    throw new Error(`Unsupported expected platform: ${expectedPlatform}`);
  }
  const versionPath = path.join(distRoot, "version.json");
  const metadata = JSON.parse(await readFile(versionPath, "utf8"));
  if (metadata.platform !== expectedPlatform) {
    throw new Error(`Built platform mismatch: expected ${expectedPlatform}, received ${String(metadata.platform)}`);
  }
  return metadata;
}

let isMain = false;
try {
  isMain = Boolean(process.argv[1])
    && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isMain = false;
}

if (isMain) {
  const expectedPlatform = process.argv[2];
  await verifyBuiltPlatform(expectedPlatform);
  process.stdout.write(`built-platform-ok\t${expectedPlatform}\n`);
}
