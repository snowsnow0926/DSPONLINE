"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createHash } = require("node:crypto");

const { NativeAuthorityCloudTransfer } = require("./native-authority-cloud-transfer.cjs");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(fetchImpl) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsp-native-cloud-"));
  await fs.promises.mkdir(path.join(root, "exports"), { recursive: true });
  let exports = 0;
  const transfer = new NativeAuthorityCloudTransfer({
    rootPath: root,
    resolveRequestUrl: (requestPath) => new URL(requestPath, "https://mock.invalid/api/"),
    fetchImpl,
    now: () => 1234,
    createToken: () => "native-cloud-00000000-0000-4000-8000-000000000001",
    exportArtifact: async ({ exportId, savedAtMs }) => {
      exports += 1;
      const bytes = Buffer.from('{"formatVersion":2,"state":{"version":47}}');
      await fs.promises.writeFile(path.join(root, "exports", `${exportId}.json`), bytes);
      return {
        exportId,
        mode: "normal",
        result: {
          revision: 9,
          savedAtMs,
          byteLength: bytes.length,
          envelopeSha256: sha256(bytes),
          stateChecksum: "12345678",
        },
      };
    },
  });
  return { root, transfer, exportCount: () => exports };
}

test("streams a fixed native export with direct-payload headers and removes it only after confirmation", async (t) => {
  let received = Buffer.alloc(0);
  let requestOptions;
  const current = await fixture(async (_url, options) => {
    requestOptions = options;
    for await (const chunk of options.body) received = Buffer.concat([received, chunk]);
    return new Response(JSON.stringify({ cloudSave: { revision: 4, checksum: "12345678" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));

  const result = await current.transfer.upload({
    authorization: "Bearer abcdefgh12345678",
    expectedRevision: 3,
  });

  assert.equal(result.status, "confirmed");
  assert.equal(current.exportCount(), 1);
  assert.match(received.toString("utf8"), /"version":47/);
  assert.equal(requestOptions.headers["x-dsp-expected-revision"], "3");
  assert.equal(requestOptions.headers["x-dsp-request-id"], result.token);
  assert.equal((await fs.promises.readdir(path.join(current.root, "exports"))).length, 0);
  assert.equal((await fs.promises.readdir(path.join(current.root, "cloud-pending"))).length, 0);
});

test("unknown network status keeps the exact candidate and retries with the same token without exporting again", async (t) => {
  let attempts = 0;
  const current = await fixture(async (_url, options) => {
    attempts += 1;
    for await (const _chunk of options.body) { /* consume with backpressure */ }
    if (attempts === 1) throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    return new Response(JSON.stringify({ cloudSave: { revision: 8 } }), { status: 200 });
  });
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));

  const first = await current.transfer.upload({
    authorization: "Bearer abcdefgh12345678",
    expectedRevision: 7,
  });
  assert.equal(first.status, "unknown");
  assert.equal(current.exportCount(), 1);
  assert.equal((await fs.promises.readdir(path.join(current.root, "cloud-pending"))).length, 1);

  const retried = await current.transfer.upload({
    authorization: "Bearer abcdefgh12345678",
    expectedRevision: 7,
    retryToken: first.token,
  });
  assert.equal(retried.status, "confirmed");
  assert.equal(retried.token, first.token);
  assert.equal(current.exportCount(), 1);
});
