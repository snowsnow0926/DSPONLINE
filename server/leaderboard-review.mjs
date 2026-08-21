import { createHash } from "node:crypto";

export const LEADERBOARD_REVIEW_VERSION = "leaderboard-review-v1";
export const LEADERBOARD_REVIEW_REASON = "SAVE_DATA_INTEGRITY";
export const LEADERBOARD_REVIEW_PENDING = "pending";
export const LEADERBOARD_REVIEW_APPROVED = "approved";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const FINDING_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_:-]{0,79}$/;
const REVIEW_STATUSES = new Set([LEADERBOARD_REVIEW_PENDING, LEADERBOARD_REVIEW_APPROVED]);

function normalizedSource(value) {
  if (typeof value !== "string") return null;
  const source = value.trim().toLowerCase();
  return SOURCE_PATTERN.test(source) ? source : null;
}

function normalizedTimestamp(value) {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)))
    : 0;
}

function normalizedRevision(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function normalizedFindings(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Map();
  for (const finding of value) {
    if (!finding || typeof finding !== "object") continue;
    const code = typeof finding.code === "string" ? finding.code.trim().toUpperCase() : "";
    if (!FINDING_CODE_PATTERN.test(code)) continue;
    const field = typeof finding.field === "string" && finding.field.trim()
      ? finding.field.trim().slice(0, 120)
      : null;
    const severity = finding.severity === "info" ? "info" : "freeze";
    unique.set(`${code}:${field ?? ""}`, { code, ...(field ? { field } : {}), severity });
  }
  return [...unique.values()].slice(0, 64);
}

function fingerprintForFindings(findings) {
  const canonical = normalizedFindings(findings).map((finding) => ({
    code: finding.code,
    field: finding.field ?? null,
    severity: finding.severity,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function normalizedRecord(userId, record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (!REVIEW_STATUSES.has(record.status) || record.reasonCode !== LEADERBOARD_REVIEW_REASON) return null;
  const source = normalizedSource(record.source);
  if (!source) return null;
  const findings = normalizedFindings(record.findings);
  if (findings.length === 0) return null;
  const detectedRevision = normalizedRevision(record.detectedRevision);
  if (detectedRevision <= 0) return null;
  const fingerprint = typeof record.fingerprint === "string" && SHA256_PATTERN.test(record.fingerprint)
    ? record.fingerprint
    : fingerprintForFindings(findings);
  const detectedChecksum = typeof record.detectedChecksum === "string" && SHA256_PATTERN.test(record.detectedChecksum)
    ? record.detectedChecksum
    : null;
  const firstDetectedAt = normalizedTimestamp(record.firstDetectedAt ?? record.createdAt);
  const lastDetectedAt = Math.max(firstDetectedAt, normalizedTimestamp(record.lastDetectedAt ?? firstDetectedAt));
  const normalized = {
    status: record.status,
    reasonCode: LEADERBOARD_REVIEW_REASON,
    source,
    mode: "normal",
    firstDetectedAt,
    lastDetectedAt,
    detectedRevision,
    ...(detectedChecksum ? { detectedChecksum } : {}),
    occurrences: Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(record.occurrences) || 1))),
    findings,
    fingerprint,
  };
  if (record.status === LEADERBOARD_REVIEW_APPROVED) {
    const reviewedAt = normalizedTimestamp(record.reviewedAt);
    const approvedRevision = normalizedRevision(record.approvedRevision);
    if (reviewedAt <= 0 || approvedRevision <= 0 || approvedRevision !== detectedRevision || record.reviewAction !== "approved") {
      return null;
    }
    normalized.reviewedAt = reviewedAt;
    normalized.approvedRevision = approvedRevision;
    normalized.reviewAction = "approved";
  }
  return [userId, normalized];
}

export function normalizeLeaderboardReviewQueue(value, users) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const knownUsers = users && typeof users === "object" ? users : {};
  return Object.fromEntries(Object.entries(value).flatMap(([userId, record]) => {
    if (!knownUsers[userId] || knownUsers[userId]?.id !== userId) return [];
    const normalized = normalizedRecord(userId, record);
    return normalized ? [normalized] : [];
  }));
}

export function leaderboardReviewFingerprint(findings) {
  return fingerprintForFindings(findings);
}

export function getLeaderboardReview(data, userId) {
  return data?.leaderboardReviewQueue?.[userId] ?? null;
}

export function isLeaderboardReviewPending(data, userId) {
  return getLeaderboardReview(data, userId)?.status === LEADERBOARD_REVIEW_PENDING;
}

export function isLeaderboardReviewApproved(data, userId, { revision, fingerprint } = {}) {
  const record = getLeaderboardReview(data, userId);
  return record?.status === LEADERBOARD_REVIEW_APPROVED
    && record.approvedRevision === revision
    && record.fingerprint === fingerprint;
}

export function queueLeaderboardReview(data, userId, {
  source,
  revision,
  checksum = null,
  findings,
  now = Date.now(),
} = {}) {
  if (!data || typeof data !== "object" || !data.users?.[userId]) throw new Error("Leaderboard review account is invalid");
  const normalizedSourceValue = normalizedSource(source);
  const normalizedRevisionValue = normalizedRevision(revision);
  const normalizedFindingsValue = normalizedFindings(findings);
  if (!normalizedSourceValue || normalizedRevisionValue <= 0 || normalizedFindingsValue.length === 0) {
    throw new Error("Leaderboard review evidence is invalid");
  }
  const fingerprint = fingerprintForFindings(normalizedFindingsValue);
  const normalizedChecksum = typeof checksum === "string" && SHA256_PATTERN.test(checksum) ? checksum : null;
  const previous = getLeaderboardReview(data, userId);
  if (previous
    && previous.status === LEADERBOARD_REVIEW_APPROVED
    && previous.approvedRevision === normalizedRevisionValue
    && previous.fingerprint === fingerprint) {
    return { changed: false, status: LEADERBOARD_REVIEW_APPROVED, record: previous };
  }
  if (previous
    && previous.status === LEADERBOARD_REVIEW_PENDING
    && previous.detectedRevision === normalizedRevisionValue
    && previous.fingerprint === fingerprint) {
    return { changed: false, status: LEADERBOARD_REVIEW_PENDING, record: previous };
  }
  data.leaderboardReviewQueue ??= {};
  const timestamp = normalizedTimestamp(now);
  const record = {
    status: LEADERBOARD_REVIEW_PENDING,
    reasonCode: LEADERBOARD_REVIEW_REASON,
    source: normalizedSourceValue,
    mode: "normal",
    firstDetectedAt: previous?.firstDetectedAt ?? timestamp,
    lastDetectedAt: timestamp,
    detectedRevision: normalizedRevisionValue,
    ...(normalizedChecksum ? { detectedChecksum: normalizedChecksum } : {}),
    occurrences: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number(previous?.occurrences) || 0) + 1),
    findings: normalizedFindingsValue,
    fingerprint,
  };
  data.leaderboardReviewQueue[userId] = record;
  return { changed: true, status: LEADERBOARD_REVIEW_PENDING, record };
}

export function approveLeaderboardReview(data, userId, {
  revision,
  fingerprint,
  now = Date.now(),
} = {}) {
  const previous = getLeaderboardReview(data, userId);
  if (!previous || previous.status !== LEADERBOARD_REVIEW_PENDING) {
    return { changed: false, status: previous?.status ?? "missing", record: previous ?? null };
  }
  if (previous.detectedRevision !== revision || previous.fingerprint !== fingerprint) {
    throw new Error("Leaderboard review evidence changed; refresh the report");
  }
  const record = {
    ...previous,
    status: LEADERBOARD_REVIEW_APPROVED,
    reviewedAt: normalizedTimestamp(now),
    approvedRevision: revision,
    reviewAction: "approved",
  };
  data.leaderboardReviewQueue[userId] = record;
  return { changed: true, status: LEADERBOARD_REVIEW_APPROVED, record };
}

export function clearLeaderboardReview(data, userId) {
  if (!data?.leaderboardReviewQueue || !Object.hasOwn(data.leaderboardReviewQueue, userId)) {
    return false;
  }
  delete data.leaderboardReviewQueue[userId];
  return true;
}

export function pendingLeaderboardReviewEntries(data, { limit = 500 } = {}) {
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(Number(limit) || 500)));
  return Object.entries(data?.leaderboardReviewQueue ?? {})
    .filter(([, record]) => record?.status === LEADERBOARD_REVIEW_PENDING)
    .sort(([, left], [, right]) => right.lastDetectedAt - left.lastDetectedAt)
    .slice(0, safeLimit)
    .map(([userId, record]) => ({ userId, record }));
}

export function publicLeaderboardReviewRecord(data, userId, record = getLeaderboardReview(data, userId)) {
  if (!record) return null;
  const user = data?.users?.[userId];
  const submission = Object.values(data?.submissions ?? {}).find((entry) =>
    entry?.userId === userId || entry?.accountId === userId) ?? null;
  return {
    accountId: userId,
    username: typeof user?.username === "string" ? user.username : null,
    displayName: typeof user?.displayName === "string" ? user.displayName : null,
    status: record.status,
    reasonCode: record.reasonCode,
    source: record.source,
    mode: record.mode,
    firstDetectedAt: record.firstDetectedAt,
    lastDetectedAt: record.lastDetectedAt,
    detectedRevision: record.detectedRevision,
    detectedChecksumPrefix: record.detectedChecksum?.slice(0, 12) ?? null,
    occurrences: record.occurrences,
    findings: record.findings,
    fingerprint: record.fingerprint,
    reviewedAt: record.reviewedAt ?? null,
    leaderboardSubmissionRevision: submission?.verification?.cloudRevision ?? null,
    leaderboardPeakWhiteMatrixPerMinute: Number.isFinite(submission?.metrics?.peakWhiteMatrixPerMinute)
      ? submission.metrics.peakWhiteMatrixPerMinute
      : null,
  };
}

export function leaderboardReviewReport(data, { limit = 500, generatedAt = Date.now() } = {}) {
  const entries = pendingLeaderboardReviewEntries(data, { limit })
    .map(({ userId, record }) => publicLeaderboardReviewRecord(data, userId, record));
  return {
    version: LEADERBOARD_REVIEW_VERSION,
    generatedAt: normalizedTimestamp(generatedAt),
    status: "pending-review",
    pendingCount: Object.values(data?.leaderboardReviewQueue ?? {})
      .filter((record) => record?.status === LEADERBOARD_REVIEW_PENDING).length,
    entries,
  };
}
