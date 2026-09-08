import { realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supportedPlatforms = new Set(["web", "desktop", "android"]);

export async function verifyBuiltPlatform(expectedPlatform, distRoot = path.resolve("dist"), requiredUrls = []) {
  if (!supportedPlatforms.has(expectedPlatform)) {
    throw new Error(`Unsupported expected platform: ${expectedPlatform}`);
  }
  const versionPath = path.join(distRoot, "version.json");
  const metadata = JSON.parse(await readFile(versionPath, "utf8"));
  if (metadata.platform !== expectedPlatform) {
    throw new Error(`Built platform mismatch: expected ${expectedPlatform}, received ${String(metadata.platform)}`);
  }
  if (requiredUrls.length) {
    const assets = path.join(distRoot, "assets");
    const scripts = (await readdir(assets)).filter((name) => name.endsWith(".js"));
    const compiled = (await Promise.all(scripts.map((name) => readFile(path.join(assets, name), "utf8")))).join("\n");
    for (const url of requiredUrls) {
      const literals = [JSON.stringify(url), `'${url.replaceAll("'", "\\'")}'`, `\`${url.replaceAll("`", "\\`").replaceAll("${", "\\${")}\``];
      if (!literals.some((literal) => compiled.includes(literal))) throw new Error("Built native JavaScript is missing a configured service URL");
    }
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
