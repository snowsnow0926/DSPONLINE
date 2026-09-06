import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { probeNodeHealth } from "./probe-node-health.mjs";

let directory;
let server;
let baseUrl;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "dsp-node-health-"));
  server = http.createServer((request, response) => {
    response.writeHead(request.url === "/ok" ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: request.url === "/ok" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

test("records healthy endpoint and disk checks without exposing response bodies", async () => {
  const statusFile = path.join(directory, "healthy.json");
  const result = await probeNodeHealth({ endpoints: [`${baseUrl}/ok`], dataDirectory: directory, statusFile, minimumDiskFreeRatio: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.endpoints[0].status, 200);
  assert.equal("body" in result.endpoints[0], false);
  assert.equal(JSON.parse(await readFile(statusFile, "utf8")).disk.ok, true);
});

test("marks failed endpoints and attempts a privacy-safe alert", async () => {
  const alerts = [];
  const fetchImpl = async (url, options) => {
    if (url === "https://alerts.example.test") {
      alerts.push(JSON.parse(options.body));
      return new Response("{}", { status: 202 });
    }
    return fetch(url, options);
  };
  const result = await probeNodeHealth({
    endpoints: [`${baseUrl}/failed`],
    dataDirectory: directory,
    statusFile: path.join(directory, "failed.json"),
    minimumDiskFreeRatio: 0,
    alertWebhookUrl: "https://alerts.example.test",
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.alertSent, true);
  assert.deepEqual(alerts[0].failedChecks, [`endpoint:${baseUrl}/failed`]);
  assert.equal(JSON.stringify(alerts[0]).includes("password"), false);
});

test("fails the disk gate before a release when reserved snapshot headroom would cross the threshold", async () => {
  const result = await probeNodeHealth({
    endpoints: [`${baseUrl}/ok`],
    dataDirectory: directory,
    statusFile: path.join(directory, "reserved-headroom.json"),
    minimumDiskFreeRatio: 0,
    reservedBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failedChecks, ["disk"]);
  assert.equal(result.disk.reservedBytes, Number.MAX_SAFE_INTEGER);
  assert.ok(result.disk.postReserveFreeBytes < 0);
  assert.ok(result.disk.postReserveFreeRatio < 0);
});

test("rejects malformed headroom configuration instead of silently disabling the gate", async () => {
  await assert.rejects(
    probeNodeHealth({ dataDirectory: directory, statusFile: path.join(directory, "invalid-headroom.json"), reservedBytes: "not-a-number" }),
    /reservedBytes must be a non-negative number/,
  );
});
