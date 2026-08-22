#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.resolve(repositoryRoot, "dist");

export async function verifyWebBuild({ root = distRoot } = {}) {
  const marker = JSON.parse(await readFile(path.join(root, "build-platform.json"), "utf8"));
  if (!marker || marker.platform !== "web") {
    throw new Error(`Web build marker is ${JSON.stringify(marker?.platform ?? null)}; expected web`);
  }
  const version = JSON.parse(await readFile(path.join(root, "version.json"), "utf8"));
  if (typeof version.buildId !== "string" || !version.buildId.trim()) {
    throw new Error("Web build is missing a non-empty build ID");
  }
  const html = await readFile(path.join(root, "index.html"), "utf8");
  if (!/assets\/[^"']+\.js/.test(html)) throw new Error("Web index does not reference a JavaScript entry");
  return { platform: marker.platform, buildId: version.buildId };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  verifyWebBuild()
    .then((result) => console.log(`Web build verified: ${JSON.stringify(result)}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
