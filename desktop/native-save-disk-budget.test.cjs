"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  MINIMUM_NATIVE_SAVE_HEADROOM_BYTES,
  NATIVE_SAVE_DISK_BUDGET_CODES,
  NativeSaveDiskBudgetError,
  exactUtf8PayloadBytes,
  requireNativeSaveDiskBudget,
} = require("./native-save-disk-budget.cjs");

const TARGET = "C:\\DSPidle2-Performance-Edition\\native-save-v1\\pending.chunk";
const PARENT = path.win32.dirname(TARGET);

function directDirectory() {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

function fakeFileSystem({ bsize = 1n, bavail = MINIMUM_NATIVE_SAVE_HEADROOM_BYTES * 2n } = {}) {
  const calls = { lstat: [], statfs: [], destructive: 0 };
  return {
    calls,
    lstatSync(target) {
      calls.lstat.push(target);
      return directDirectory();
    },
    statfsSync(target, options) {
      calls.statfs.push([target, options]);
      return { bsize, bavail, bfree: 0n };
    },
    rmSync() { calls.destructive += 1; throw new Error("must not delete"); },
    unlinkSync() { calls.destructive += 1; throw new Error("must not delete"); },
  };
}

function expectCode(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof NativeSaveDiskBudgetError);
    assert.equal(error.code, code);
    return true;
  });
}

test("measures exact UTF-8 bytes and calls statfsSync on the existing parent with bigint enabled", () => {
  const payload = ["ASCII", "白糖", "🚀", "\ud800"];
  const expectedPayloadBytes = BigInt(payload.reduce(
    (total, value) => total + Buffer.byteLength(value, "utf8"),
    0,
  ));
  assert.equal(exactUtf8PayloadBytes(payload), expectedPayloadBytes);

  const fileSystem = fakeFileSystem({
    bsize: 1n,
    bavail: expectedPayloadBytes + MINIMUM_NATIVE_SAVE_HEADROOM_BYTES,
  });
  const result = requireNativeSaveDiskBudget({ targetPath: TARGET, payload }, {
    fileSystem,
    pathModule: path.win32,
  });
  assert.deepEqual(result, {
    allowed: true,
    checked: true,
    code: NATIVE_SAVE_DISK_BUDGET_CODES.OK,
    payloadBytes: expectedPayloadBytes,
    minimumHeadroomBytes: 64n * 1024n * 1024n,
    requiredAvailableBytes: expectedPayloadBytes + MINIMUM_NATIVE_SAVE_HEADROOM_BYTES,
    availableBytes: expectedPayloadBytes + MINIMUM_NATIVE_SAVE_HEADROOM_BYTES,
  });
  assert.deepEqual(fileSystem.calls.lstat, [PARENT]);
  assert.deepEqual(fileSystem.calls.statfs, [[PARENT, { bigint: true }]]);
  assert.equal(fileSystem.calls.destructive, 0);
});

test("uses bavail and fails one byte below payload plus the fixed 64 MiB margin", () => {
  const payload = "磁石";
  const payloadBytes = exactUtf8PayloadBytes(payload);
  const fileSystem = fakeFileSystem({
    bsize: 1n,
    bavail: payloadBytes + MINIMUM_NATIVE_SAVE_HEADROOM_BYTES - 1n,
  });
  expectCode(
    () => requireNativeSaveDiskBudget({ targetPath: TARGET, payload }, { fileSystem, pathModule: path.win32 }),
    NATIVE_SAVE_DISK_BUDGET_CODES.SPACE_INSUFFICIENT,
  );
  assert.equal(fileSystem.calls.statfs.length, 1);
  assert.equal(fileSystem.calls.destructive, 0);
});

test("rejects relative, root, NUL, and missing request paths before filesystem access", () => {
  for (const targetPath of ["relative.save", "C:\\", "C:\\save\0evil"] ) {
    const fileSystem = fakeFileSystem();
    expectCode(
      () => requireNativeSaveDiskBudget({ targetPath, payload: "x" }, { fileSystem, pathModule: path.win32 }),
      NATIVE_SAVE_DISK_BUDGET_CODES.PATH_INVALID,
    );
    assert.equal(fileSystem.calls.lstat.length, 0);
    assert.equal(fileSystem.calls.statfs.length, 0);
  }
  expectCode(
    () => requireNativeSaveDiskBudget({ payload: "x" }, { fileSystem: fakeFileSystem(), pathModule: path.win32 }),
    NATIVE_SAVE_DISK_BUDGET_CODES.REQUEST_INVALID,
  );
});

test("requires a direct existing parent directory", () => {
  const missing = fakeFileSystem();
  missing.lstatSync = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
  expectCode(
    () => requireNativeSaveDiskBudget({ targetPath: TARGET, payload: "x" }, { fileSystem: missing, pathModule: path.win32 }),
    NATIVE_SAVE_DISK_BUDGET_CODES.PARENT_MISSING,
  );

  for (const metadata of [
    { isDirectory: () => false, isSymbolicLink: () => false },
    { isDirectory: () => false, isSymbolicLink: () => true },
  ]) {
    const invalid = fakeFileSystem();
    invalid.lstatSync = () => metadata;
    expectCode(
      () => requireNativeSaveDiskBudget({ targetPath: TARGET, payload: "x" }, { fileSystem: invalid, pathModule: path.win32 }),
      NATIVE_SAVE_DISK_BUDGET_CODES.PARENT_INVALID,
    );
  }
});

test("only an unsupported statfs capability fails open with an unchecked stable receipt", () => {
  const payloadBytes = exactUtf8PayloadBytes("x");
  const expected = {
    allowed: true,
    checked: false,
    code: NATIVE_SAVE_DISK_BUDGET_CODES.STATFS_UNSUPPORTED,
    payloadBytes,
    minimumHeadroomBytes: MINIMUM_NATIVE_SAVE_HEADROOM_BYTES,
    requiredAvailableBytes: payloadBytes + MINIMUM_NATIVE_SAVE_HEADROOM_BYTES,
  };
  const unsupported = {
    lstatSync: () => directDirectory(),
  };
  assert.deepEqual(
    requireNativeSaveDiskBudget({ targetPath: TARGET, payload: "x" }, {
      fileSystem: unsupported,
      pathModule: path.win32,
    }),
    expected,
  );

  for (const errorCode of ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "ERR_METHOD_NOT_IMPLEMENTED"]) {
    const unsupportedError = fakeFileSystem();
    unsupportedError.statfsSync = () => {
      throw Object.assign(new Error("unsupported"), { code: errorCode });
    };
    assert.deepEqual(
      requireNativeSaveDiskBudget({ targetPath: TARGET, payload: "x" }, {
        fileSystem: unsupportedError,
        pathModule: path.win32,
      }),
      expected,
    );
  }

  const failed = fakeFileSystem();
  failed.statfsSync = () => { throw Object.assign(new Error("private filesystem detail"), { code: "EIO" }); };
  expectCode(
    () => requireNativeSaveDiskBudget({ targetPath: TARGET, payload: "x" }, { fileSystem: failed, pathModule: path.win32 }),
    NATIVE_SAVE_DISK_BUDGET_CODES.STATFS_FAILED,
  );
});

test("rejects non-BigInt and impossible statfs receipts without numeric fallback", () => {
  for (const capacity of [
    { bsize: 4096, bavail: 1000 },
    { bsize: 0n, bavail: 1000n },
    { bsize: 4096n, bavail: -1n },
    { bsize: 4096n },
  ]) {
    const fileSystem = fakeFileSystem();
    fileSystem.statfsSync = () => capacity;
    expectCode(
      () => requireNativeSaveDiskBudget({ targetPath: TARGET, payload: "x" }, { fileSystem, pathModule: path.win32 }),
      NATIVE_SAVE_DISK_BUDGET_CODES.STATFS_INVALID,
    );
  }
});

test("keeps arithmetic exact above Number.MAX_SAFE_INTEGER", () => {
  const bsize = 2n ** 62n;
  const bavail = 2n ** 31n;
  const fileSystem = fakeFileSystem({ bsize, bavail });
  const result = requireNativeSaveDiskBudget({ targetPath: TARGET, payload: "x" }, {
    fileSystem,
    pathModule: path.win32,
  });
  assert.equal(result.availableBytes, bsize * bavail);
  assert.ok(result.availableBytes > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(typeof result.availableBytes, "bigint");
});

test("rejects non-string payload entries and unknown request fields before statfs", () => {
  const fileSystem = fakeFileSystem();
  for (const payload of [Buffer.from("x"), ["ok", 1], { value: "x" }, null]) {
    expectCode(
      () => requireNativeSaveDiskBudget({ targetPath: TARGET, payload }, { fileSystem, pathModule: path.win32 }),
      NATIVE_SAVE_DISK_BUDGET_CODES.PAYLOAD_INVALID,
    );
  }
  expectCode(
    () => requireNativeSaveDiskBudget({ targetPath: TARGET, payload: "x", reserveBytes: 0 }, {
      fileSystem,
      pathModule: path.win32,
    }),
    NATIVE_SAVE_DISK_BUDGET_CODES.REQUEST_INVALID,
  );
  assert.equal(fileSystem.calls.statfs.length, 0);
  assert.equal(fileSystem.calls.destructive, 0);
});
