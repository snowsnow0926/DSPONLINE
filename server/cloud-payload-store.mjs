import { createHash } from "node:crypto";

export const CLOUD_PAYLOAD_STORE_INTERNAL_VERSION = 1;
export const CLOUD_PAYLOAD_SQLITE_LAYOUT_VERSION = 2;
export const CLOUD_PAYLOAD_TABLE = "cloud_save_payloads";
export const CLOUD_PAYLOAD_BLOB_TABLE = "cloud_save_payload_blobs";
export const CLOUD_PAYLOAD_ALIAS_PREFIX = "\u001eDSPIDLE-CLOUD-PAYLOAD-ALIAS/V1/";

const CLOUD_PAYLOAD_ALIAS_SUFFIX = "\u001f";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ALIAS_PATTERN = /^\u001eDSPIDLE-CLOUD-PAYLOAD-ALIAS\/V1\/([0-9a-f]{64})\/(0|[1-9][0-9]{0,15})\u001f$/;
const CLOUD_PAYLOAD_ALIAS_PROJECTION_CHARACTERS = 161;
const DEFAULT_SCAN_BATCH_SIZE = 1;

export class CloudPayloadStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CloudPayloadStoreError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new CloudPayloadStoreError(code, message, details);
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
    fail("CLOUD_PAYLOAD_DATABASE_INVALID", "A synchronous SQLite database connection is required");
  }
}

function requireOuterTransaction(database, operation) {
  assertDatabase(database);
  if (database.inTransaction !== true) {
    fail(
      "CLOUD_PAYLOAD_TRANSACTION_REQUIRED",
      `${operation} requires a caller-owned SQLite transaction`,
      { operation },
    );
  }
}

function assertTableColumns(database, tableName, requiredColumns) {
  const row = database.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(tableName);
  if (!row || row.type !== "table") {
    fail("CLOUD_PAYLOAD_SCHEMA_INVALID", `Required SQLite table ${tableName} is missing`);
  }
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  const byName = new Map(columns.map((column) => [column.name, column]));
  const names = new Set(byName.keys());
  const missing = requiredColumns.filter((column) => !names.has(column));
  if (missing.length > 0) {
    fail("CLOUD_PAYLOAD_SCHEMA_INVALID", `SQLite table ${tableName} has an incompatible shape`, {
      table: tableName,
      missingColumns: missing,
    });
  }
  return byName;
}

function declaredType(column) {
  return typeof column?.type === "string" ? column.type.trim().toUpperCase() : "";
}

function assertCanonicalPayloadTableShape(columns) {
  const expected = [
    ["user_id", "TEXT", 1],
    ["slot", "TEXT", 2],
    ["revision", "INTEGER", 3],
    ["payload", "TEXT", 0],
  ];
  for (const [name, type, primaryKeyPosition] of expected) {
    const column = columns.get(name);
    if (declaredType(column) !== type || Number(column?.notnull) !== 1 || Number(column?.pk) !== primaryKeyPosition) {
      fail("CLOUD_PAYLOAD_SCHEMA_INVALID", `SQLite table ${CLOUD_PAYLOAD_TABLE} has an incompatible ${name} column`);
    }
  }
}

function assertBlobTableShape(columns) {
  const checksum = columns.get("checksum");
  const sizeBytes = columns.get("size_bytes");
  const payload = columns.get("payload");
  if (declaredType(checksum) !== "TEXT" || Number(checksum?.notnull) !== 1 || Number(checksum?.pk) !== 1 ||
      declaredType(sizeBytes) !== "INTEGER" || Number(sizeBytes?.notnull) !== 1 || Number(sizeBytes?.pk) !== 0 ||
      declaredType(payload) !== "TEXT" || Number(payload?.notnull) !== 1 || Number(payload?.pk) !== 0) {
    fail("CLOUD_PAYLOAD_SCHEMA_INVALID", `SQLite table ${CLOUD_PAYLOAD_BLOB_TABLE} has an incompatible shape`);
  }
}

function validateIdentity({ userId, slot, revision }) {
  if (typeof userId !== "string" || userId.length === 0) {
    fail("CLOUD_PAYLOAD_IDENTITY_INVALID", "Cloud payload userId must be a non-empty string");
  }
  if (typeof slot !== "string" || slot.length === 0) {
    fail("CLOUD_PAYLOAD_IDENTITY_INVALID", "Cloud payload slot must be a non-empty string");
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail("CLOUD_PAYLOAD_IDENTITY_INVALID", "Cloud payload revision must be a positive safe integer");
  }
  return { userId, slot, revision };
}

function validateUserId(userId) {
  if (typeof userId !== "string" || userId.length === 0) {
    fail("CLOUD_PAYLOAD_IDENTITY_INVALID", "Cloud payload userId must be a non-empty string");
  }
  return userId;
}

function assertChecksum(checksum, code = "CLOUD_PAYLOAD_CHECKSUM_INVALID") {
  if (typeof checksum !== "string" || !SHA256_PATTERN.test(checksum)) {
    fail(code, "Cloud payload checksum must be a lowercase SHA-256 hex digest");
  }
  return checksum;
}

function assertSizeBytes(sizeBytes, code = "CLOUD_PAYLOAD_SIZE_INVALID") {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    fail(code, "Cloud payload byte size must be a non-negative safe integer");
  }
  return sizeBytes;
}

function isAliasCandidate(value) {
  return typeof value === "string" && value.charCodeAt(0) === 0x1e;
}

function sha256(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function describePayload(payload, expectedChecksum = undefined) {
  if (typeof payload !== "string") {
    fail("CLOUD_PAYLOAD_BODY_INVALID", "Cloud payload body must be a string");
  }
  if (isAliasCandidate(payload)) {
    fail("CLOUD_PAYLOAD_BODY_INVALID", "A payload alias cannot be stored as blob content");
  }
  if (Buffer.from(payload, "utf8").toString("utf8") !== payload) {
    fail("CLOUD_PAYLOAD_TEXT_ENCODING_INVALID", "Cloud payload body is not stable UTF-8 text");
  }
  const sizeBytes = Buffer.byteLength(payload, "utf8");
  assertSizeBytes(sizeBytes);
  const checksum = sha256(payload);
  if (expectedChecksum !== undefined) {
    assertChecksum(expectedChecksum);
    if (expectedChecksum !== checksum) {
      fail("CLOUD_PAYLOAD_INPUT_CHECKSUM_MISMATCH", "Cloud payload body does not match its supplied SHA-256 checksum", {
        sizeBytes,
      });
    }
  }
  return { payload, checksum, sizeBytes };
}

export function createCloudPayloadAlias(checksum, sizeBytes) {
  assertChecksum(checksum);
  assertSizeBytes(sizeBytes);
  return `${CLOUD_PAYLOAD_ALIAS_PREFIX}${checksum}/${sizeBytes}${CLOUD_PAYLOAD_ALIAS_SUFFIX}`;
}

export function parseCloudPayloadAlias(value) {
  if (!isAliasCandidate(value)) return null;
  const match = ALIAS_PATTERN.exec(value);
  if (!match) {
    fail("CLOUD_PAYLOAD_ALIAS_INVALID", "Cloud payload alias is malformed or uses an unsupported version");
  }
  const sizeBytes = Number(match[2]);
  if (!Number.isSafeInteger(sizeBytes)) {
    fail("CLOUD_PAYLOAD_ALIAS_INVALID", "Cloud payload alias contains an unsafe byte size");
  }
  return { version: 1, checksum: match[1], sizeBytes };
}

/**
 * Adds the content-addressed blob table without changing the existing layout-v2
 * cloud_save_payloads table or its direct-SELECT compatibility contract.
 */
export function initializeCloudPayloadStore(database) {
  assertDatabase(database);
  const payloadColumns = assertTableColumns(database, CLOUD_PAYLOAD_TABLE, ["user_id", "slot", "revision", "payload"]);
  assertCanonicalPayloadTableShape(payloadColumns);
  const existing = database.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(CLOUD_PAYLOAD_BLOB_TABLE);
  if (existing && existing.type !== "table") {
    fail("CLOUD_PAYLOAD_SCHEMA_INVALID", `SQLite object ${CLOUD_PAYLOAD_BLOB_TABLE} must be a table`);
  }
  if (!existing) {
    database.exec(`
      CREATE TABLE ${CLOUD_PAYLOAD_BLOB_TABLE} (
        checksum TEXT NOT NULL PRIMARY KEY
          CHECK(length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
        size_bytes INTEGER NOT NULL
          CHECK(typeof(size_bytes) = 'integer' AND size_bytes >= 0),
        payload TEXT NOT NULL
          CHECK(typeof(payload) = 'text' AND length(CAST(payload AS BLOB)) = size_bytes)
      ) WITHOUT ROWID
    `);
  }
  const blobColumns = assertTableColumns(database, CLOUD_PAYLOAD_BLOB_TABLE, ["checksum", "size_bytes", "payload"]);
  assertBlobTableShape(blobColumns);
  return {
    internalVersion: CLOUD_PAYLOAD_STORE_INTERNAL_VERSION,
    sqliteLayoutVersion: CLOUD_PAYLOAD_SQLITE_LAYOUT_VERSION,
    payloadTable: CLOUD_PAYLOAD_TABLE,
    blobTable: CLOUD_PAYLOAD_BLOB_TABLE,
  };
}

function readBlobRow(database, checksum) {
  return database.prepare(`
    SELECT checksum, size_bytes AS sizeBytes, payload
    FROM ${CLOUD_PAYLOAD_BLOB_TABLE}
    WHERE checksum = ?
  `).get(checksum);
}

function validateResolvedBlob(row, alias) {
  if (!row) {
    fail("CLOUD_PAYLOAD_BLOB_MISSING", "Cloud payload alias points to a missing blob", {
      expectedSizeBytes: alias.sizeBytes,
    });
  }
  if (typeof row.payload !== "string" || isAliasCandidate(row.payload)) {
    fail("CLOUD_PAYLOAD_BLOB_BODY_INVALID", "Cloud payload blob does not contain original text");
  }
  if (!Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0) {
    fail("CLOUD_PAYLOAD_BLOB_SIZE_INVALID", "Cloud payload blob has invalid byte-size metadata");
  }
  if (row.sizeBytes !== alias.sizeBytes) {
    fail("CLOUD_PAYLOAD_ALIAS_SIZE_MISMATCH", "Cloud payload alias and blob disagree on byte size", {
      aliasSizeBytes: alias.sizeBytes,
      blobSizeBytes: row.sizeBytes,
    });
  }
  const actualSizeBytes = Buffer.byteLength(row.payload, "utf8");
  if (actualSizeBytes !== row.sizeBytes) {
    fail("CLOUD_PAYLOAD_BLOB_SIZE_MISMATCH", "Cloud payload blob body does not match its stored byte size", {
      storedSizeBytes: row.sizeBytes,
      actualSizeBytes,
    });
  }
  if (sha256(row.payload) !== alias.checksum) {
    fail("CLOUD_PAYLOAD_BLOB_CHECKSUM_MISMATCH", "Cloud payload blob body does not match its SHA-256 address", {
      sizeBytes: row.sizeBytes,
    });
  }
  return row.payload;
}

function resolveAlias(database, alias) {
  return validateResolvedBlob(readBlobRow(database, alias.checksum), alias);
}

function projectedAlias(row) {
  if (!row) return null;
  if (row.storageType !== "text") {
    fail("CLOUD_PAYLOAD_ROW_INVALID", "Cloud payload row does not use SQLite TEXT storage");
  }
  if (row.prefix === null || row.prefix === undefined) return null;
  if (typeof row.prefix !== "string") {
    fail("CLOUD_PAYLOAD_ROW_INVALID", "Cloud payload row does not contain text");
  }
  return parseCloudPayloadAlias(row.prefix);
}

function addBlobCleanupCandidate(candidates, alias) {
  if (!candidates || !alias) return;
  if (!(candidates instanceof Map)) {
    fail("CLOUD_PAYLOAD_CLEANUP_CANDIDATES_INVALID", "Cloud payload blob cleanup candidates must be a Map");
  }
  const previousSize = candidates.get(alias.checksum);
  if (previousSize !== undefined && previousSize !== alias.sizeBytes) {
    fail("CLOUD_PAYLOAD_ALIAS_SIZE_MISMATCH", "Deleted aliases sharing a checksum disagree on byte size");
  }
  candidates.set(alias.checksum, alias.sizeBytes);
}

function aliasProjectionSql(whereClause) {
  return `
    SELECT
      typeof(payload) AS storageType,
      CASE
        WHEN typeof(payload) <> 'text' THEN NULL
        WHEN substr(payload, 1, 1) = ? THEN substr(payload, 1, ?)
        ELSE NULL
      END AS prefix
    FROM ${CLOUD_PAYLOAD_TABLE}
    ${whereClause}
  `;
}

/**
 * Reads only the fixed-size alias representation for one primary-key row.
 * Direct legacy payloads never execute the fixed-prefix projection and are not
 * materialized. This helper exists for the server's in-memory alias index; it
 * is deliberately not a replacement for readCloudPayload().
 */
export function readCloudPayloadAlias(database, input) {
  assertDatabase(database);
  const identity = validateIdentity(input ?? {});
  const row = database.prepare(aliasProjectionSql("WHERE user_id = ? AND slot = ? AND revision = ?"))
    .get(CLOUD_PAYLOAD_ALIAS_PREFIX[0], CLOUD_PAYLOAD_ALIAS_PROJECTION_CHARACTERS, identity.userId, identity.slot, identity.revision);
  return projectedAlias(row);
}

/**
 * Audits the actual fixed-prefix projection of every logical payload row for
 * the server's startup reference index. Direct legacy bodies are never
 * selected or measured. A malformed alias row makes the audit incomplete so
 * online cleanup can retain every candidate conservatively; the explicit
 * maintenance GC remains responsible for resolving and validating bodies.
 */
export function auditCloudPayloadAliasReferences(database) {
  assertDatabase(database);
  const rows = database.prepare(`
    SELECT
      user_id AS userId,
      slot,
      revision,
      typeof(payload) AS storageType,
      CASE
        WHEN typeof(payload) <> 'text' THEN NULL
        WHEN substr(payload, 1, 1) = ? THEN substr(payload, 1, ?)
        ELSE NULL
      END AS prefix
    FROM ${CLOUD_PAYLOAD_TABLE}
    ORDER BY user_id, slot, revision
  `).iterate(CLOUD_PAYLOAD_ALIAS_PREFIX[0], CLOUD_PAYLOAD_ALIAS_PROJECTION_CHARACTERS);
  const references = [];
  const audit = {
    complete: true,
    scannedRows: 0,
    aliasRows: 0,
    directRows: 0,
    invalidAliasRows: 0,
    invalidStorageTypeRows: 0,
    maximumProjectedCharacters: CLOUD_PAYLOAD_ALIAS_PROJECTION_CHARACTERS,
  };
  for (const row of rows) {
    audit.scannedRows += 1;
    if (row.storageType !== "text") {
      audit.complete = false;
      audit.invalidStorageTypeRows += 1;
      continue;
    }
    if (row.prefix === null || row.prefix === undefined) {
      audit.directRows += 1;
      continue;
    }
    try {
      const alias = projectedAlias(row);
      if (!alias) {
        audit.directRows += 1;
        continue;
      }
      audit.aliasRows += 1;
      references.push({
        userId: row.userId,
        slot: row.slot,
        revision: sqliteSafeNumber(row.revision),
        checksum: alias.checksum,
        sizeBytes: alias.sizeBytes,
      });
    } catch (error) {
      if (!(error instanceof CloudPayloadStoreError)) throw error;
      audit.complete = false;
      audit.invalidAliasRows += 1;
    }
  }
  return { references, audit };
}

function validCurrentMainMetadata(value) {
  return Number.isSafeInteger(value?.revision) && value.revision > 0 &&
    typeof value?.checksum === "string" && SHA256_PATTERN.test(value.checksum) &&
    Number.isSafeInteger(value?.size) && value.size >= 0;
}

/**
 * Audits whether each normal-mode current-main metadata record still has an
 * addressable payload row. This deliberately returns aggregate counters only:
 * it never returns an account ID, revision, checksum, alias, or body.
 *
 * Alias rows are checked without materializing blob bodies so server startup
 * remains bounded for large saves. The offline recovery and maintenance tools
 * perform the full size/SHA-256/body validation before making any mutation.
 * The internal userIds/onRecord hooks let the runtime index revalidate affected
 * accounts after a committed write; the returned value stays aggregate-only.
 */
export function auditCurrentMainCloudPayloadResolution(database, data, { userIds = null, onRecord = null } = {}) {
  assertDatabase(database);
  const result = {
    checked: 0,
    resolvable: 0,
    unresolvable: 0,
    invalidMetadata: 0,
    orphanedMetadata: 0,
    missingPayloadRows: 0,
    invalidPayloadRows: 0,
    metadataMismatches: 0,
    missingBlobs: 0,
    blobMetadataMismatches: 0,
    legacyDirectRows: 0,
  };
  const users = data?.users && typeof data.users === "object" ? data.users : {};
  const current = data?.cloudSaves && typeof data.cloudSaves === "object" ? data.cloudSaves : {};
  const readPayload = database.prepare(`
    SELECT
      typeof(payload) AS storageType,
      CASE
        WHEN typeof(payload) <> 'text' THEN NULL
        WHEN substr(payload, 1, 1) = ? THEN substr(payload, 1, ?)
        ELSE NULL
      END AS prefix,
      CASE
        WHEN typeof(payload) = 'text' THEN length(CAST(payload AS BLOB))
        ELSE NULL
      END AS storedBytes
    FROM ${CLOUD_PAYLOAD_TABLE}
    WHERE user_id = ? AND slot = 'main' AND revision = ?
  `);
  const readBlob = database.prepare(`
    SELECT checksum, size_bytes AS sizeBytes
    FROM ${CLOUD_PAYLOAD_BLOB_TABLE}
    WHERE checksum = ?
  `);

  for (const [userId, metadata] of Object.entries(current)) {
    if (userIds instanceof Set && !userIds.has(userId)) continue;
    const before = typeof onRecord === "function" ? { ...result } : null;
    try {
      result.checked += 1;
      if (!users[userId]) {
        result.orphanedMetadata += 1;
        continue;
      }
      if (!validCurrentMainMetadata(metadata)) {
        result.invalidMetadata += 1;
        continue;
      }
      const row = readPayload.get(CLOUD_PAYLOAD_ALIAS_PREFIX[0], CLOUD_PAYLOAD_ALIAS_PROJECTION_CHARACTERS, userId, metadata.revision);
      if (!row) {
        result.missingPayloadRows += 1;
        continue;
      }
      if (row.storageType !== "text") {
        result.invalidPayloadRows += 1;
        continue;
      }
      try {
        const alias = projectedAlias(row);
        if (!alias) {
          if (sqliteSafeNumber(row.storedBytes) !== metadata.size) {
            result.metadataMismatches += 1;
            continue;
          }
          result.legacyDirectRows += 1;
          result.resolvable += 1;
          continue;
        }
        if (alias.checksum !== metadata.checksum || alias.sizeBytes !== metadata.size) {
          result.metadataMismatches += 1;
          continue;
        }
        const blob = readBlob.get(alias.checksum);
        if (!blob) {
          result.missingBlobs += 1;
          continue;
        }
        if (blob.checksum !== alias.checksum || sqliteSafeNumber(blob.sizeBytes) !== alias.sizeBytes) {
          result.blobMetadataMismatches += 1;
          continue;
        }
        result.resolvable += 1;
      } catch (error) {
        if (!(error instanceof CloudPayloadStoreError)) throw error;
        result.invalidPayloadRows += 1;
      }
    } finally {
      if (before) {
        const record = Object.fromEntries(Object.keys(result).map((key) => [key, result[key] - before[key]]));
        record.unresolvable = record.checked - record.resolvable;
        onRecord(userId, record);
      }
    }
  }
  result.unresolvable = result.checked - result.resolvable;
  return result;
}

function ensureBlob(database, descriptor) {
  const existing = readBlobRow(database, descriptor.checksum);
  if (existing) {
    if (existing.payload !== descriptor.payload) {
      fail(
        "CLOUD_PAYLOAD_CHECKSUM_COLLISION",
        "An existing cloud payload blob has the same checksum but different content; it was not overwritten",
        { incomingSizeBytes: descriptor.sizeBytes },
      );
    }
    validateResolvedBlob(existing, descriptor);
    return "reused";
  }
  database.prepare(`
    INSERT INTO ${CLOUD_PAYLOAD_BLOB_TABLE} (checksum, size_bytes, payload)
    VALUES (?, ?, ?)
  `).run(descriptor.checksum, descriptor.sizeBytes, descriptor.payload);
  return "inserted";
}

function inspectedPayloadDescriptor(payload, checksum, sizeBytes) {
  if (typeof payload !== "string" || isAliasCandidate(payload)) {
    fail("CLOUD_PAYLOAD_BODY_INVALID", "Inspected cloud payload body must be original text");
  }
  assertChecksum(checksum);
  assertSizeBytes(sizeBytes);
  return { payload, checksum, sizeBytes };
}

export function writeCloudPayload(database, input) {
  requireOuterTransaction(database, "writeCloudPayload");
  const identity = validateIdentity(input ?? {});
  const descriptor = describePayload(input?.payload, input?.checksum);
  const blob = ensureBlob(database, descriptor);
  const alias = createCloudPayloadAlias(descriptor.checksum, descriptor.sizeBytes);
  const result = database.prepare(`
    INSERT INTO ${CLOUD_PAYLOAD_TABLE} (user_id, slot, revision, payload)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, slot, revision) DO UPDATE SET payload = excluded.payload
  `).run(identity.userId, identity.slot, identity.revision, alias);
  return {
    checksum: descriptor.checksum,
    sizeBytes: descriptor.sizeBytes,
    blob,
    rowChanges: result.changes,
  };
}

/**
 * Persist a body whose exact UTF-8 size and SHA-256 were already produced by
 * the authoritative upload inspector. This deliberately avoids hashing a
 * second large-save string while the SQLite mutation queue is held. The blob-table
 * CHECK constraint still enforces the supplied byte size, and an existing
 * address is compared byte-for-byte so a checksum collision cannot overwrite
 * stored content. Callers outside that inspected boundary must use
 * writeCloudPayload(), which computes both values itself.
 */
export function writeInspectedCloudPayload(database, input) {
  requireOuterTransaction(database, "writeInspectedCloudPayload");
  const identity = validateIdentity(input ?? {});
  const descriptor = inspectedPayloadDescriptor(input?.payload, input?.checksum, input?.sizeBytes);
  const blob = ensureBlob(database, descriptor);
  const alias = createCloudPayloadAlias(descriptor.checksum, descriptor.sizeBytes);
  const result = database.prepare(`
    INSERT INTO ${CLOUD_PAYLOAD_TABLE} (user_id, slot, revision, payload)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, slot, revision) DO UPDATE SET payload = excluded.payload
  `).run(identity.userId, identity.slot, identity.revision, alias);
  return {
    checksum: descriptor.checksum,
    sizeBytes: descriptor.sizeBytes,
    blob,
    rowChanges: result.changes,
  };
}

/**
 * Link another logical revision to a blob that the caller already verified by
 * calling writeCloudPayload/writeInspectedCloudPayload in the same outer
 * transaction. Only fixed-size metadata is read here, so duplicate revisions
 * do not materialize the same large payload again.
 */
export function linkVerifiedCloudPayload(database, input) {
  requireOuterTransaction(database, "linkVerifiedCloudPayload");
  const identity = validateIdentity(input ?? {});
  const checksum = assertChecksum(input?.checksum);
  const sizeBytes = assertSizeBytes(input?.sizeBytes);
  const row = database.prepare(`
    SELECT checksum, size_bytes AS sizeBytes
    FROM ${CLOUD_PAYLOAD_BLOB_TABLE}
    WHERE checksum = ?
  `).get(checksum);
  if (!row) fail("CLOUD_PAYLOAD_BLOB_MISSING", "Verified cloud payload blob is missing before alias linking");
  if (row.checksum !== checksum || row.sizeBytes !== sizeBytes) {
    fail("CLOUD_PAYLOAD_BLOB_SIZE_MISMATCH", "Verified cloud payload blob metadata changed before alias linking");
  }
  const result = database.prepare(`
    INSERT INTO ${CLOUD_PAYLOAD_TABLE} (user_id, slot, revision, payload)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, slot, revision) DO UPDATE SET payload = excluded.payload
  `).run(identity.userId, identity.slot, identity.revision, createCloudPayloadAlias(checksum, sizeBytes));
  return { checksum, sizeBytes, blob: "linked", rowChanges: result.changes };
}

export function readCloudPayload(database, input) {
  assertDatabase(database);
  const identity = validateIdentity(input ?? {});
  const row = database.prepare(`
    SELECT payload
    FROM ${CLOUD_PAYLOAD_TABLE}
    WHERE user_id = ? AND slot = ? AND revision = ?
  `).get(identity.userId, identity.slot, identity.revision);
  if (!row) return null;
  if (typeof row.payload !== "string") {
    fail("CLOUD_PAYLOAD_ROW_INVALID", "Cloud payload row does not contain text");
  }
  const alias = parseCloudPayloadAlias(row.payload);
  return alias ? resolveAlias(database, alias) : row.payload;
}

export function deleteCloudPayload(database, input, options = {}) {
  requireOuterTransaction(database, "deleteCloudPayload");
  const identity = validateIdentity(input ?? {});
  addBlobCleanupCandidate(options?.blobCleanupCandidates, readCloudPayloadAlias(database, identity));
  return database.prepare(`
    DELETE FROM ${CLOUD_PAYLOAD_TABLE}
    WHERE user_id = ? AND slot = ? AND revision = ?
  `).run(identity.userId, identity.slot, identity.revision).changes;
}

export function deleteCloudPayloadsForUser(database, userId, options = {}) {
  requireOuterTransaction(database, "deleteCloudPayloadsForUser");
  validateUserId(userId);
  const rows = database.prepare(aliasProjectionSql("WHERE user_id = ?"))
    .iterate(CLOUD_PAYLOAD_ALIAS_PREFIX[0], CLOUD_PAYLOAD_ALIAS_PROJECTION_CHARACTERS, userId);
  for (const row of rows) {
    const alias = projectedAlias(row);
    if (alias) addBlobCleanupCandidate(options?.blobCleanupCandidates, alias);
  }
  return database.prepare(`DELETE FROM ${CLOUD_PAYLOAD_TABLE} WHERE user_id = ?`).run(userId).changes;
}

/**
 * Online orphan cleanup for aliases touched by the current transaction only.
 * The caller supplies reference counts from its transaction-local alias index;
 * this function never scans cloud_save_payloads, enumerates unrelated blobs,
 * or resolves blob bodies. The full maintenance GC below remains the audit
 * path that scans and cryptographically validates every live reference.
 */
export function garbageCollectCloudPayloadBlobCandidates(database, candidates, remainingReferences = new Map()) {
  requireOuterTransaction(database, "garbageCollectCloudPayloadBlobCandidates");
  if (!(candidates instanceof Map) || !(remainingReferences instanceof Map)) {
    fail("CLOUD_PAYLOAD_CLEANUP_CANDIDATES_INVALID", "Targeted cloud payload cleanup requires Map inputs");
  }
  const remove = database.prepare(`DELETE FROM ${CLOUD_PAYLOAD_BLOB_TABLE} WHERE checksum = ?`);
  let referencedBlobs = 0;
  let missingBlobs = 0;
  let deletedBlobs = 0;
  for (const [checksum, sizeBytes] of candidates) {
    assertChecksum(checksum);
    assertSizeBytes(sizeBytes);
    const references = remainingReferences.get(checksum) ?? 0;
    if (!Number.isSafeInteger(references) || references < 0) {
      fail("CLOUD_PAYLOAD_REFERENCE_COUNT_INVALID", "Targeted cloud payload cleanup received an invalid reference count");
    }
    if (references > 0) {
      referencedBlobs += 1;
      continue;
    }
    const changes = remove.run(checksum).changes;
    if (changes === 1) deletedBlobs += 1;
    else missingBlobs += 1;
  }
  return {
    candidateBlobs: candidates.size,
    referencedBlobs,
    missingBlobs,
    deletedBlobs,
  };
}

function normalizeBatchSize(value) {
  if (value === undefined) return DEFAULT_SCAN_BATCH_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    fail("CLOUD_PAYLOAD_BATCH_SIZE_INVALID", "Cloud payload scan batch size must be an integer from 1 through 100");
  }
  return value;
}

function scanPayloadRows(database, batchSize, visitor) {
  const first = database.prepare(`
    SELECT user_id AS userId, slot, revision, payload
    FROM ${CLOUD_PAYLOAD_TABLE}
    ORDER BY user_id, slot, revision
    LIMIT ?
  `);
  const next = database.prepare(`
    SELECT user_id AS userId, slot, revision, payload
    FROM ${CLOUD_PAYLOAD_TABLE}
    WHERE (user_id, slot, revision) > (?, ?, ?)
    ORDER BY user_id, slot, revision
    LIMIT ?
  `);
  let cursor = null;
  while (true) {
    const rows = cursor
      ? next.all(cursor.userId, cursor.slot, cursor.revision, batchSize)
      : first.all(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) visitor(row);
    const last = rows.at(-1);
    cursor = { userId: last.userId, slot: last.slot, revision: last.revision };
  }
}

function addSafe(total, value) {
  return Math.min(Number.MAX_SAFE_INTEGER, total + Math.max(0, Number(value) || 0));
}

export function backfillCloudPayloadAliases(database, options = {}) {
  requireOuterTransaction(database, "backfillCloudPayloadAliases");
  const batchSize = normalizeBatchSize(options.batchSize);
  const update = database.prepare(`
    UPDATE ${CLOUD_PAYLOAD_TABLE}
    SET payload = ?
    WHERE user_id = ? AND slot = ? AND revision = ?
  `);
  const result = {
    scannedRows: 0,
    backfilledRows: 0,
    alreadyAliasedRows: 0,
    blobsInserted: 0,
    blobsReused: 0,
    logicalBytes: 0,
  };
  scanPayloadRows(database, batchSize, (row) => {
    result.scannedRows += 1;
    if (typeof row.payload !== "string") {
      fail("CLOUD_PAYLOAD_ROW_INVALID", "Cloud payload row does not contain text");
    }
    const alias = parseCloudPayloadAlias(row.payload);
    if (alias) {
      resolveAlias(database, alias);
      result.alreadyAliasedRows += 1;
      result.logicalBytes = addSafe(result.logicalBytes, alias.sizeBytes);
      return;
    }
    const descriptor = describePayload(row.payload);
    const blob = ensureBlob(database, descriptor);
    const changes = update.run(
      createCloudPayloadAlias(descriptor.checksum, descriptor.sizeBytes),
      row.userId,
      row.slot,
      row.revision,
    ).changes;
    if (changes !== 1) {
      fail("CLOUD_PAYLOAD_ROW_CHANGED", "Cloud payload row changed during backfill");
    }
    result.backfilledRows += 1;
    result.logicalBytes = addSafe(result.logicalBytes, descriptor.sizeBytes);
    if (blob === "inserted") result.blobsInserted += 1;
    else result.blobsReused += 1;
  });
  return result;
}

export function materializeCloudPayloadAliases(database, options = {}) {
  requireOuterTransaction(database, "materializeCloudPayloadAliases");
  const batchSize = normalizeBatchSize(options.batchSize);
  const update = database.prepare(`
    UPDATE ${CLOUD_PAYLOAD_TABLE}
    SET payload = ?
    WHERE user_id = ? AND slot = ? AND revision = ?
  `);
  const result = {
    scannedRows: 0,
    materializedRows: 0,
    alreadyMaterializedRows: 0,
    logicalBytes: 0,
  };
  scanPayloadRows(database, batchSize, (row) => {
    result.scannedRows += 1;
    if (typeof row.payload !== "string") {
      fail("CLOUD_PAYLOAD_ROW_INVALID", "Cloud payload row does not contain text");
    }
    const alias = parseCloudPayloadAlias(row.payload);
    if (!alias) {
      result.alreadyMaterializedRows += 1;
      result.logicalBytes = addSafe(result.logicalBytes, Buffer.byteLength(row.payload, "utf8"));
      return;
    }
    const payload = resolveAlias(database, alias);
    const changes = update.run(payload, row.userId, row.slot, row.revision).changes;
    if (changes !== 1) {
      fail("CLOUD_PAYLOAD_ROW_CHANGED", "Cloud payload row changed during rollback materialization");
    }
    result.materializedRows += 1;
    result.logicalBytes = addSafe(result.logicalBytes, alias.sizeBytes);
  });
  return result;
}

function collectAliasReferences(database) {
  const references = new Map();
  for (const row of database.prepare(`
    SELECT
      substr(payload, 1, 160) AS prefix,
      length(CAST(payload AS BLOB)) AS storedBytes
    FROM ${CLOUD_PAYLOAD_TABLE}
  `).iterate()) {
    if (typeof row.prefix !== "string") {
      fail("CLOUD_PAYLOAD_ROW_INVALID", "Cloud payload row does not contain text");
    }
    if (!isAliasCandidate(row.prefix)) continue;
    const storedBytes = sqliteSafeNumber(row.storedBytes);
    if (storedBytes !== Buffer.byteLength(row.prefix, "utf8")) {
      fail("CLOUD_PAYLOAD_ALIAS_INVALID", "Cloud payload alias exceeds its fixed maximum representation");
    }
    const alias = parseCloudPayloadAlias(row.prefix);
    if (!alias) continue;
    const previousSize = references.get(alias.checksum);
    if (previousSize !== undefined && previousSize !== alias.sizeBytes) {
      fail("CLOUD_PAYLOAD_ALIAS_SIZE_MISMATCH", "Aliases sharing a checksum disagree on byte size");
    }
    references.set(alias.checksum, alias.sizeBytes);
  }
  return references;
}

export function garbageCollectCloudPayloadBlobs(database) {
  requireOuterTransaction(database, "garbageCollectCloudPayloadBlobs");
  const references = collectAliasReferences(database);
  for (const [checksum, sizeBytes] of references) {
    resolveAlias(database, { version: 1, checksum, sizeBytes });
  }
  const orphanChecksums = [];
  for (const row of database.prepare(`SELECT checksum FROM ${CLOUD_PAYLOAD_BLOB_TABLE}`).iterate()) {
    if (typeof row.checksum !== "string" || !SHA256_PATTERN.test(row.checksum)) {
      fail("CLOUD_PAYLOAD_BLOB_CHECKSUM_INVALID", "Cloud payload blob has an invalid checksum address");
    }
    if (!references.has(row.checksum)) orphanChecksums.push(row.checksum);
  }
  const remove = database.prepare(`DELETE FROM ${CLOUD_PAYLOAD_BLOB_TABLE} WHERE checksum = ?`);
  let deletedBlobs = 0;
  for (const checksum of orphanChecksums) deletedBlobs += remove.run(checksum).changes;
  return {
    referencedBlobs: references.size,
    orphanBlobs: orphanChecksums.length,
    deletedBlobs,
  };
}

function sqliteSafeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number));
}

/**
 * Returns only aggregate counts and byte totals. It never returns account IDs,
 * slots, revisions, checksums, aliases, or save payload text.
 */
export function collectCloudPayloadStoreStats(database) {
  assertDatabase(database);
  const references = new Map();
  let totalRows = 0;
  let legacyRows = 0;
  let aliasRows = 0;
  let invalidAliasRows = 0;
  let conflictingAliasMetadata = 0;
  let mainStoredBytes = 0;
  let legacyLogicalBytes = 0;
  let aliasedLogicalBytes = 0;
  const rows = database.prepare(`
    SELECT
      substr(payload, 1, 160) AS prefix,
      length(CAST(payload AS BLOB)) AS storedBytes
    FROM ${CLOUD_PAYLOAD_TABLE}
  `).iterate();
  for (const row of rows) {
    totalRows += 1;
    const storedBytes = sqliteSafeNumber(row.storedBytes);
    mainStoredBytes = addSafe(mainStoredBytes, storedBytes);
    if (!isAliasCandidate(row.prefix)) {
      legacyRows += 1;
      legacyLogicalBytes = addSafe(legacyLogicalBytes, storedBytes);
      continue;
    }
    try {
      if (storedBytes !== Buffer.byteLength(row.prefix, "utf8")) {
        fail("CLOUD_PAYLOAD_ALIAS_INVALID", "Cloud payload alias exceeds its fixed maximum representation");
      }
      const alias = parseCloudPayloadAlias(row.prefix);
      aliasRows += 1;
      aliasedLogicalBytes = addSafe(aliasedLogicalBytes, alias.sizeBytes);
      const previousSize = references.get(alias.checksum);
      if (previousSize !== undefined && previousSize !== alias.sizeBytes) conflictingAliasMetadata += 1;
      else references.set(alias.checksum, alias.sizeBytes);
    } catch (error) {
      if (!(error instanceof CloudPayloadStoreError)) throw error;
      invalidAliasRows += 1;
    }
  }

  let blobRows = 0;
  let blobBytes = 0;
  let referencedBlobRows = 0;
  let referencedBlobBytes = 0;
  let orphanBlobRows = 0;
  const foundReferences = new Set();
  for (const row of database.prepare(`
    SELECT checksum, size_bytes AS sizeBytes
    FROM ${CLOUD_PAYLOAD_BLOB_TABLE}
  `).iterate()) {
    blobRows += 1;
    const sizeBytes = sqliteSafeNumber(row.sizeBytes);
    blobBytes = addSafe(blobBytes, sizeBytes);
    if (typeof row.checksum === "string" && references.has(row.checksum)) {
      referencedBlobRows += 1;
      referencedBlobBytes = addSafe(referencedBlobBytes, sizeBytes);
      foundReferences.add(row.checksum);
    } else {
      orphanBlobRows += 1;
    }
  }
  let missingBlobReferences = 0;
  for (const checksum of references.keys()) if (!foundReferences.has(checksum)) missingBlobReferences += 1;

  return {
    internalVersion: CLOUD_PAYLOAD_STORE_INTERNAL_VERSION,
    sqliteLayoutVersion: CLOUD_PAYLOAD_SQLITE_LAYOUT_VERSION,
    rows: {
      total: totalRows,
      legacy: legacyRows,
      aliases: aliasRows,
      invalidAliases: invalidAliasRows,
      conflictingAliasMetadata,
    },
    blobs: {
      total: blobRows,
      referenced: referencedBlobRows,
      orphan: orphanBlobRows,
      missingReferences: missingBlobReferences,
    },
    bytes: {
      mainStored: mainStoredBytes,
      logical: addSafe(legacyLogicalBytes, aliasedLogicalBytes),
      legacyLogical: legacyLogicalBytes,
      aliasedLogical: aliasedLogicalBytes,
      blobStored: blobBytes,
      referencedBlobStored: referencedBlobBytes,
      deduplicated: Math.max(0, aliasedLogicalBytes - referencedBlobBytes),
    },
  };
}
