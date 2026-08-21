import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeLeaderboardReviewQueue,
  leaderboardReviewReport,
} from "./leaderboard-review.mjs";

const packageFile = fileURLToPath(new URL("./package.json", import.meta.url));
const Database = createRequire(packageFile)("better-sqlite3");
const DEFAULT_DATABASE_FILE = "/var/lib/dsp-idle-cloud/cloud.sqlite";
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5_000;
const DEFAULT_RETAIN = 30;
const MAX_RETAIN = 3_650;

function positiveLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(MAX_LIMIT, parsed)) : fallback;
}

function positiveRetention(value, fallback = DEFAULT_RETAIN) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(MAX_RETAIN, parsed)) : fallback;
}

function reportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Read only the durable app_state snapshot and project the pending review
 * queue.  The database is opened read-only and query_only is enabled before
 * any application data is decoded; this command can therefore be scheduled
 * beside the API writer without mutating player data.
 */
export function readLeaderboardReviewReport({
  databaseFile = process.env.DSP_CLOUD_DATABASE_FILE || DEFAULT_DATABASE_FILE,
  limit = DEFAULT_LIMIT,
  generatedAt = Date.now(),
} = {}) {
  if (typeof databaseFile !== "string" || databaseFile.length === 0) {
    throw reportError("LEADERBOARD_REVIEW_DATABASE_INVALID", "排行榜复核报告缺少数据库路径");
  }
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only = ON");
    const row = database.prepare("SELECT payload, updated_at AS updatedAt FROM app_state WHERE id = 1").get();
    if (!row?.payload) throw reportError("LEADERBOARD_REVIEW_STATE_MISSING", "云服务 app_state 不存在或为空");
    let data;
    try {
      data = JSON.parse(row.payload);
    } catch {
      throw reportError("LEADERBOARD_REVIEW_STATE_INVALID", "云服务 app_state 不是有效 JSON");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw reportError("LEADERBOARD_REVIEW_STATE_INVALID", "云服务 app_state 结构无效");
    }
    // The CLI intentionally does not boot the API (and therefore does not
    // run its full migration pipeline), so apply the same account-bound
    // queue normalization before projecting anything to an operator.
    const normalizedData = {
      ...data,
      leaderboardReviewQueue: normalizeLeaderboardReviewQueue(data.leaderboardReviewQueue, data.users),
    };
    const report = leaderboardReviewReport(normalizedData, {
      limit: positiveLimit(limit),
      generatedAt,
    });
    return {
      ...report,
      database: {
        schemaVersion: Number.isInteger(data.schemaVersion) ? data.schemaVersion : null,
        storageLayoutVersion: Number.isInteger(data.storageLayoutVersion) ? data.storageLayoutVersion : null,
        updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : null,
      },
      policy: {
        automaticRestriction: false,
        automaticSubmissionRemoval: false,
        manualActionRequired: true,
      },
    };
  } finally {
    database.close();
  }
}

async function atomicWriteJson(file, value) {
  const absolute = path.resolve(file);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
    await rename(temporary, absolute);
  } finally {
    try { await unlink(temporary); } catch { /* already renamed */ }
  }
  return absolute;
}

export async function writeLeaderboardReviewReport({
  report,
  output,
  outputDirectory,
  retain = DEFAULT_RETAIN,
} = {}) {
  if (!report || typeof report !== "object") throw reportError("LEADERBOARD_REVIEW_REPORT_INVALID", "排行榜复核报告为空");
  if (output && outputDirectory) throw reportError("LEADERBOARD_REVIEW_OUTPUT_AMBIGUOUS", "不能同时指定报告文件和目录");
  if (output) return { output: await atomicWriteJson(output, report), latest: null };
  if (!outputDirectory) return { output: null, latest: null };
  const directory = path.resolve(outputDirectory);
  const stamp = new Date(Number.isFinite(report.generatedAt) ? report.generatedAt : Date.now())
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(":", "");
  const outputFile = path.join(directory, `leaderboard-review-${stamp}.json`);
  const latestFile = path.join(directory, "leaderboard-review-latest.json");
  await atomicWriteJson(outputFile, report);
  await atomicWriteJson(latestFile, report);
  const reportFiles = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^leaderboard-review-\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const file of reportFiles.slice(positiveRetention(retain))) {
    try { await unlink(path.join(directory, file)); } catch { /* another run may have pruned it */ }
  }
  return { output: outputFile, latest: latestFile };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length || args[index + 1].startsWith("--")) return null;
  return args[index + 1];
}

function usage() {
  return "用法：node leaderboard-review-report.mjs [--database <cloud.sqlite>] [--limit <1-5000>] [--retain <1-3650>] [--output <report.json> | --output-directory <dir>]";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const databaseFile = optionValue(args, "--database") ?? process.env.DSP_CLOUD_DATABASE_FILE ?? DEFAULT_DATABASE_FILE;
  const output = optionValue(args, "--output");
  const outputDirectory = optionValue(args, "--output-directory");
  const report = readLeaderboardReviewReport({
    databaseFile,
    limit: positiveLimit(optionValue(args, "--limit")),
  });
  const written = await writeLeaderboardReviewReport({
    report,
    output,
    outputDirectory,
    retain: positiveRetention(optionValue(args, "--retain")),
  });
  process.stdout.write(`${JSON.stringify({ ...report, written }, null, 2)}\n`);
}

let isCli = false;
try {
  isCli = Boolean(process.argv[1])
    && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isCli = false;
}

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "LEADERBOARD_REVIEW_REPORT_FAILED"}: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
