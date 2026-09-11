import { createInitialState } from "./engine";
import { createVeinReserve, DEFAULT_GALAXY_SEED } from "./galaxy";
import { computeSaveStateChecksum } from "./saveEnvelopeIntegrity";
import type { FactoryEntity, GameState, PlanetId, SaveMode } from "./types";

export const CANONICAL_UNIPOLAR_PLANET_ID: PlanetId = "magnetar";
export const CANONICAL_UNIPOLAR_VEIN_ID = "ashen_unipolar";
export const SECONDARY_UNIPOLAR_VEIN_ID = "ashen_unipolar_secondary";
export const UNIPOLAR_VEIN_HARD_CAP = 2;
const SAVE_FORMAT_VERSION = 2;

export interface UnipolarVeinAudit {
  expectedPlanetIds: PlanetId[];
  observedTotal: number;
  observedByPlanet: Partial<Record<PlanetId, number>>;
  canonicalCount: number;
  canonicalIdValid: boolean;
  missingExpectedPlanetIds: PlanetId[];
  duplicatePlanetIds: PlanetId[];
  issues: string[];
  healthy: boolean;
}

export interface UnipolarRepairContext {
  saveId: string;
  reason: string;
  operator: string;
  createdAt: number;
  leaderboardReview?: "not-required" | "required" | "approved" | "rejected";
}

export interface UnipolarRepairPreview {
  eligible: boolean;
  sourceChecksum: string;
  confirmationToken: string;
  sourceAudit: UnipolarVeinAudit;
  targetPlanetId: PlanetId;
  targetEntityId: string;
  mode: SaveMode;
  requiresLeaderboardReview: boolean;
  blockingReasons: string[];
}

export interface UnipolarRepairAuditRecord {
  operation: "restore-missing-canonical-unipolar-v1" | "expand-single-unipolar-to-two-v1";
  saveId: string;
  operator: string;
  reason: string;
  createdAt: number;
  mode: SaveMode;
  sourceChecksum: string;
  candidateChecksum: string;
  confirmationToken: string;
  beforeCount: number;
  afterCount: number;
  targetPlanetId: PlanetId;
  targetEntityId: string;
  leaderboardReview: "not-required" | "required" | "approved" | "rejected";
}

export interface UnipolarRepairPackage {
  backupState: GameState;
  candidateState: GameState;
  audit: UnipolarRepairAuditRecord;
}

function checksum(state: GameState): string {
  return computeSaveStateChecksum(SAVE_FORMAT_VERSION, state);
}

function cleanAuditText(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[\r\n\t]+/g, " ").slice(0, 160);
  return normalized || fallback;
}

function expectedUnipolarPlanets(state: GameState): PlanetId[] {
  return Object.values(state.galaxy.profiles)
    .filter((profile) => profile.resourceIds.includes("unipolar_magnet"))
    .map((profile) => profile.planetId)
    .sort();
}

export function auditUnipolarVeins(state: GameState): UnipolarVeinAudit {
  const expectedPlanetIds = expectedUnipolarPlanets(state);
  const observed = state.entities.filter((entity) => entity.kind === "vein" && entity.resourceId === "unipolar_magnet");
  const observedByPlanet: Partial<Record<PlanetId, number>> = {};
  for (const entity of observed) observedByPlanet[entity.planetId] = (observedByPlanet[entity.planetId] ?? 0) + 1;
  const missingExpectedPlanetIds = expectedPlanetIds.filter((planetId) => (observedByPlanet[planetId] ?? 0) === 0);
  const duplicatePlanetIds = expectedPlanetIds.filter((planetId) => (observedByPlanet[planetId] ?? 0) > UNIPOLAR_VEIN_HARD_CAP);
  const canonicalEntities = observed.filter((entity) => entity.planetId === CANONICAL_UNIPOLAR_PLANET_ID);
  const canonicalIdEntity = state.entities.find((entity) => entity.id === CANONICAL_UNIPOLAR_VEIN_ID);
  const canonicalIdValid = Boolean(canonicalIdEntity && canonicalIdEntity.kind === "vein" &&
    canonicalIdEntity.planetId === CANONICAL_UNIPOLAR_PLANET_ID && canonicalIdEntity.resourceId === "unipolar_magnet");
  const issues: string[] = [];
  if (missingExpectedPlanetIds.length > 0) issues.push(`缺少声明资源节点：${missingExpectedPlanetIds.join("、")}`);
  const secondary = state.entities.find((entity) => entity.id === SECONDARY_UNIPOLAR_VEIN_ID);
  const secondaryIdValid = Boolean(secondary && secondary.kind === "vein" &&
    secondary.planetId === CANONICAL_UNIPOLAR_PLANET_ID && secondary.resourceId === "unipolar_magnet");
  if (canonicalEntities.length > UNIPOLAR_VEIN_HARD_CAP) {
    issues.push(`单极磁石节点超过硬上限 ${UNIPOLAR_VEIN_HARD_CAP}：${canonicalEntities.length}`);
  } else if (canonicalEntities.length === UNIPOLAR_VEIN_HARD_CAP && !secondaryIdValid) {
    issues.push(`第二个单极磁石节点缺少规范 ID ${SECONDARY_UNIPOLAR_VEIN_ID}`);
  }
  if (canonicalEntities.length > 0 && !canonicalIdValid) issues.push(`磁潮孤星单极磁石节点缺少规范 ID ${CANONICAL_UNIPOLAR_VEIN_ID}`);
  for (const entity of observed) {
    if (!expectedPlanetIds.includes(entity.planetId)) issues.push(`行星 ${entity.planetId} 存在目录未声明的单极磁石节点 ${entity.id}`);
  }
  return {
    expectedPlanetIds,
    observedTotal: observed.length,
    observedByPlanet,
    canonicalCount: canonicalEntities.length,
    canonicalIdValid,
    missingExpectedPlanetIds,
    duplicatePlanetIds,
    issues,
    healthy: issues.length === 0,
  };
}

function repairToken(sourceChecksum: string, context: UnipolarRepairContext): string {
  return computeSaveStateChecksum(SAVE_FORMAT_VERSION, {
    operation: "restore-missing-canonical-unipolar-v1",
    sourceChecksum,
    saveId: cleanAuditText(context.saveId, "unknown-save"),
    reason: cleanAuditText(context.reason, "missing canonical unipolar vein"),
    operator: cleanAuditText(context.operator, "unknown-operator"),
    createdAt: Math.max(0, Math.floor(context.createdAt)),
  });
}

export function previewUnipolarVeinRepair(state: GameState, context: UnipolarRepairContext): UnipolarRepairPreview {
  const sourceAudit = auditUnipolarVeins(state);
  const sourceChecksum = checksum(state);
  const mode: SaveMode = state.mode === "speedrun" ? "speedrun" : "normal";
  const requiresLeaderboardReview = mode === "speedrun" || state.speedrun?.enabled === true;
  const blockingReasons: string[] = [];
  const canonicalProfile = state.galaxy.profiles[CANONICAL_UNIPOLAR_PLANET_ID];
  if (!canonicalProfile?.resourceIds.includes("unipolar_magnet")) {
    blockingReasons.push("当前星系目录没有声明磁潮孤星单极磁石，不能凭空补矿");
  }
  if (sourceAudit.canonicalCount !== 0) {
    blockingReasons.push(sourceAudit.canonicalCount === 1
      ? "磁潮孤星已有一个合法单极磁石节点；单个节点是当前规则的正常结果"
      : "磁潮孤星已有重复单极磁石节点，必须先人工审计，不能继续增加");
  }
  const idCollision = state.entities.find((entity) => entity.id === CANONICAL_UNIPOLAR_VEIN_ID);
  if (idCollision) blockingReasons.push(`实体 ID ${CANONICAL_UNIPOLAR_VEIN_ID} 已被占用，不能自动改名或覆盖`);
  if (requiresLeaderboardReview && context.leaderboardReview !== "approved") {
    blockingReasons.push("速通或排行榜相关存档必须先完成独立资格复核");
  }
  return {
    eligible: blockingReasons.length === 0,
    sourceChecksum,
    confirmationToken: repairToken(sourceChecksum, context),
    sourceAudit,
    targetPlanetId: CANONICAL_UNIPOLAR_PLANET_ID,
    targetEntityId: CANONICAL_UNIPOLAR_VEIN_ID,
    mode,
    requiresLeaderboardReview,
    blockingReasons,
  };
}

function canonicalUnipolarTemplate(state: GameState): FactoryEntity {
  const baseline = createInitialState(state.galaxy.seed, state.galaxy.seed === DEFAULT_GALAXY_SEED);
  const entity = baseline.entities.find((candidate) => candidate.id === CANONICAL_UNIPOLAR_VEIN_ID);
  if (!entity || entity.kind !== "vein" || entity.resourceId !== "unipolar_magnet") {
    throw new Error("当前版本缺少规范单极磁石模板");
  }
  return structuredClone(entity);
}

/**
 * Builds an in-memory repair package only. Callers must persist the backup and
 * verify its hash before writing the candidate. Nothing invokes this during
 * migration, load, import, cloud restore, or leaderboard submission.
 */
export function createUnipolarVeinRepairPackage(
  state: GameState,
  context: UnipolarRepairContext,
  confirmationToken: string,
): UnipolarRepairPackage {
  const preview = previewUnipolarVeinRepair(state, context);
  if (!preview.eligible) throw new Error(preview.blockingReasons[0] ?? "该存档不符合单极磁石人工修复条件");
  if (preview.confirmationToken !== confirmationToken) throw new Error("人工修复确认令牌不匹配，源存档或审核信息已变化");
  if (checksum(state) !== preview.sourceChecksum) throw new Error("源存档哈希已变化，请重新预览并备份");
  const backupState = structuredClone(state);
  const candidateState = structuredClone(state);
  candidateState.entities.push(canonicalUnipolarTemplate(state));
  const candidateAudit = auditUnipolarVeins(candidateState);
  if (!candidateAudit.healthy || candidateAudit.canonicalCount !== 1) {
    throw new Error(candidateAudit.issues[0] ?? "修复候选未通过单极磁石资源校验");
  }
  const candidateChecksum = checksum(candidateState);
  return {
    backupState,
    candidateState,
    audit: {
      saveId: cleanAuditText(context.saveId, "unknown-save"),
      operation: "restore-missing-canonical-unipolar-v1",
      operator: cleanAuditText(context.operator, "unknown-operator"),
      reason: cleanAuditText(context.reason, "missing canonical unipolar vein"),
      createdAt: Math.max(0, Math.floor(context.createdAt)),
      mode: preview.mode,
      sourceChecksum: preview.sourceChecksum,
      candidateChecksum,
      confirmationToken: preview.confirmationToken,
      beforeCount: preview.sourceAudit.observedTotal,
      afterCount: candidateAudit.observedTotal,
      targetPlanetId: CANONICAL_UNIPOLAR_PLANET_ID,
      targetEntityId: CANONICAL_UNIPOLAR_VEIN_ID,
      leaderboardReview: context.leaderboardReview ?? (preview.requiresLeaderboardReview ? "required" : "not-required"),
    },
  };
}

function expansionToken(sourceChecksum: string, context: UnipolarRepairContext): string {
  return computeSaveStateChecksum(SAVE_FORMAT_VERSION, {
    operation: "expand-single-unipolar-to-two-v1",
    sourceChecksum,
    saveId: cleanAuditText(context.saveId, "local-main"),
    reason: cleanAuditText(context.reason, "player requested second unipolar vein"),
    operator: cleanAuditText(context.operator, "local-player"),
    createdAt: Math.max(0, Math.floor(context.createdAt)),
  });
}

/** Explicit normal-save operation; never called by load, migration or cloud restore. */
export function previewSecondUnipolarVein(
  state: GameState,
  context: UnipolarRepairContext,
): UnipolarRepairPreview {
  const sourceAudit = auditUnipolarVeins(state);
  const sourceChecksum = checksum(state);
  const mode: SaveMode = state.mode === "speedrun" ? "speedrun" : "normal";
  const blockingReasons: string[] = [];
  if (mode !== "normal" || state.speedrun?.enabled === true) {
    blockingReasons.push("速通或排行榜相关存档不能增加第二个单极磁石矿脉");
  }
  if (!state.galaxy.profiles[CANONICAL_UNIPOLAR_PLANET_ID]?.resourceIds.includes("unipolar_magnet")) {
    blockingReasons.push("当前星系目录没有声明磁潮孤星单极磁石");
  }
  if (!sourceAudit.healthy) blockingReasons.push(sourceAudit.issues[0] ?? "单极磁石资源审计未通过");
  if (sourceAudit.observedTotal !== 1 || sourceAudit.canonicalCount !== 1 || !sourceAudit.canonicalIdValid) {
    blockingReasons.push(sourceAudit.observedTotal >= UNIPOLAR_VEIN_HARD_CAP
      ? `当前已有 ${sourceAudit.observedTotal} 个单极磁石矿脉，硬上限为 ${UNIPOLAR_VEIN_HARD_CAP}`
      : "仅允许为恰好拥有一个规范单极磁石矿脉的普通存档增加一次");
  }
  if (state.entities.some((entity) => entity.id === SECONDARY_UNIPOLAR_VEIN_ID)) {
    blockingReasons.push(`实体 ID ${SECONDARY_UNIPOLAR_VEIN_ID} 已存在，不能覆盖或改名`);
  }
  return {
    eligible: blockingReasons.length === 0,
    sourceChecksum,
    confirmationToken: expansionToken(sourceChecksum, context),
    sourceAudit,
    targetPlanetId: CANONICAL_UNIPOLAR_PLANET_ID,
    targetEntityId: SECONDARY_UNIPOLAR_VEIN_ID,
    mode,
    requiresLeaderboardReview: false,
    blockingReasons,
  };
}

function secondaryUnipolarTemplate(state: GameState): FactoryEntity {
  const entity = canonicalUnipolarTemplate(state);
  const reserve = createVeinReserve(
    state.galaxy,
    CANONICAL_UNIPOLAR_PLANET_ID,
    "unipolar_magnet",
    SECONDARY_UNIPOLAR_VEIN_ID,
  );
  return {
    ...entity,
    id: SECONDARY_UNIPOLAR_VEIN_ID,
    position: { x: 170, y: 35 },
    minerCount: 0,
    machineCount: 0,
    inputs: {},
    outputs: { unipolar_magnet: 0 },
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
    resourceRemaining: reserve,
    resourceCapacity: reserve,
    resourceDepletionRemainder: 0,
  };
}

export function createSecondUnipolarVeinPackage(
  state: GameState,
  context: UnipolarRepairContext,
  confirmationToken: string,
): UnipolarRepairPackage {
  const preview = previewSecondUnipolarVein(state, context);
  if (!preview.eligible) throw new Error(preview.blockingReasons[0] ?? "该存档不能增加第二个单极磁石矿脉");
  if (preview.confirmationToken !== confirmationToken) throw new Error("增加矿脉确认令牌不匹配，源存档已变化");
  if (checksum(state) !== preview.sourceChecksum) throw new Error("源存档哈希已变化，请重新预览并备份");
  const backupState = structuredClone(state);
  const candidateState = structuredClone(state);
  candidateState.entities.push(secondaryUnipolarTemplate(state));
  const candidateAudit = auditUnipolarVeins(candidateState);
  if (!candidateAudit.healthy || candidateAudit.observedTotal !== UNIPOLAR_VEIN_HARD_CAP) {
    throw new Error(candidateAudit.issues[0] ?? "第二个单极磁石矿脉候选未通过硬上限校验");
  }
  const candidateChecksum = checksum(candidateState);
  return {
    backupState,
    candidateState,
    audit: {
      operation: "expand-single-unipolar-to-two-v1",
      saveId: cleanAuditText(context.saveId, "local-main"),
      operator: cleanAuditText(context.operator, "local-player"),
      reason: cleanAuditText(context.reason, "player requested second unipolar vein"),
      createdAt: Math.max(0, Math.floor(context.createdAt)),
      mode: "normal",
      sourceChecksum: preview.sourceChecksum,
      candidateChecksum,
      confirmationToken: preview.confirmationToken,
      beforeCount: 1,
      afterCount: UNIPOLAR_VEIN_HARD_CAP,
      targetPlanetId: CANONICAL_UNIPOLAR_PLANET_ID,
      targetEntityId: SECONDARY_UNIPOLAR_VEIN_ID,
      leaderboardReview: "not-required",
    },
  };
}

export function rollbackUnipolarVeinRepair(repaired: GameState, repairPackage: UnipolarRepairPackage): GameState {
  if (checksum(repaired) !== repairPackage.audit.candidateChecksum) {
    throw new Error("当前状态与修复候选哈希不一致，已拒绝覆盖式回滚");
  }
  if (checksum(repairPackage.backupState) !== repairPackage.audit.sourceChecksum) {
    throw new Error("修复备份哈希不一致，已拒绝回滚");
  }
  return structuredClone(repairPackage.backupState);
}
