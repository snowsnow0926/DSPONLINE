import { auditCurrentMainCloudPayloadResolution } from "./cloud-payload-store.mjs";

function sources(data) {
  return {
    users: data?.users && typeof data.users === "object" ? data.users : {},
    current: data?.cloudSaves && typeof data.cloudSaves === "object" ? data.cloudSaves : {},
  };
}

function signature(metadata, ownerExists) {
  const valid = Number.isSafeInteger(metadata?.revision) && metadata.revision > 0 &&
    typeof metadata?.checksum === "string" && /^[a-f0-9]{64}$/.test(metadata.checksum) &&
    Number.isSafeInteger(metadata?.size) && metadata.size >= 0;
  return valid
    ? JSON.stringify([ownerExists, metadata.revision, metadata.checksum, metadata.size])
    : JSON.stringify([ownerExists, "invalid"]);
}

/**
 * Runtime-only audit results under the service's single-writer boundary.
 * Startup and explicit refreshes audit everything. Commits revalidate changed
 * metadata and every account whose payload rows were touched, including writes
 * that leave the current revision unchanged. External maintenance must request
 * a full refresh or restart; public snapshots contain counters only.
 */
export class CurrentMainPayloadAuditIndex {
  constructor(database) {
    this.database = database;
    this.records = new Map();
    this.summary = null;
  }

  refresh(data, { forceUserIds = [], full = false } = {}) {
    const { users, current } = sources(data);
    const signatures = new Map(Object.entries(current).map(([userId, metadata]) => [userId, signature(metadata, Boolean(users[userId]))]));
    const rebuild = full || this.summary === null;
    const changed = new Set(forceUserIds);
    for (const [userId, value] of signatures) {
      if (rebuild || this.records.get(userId)?.signature !== value) changed.add(userId);
    }
    const removed = [...this.records.keys()].filter((userId) => !signatures.has(userId));
    if (!rebuild && changed.size === 0 && removed.length === 0) return { ...this.summary };

    // Keep all proposed changes private until every SQLite read succeeds.
    const refreshed = new Map();
    const partial = auditCurrentMainCloudPayloadResolution(this.database, data, {
      userIds: changed,
      onRecord: (userId, counters) => refreshed.set(userId, { signature: signatures.get(userId), counters }),
    });
    const records = rebuild ? new Map() : new Map(this.records);
    const summary = rebuild ? Object.fromEntries(Object.keys(partial).map((key) => [key, 0])) : { ...this.summary };
    const accumulate = (counters, sign) => {
      for (const key of Object.keys(summary)) summary[key] += sign * counters[key];
    };
    for (const userId of new Set([...removed, ...refreshed.keys()])) {
      const previous = records.get(userId);
      if (previous) accumulate(previous.counters, -1);
      records.delete(userId);
    }
    for (const [userId, record] of refreshed) {
      records.set(userId, record);
      accumulate(record.counters, 1);
    }
    this.records = records;
    this.summary = summary;
    return { ...summary };
  }
}
