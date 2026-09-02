import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM = 35_000;
const FIXED_AFFINITY_PRIORITY_CLASSES = new Set([
  "Idle", "BelowNormal", "Normal", "AboveNormal", "High", "RealTime",
]);
const CHILD_ENV_ALLOWLIST = Object.freeze([
  "APPDATA", "COMSPEC", "HOME", "LANG", "LC_ALL", "LOCALAPPDATA", "PATH", "PATHEXT",
  "PROGRAMDATA", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "TZ", "USERPROFILE", "WINDIR",
]);

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function asSnapshotBuffer(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError("fixed v47 fixture generator must return UTF-8 bytes or text");
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`fixed fixture is not valid UTF-8: ${String(error?.message ?? error)}`);
  }
}

export function computeV47StateChecksum(state) {
  const payload = JSON.stringify({ formatVersion: 2, state });
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function inspectV47Envelope(bytes) {
  let envelope;
  try {
    envelope = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (String(error?.message ?? error).startsWith("fixed fixture is not valid UTF-8:")) throw error;
    throw new Error(`fixed fixture is not valid JSON: ${String(error?.message ?? error)}`);
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      envelope.formatVersion !== 2 || !envelope.state || typeof envelope.state !== "object" ||
      Array.isArray(envelope.state) || envelope.state.version !== 47 ||
      !Array.isArray(envelope.state.entities) || !Array.isArray(envelope.state.belts) ||
      !/^[a-f0-9]{8}$/.test(envelope.checksum ?? "")) {
    throw new Error("fixed fixture must be an envelope-v2/state-v47 save");
  }
  const computedChecksum = computeV47StateChecksum(envelope.state);
  if (envelope.checksum !== computedChecksum) {
    throw new Error(`fixed fixture state checksum mismatch: expected ${envelope.checksum}, computed ${computedChecksum}`);
  }
  return {
    envelopeFormatVersion: envelope.formatVersion,
    stateVersion: envelope.state.version,
    stateChecksum: envelope.checksum,
    entityCount: envelope.state.entities.length,
    beltCount: envelope.state.belts.length,
  };
}

function assertLowerSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a 64-character lowercase SHA-256 digest`);
  }
  return value;
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

export function buildFixedAffinityChildEnvironment(parentEnvironment, managedEnvironment, platform = process.platform) {
  const child = {};
  const sourceKeys = Object.keys(parentEnvironment ?? {});
  for (const allowed of CHILD_ENV_ALLOWLIST) {
    const sourceKey = platform === "win32"
      ? sourceKeys.find((key) => key.toUpperCase() === allowed)
      : sourceKeys.find((key) => key === allowed);
    if (sourceKey && parentEnvironment[sourceKey] !== undefined) child[sourceKey] = parentEnvironment[sourceKey];
  }
  for (const [key, value] of Object.entries(managedEnvironment ?? {})) {
    if (value !== undefined && value !== null) child[key] = String(value);
  }
  return child;
}

function readRegularFileSnapshot(filePath) {
  const resolved = path.resolve(filePath);
  const pathStat = fs.lstatSync(resolved);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error(`fixed fixture must be a regular non-symbolic-link file: ${resolved}`);
  }
  const descriptor = fs.openSync(resolved, "r");
  try {
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile()) throw new Error(`fixed fixture is not a regular file: ${resolved}`);
    return { resolved, bytes: fs.readFileSync(descriptor) };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readFixedV47Fixture(filePath, expectedSha256 = null) {
  const { resolved, bytes } = readRegularFileSnapshot(filePath);
  const sha256 = sha256Bytes(bytes);
  if (expectedSha256 !== null) {
    const expected = assertLowerSha256(expectedSha256, "expected fixture SHA-256");
    if (sha256 !== expected) {
      throw new Error(`fixed fixture SHA-256 mismatch: expected ${expected}, received ${sha256}`);
    }
  }
  return {
    path: resolved,
    bytes,
    sha256,
    sizeBytes: bytes.length,
    ...inspectV47Envelope(bytes),
  };
}

export function generateAndPersistFixedV47Fixture({ outputPath, generate, overwrite = false }) {
  if (typeof generate !== "function") throw new TypeError("fixed v47 fixture generate callback is required");
  if (overwrite) throw new Error("fixed fixture persistence never overwrites an existing path");
  const resolved = path.resolve(outputPath);
  if (fs.existsSync(resolved)) throw new Error(`fixed fixture already exists: ${resolved}`);
  let generatorCallbackCalls = 0;
  const bytes = asSnapshotBuffer((() => {
    generatorCallbackCalls += 1;
    return generate();
  })());
  inspectV47Envelope(bytes);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    // A same-directory hard link publishes complete bytes without replacing an
    // existing file. Concurrent creators fail with EEXIST instead of winning a
    // check-then-write race or following a target symlink.
    fs.linkSync(temporary, resolved);
    const persisted = readFixedV47Fixture(resolved, sha256Bytes(bytes));
    if (!persisted.bytes.equals(bytes)) throw new Error("persisted fixed fixture bytes differ from generator output");
    return { ...persisted, generatorCallbackCalls };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

export function normalizeAffinity(mask) {
  const value = String(mask).trim().replace(/^0x/i, "").toUpperCase();
  if (!/^[0-9A-F]{1,16}$/.test(value)) throw new Error("affinity must be a 1-to-16-digit hexadecimal mask");
  const selected = value.replace(/^0+/, "");
  if (!selected) throw new Error("affinity must select at least one processor");
  return `0X${selected}`;
}

function invalidEvaluation(reasonCode) {
  return { status: "NO_RESULT", reasonCodes: [reasonCode], expected: null };
}

function expectedConfiguration({ fixtureSha256, affinity, threads, nodePriority, nativePriority }) {
  if (!FIXED_AFFINITY_PRIORITY_CLASSES.has(nodePriority)) throw new Error("expected Node priority is unsupported");
  if (!FIXED_AFFINITY_PRIORITY_CLASSES.has(nativePriority)) throw new Error("expected Native Host priority is unsupported");
  return {
    fixtureSha256: assertLowerSha256(fixtureSha256, "fixture SHA-256"),
    affinity: normalizeAffinity(affinity),
    threads: assertPositiveSafeInteger(threads, "threads"),
    nodePriority,
    nativePriority,
  };
}

function digestMismatch(records, field) {
  return records.some((record) => typeof record[field] !== "string" || !SHA256_PATTERN.test(record[field])) ||
    new Set(records.map((record) => record[field])).size !== 1;
}

function localDispatchShapeSha256(profile) {
  return createHash("sha256").update(JSON.stringify([
    profile.instrumentationVersion,
    profile.workScope,
    profile.selectedDemands,
    profile.totalDemands,
    profile.planetShards,
    profile.demandSlots,
    profile.peerEdges,
    profile.sortWorkUnits,
    profile.totalWorkUnits,
    profile.largestShardWorkUnits,
    profile.largestShardRatioPpm,
    profile.parallelizableWorkUnits,
    profile.parallelizableRatioPpm,
    profile.routeEvents,
    profile.shardWorkSha256,
    profile.planetIdentityProven,
    profile.scanFallback,
    profile.parallelFallback,
  ])).digest("hex");
}

function validLocalDispatchEvidence(record) {
  const profile = record?.localDispatchProfile;
  const gate = record?.profileGate;
  const decision = record?.performanceDecision;
  if (record?.evidenceStatus !== "RESULT" || !profile || typeof profile !== "object" || Array.isArray(profile) ||
      !gate || typeof gate !== "object" || Array.isArray(gate) ||
      !decision || typeof decision !== "object" || Array.isArray(decision) ||
      decision.status !== "NOT_EVALUATED" ||
      decision.reasonCode !== "profile-shape-and-stage-share-are-not-performance-benefit" ||
      profile.schemaVersion !== 2 || profile.instrumentationVersion !== "local-dispatch-profile-v3" ||
      profile.workScope !== "shape-proxy-only-not-time-or-speedup" ||
      profile.productGate !== "full-advance-stage-share-times-parallelizable-share-at-least-3.5-percent" ||
      !SHA256_PATTERN.test(profile.shardWorkSha256 ?? "") ||
      !SHA256_PATTERN.test(profile.shapeSha256 ?? "") ||
      profile.shapeSha256 !== localDispatchShapeSha256(profile) ||
      !Number.isSafeInteger(profile.stageDurationNs) || profile.stageDurationNs < 0 ||
      profile.stageDurationMicros !== Math.floor(profile.stageDurationNs / 1_000) ||
      !Number.isSafeInteger(profile.fullAdvanceDurationNs) || profile.fullAdvanceDurationNs <= 0 ||
      !Number.isSafeInteger(profile.stageSharePpm) || profile.stageSharePpm < 0 || profile.stageSharePpm > 1_000_000 ||
      !Number.isSafeInteger(profile.parallelBenefitUpperBoundPpm) || profile.parallelBenefitUpperBoundPpm < 0 ||
      !Number.isSafeInteger(profile.parallelizableRatioPpm) || profile.parallelizableRatioPpm < 0 ||
      profile.parallelBenefitUpperBoundScope !== "theoretical-before-coordination-and-merge-overhead" ||
      BigInt(profile.stageDurationNs) > BigInt(profile.fullAdvanceDurationNs) ||
      profile.stageSharePpm !== Number((BigInt(profile.stageDurationNs) * 1_000_000n) /
        BigInt(profile.fullAdvanceDurationNs)) ||
      profile.parallelBenefitUpperBoundPpm !== Number(
        (BigInt(profile.stageSharePpm) * BigInt(profile.parallelizableRatioPpm)) / 1_000_000n,
      ) ||
      !Array.isArray(profile.gateReasonCodes) ||
      gate.thresholdPpm !== LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM ||
      gate.theoreticalUpperBoundPpm !== profile.parallelBenefitUpperBoundPpm ||
      !["ELIGIBLE_FOR_FIXED_AB", "NO_GO"].includes(gate.status) ||
      gate.status !== profile.gateStatus || !Array.isArray(gate.reasonCodes) ||
      JSON.stringify(gate.reasonCodes) !== JSON.stringify(profile.gateReasonCodes)) {
    return false;
  }
  const numericShapeFields = [
    "selectedDemands", "totalDemands", "planetShards", "demandSlots", "peerEdges",
    "sortWorkUnits", "totalWorkUnits", "largestShardWorkUnits", "largestShardRatioPpm",
    "parallelizableWorkUnits", "parallelizableRatioPpm", "routeEvents",
  ];
  if (numericShapeFields.some((key) => !Number.isSafeInteger(profile[key]) || profile[key] < 0) ||
      typeof profile.planetIdentityProven !== "boolean" || typeof profile.scanFallback !== "string" ||
      typeof profile.parallelFallback !== "string" ||
      profile.gateReasonCodes.some((reason) => typeof reason !== "string") ||
      new Set(profile.gateReasonCodes).size !== profile.gateReasonCodes.length ||
      (profile.gateStatus === "ELIGIBLE_FOR_FIXED_AB") !== (profile.gateReasonCodes.length === 0) ||
      profile.gateReasonCodes.includes("local-dispatch-stage-share-below-3.5-percent") !==
        (profile.stageSharePpm < LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM)) {
    return false;
  }
  const ratioPpm = (numerator, denominator) => denominator === 0
    ? 0
    : Number((BigInt(numerator) * 1_000_000n) / BigInt(denominator));
  if (profile.selectedDemands > profile.totalDemands || profile.planetShards > profile.selectedDemands ||
      BigInt(profile.totalWorkUnits) !== BigInt(profile.selectedDemands) + BigInt(profile.demandSlots) +
        BigInt(profile.peerEdges) + BigInt(profile.sortWorkUnits) + BigInt(profile.routeEvents) ||
      profile.largestShardWorkUnits > profile.totalWorkUnits ||
      profile.largestShardRatioPpm !== ratioPpm(profile.largestShardWorkUnits, profile.totalWorkUnits) ||
      profile.parallelizableRatioPpm !== ratioPpm(profile.parallelizableWorkUnits, profile.totalWorkUnits) ||
      profile.parallelizableWorkUnits !== (profile.planetIdentityProven
        ? profile.totalWorkUnits - profile.largestShardWorkUnits
        : 0)) {
    return false;
  }
  const expectedGateReasons = [];
  if (profile.scanFallback !== "none") expectedGateReasons.push("local-dispatch-scan-fallback");
  if (!profile.planetIdentityProven) expectedGateReasons.push("local-dispatch-planet-identity-unproven");
  if (profile.planetShards < 2) expectedGateReasons.push("local-dispatch-planet-shards-insufficient");
  if (profile.parallelFallback !== "shape-only-requires-full-advance-gate") {
    expectedGateReasons.push("local-dispatch-parallel-fallback");
  }
  if (profile.stageSharePpm < LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM) {
    expectedGateReasons.push("local-dispatch-stage-share-below-3.5-percent");
  }
  if (profile.parallelBenefitUpperBoundPpm < LOCAL_DISPATCH_STAGE_SHARE_MIN_PPM) {
    expectedGateReasons.push("local-dispatch-parallel-benefit-upper-bound-below-3.5-percent");
  }
  if (JSON.stringify(profile.gateReasonCodes) !== JSON.stringify(expectedGateReasons)) return false;
  return true;
}

function localDispatchEvidenceReasons(records, requiredShapeSha256 = null) {
  if (records.some((record) => !validLocalDispatchEvidence(record))) {
    return ["local-dispatch-profile-evidence-mismatch"];
  }
  const shapes = new Set(records.map((record) => record.localDispatchProfile.shapeSha256));
  if (shapes.size !== 1 || (requiredShapeSha256 !== null && !shapes.has(requiredShapeSha256))) {
    return ["local-dispatch-profile-shape-mismatch"];
  }
  return [];
}

function identityReasons(
  records,
  expected,
  requiredWriteBackWorkers = null,
  requiredLocalDispatchShapeSha256 = null,
) {
  const reasons = [];
  if (records.some((record) => record.fixtureSha256 !== expected.fixtureSha256)) {
    reasons.push("fixture-sha-mismatch");
  }
  const affinityMatches = (value) => {
    try {
      return normalizeAffinity(value) === expected.affinity;
    } catch {
      return false;
    }
  };
  let processPolicyEvidenceMismatch = false;
  let processIdentityMismatch = false;
  let processPolicyAffinityMismatch = false;
  let processPolicyPriorityMismatch = false;
  for (const record of records) {
    const policy = record.processPolicy;
    const requested = policy?.requested;
    const before = policy?.before;
    const after = policy?.after;
    if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
        !requested || typeof requested !== "object" || Array.isArray(requested) ||
        !before || typeof before !== "object" || Array.isArray(before) ||
        !after || typeof after !== "object" || Array.isArray(after)) {
      processPolicyEvidenceMismatch = true;
      continue;
    }
    if (!affinityMatches(requested.affinity)) processPolicyAffinityMismatch = true;
    if (requested.nodePriority !== expected.nodePriority || requested.nativePriority !== expected.nativePriority) {
      processPolicyPriorityMismatch = true;
    }
    const nodeSnapshots = [before.node, after.node];
    const nativeSnapshots = [before.nativeHost, after.nativeHost];
    const snapshots = [...nodeSnapshots, ...nativeSnapshots];
    if (snapshots.some((snapshot) => !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))) {
      processPolicyEvidenceMismatch = true;
      continue;
    }
    if (nodeSnapshots.some((snapshot) => !Number.isSafeInteger(snapshot.Id) || snapshot.Id <= 0) ||
        nativeSnapshots.some((snapshot) => !Number.isSafeInteger(snapshot.Id) || snapshot.Id <= 0) ||
        nodeSnapshots[0].Id !== nodeSnapshots[1].Id ||
        nativeSnapshots[0].Id !== nativeSnapshots[1].Id ||
        nodeSnapshots[0].Id === nativeSnapshots[0].Id) {
      processIdentityMismatch = true;
    }
    if (nodeSnapshots.some((snapshot) => !affinityMatches(snapshot.ProcessorAffinity)) ||
        nativeSnapshots.some((snapshot) => !affinityMatches(snapshot.ProcessorAffinity))) {
      processPolicyAffinityMismatch = true;
    }
    if (nodeSnapshots.some((snapshot) => snapshot.PriorityClass !== expected.nodePriority) ||
        nativeSnapshots.some((snapshot) => snapshot.PriorityClass !== expected.nativePriority)) {
      processPolicyPriorityMismatch = true;
    }
  }
  if (processPolicyEvidenceMismatch) reasons.push("process-policy-evidence-mismatch");
  if (processIdentityMismatch) reasons.push("process-identity-mismatch");
  if (processPolicyAffinityMismatch) reasons.push("process-affinity-mismatch");
  if (processPolicyPriorityMismatch) reasons.push("process-priority-mismatch");
  if (records.some((record) => !affinityMatches(record.nodeAffinity) || !affinityMatches(record.nativeAffinity))) {
    reasons.push("process-affinity-mismatch");
  }
  if (records.some((record) =>
    record.nodePriority !== expected.nodePriority || record.nativePriority !== expected.nativePriority)) {
    reasons.push("process-priority-mismatch");
  }
  const writeBackValues = new Set(records.map((record) => record.writeBackWorkers));
  if (writeBackValues.size !== 1 || records.some((record) =>
    record.requestedThreads !== String(expected.threads) ||
    record.profileEnabled !== true ||
    record.effectiveWorkerLimit !== expected.threads ||
    record.observedWorkerCount !== expected.threads ||
    !Number.isSafeInteger(record.writeBackWorkers) ||
    record.writeBackWorkers <= 0 || record.writeBackWorkers > expected.threads) ||
    (requiredWriteBackWorkers !== null && records.some((record) => record.writeBackWorkers !== requiredWriteBackWorkers))) {
    reasons.push("worker-metadata-mismatch");
  }
  reasons.push(...localDispatchEvidenceReasons(records, requiredLocalDispatchShapeSha256));
  return reasons;
}

export function evaluateFixedPreflight({
  records,
  fixtureSha256,
  affinity,
  threads,
  nodePriority,
  nativePriority,
}) {
  if (!Array.isArray(records) || records.length !== 2 || records.some((record) => !record || typeof record !== "object")) {
    return invalidEvaluation("preflight-process-failed");
  }
  let expected;
  try {
    expected = expectedConfiguration({ fixtureSha256, affinity, threads, nodePriority, nativePriority });
  } catch {
    return invalidEvaluation("preflight-configuration-invalid");
  }
  const reasonCodes = identityReasons(records, expected);
  for (const [field, reason] of [
    ["openCanonicalSha256", "open-canonical-hash-mismatch"],
    ["preStepCanonicalSha256", "pre-step-canonical-hash-mismatch"],
    ["preStepDomainSha256", "pre-step-domain-hash-mismatch"],
    ["measuredCanonicalSha256", "measured-canonical-hash-mismatch"],
    ["measuredDomainSha256", "measured-domain-hash-mismatch"],
  ]) {
    if (digestMismatch(records, field)) reasonCodes.push(reason);
  }
  const unique = [...new Set(reasonCodes)];
  return {
    status: unique.length === 0 ? "RESULT" : "NO_RESULT",
    reasonCodes: unique,
    expected: unique.length === 0 ? {
      ...records[0],
      fixtureSha256: expected.fixtureSha256,
      nodeAffinity: expected.affinity,
      nativeAffinity: expected.affinity,
      nodePriority: expected.nodePriority,
      nativePriority: expected.nativePriority,
    } : null,
  };
}

export function evaluateFixedMeasured({
  records,
  expectedCount,
  fixtureSha256,
  affinity,
  threads,
  nodePriority,
  nativePriority,
  preflightExpected,
}) {
  if (!Array.isArray(records) || !Number.isSafeInteger(expectedCount) || expectedCount <= 0 ||
      records.length !== expectedCount || records.some((record) => !record || typeof record !== "object")) {
    return invalidEvaluation("measured-process-failed");
  }
  let expected;
  try {
    expected = expectedConfiguration({ fixtureSha256, affinity, threads, nodePriority, nativePriority });
    if (!preflightExpected || typeof preflightExpected !== "object") throw new Error("preflight expected record is required");
  } catch {
    return invalidEvaluation("measured-configuration-invalid");
  }
  const reasonCodes = identityReasons(
    records,
    expected,
    preflightExpected.writeBackWorkers,
    preflightExpected.localDispatchProfile?.shapeSha256 ?? null,
  );
  for (const [field, reason] of [
    ["openCanonicalSha256", "open-canonical-hash-mismatch"],
    ["preStepCanonicalSha256", "pre-step-canonical-hash-mismatch"],
    ["preStepDomainSha256", "pre-step-domain-hash-mismatch"],
  ]) {
    if (digestMismatch(records, field) || records.some((record) => record[field] !== preflightExpected[field])) {
      reasonCodes.push(reason);
    }
  }
  for (const [field, reason] of [
    ["measuredCanonicalSha256", "measured-canonical-hash-mismatch"],
    ["measuredDomainSha256", "measured-domain-hash-mismatch"],
  ]) {
    if (digestMismatch(records, field) || records.some((record) => record[field] !== preflightExpected[field])) {
      reasonCodes.push(reason);
    }
  }
  if (records.some((record) => !Number.isFinite(record.durationMs) || record.durationMs <= 0)) {
    reasonCodes.push("measured-duration-invalid");
  }
  const unique = [...new Set(reasonCodes)];
  return {
    status: unique.length === 0 ? "RESULT" : "NO_RESULT",
    reasonCodes: unique,
    expected: unique.length === 0 ? preflightExpected : null,
  };
}

export { assertLowerSha256, assertPositiveSafeInteger, sha256Bytes };
