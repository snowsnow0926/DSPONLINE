import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { aggregateManifestHash, parseSha256Sums, verifyReleasePreflight } from "./release-preflight.mjs";

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

test("release preflight verifies clean SHA, artifact hashes and aggregate", async () => {
  const root = await fsTempDirectory("dsp-release-preflight-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Release Test"], { cwd: root });
    const web = Buffer.from("web");
    const api = Buffer.from("api");
    await writeFile(path.join(root, "release-web.tar.gz"), web);
    await writeFile(path.join(root, "release-api.tar.gz"), api);
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const files = [
      { path: "release-api.tar.gz", size: api.length, sha256: digest(api) },
      { path: "release-web.tar.gz", size: web.length, sha256: digest(web) },
    ];
    const manifest = { formatVersion: 1, releaseId: `1.1.7-${sha.slice(0, 12)}`, appVersion: "1.1.7", buildId: `1.1.7+${sha.slice(0, 12)}`, git: { sha, clean: true }, fileCount: files.length, aggregateSha256: aggregateManifestHash(files), files };
    await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    await writeFile(path.join(root, "SHA256SUMS.txt"), `${files.map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`);
    const report = await verifyReleasePreflight({ manifestPath: path.join(root, "manifest.json"), shaSumsPath: path.join(root, "SHA256SUMS.txt"), workspaceRoot: root, expectedGitSha: sha, requireClean: false });
    assert.equal(report.ok, true);
    assert.equal(report.fileCount, 2);
    assert.equal(report.shaSumsVerified, 2);
    assert.equal(report.artifacts.web.size, web.length);
    await writeFile(path.join(root, "SHA256SUMS.txt"), `${files[0].sha256}  ${files[0].path}\n`);
    await assert.rejects(
      verifyReleasePreflight({ manifestPath: path.join(root, "manifest.json"), shaSumsPath: path.join(root, "SHA256SUMS.txt"), workspaceRoot: root, requireClean: false }),
      /SHA256SUMS missing manifest file/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SHA256SUMS parser rejects malformed records", () => {
  assert.deepEqual(parseSha256Sums(`${"a".repeat(64)}  file.tar.gz\n`), [{ sha256: "a".repeat(64), path: "file.tar.gz" }]);
  assert.throws(() => parseSha256Sums("not-a-checksum"), /invalid SHA256SUMS line/);
});

async function fsTempDirectory(prefix) {
  return (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), prefix));
}
