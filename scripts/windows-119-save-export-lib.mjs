import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { access, open, readFile, rm, link, copyFile } from "node:fs/promises";
import { once } from "node:events";
import { createGunzip, createGzip } from "node:zlib";

export const WINDOWS_119_SAVE_DATABASE = "dsp-idle-network.local-saves";
export const WINDOWS_119_SAVE_STORE = "records";
export const WINDOWS_119_PRIMARY_KEY = "dsp-idle-network.save.v1";
export const WINDOWS_119_INTERNAL_PREFIX = "dsp-idle-network.internal.v1.";
export const WINDOWS_119_EXPORT_FORMAT_VERSION = 2;
export const WINDOWS_119_GAME_STATE_VERSION = 47;

const MAX_SCALAR_CHARS = 4_096;
const MAX_MANIFEST_CHUNKS = 4_096;
const MAX_COLLECTION_LENGTH = 10_000_000;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function primaryKeyForMode(mode) {
  if (mode !== "normal" && mode !== "speedrun") throw new TypeError("存档模式必须是 normal 或 speedrun");
  return mode === "speedrun" ? `${WINDOWS_119_PRIMARY_KEY}.speedrun` : WINDOWS_119_PRIMARY_KEY;
}

export function chunkedJournalPrefix(mode) {
  if (mode !== "normal" && mode !== "speedrun") throw new TypeError("存档模式必须是 normal 或 speedrun");
  return `${WINDOWS_119_INTERNAL_PREFIX}chunked.v1.${mode}.`;
}

export function chunkedManifestKey(mode) {
  return `${chunkedJournalPrefix(mode)}manifest`;
}

export function chunkedRecordKey(mode, id) {
  return `${chunkedJournalPrefix(mode)}chunk.${encodeURIComponent(id)}`;
}

/** FNV-1a over JavaScript UTF-16 code units, matching save envelope v2. */
export function computeSaveStateChecksumFromSegments(formatVersion, stateSegments) {
  let hash = 0x811c9dc5;
  const mix = (value, start = 0, end = value.length) => {
    for (let index = start; index < end; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  mix(`{"formatVersion":${JSON.stringify(formatVersion)},"state":`);
  for (const segment of stateSegments) mix(segment);
  mix("}");
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function computeSaveStateChecksumFromJson(formatVersion, stateJson) {
  return computeSaveStateChecksumFromSegments(formatVersion, [stateJson]);
}

/** FNV-1a over exact UTF-8 bytes, matching the 1.1.9 sidecar contract. */
export function computePayloadTextIdentity(value) {
  let hash = 0x811c9dc5;
  let byteLength = 0;
  const mix = (byte) => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
    byteLength += 1;
  };
  for (let index = 0; index < value.length; index += 1) {
    let code = value.charCodeAt(index);
    if (code <= 0x7f) mix(code);
    else if (code <= 0x7ff) {
      mix(0xc0 | code >> 6);
      mix(0x80 | code & 0x3f);
    } else {
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const low = value.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          index += 1;
          mix(0xf0 | code >> 18);
          mix(0x80 | code >> 12 & 0x3f);
          mix(0x80 | code >> 6 & 0x3f);
          mix(0x80 | code & 0x3f);
          continue;
        }
      }
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      mix(0xe0 | code >> 12);
      mix(0x80 | code >> 6 & 0x3f);
      mix(0x80 | code & 0x3f);
    }
  }
  return { checksum: (hash >>> 0).toString(16).padStart(8, "0"), byteLength };
}

function skipWhitespace(raw, index, end) {
  while (index < end && /[\t\n\r ]/.test(raw[index])) index += 1;
  return index;
}

function skipJsonString(raw, start, end) {
  if (raw[start] !== '"') throw new Error("存档不是规范 JSON 字符串");
  for (let index = start + 1; index < end; index += 1) {
    const code = raw.charCodeAt(index);
    if (code === 0x22) return index + 1;
    if (code < 0x20) throw new Error("存档包含非法 JSON 控制字符");
    if (code !== 0x5c) continue;
    index += 1;
    if (index >= end || !'"\\/bfnrtu'.includes(raw[index])) throw new Error("存档包含非法 JSON 转义");
    if (raw[index] === "u") {
      if (index + 4 >= end || !/^[0-9a-fA-F]{4}$/.test(raw.slice(index + 1, index + 5))) {
        throw new Error("存档包含非法 Unicode 转义");
      }
      index += 4;
    }
  }
  throw new Error("存档 JSON 字符串未闭合");
}

function skipCompositeJsonValue(raw, start, end) {
  const stack = [raw[start]];
  for (let index = start + 1; index < end; index += 1) {
    const char = raw[index];
    if (char === '"') {
      index = skipJsonString(raw, index, end) - 1;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const open = stack.pop();
      if (open !== (char === "}" ? "{" : "[")) throw new Error("存档 JSON 容器不匹配");
      if (stack.length === 0) return index + 1;
    }
  }
  throw new Error("存档 JSON 容器未闭合");
}

function skipJsonValue(raw, start, end) {
  const index = skipWhitespace(raw, start, end);
  const first = raw[index];
  if (first === '"') return skipJsonString(raw, index, end);
  if (first === "{" || first === "[") return skipCompositeJsonValue(raw, index, end);
  let cursor = index;
  while (cursor < end && !/[,}\]\t\n\r ]/.test(raw[cursor])) cursor += 1;
  if (cursor === index) throw new Error("存档 JSON 缺少值");
  return cursor;
}

function objectPropertyRanges(raw, range) {
  let cursor = skipWhitespace(raw, range.start, range.end);
  if (raw[cursor] !== "{") throw new Error("存档 JSON 顶层不是对象");
  cursor = skipWhitespace(raw, cursor + 1, range.end);
  const properties = new Map();
  if (raw[cursor] === "}") return { properties, end: cursor + 1 };
  while (cursor < range.end) {
    const keyStart = cursor;
    const keyEnd = skipJsonString(raw, keyStart, range.end);
    const keyRaw = raw.slice(keyStart, keyEnd);
    if (keyRaw.length > 512) throw new Error("存档 JSON 键过长");
    const key = JSON.parse(keyRaw);
    if (typeof key !== "string" || properties.has(key)) throw new Error("存档 JSON 键重复或非法");
    cursor = skipWhitespace(raw, keyEnd, range.end);
    if (raw[cursor] !== ":") throw new Error("存档 JSON 缺少冒号");
    const valueStart = skipWhitespace(raw, cursor + 1, range.end);
    const valueEnd = skipJsonValue(raw, valueStart, range.end);
    properties.set(key, { start: valueStart, end: valueEnd });
    cursor = skipWhitespace(raw, valueEnd, range.end);
    if (raw[cursor] === "}") return { properties, end: cursor + 1 };
    if (raw[cursor] !== ",") throw new Error("存档 JSON 缺少逗号");
    cursor = skipWhitespace(raw, cursor + 1, range.end);
  }
  throw new Error("存档 JSON 对象未闭合");
}

function requiredRange(properties, key) {
  const range = properties.get(key);
  if (!range) throw new Error(`存档缺少 ${key}`);
  return range;
}

function parseScalar(raw, range) {
  if (range.end - range.start > MAX_SCALAR_CHARS) throw new Error("存档 JSON 标量过大");
  return JSON.parse(raw.slice(range.start, range.end));
}

function finiteInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 不是非负安全整数`);
  return value;
}

function finiteNonNegativeFloor(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} 不是非负数`);
  return Math.floor(value);
}

function countArrayElements(raw, range) {
  let cursor = skipWhitespace(raw, range.start, range.end);
  if (raw[cursor] !== "[") throw new Error("存档字段不是数组");
  cursor = skipWhitespace(raw, cursor + 1, range.end);
  if (raw[cursor] === "]") return 0;
  let count = 0;
  while (cursor < range.end) {
    cursor = skipJsonValue(raw, cursor, range.end);
    count += 1;
    if (!Number.isSafeInteger(count)) throw new Error("存档数组过大");
    cursor = skipWhitespace(raw, cursor, range.end);
    if (raw[cursor] === "]") return count;
    if (raw[cursor] !== ",") throw new Error("存档数组缺少逗号");
    cursor = skipWhitespace(raw, cursor + 1, range.end);
  }
  throw new Error("存档数组未闭合");
}

function checksumRange(formatVersion, raw, stateRange) {
  let hash = 0x811c9dc5;
  const mix = (value, start = 0, end = value.length) => {
    for (let index = start; index < end; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  mix(`{"formatVersion":${JSON.stringify(formatVersion)},"state":`);
  mix(raw, stateRange.start, stateRange.end);
  mix("}");
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Validate a canonical 1.1.9 primary envelope without parsing the large
 * entity/belt arrays into a second object graph.
 */
export function inspectWindows119Envelope(raw, expectedMode = "normal") {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("主存档正文为空");
  const envelopeResult = objectPropertyRanges(raw, { start: 0, end: raw.length });
  if (skipWhitespace(raw, envelopeResult.end, raw.length) !== raw.length) throw new Error("存档 JSON 结尾存在多余内容");
  const envelope = envelopeResult.properties;
  const formatVersion = finiteInteger(parseScalar(raw, requiredRange(envelope, "formatVersion")), "formatVersion");
  const kind = parseScalar(raw, requiredRange(envelope, "kind"));
  const savedAt = finiteInteger(parseScalar(raw, requiredRange(envelope, "savedAt")), "savedAt");
  const mode = parseScalar(raw, requiredRange(envelope, "mode"));
  const slot = parseScalar(raw, requiredRange(envelope, "slot"));
  const recordedChecksum = parseScalar(raw, requiredRange(envelope, "checksum"));
  const stateRange = requiredRange(envelope, "state");
  if (formatVersion !== WINDOWS_119_EXPORT_FORMAT_VERSION || kind !== "primary" || slot !== "main") {
    throw new Error("不是 1.1.9 可导出的 v2 主存档");
  }
  if (mode !== expectedMode || (mode !== "normal" && mode !== "speedrun")) throw new Error("存档模式与请求不一致");
  if (typeof recordedChecksum !== "string" || !/^[0-9a-f]{8}$/.test(recordedChecksum)) throw new Error("主存档 checksum 格式无效");
  const computedChecksum = checksumRange(formatVersion, raw, stateRange);
  if (computedChecksum !== recordedChecksum) throw new Error("主存档 checksum 校验失败");

  const state = objectPropertyRanges(raw, stateRange).properties;
  const stateMode = parseScalar(raw, requiredRange(state, "mode"));
  const stateVersion = finiteInteger(parseScalar(raw, requiredRange(state, "version")), "GameState.version");
  if (stateMode !== mode || stateVersion !== WINDOWS_119_GAME_STATE_VERSION) {
    throw new Error("主存档不是 1.1.9 的 GameState v47");
  }
  const activePlanetId = parseScalar(raw, requiredRange(state, "activePlanetId"));
  if (typeof activePlanetId !== "string" || activePlanetId.length > 128) throw new Error("activePlanetId 无效");
  const research = objectPropertyRanges(raw, requiredRange(state, "research")).properties;
  const dysonSphere = objectPropertyRanges(raw, requiredRange(state, "dysonSphere")).properties;
  return {
    formatVersion,
    kind,
    savedAt,
    mode,
    slot,
    recordedChecksum,
    computedChecksum,
    state: {
      mode: stateMode,
      version: stateVersion,
      activePlanetId,
      entityCount: countArrayElements(raw, requiredRange(state, "entities")),
      beltCount: countArrayElements(raw, requiredRange(state, "belts")),
      elapsedSeconds: finiteNonNegativeFloor(parseScalar(raw, requiredRange(state, "elapsedSeconds")), "elapsedSeconds"),
      completedTechCount: countArrayElements(raw, requiredRange(research, "completedTechIds")),
      structurePoints: finiteInteger(parseScalar(raw, requiredRange(dysonSphere, "structurePoints")), "structurePoints"),
    },
  };
}

export function computeChunkRootChecksum(chunks) {
  const material = chunks.map((chunk) => `${chunk.id}:${chunk.kind}:${chunk.offset}:${chunk.count}:${chunk.checksum}:${chunk.bytes};`).join("");
  return computePayloadTextIdentity(material).checksum;
}

export function parseWindows119ChunkedManifest(raw, expectedMode) {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("1.1.9 sidecar manifest 为空");
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("1.1.9 sidecar manifest 不是合法 JSON"); }
  if (!isRecord(value) || value.formatVersion !== 1 || value.envelopeFormatVersion !== 2 ||
    value.mode !== expectedMode || value.slot !== "main" || value.stateVersion !== WINDOWS_119_GAME_STATE_VERSION ||
    !Number.isSafeInteger(value.savedAt) || value.savedAt < 0 ||
    typeof value.basePrimaryChecksum !== "string" || !/^[0-9a-f]{8}$/.test(value.basePrimaryChecksum) ||
    typeof value.chunkRootChecksum !== "string" || !/^[0-9a-f]{8}$/.test(value.chunkRootChecksum) ||
    !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 ||
    !Number.isSafeInteger(value.entityCount) || value.entityCount < 0 || value.entityCount > MAX_COLLECTION_LENGTH ||
    !Number.isSafeInteger(value.beltCount) || value.beltCount < 0 || value.beltCount > MAX_COLLECTION_LENGTH ||
    !Array.isArray(value.chunks) || value.chunks.length < 1 || value.chunks.length > MAX_MANIFEST_CHUNKS) {
    throw new Error("1.1.9 sidecar manifest 结构无效");
  }
  const chunks = value.chunks.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length < 1 || candidate.id.length > 512 ||
      !["base", "entities", "belts"].includes(candidate.kind) ||
      !Number.isSafeInteger(candidate.offset) || candidate.offset < 0 ||
      !Number.isSafeInteger(candidate.count) || candidate.count < 0 ||
      typeof candidate.checksum !== "string" || !/^[0-9a-f]{8}$/.test(candidate.checksum) ||
      !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0) {
      throw new Error("1.1.9 sidecar chunk 元数据无效");
    }
    return {
      id: candidate.id,
      kind: candidate.kind,
      offset: candidate.offset,
      count: candidate.count,
      checksum: candidate.checksum,
      bytes: candidate.bytes,
    };
  });
  if (new Set(chunks.map((chunk) => chunk.id)).size !== chunks.length || chunks.filter((chunk) => chunk.kind === "base").length !== 1) {
    throw new Error("1.1.9 sidecar chunk ID 重复或 base 数量错误");
  }
  if (computeChunkRootChecksum(chunks) !== value.chunkRootChecksum) throw new Error("1.1.9 sidecar 根校验失败");
  const summedBytes = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
  if (!Number.isSafeInteger(summedBytes) || summedBytes !== value.totalBytes) throw new Error("1.1.9 sidecar 总字节数不一致");
  const base = chunks.find((chunk) => chunk.kind === "base");
  if (!base || base.offset !== 0 || base.count !== 1) throw new Error("1.1.9 sidecar base 元数据无效");
  return { ...value, chunks };
}

function validateCollectionCoverage(chunks, kind, total) {
  const selected = chunks.filter((chunk) => chunk.kind === kind).sort((left, right) => left.offset - right.offset);
  if (selected.length === 0) throw new Error(`1.1.9 sidecar 缺少 ${kind} 区块`);
  let cursor = 0;
  for (const chunk of selected) {
    if (chunk.offset !== cursor) throw new Error(`1.1.9 sidecar ${kind} 区块存在空洞或重叠`);
    if (total > 0 && chunk.count === 0) throw new Error(`1.1.9 sidecar ${kind} 区块长度为零`);
    cursor += chunk.count;
    if (!Number.isSafeInteger(cursor) || cursor > total) throw new Error(`1.1.9 sidecar ${kind} 区块越界`);
  }
  if (cursor !== total) throw new Error(`1.1.9 sidecar ${kind} 区块未覆盖完整集合`);
  return selected;
}

function summarizeRestoredBase(base, manifest, checksum) {
  if (!isRecord(base) || base.version !== WINDOWS_119_GAME_STATE_VERSION || base.mode !== manifest.mode ||
    typeof base.activePlanetId !== "string" || base.activePlanetId.length > 128 || "entities" in base || "belts" in base ||
    !isRecord(base.research) || !Array.isArray(base.research.completedTechIds) || !isRecord(base.dysonSphere)) {
    throw new Error("1.1.9 sidecar 重建出的 GameState v47 结构无效");
  }
  return {
    formatVersion: WINDOWS_119_EXPORT_FORMAT_VERSION,
    kind: "primary",
    savedAt: manifest.savedAt,
    mode: manifest.mode,
    slot: "main",
    recordedChecksum: checksum,
    computedChecksum: checksum,
    state: {
      mode: base.mode,
      version: base.version,
      activePlanetId: base.activePlanetId,
      entityCount: manifest.entityCount,
      beltCount: manifest.beltCount,
      elapsedSeconds: finiteNonNegativeFloor(base.elapsedSeconds, "elapsedSeconds"),
      completedTechCount: base.research.completedTechIds.length,
      structurePoints: finiteInteger(base.dysonSphere.structurePoints, "structurePoints"),
    },
  };
}

function collectionSegments(chunkTexts) {
  const segments = ["["];
  let hasValues = false;
  for (const text of chunkTexts) {
    const inner = text.slice(1, -1);
    if (inner.length === 0) continue;
    if (hasValues) segments.push(",");
    segments.push(inner);
    hasValues = true;
  }
  segments.push("]");
  return segments;
}

/**
 * Materialize the latest valid 1.1.9 save. A corrupt/incomplete sidecar falls
 * back to the checksum-valid full primary, exactly like the game loader.
 */
export async function materializeWindows119Save({ baseRaw, mode = "normal", readInternalRecord }) {
  const primaryInspection = inspectWindows119Envelope(baseRaw, mode);
  const manifestKey = chunkedManifestKey(mode);
  const manifestRaw = await readInternalRecord(manifestKey);
  if (manifestRaw === null) {
    return { source: "primary", segments: [baseRaw], inspection: primaryInspection, warnings: [] };
  }

  try {
    const manifest = parseWindows119ChunkedManifest(manifestRaw, mode);
    if (manifest.basePrimaryChecksum !== primaryInspection.recordedChecksum) {
      throw new Error("1.1.9 sidecar 与完整主档 checksum 不匹配");
    }
    const entityChunks = validateCollectionCoverage(manifest.chunks, "entities", manifest.entityCount);
    const beltChunks = validateCollectionCoverage(manifest.chunks, "belts", manifest.beltCount);
    const baseMetadata = manifest.chunks.find((chunk) => chunk.kind === "base");
    const readAndVerify = async (metadata) => {
      const text = await readInternalRecord(chunkedRecordKey(mode, metadata.id));
      if (text === null) throw new Error(`1.1.9 sidecar 缺少区块 ${metadata.id}`);
      const identity = computePayloadTextIdentity(text);
      if (identity.checksum !== metadata.checksum || identity.byteLength !== metadata.bytes) {
        throw new Error(`1.1.9 sidecar 区块校验失败：${metadata.id}`);
      }
      return text;
    };

    const baseText = await readAndVerify(baseMetadata);
    let base;
    try { base = JSON.parse(baseText); } catch { throw new Error("1.1.9 sidecar base 不是合法 JSON"); }
    if (!isRecord(base)) throw new Error("1.1.9 sidecar base 不是对象");
    const baseJson = JSON.stringify(base);
    const readCollectionChunks = async (chunks) => {
      const texts = [];
      for (const metadata of chunks) {
        const text = await readAndVerify(metadata);
        let values;
        try { values = JSON.parse(text); } catch { throw new Error(`1.1.9 sidecar 区块不是合法 JSON：${metadata.id}`); }
        if (!Array.isArray(values) || values.length !== metadata.count) throw new Error(`1.1.9 sidecar 区块长度不一致：${metadata.id}`);
        texts.push(JSON.stringify(values));
      }
      return texts;
    };
    const entityTexts = await readCollectionChunks(entityChunks);
    const beltTexts = await readCollectionChunks(beltChunks);
    const baseInterior = baseJson.slice(1, -1);
    const stateSegments = ["{"];
    if (baseInterior.length > 0) stateSegments.push(baseInterior, ",");
    stateSegments.push("\"entities\":", ...collectionSegments(entityTexts), ",\"belts\":", ...collectionSegments(beltTexts), "}");
    const checksum = computeSaveStateChecksumFromSegments(WINDOWS_119_EXPORT_FORMAT_VERSION, stateSegments);
    const prefix = `{"formatVersion":2,"kind":"primary","mode":${JSON.stringify(mode)},"slot":"main","savedAt":${manifest.savedAt},"state":`;
    const suffix = `,"checksum":${JSON.stringify(checksum)}}`;
    const inspection = summarizeRestoredBase(base, manifest, checksum);
    return { source: "chunked-sidecar", segments: [prefix, ...stateSegments, suffix], inspection, warnings: [] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "未知 sidecar 错误";
    return {
      source: "primary",
      segments: [baseRaw],
      inspection: primaryInspection,
      warnings: [`检测到 1.1.9 分块 sidecar，但无法完整验证；已导出较旧的完整主档：${reason}`],
    };
  }
}

export function joinMaterializedSave(materialized) {
  return materialized.segments.join("");
}

async function writeChunk(stream, value) {
  if (stream.write(value, "utf8")) return;
  await once(stream, "drain");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function sha256GunzipFile(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath).pipe(createGunzip())) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Write verified segments to a new file without overwriting an existing export. */
export async function writeMaterializedSave(materialized, outputPath) {
  const gzip = outputPath.toLowerCase().endsWith(".json.gz");
  if (!gzip && !outputPath.toLowerCase().endsWith(".json")) throw new Error("输出文件必须以 .json 或 .json.gz 结尾");
  try {
    await access(outputPath, fsConstants.F_OK);
    throw new Error(`输出文件已存在，未覆盖：${outputPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${outputPath}.${process.pid}-${Date.now()}.part`;
  const uncompressedHash = createHash("sha256");
  let uncompressedBytes = 0;
  try {
    const destination = createWriteStream(temporaryPath, { flags: "wx" });
    const writer = gzip ? createGzip({ level: 9 }) : destination;
    const completion = gzip
      ? new Promise((resolve, reject) => {
        writer.pipe(destination);
        destination.on("finish", resolve);
        destination.on("error", reject);
        writer.on("error", reject);
      })
      : new Promise((resolve, reject) => {
        destination.on("finish", resolve);
        destination.on("error", reject);
      });
    for (const segment of materialized.segments) {
      const bytes = Buffer.from(segment, "utf8");
      uncompressedHash.update(bytes);
      uncompressedBytes += bytes.length;
      await writeChunk(writer, segment);
    }
    writer.end();
    await completion;
    const handle = await open(temporaryPath, "r+");
    try { await handle.sync(); } finally { await handle.close(); }

    const expected = { sha256: uncompressedHash.digest("hex"), bytes: uncompressedBytes };
    const verified = gzip ? await sha256GunzipFile(temporaryPath) : await sha256File(temporaryPath);
    if (verified.sha256 !== expected.sha256 || verified.bytes !== expected.bytes) throw new Error("导出文件落盘读回校验失败");
    const packaged = await sha256File(temporaryPath);
    try {
      await link(temporaryPath, outputPath);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`输出文件已存在，未覆盖：${outputPath}`);
      await copyFile(temporaryPath, outputPath, fsConstants.COPYFILE_EXCL);
    }
    const outputHandle = await open(outputPath, "r+");
    try { await outputHandle.sync(); } finally { await outputHandle.close(); }
    await rm(temporaryPath, { force: true });
    return {
      outputPath,
      gzip,
      byteLength: packaged.bytes,
      sha256: packaged.sha256,
      uncompressedByteLength: expected.bytes,
      uncompressedSha256: expected.sha256,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readExtractedRecord(recordIndex, key) {
  const entry = recordIndex.get(key);
  if (!entry?.found || !entry.path) return null;
  return readFile(entry.path, "utf8");
}
