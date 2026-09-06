import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { probeRelease } from "./probe-release.mjs";

const artifact = Buffer.from("synthetic release artifact\n", "utf8");
const sha256 = createHash("sha256").update(artifact).digest("hex");
let server;
let baseUrl;

before(async () => {
  server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end("<!doctype html><title>synthetic release 1.0.40</title>");
      return;
    }
    if (request.url === "/version.json") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache, no-store" });
      response.end(JSON.stringify({ version: "1.0.40", buildId: "1.0.40+synthetic" }));
      return;
    }
    if (request.url === "/downloads/app.bin") {
      const range = /^bytes=(\d+)-(\d*)$/i.exec(request.headers.range || "");
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : artifact.length - 1, artifact.length - 1);
        if (start >= artifact.length || end < start) {
          response.writeHead(416, { "content-range": `bytes */${artifact.length}` });
          response.end();
          return;
        }
        const body = artifact.subarray(start, end + 1);
        response.writeHead(206, {
          "accept-ranges": "bytes",
          "cache-control": "public, max-age=31536000, immutable",
          "content-length": body.length,
          "content-range": `bytes ${start}-${end}/${artifact.length}`,
        });
        response.end(body);
        return;
      }
      response.writeHead(200, { "accept-ranges": "bytes", "cache-control": "public, max-age=31536000, immutable", "content-length": artifact.length });
      response.end(artifact);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server.close(resolve)));

test("probes page, version metadata, Range and artifact integrity against synthetic HTTP", async () => {
  const report = await probeRelease({
    baseUrl,
    expectedVersion: "1.0.40",
    expectedBuildId: "1.0.40+synthetic",
    artifacts: [{ path: "/downloads/app.bin", size: artifact.length, sha256 }],
  });
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 3);
  assert.equal(report.checks.at(-1).rangeStatus, 206);
  assert.equal(report.checks.at(-1).sha256, sha256);
});

test("reports stale version, cache and hash failures without exposing response bodies", async () => {
  const report = await probeRelease({
    baseUrl,
    expectedVersion: "1.0.39",
    artifacts: [{ path: "/downloads/app.bin", size: artifact.length + 1, sha256: "0".repeat(64) }],
  });
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /version is/);
  assert.match(report.errors.join("\n"), /size|sha256/);
  assert.equal(report.errors.join("\n").includes(artifact.toString()), false);
});

test("bounds concurrent artifact probes while preserving manifest order", async () => {
  let active = 0;
  let maximumActive = 0;
  const fetchImpl = async (url, options) => {
    const isArtifact = String(url).includes("/downloads/app.bin");
    if (isArtifact) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    try {
      return await fetch(url, options);
    } finally {
      if (isArtifact) active -= 1;
    }
  };
  const report = await probeRelease({
    baseUrl,
    expectedVersion: "1.0.40",
    expectedBuildId: "1.0.40+synthetic",
    concurrency: 2,
    artifacts: Array.from({ length: 5 }, (_, index) => ({
      name: `artifact-${index}`,
      path: "/downloads/app.bin",
      size: artifact.length,
      sha256,
    })),
    fetchImpl,
  });
  assert.equal(report.ok, true);
  assert.equal(maximumActive <= 2, true);
  assert.deepEqual(report.checks.slice(2).map((entry) => entry.name), [
    "artifact-0",
    "artifact-1",
    "artifact-2",
    "artifact-3",
    "artifact-4",
  ]);
});
