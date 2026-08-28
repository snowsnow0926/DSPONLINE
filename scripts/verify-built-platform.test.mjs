import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyBuiltPlatform } from "./verify-built-platform.mjs";

test("accepts a build whose emitted platform matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsp-built-platform-"));
  try {
    await writeFile(path.join(root, "version.json"), JSON.stringify({ version: "1.2.4", buildId: "test", platform: "web" }));
    const metadata = await verifyBuiltPlatform("web", root);
    assert.equal(metadata.platform, "web");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a desktop build presented as a Web artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsp-built-platform-"));
  try {
    await writeFile(path.join(root, "version.json"), JSON.stringify({ version: "1.2.4", buildId: "test", platform: "desktop" }));
    await assert.rejects(() => verifyBuiltPlatform("web", root), /expected web, received desktop/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
