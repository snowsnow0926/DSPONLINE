#!/usr/bin/env node

import process from "node:process";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import {
  chunkedManifestKey,
  materializeWindows119Save,
  primaryKeyForMode,
  readExtractedRecord,
  writeMaterializedSave,
} from "./windows-119-save-export-lib.mjs";
import { extractWindows119RecordsInPage } from "./windows-119-save-reader.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const readerPagePath = join(scriptDirectory, "windows-119-save-reader.html");
const STORAGE_DIRECTORIES = ["IndexedDB", "Local Storage"];

function usage() {
  return [
    "DSP 极简网络 1.1.9 Windows 离线存档导出器",
    "",
    "用法：",
    "  npm run save:export:windows119 -- [选项]",
    "  node scripts/export-windows-119-save.mjs [选项]",
    "",
    "选项：",
    "  --profile <目录>   Electron 用户数据目录",
    "                     默认：%APPDATA%\\dsp-idle-network",
    "  --output <文件>    新建的 .json.gz（推荐）或 .json 文件",
    "  --mode <模式>      normal（默认）或 speedrun",
    "  --help             显示帮助",
    "",
    "运行前必须完全退出 DSP 极简网络。工具只读取存档目录的临时副本，且绝不覆盖已有导出文件。",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { profilePath: null, outputPath: null, mode: "normal", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const nextValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少参数`);
      index += 1;
      return value;
    };
    if (argument === "--profile") options.profilePath = nextValue();
    else if (argument === "--output") options.outputPath = nextValue();
    else if (argument === "--mode") options.mode = nextValue();
    else throw new Error(`未知参数：${argument}`);
  }
  if (options.mode !== "normal" && options.mode !== "speedrun") throw new Error("--mode 只能是 normal 或 speedrun");
  return options;
}

function defaultProfilePath() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("找不到 APPDATA；请用 --profile 指定 1.1.9 的 Electron 用户数据目录");
  return join(appData, "dsp-idle-network");
}

function timestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function defaultOutputPath(mode) {
  return resolve(`DSPidle-1.1.9-${mode}-${timestampForFilename()}.json.gz`);
}

function isWithin(parentPath, candidatePath) {
  const result = relative(resolve(parentPath), resolve(candidatePath));
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

async function statDirectory(path, label) {
  let value;
  try { value = await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label}不存在：${path}`);
    throw error;
  }
  if (!value.isDirectory()) throw new Error(`${label}不是目录：${path}`);
  if (value.isSymbolicLink()) throw new Error(`${label}不能是符号链接：${path}`);
}

async function walkStorageTree(rootPath, relativePath, records) {
  const absolutePath = relativePath ? join(rootPath, relativePath) : rootPath;
  const metadata = await lstat(absolutePath, { bigint: true });
  if (metadata.isSymbolicLink()) throw new Error(`存档目录含符号链接，已拒绝读取：${absolutePath}`);
  const normalized = relativePath.split(sep).join("/");
  if (metadata.isDirectory()) {
    records.push(`d\0${normalized}\0${metadata.mtimeNs}`);
    const children = await readdir(absolutePath);
    children.sort((left, right) => left.localeCompare(right, "en"));
    for (const child of children) await walkStorageTree(rootPath, join(relativePath, child), records);
    return;
  }
  if (!metadata.isFile()) throw new Error(`存档目录含不支持的文件类型：${absolutePath}`);
  records.push(`f\0${normalized}\0${metadata.size}\0${metadata.mtimeNs}`);
}

export async function fingerprintWindows119Storage(profilePath) {
  const records = [];
  const present = [];
  for (const name of STORAGE_DIRECTORIES) {
    const storagePath = join(profilePath, name);
    try {
      const metadata = await lstat(storagePath);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`存档存储路径类型异常：${storagePath}`);
      present.push(name);
      await walkStorageTree(profilePath, name, records);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (present.length === 0) {
    throw new Error(`目录中没有 IndexedDB 或 Local Storage，可能不是 1.1.9 的用户数据目录：${profilePath}`);
  }
  const hash = createHash("sha256");
  for (const record of records) hash.update(record).update("\n");
  return { sha256: hash.digest("hex"), entryCount: records.length, directories: present };
}

async function assertGameIsClosed() {
  if (process.platform !== "win32") return;
  const command = [
    "$running = Get-Process -Name 'DSP极简网络' -ErrorAction SilentlyContinue | Select-Object -First 1;",
    "if ($null -ne $running) { [Console]::Out.Write('RUNNING') }",
  ].join(" ");
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    }));
  } catch (error) {
    throw new Error(`无法确认游戏是否已经退出：${error instanceof Error ? error.message : String(error)}`);
  }
  if (stdout.includes("RUNNING")) throw new Error("检测到 DSP 极简网络仍在运行。请完全退出游戏后再导出，避免复制到半写入存档");
}

async function copyStorageSnapshot(sourceProfilePath, browserUserDataPath) {
  const defaultProfilePath = join(browserUserDataPath, "Default");
  await mkdir(defaultProfilePath, { recursive: true });
  for (const name of STORAGE_DIRECTORIES) {
    const source = join(sourceProfilePath, name);
    try {
      const metadata = await lstat(source);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`存档存储路径类型异常：${source}`);
      await cp(source, join(defaultProfilePath, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

class ExtractedRecordSink {
  constructor(directoryPath) {
    this.directoryPath = directoryPath;
    this.index = new Map();
    this.active = null;
  }

  async accept(event) {
    if (!event || typeof event !== "object" || typeof event.type !== "string" ||
      typeof event.label !== "string" || !/^(?:primary|manifest|chunk-\d{4})$/.test(event.label) ||
      (typeof event.key !== "string" && event.type !== "chunk")) {
      throw new Error("浏览器返回了无效的存档读取事件");
    }
    if (event.type === "missing" || event.type === "invalid") {
      if (this.active || this.index.has(event.key)) throw new Error("存档读取事件顺序无效");
      this.index.set(event.key, { found: false, status: event.type, label: event.label, path: null });
      return;
    }
    if (event.type === "start") {
      if (this.active || this.index.has(event.key) || !Number.isSafeInteger(event.charLength) || event.charLength < 0) {
        throw new Error("存档记录开始事件无效");
      }
      const path = join(this.directoryPath, `${event.label}.txt`);
      const handle = await open(path, "wx");
      this.active = { label: event.label, key: event.key, path, handle, charLength: event.charLength, receivedChars: 0 };
      return;
    }
    if (event.type === "chunk") {
      if (!this.active || this.active.label !== event.label || typeof event.value !== "string") {
        throw new Error("存档记录分片事件无效");
      }
      await this.active.handle.writeFile(event.value, "utf8");
      this.active.receivedChars += event.value.length;
      return;
    }
    if (event.type === "end") {
      if (!this.active || this.active.label !== event.label || this.active.key !== event.key ||
        event.charLength !== this.active.charLength || this.active.receivedChars !== this.active.charLength) {
        throw new Error("存档记录结束事件无效");
      }
      const completed = this.active;
      this.active = null;
      await completed.handle.sync();
      await completed.handle.close();
      this.index.set(completed.key, { found: true, status: "found", label: completed.label, path: completed.path });
      return;
    }
    throw new Error(`未知存档读取事件：${event.type}`);
  }

  async closeAfterFailure() {
    if (!this.active) return;
    const active = this.active;
    this.active = null;
    await active.handle.close().catch(() => undefined);
  }
}

async function loadChromium() {
  try {
    const playwright = await import("@playwright/test");
    return playwright.chromium;
  } catch (error) {
    throw new Error(`缺少 Playwright Chromium 运行环境；请先在项目中执行 npm ci：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function extractSnapshotRecords({ browserUserDataPath, extractedRecordsPath, mode, chromium }) {
  const sink = new ExtractedRecordSink(extractedRecordsPath);
  let context = null;
  try {
    context = await chromium.launchPersistentContext(browserUserDataPath, {
      headless: true,
      acceptDownloads: false,
      serviceWorkers: "block",
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-domain-reliability",
        "--disable-features=OptimizationHints,MediaRouter",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run",
        "--safebrowsing-disable-auto-update",
      ],
    });
    await context.route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
    await context.exposeBinding("__dspWindows119Record", async (_source, event) => sink.accept(event));
    const pages = context.pages();
    const page = pages[0] ?? await context.newPage();
    await page.goto(pathToFileURL(readerPagePath).href, { waitUntil: "load" });
    const report = await page.evaluate(extractWindows119RecordsInPage, { mode });
    return { report, recordIndex: sink.index };
  } catch (error) {
    await sink.closeAfterFailure();
    throw error;
  } finally {
    await context?.close().catch(() => undefined);
  }
}

function assertUnchanged(before, after, phase) {
  if (before.sha256 !== after.sha256 || before.entryCount !== after.entryCount) {
    throw new Error(`源存档在${phase}发生变化，已中止导出。请确认游戏完全退出后重试`);
  }
}

export async function exportWindows119Save({
  profilePath = defaultProfilePath(),
  outputPath = null,
  mode = "normal",
  chromium = null,
  skipProcessCheck = false,
} = {}) {
  if (mode !== "normal" && mode !== "speedrun") throw new Error("存档模式必须是 normal 或 speedrun");
  const requestedProfilePath = resolve(profilePath);
  await statDirectory(requestedProfilePath, "用户数据目录");
  const sourceProfilePath = await realpath(requestedProfilePath);
  const requestedOutputPath = resolve(outputPath ?? defaultOutputPath(mode));
  const lowerOutput = requestedOutputPath.toLowerCase();
  if (!lowerOutput.endsWith(".json") && !lowerOutput.endsWith(".json.gz")) {
    throw new Error("输出文件必须以 .json 或 .json.gz 结尾");
  }
  await mkdir(dirname(requestedOutputPath), { recursive: true });
  const outputDirectoryPath = await realpath(dirname(requestedOutputPath));
  const resolvedOutputPath = join(outputDirectoryPath, basename(requestedOutputPath));
  if (isWithin(sourceProfilePath, resolvedOutputPath)) throw new Error("输出文件不能放在游戏用户数据目录内");
  if (!skipProcessCheck) await assertGameIsClosed();

  const sourceBefore = await fingerprintWindows119Storage(sourceProfilePath);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "dspidle119-export-"));
  const browserUserDataPath = join(temporaryRoot, "browser-user-data");
  const extractedRecordsPath = join(temporaryRoot, "records");
  await mkdir(extractedRecordsPath, { recursive: true });
  try {
    await copyStorageSnapshot(sourceProfilePath, browserUserDataPath);
    const sourceAfterCopy = await fingerprintWindows119Storage(sourceProfilePath);
    assertUnchanged(sourceBefore, sourceAfterCopy, "创建只读快照时");
    if (!skipProcessCheck) await assertGameIsClosed();

    const browserType = chromium ?? await loadChromium();
    const extracted = await extractSnapshotRecords({ browserUserDataPath, extractedRecordsPath, mode, chromium: browserType });
    const primaryKey = primaryKeyForMode(mode);
    const primaryEntry = extracted.recordIndex.get(primaryKey);
    if (primaryEntry?.status === "invalid") throw new Error("IndexedDB 中的 1.1.9 主存档记录结构损坏，未导出");
    let baseRaw = await readExtractedRecord(extracted.recordIndex, primaryKey);
    if (baseRaw === null) {
      throw new Error(`没有找到 ${mode === "normal" ? "普通模式" : "无限矿物速通模式"}主存档：${primaryKey}`);
    }
    const materialized = await materializeWindows119Save({
      baseRaw,
      mode,
      readInternalRecord: (key) => readExtractedRecord(extracted.recordIndex, key),
    });
    baseRaw = null;
    const manifestEntry = extracted.recordIndex.get(chunkedManifestKey(mode));
    if (manifestEntry?.status === "invalid") {
      materialized.warnings.push("IndexedDB 中的 1.1.9 分块 manifest 记录结构损坏；已忽略它并导出完整主档");
    }

    const sourceBeforeWrite = await fingerprintWindows119Storage(sourceProfilePath);
    assertUnchanged(sourceBefore, sourceBeforeWrite, "解析快照期间");
    if (!skipProcessCheck) await assertGameIsClosed();
    const written = await writeMaterializedSave(materialized, resolvedOutputPath);
    const sourceAfterWrite = await fingerprintWindows119Storage(sourceProfilePath);
    try {
      assertUnchanged(sourceBefore, sourceAfterWrite, "写出导出文件期间");
    } catch (error) {
      await rm(resolvedOutputPath, { force: true });
      throw new Error(`${error instanceof Error ? error.message : String(error)}；本次新建的导出文件已删除`);
    }

    return {
      ...written,
      profilePath: sourceProfilePath,
      mode,
      saveSource: materialized.source,
      inspection: materialized.inspection,
      warnings: materialized.warnings,
      sourceFingerprint: sourceAfterWrite.sha256,
      copiedStorageDirectories: sourceBefore.directories,
      databaseFound: extracted.report.databaseFound,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  let options;
  try { options = parseArguments(process.argv.slice(2)); } catch (error) {
    console.error(`参数错误：${error instanceof Error ? error.message : String(error)}\n`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const result = await exportWindows119Save({
      profilePath: options.profilePath ?? defaultProfilePath(),
      outputPath: options.outputPath,
      mode: options.mode,
    });
    console.log("1.1.9 Windows 存档离线导出成功");
    console.log(`输出：${result.outputPath}`);
    console.log(`模式：${result.mode}；来源：${result.saveSource === "chunked-sidecar" ? "最新分块存档" : "完整主档"}`);
    console.log(`状态：GameState v${result.inspection.state.version}；建筑 ${result.inspection.state.entityCount}；传送带 ${result.inspection.state.beltCount}`);
    console.log(`文件：${result.byteLength} B；SHA-256 ${result.sha256}`);
    console.log(`源目录保持不变：${result.sourceFingerprint}`);
    for (const warning of result.warnings) console.warn(`警告：${warning}`);
  } catch (error) {
    console.error(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
