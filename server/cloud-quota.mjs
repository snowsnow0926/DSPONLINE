export const CLOUD_QUOTA_VERSION = "cloud-quota-v1";

const MIB = 1024 * 1024;
const SAVE_MODES = ["normal", "speedrun"];
const CLOUD_SLOTS = ["main", "1", "2", "3"];

export const DEFAULT_CLOUD_QUOTA_POLICY = Object.freeze({
  revisionBytes: 100_662_272,
  slotBytes: 512 * MIB,
  modeBytes: 1024 * MIB,
  accountBytes: 2 * 1024 * MIB,
  historyRevisions: 20,
});

function positiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

export function normalizeCloudQuotaPolicy(value = {}) {
  // Small positive policies are useful for deterministic boundary tests and
  // private deployments. The production defaults remain bounded below 96 MiB
  // revisions; callers cannot configure zero, negative or unsafe values.
  const revisionBytes = positiveInteger(value.revisionBytes, DEFAULT_CLOUD_QUOTA_POLICY.revisionBytes, 1, 96 * MIB);
  const slotBytes = positiveInteger(value.slotBytes, DEFAULT_CLOUD_QUOTA_POLICY.slotBytes, revisionBytes, 4 * 1024 * MIB);
  const modeBytes = positiveInteger(value.modeBytes, DEFAULT_CLOUD_QUOTA_POLICY.modeBytes, slotBytes, 6 * 1024 * MIB);
  const accountBytes = positiveInteger(value.accountBytes, DEFAULT_CLOUD_QUOTA_POLICY.accountBytes, modeBytes, 8 * 1024 * MIB);
  // The public cloud history contract retains at most twenty revisions. A
  // deployment may choose a smaller window, but advertising a larger quota
  // would be misleading because the canonical metadata normalizer still
  // enforces that compatibility ceiling.
  const historyRevisions = positiveInteger(value.historyRevisions, DEFAULT_CLOUD_QUOTA_POLICY.historyRevisions, 2, 20);
  return Object.freeze({ revisionBytes, slotBytes, modeBytes, accountBytes, historyRevisions });
}

function historyFor(data, userId, mode, slot) {
  if (mode === "normal") {
    if (slot === "main") return Array.isArray(data?.cloudSaveHistory?.[userId]) ? data.cloudSaveHistory[userId] : [];
    return Array.isArray(data?.cloudSaveSlotHistory?.[userId]?.[slot]) ? data.cloudSaveSlotHistory[userId][slot] : [];
  }
  if (slot === "main") return Array.isArray(data?.cloudSaveHistoryByMode?.[userId]?.[mode]) ? data.cloudSaveHistoryByMode[userId][mode] : [];
  return Array.isArray(data?.cloudSaveSlotHistoryByMode?.[userId]?.[mode]?.[slot]) ? data.cloudSaveSlotHistoryByMode[userId][mode][slot] : [];
}

function currentFor(data, userId, mode, slot) {
  if (mode === "normal") return slot === "main" ? data?.cloudSaves?.[userId] : data?.cloudSaveSlots?.[userId]?.[slot];
  return slot === "main" ? data?.cloudSavesByMode?.[userId]?.[mode] : data?.cloudSaveSlotsByMode?.[userId]?.[mode]?.[slot];
}

function normalizedRecord(entry, mode, slot) {
  if (!entry || typeof entry !== "object" || !Number.isInteger(entry.revision) || entry.revision < 1) return null;
  return {
    mode,
    slot,
    revision: entry.revision,
    updatedAt: Number.isFinite(entry.updatedAt) ? Math.max(0, Math.floor(entry.updatedAt)) : 0,
    size: Number.isSafeInteger(entry.size) ? Math.max(0, entry.size) : 0,
    checksum: typeof entry.checksum === "string" && /^[a-f0-9]{64}$/.test(entry.checksum) ? entry.checksum : null,
  };
}

export function cloudQuotaRecords(data, userId) {
  const records = [];
  for (const mode of SAVE_MODES) {
    for (const slot of CLOUD_SLOTS) {
      const byRevision = new Map();
      for (const entry of historyFor(data, userId, mode, slot)) {
        const record = normalizedRecord(entry, mode, slot);
        if (record) byRevision.set(record.revision, record);
      }
      const current = normalizedRecord(currentFor(data, userId, mode, slot), mode, slot);
      if (current) byRevision.set(current.revision, current);
      records.push(...[...byRevision.values()].sort((left, right) => left.revision - right.revision));
    }
  }
  return records;
}

function sumBytes(records) {
  return records.reduce((sum, record) => Math.min(Number.MAX_SAFE_INTEGER, sum + record.size), 0);
}

function uniqueBytes(records) {
  const seen = new Set();
  let total = 0;
  for (const record of records) {
    const key = record.checksum ?? `${record.mode}:${record.slot}:${record.revision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total = Math.min(Number.MAX_SAFE_INTEGER, total + record.size);
  }
  return total;
}

function usageFor(records) {
  return {
    logicalBytes: sumBytes(records),
    uniquePayloadBytes: uniqueBytes(records),
    revisionCount: records.length,
  };
}

function available(limit, used) {
  return Math.max(0, limit - used);
}

export function cloudQuotaSnapshot(data, userId, policyValue = DEFAULT_CLOUD_QUOTA_POLICY) {
  const policy = normalizeCloudQuotaPolicy(policyValue);
  const records = cloudQuotaRecords(data, userId);
  const account = usageFor(records);
  const modes = Object.fromEntries(SAVE_MODES.map((mode) => {
    const modeRecords = records.filter((record) => record.mode === mode);
    const modeUsage = usageFor(modeRecords);
    return [mode, {
      ...modeUsage,
      remainingBytes: available(policy.modeBytes, modeUsage.logicalBytes),
      slots: Object.fromEntries(CLOUD_SLOTS.map((slot) => {
        const slotUsage = usageFor(modeRecords.filter((record) => record.slot === slot));
        return [slot, {
          ...slotUsage,
          remainingBytes: available(policy.slotBytes, slotUsage.logicalBytes),
        }];
      })),
    }];
  }));
  return {
    version: CLOUD_QUOTA_VERSION,
    limits: { ...policy },
    usage: {
      ...account,
      remainingBytes: available(policy.accountBytes, account.logicalBytes),
      modes,
    },
  };
}

function violatedLimit(accountBytes, modeBytes, slotBytes, historyCount, policy) {
  if (historyCount > policy.historyRevisions) return "historyRevisions";
  if (slotBytes > policy.slotBytes) return "slotBytes";
  if (modeBytes > policy.modeBytes) return "modeBytes";
  if (accountBytes > policy.accountBytes) return "accountBytes";
  return null;
}

export function planCloudSaveUpload(data, userId, mode, slot, incoming, policyValue = DEFAULT_CLOUD_QUOTA_POLICY) {
  const policy = normalizeCloudQuotaPolicy(policyValue);
  const snapshot = cloudQuotaSnapshot(data, userId, policy);
  const incomingBytes = Number.isSafeInteger(incoming?.size) ? Math.max(0, incoming.size) : 0;
  if (!SAVE_MODES.includes(mode) || !CLOUD_SLOTS.includes(slot)) {
    return { accepted: false, reason: "invalidTarget", code: "CLOUD_QUOTA_TARGET_INVALID", snapshot };
  }
  if (incomingBytes > policy.revisionBytes) {
    return {
      accepted: false,
      reason: "revisionBytes",
      code: "CLOUD_REVISION_QUOTA_EXCEEDED",
      snapshot,
      incoming: { bytes: incomingBytes },
      prune: { revisionCount: 0, logicalBytes: 0, revisions: [] },
    };
  }

  const records = cloudQuotaRecords(data, userId);
  const targetRecords = records.filter((record) => record.mode === mode && record.slot === slot);
  const modeRecords = records.filter((record) => record.mode === mode);
  let accountBytes = sumBytes(records) + incomingBytes;
  let modeBytes = sumBytes(modeRecords) + incomingBytes;
  let slotBytes = sumBytes(targetRecords) + incomingBytes;
  let historyCount = targetRecords.length + 1;
  const newestExistingRevision = targetRecords.at(-1)?.revision ?? null;
  const candidates = targetRecords.filter((record) => record.revision !== newestExistingRevision);
  const pruned = [];
  while (violatedLimit(accountBytes, modeBytes, slotBytes, historyCount, policy) && candidates.length > 0) {
    const record = candidates.shift();
    pruned.push(record);
    accountBytes -= record.size;
    modeBytes -= record.size;
    slotBytes -= record.size;
    historyCount -= 1;
  }
  const reason = violatedLimit(accountBytes, modeBytes, slotBytes, historyCount, policy);
  const result = {
    accepted: reason === null,
    reason,
    code: reason ? `CLOUD_${reason.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_QUOTA_EXCEEDED` : null,
    snapshot,
    target: { mode, slot },
    incoming: { bytes: incomingBytes, checksum: typeof incoming?.checksum === "string" ? incoming.checksum : null },
    prune: {
      revisionCount: pruned.length,
      logicalBytes: sumBytes(pruned),
      revisions: pruned.map((record) => record.revision),
    },
    projected: {
      accountLogicalBytes: accountBytes,
      modeLogicalBytes: modeBytes,
      slotLogicalBytes: slotBytes,
      slotRevisionCount: historyCount,
      accountRemainingBytes: available(policy.accountBytes, accountBytes),
      modeRemainingBytes: available(policy.modeBytes, modeBytes),
      slotRemainingBytes: available(policy.slotBytes, slotBytes),
    },
  };
  return result;
}

export function publicCloudQuotaPlan(plan) {
  return {
    accepted: plan.accepted,
    reason: plan.reason,
    code: plan.code,
    target: plan.target,
    limits: plan.snapshot.limits,
    usage: plan.snapshot.usage,
    incoming: plan.incoming,
    prune: plan.prune,
    projected: plan.projected,
  };
}
