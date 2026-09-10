"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const { setImmediate: nextTurn } = require("node:timers/promises");
const test = require("node:test");
const { extractFile, uncache } = require("@electron/asar");
const { createCompletedAsar } = require("../tests/fixtures/complete-asar.cjs");

test("ASAR fixture waits for the final pending write before allowing validation", async () => {
  let completeWrite;
  const output = new Writable({ write(_chunk, _encoding, callback) { completeWrite = callback; } });
  let resolved = false;
  const pending = createCompletedAsar("source", "archive", async () => output.end("pending bytes"))
    .then(() => { resolved = true; });
  await nextTurn();
  const resolvedBeforeWrite = resolved;
  completeWrite();
  await pending;
  assert.equal(resolvedBeforeWrite, false);
  assert.equal(output.writableFinished, true);
  assert.equal(resolved, true);
});

test("ASAR final write errors reject instead of making an incomplete fixture look ready", async () => {
  let completeWrite;
  const output = new Writable({ write(_chunk, _encoding, callback) { completeWrite = callback; } });
  const pending = createCompletedAsar("source", "archive", async () => output.end("pending bytes"));
  const rejected = assert.rejects(pending, /synthetic final-write failure/);
  await nextTurn();
  completeWrite(new Error("synthetic final-write failure"));
  await rejected;
});

test("completed real ASAR fixtures can be read immediately and rewritten without stale bytes", async (t) => {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "dsp-complete-asar-"));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== parent || !path.basename(root).startsWith("dsp-complete-asar-")) {
      throw new Error("ASAR fixture cleanup escaped its temporary root");
    }
    uncache(path.join(root, "app.asar"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, "input");
  const target = path.join(root, "app.asar");
  fs.mkdirSync(source);
  for (const name of ["first", "replacement"]) {
    const metadata = JSON.stringify({ name, text: "合成夹具🙂".repeat(4096) });
    fs.writeFileSync(path.join(source, "package.json"), metadata);
    await createCompletedAsar(source, target);
    uncache(target);
    assert.equal(extractFile(target, "package.json").toString("utf8"), metadata);
  }
});
