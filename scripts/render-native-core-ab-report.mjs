#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";

const LABELS = {
  openDurationMs: "原生核心打开",
  openPrivateBytesDelta: "打开后 Private Bytes 增量",
  openPeakPrivateBytes: "打开期间 Private Bytes 峰值",
  openPeakPrivateBytesDelta: "打开期间峰值增量",
  commandDurationMs: "命令补丁",
  commandPrivateBytesDelta: "命令 Private Bytes 增量",
  nativeAdvanceDurationMs: "非诊断精确推进 1 模拟秒",
  nativeAdvancePeakPrivateBytes: "精确推进期间 Private Bytes 峰值",
  nativeAdvancePeakPrivateBytesDelta: "精确推进期间峰值增量",
  nativeBurst3DurationMs: "连续 3×1 秒原生推进",
  nativeBurst3PeakPrivateBytes: "连续推进期间 Private Bytes 峰值",
  nativeBurst3PeakPrivateBytesDelta: "连续推进期间峰值增量",
  nativeMeasuredWorkflowPeakPrivateBytes: "已测打开/单步/连续推进总峰值",
  javascriptAdvanceDurationMs: "JavaScript 对照推进 1 模拟秒",
  deferredDiagnosticsDurationMs: "延迟规范证明",
  cachedDiagnosticsDurationMs: "缓存规范证明",
  integratedAdvanceAndProofDurationMs: "精确推进＋规范证明",
  cachedIntegratedStatusDurationMs: "集成后缓存状态",
  durableAuthorityDurationMs: "WAL 持久权威推进＋证明",
  durableAuthorityPrivateBytesDelta: "持久推进 Private Bytes 增量",
  durableDuplicateRetryDurationMs: "WAL 幂等重试",
  incrementalCheckpointDurationMs: "增量 checkpoint",
  incrementalCheckpointChangedBytes: "增量 checkpoint 改变字节",
};

const BYTE_METRICS = new Set([
  "openPrivateBytesDelta",
  "openPeakPrivateBytes",
  "openPeakPrivateBytesDelta",
  "commandPrivateBytesDelta",
  "durableAuthorityPrivateBytesDelta",
  "nativeAdvancePeakPrivateBytes",
  "nativeAdvancePeakPrivateBytesDelta",
  "nativeBurst3PeakPrivateBytes",
  "nativeBurst3PeakPrivateBytesDelta",
  "nativeMeasuredWorkflowPeakPrivateBytes",
  "incrementalCheckpointChangedBytes",
]);

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/render-native-core-ab-report.mjs --input <absolute-json> --output <absolute-md> [--force]");
}

function parseArgs(argv) {
  const result = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--force") {
      result.force = true;
      continue;
    }
    if (!new Set(["--input", "--output"]).has(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    result[argument.slice(2)] = value;
    index += 1;
  }
  for (const key of ["input", "output"]) {
    if (!result[key]) throw new Error(`Missing required --${key}`);
    if (!path.isAbsolute(result[key])) throw new Error(`--${key} must be an absolute path`);
    result[key] = path.normalize(result[key]);
  }
  return result;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatMetric(name, value) {
  const number = finite(value);
  if (number === null) return "—";
  if (BYTE_METRICS.has(name)) return `${(number / 1024 / 1024).toFixed(2)} MiB`;
  return `${number.toFixed(2)} ms`;
}

function formatPercent(value) {
  const number = finite(value);
  return number === null ? "—" : `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function formatRatio(value) {
  const number = finite(value);
  return number === null ? "—" : `${number.toFixed(3)}×`;
}

function assertReport(report) {
  if (report?.schemaVersion !== 1 || report?.benchmark !== "native-core-real-save-interleaved-ab") {
    throw new Error("Input is not a native-core interleaved A/B report");
  }
  if (report.fixture?.unchanged !== true) throw new Error("Benchmark fixture identity was not preserved");
  const requiredValidation = [
    "allProcessesExitedZero",
    "allOpenRoundTripsExact",
    "allNativeAdvancesMatchJavascript",
    "allIntegratedProofsExact",
    "allDurableAuthorityCommitsExactAndIdempotent",
    "allIncrementalCheckpointsExact",
    "allBackToBackNativeBurstsExact",
    "allWindowsPrivatePeakSamplesValid",
  ];
  const failed = requiredValidation.filter((key) => report.validation?.[key] !== true);
  if (failed.length) throw new Error(`A/B correctness validation is incomplete: ${failed.join(", ")}`);
  if (!report.binaries?.baseline?.sha256 || !report.binaries?.candidate?.sha256) {
    throw new Error("A/B binary identities are missing");
  }
  if (!report.summary?.baseline || !report.summary?.candidate || !report.comparison) {
    throw new Error("A/B summary is missing");
  }
}

function render(report, inputPath) {
  const rows = Object.keys(LABELS).map((name) => {
    const baseline = report.summary.baseline[name] ?? {};
    const candidate = report.summary.candidate[name] ?? {};
    const comparison = report.comparison[name];
    return `| ${LABELS[name]} | ${formatMetric(name, baseline.median)} | ${formatMetric(name, baseline.p95NearestRank)} | ${formatMetric(name, candidate.median)} | ${formatMetric(name, candidate.p95NearestRank)} | ${formatRatio(comparison?.baselineOverCandidate)} | ${formatPercent(comparison?.candidateReductionPercent)} |`;
  });
  const order = report.command.order.join(" → ");
  const baseline = report.binaries.baseline;
  const candidate = report.binaries.candidate;
  const fixture = report.fixture.before;
  return `# DSP极简网络 Windows 原生核心新旧版 A/B 实测报告

- 生成时间：${report.generatedAt}
- 原始机器报告：\`${inputPath}\`
- 口径：旧/新交错运行，每个二进制 ${report.command.runsPerBinary} 个样本；报告中 P95 使用 nearest-rank。
- 运行顺序：${order}
- 线程设置：\`${report.command.threads}\`

## 正确性与数据保护

- 所有进程均正常退出，打开 round-trip、精确推进、集成证明、WAL 持久提交和增量 checkpoint 全部通过。
- Windows Native Host 的 Private Bytes 峰值由独立采样器按样本记录，报告绝对峰值及相对操作开始时的增量；采样失败不会生成通过报告。
- 每次 Rust 推进都与 JavaScript 权威状态 canonical SHA-256 完全一致；没有放宽误差或只比较显示数字。
- 测试存档前后 SHA-256、大小和修改时间一致：\`${fixture.sha256}\`（${fixture.sizeBytes.toLocaleString("en-US")} B）。
- 测试只读，不连接生产服务器、不上传云端、不修改真实玩家档。

## 构建与机器身份

| 项目 | 旧版 | 新版 |
| --- | --- | --- |
| Host SHA-256 | \`${baseline.sha256}\` | \`${candidate.sha256}\` |
| Host 大小 | ${baseline.sizeBytes.toLocaleString("en-US")} B | ${candidate.sizeBytes.toLocaleString("en-US")} B |

- 系统：${report.host.platform}-${report.host.arch}，Node ${report.host.node}
- CPU：${report.host.cpuModel}（${report.host.cpuCount} logical processors）
- 内存：${(report.host.totalMemoryBytes / 1024 / 1024 / 1024).toFixed(2)} GiB

## 真实存档结果

| 指标 | 旧版 median | 旧版 P95 | 新版 median | 新版 P95 | 旧/新倍数 | 新版降幅 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join("\n")}

正数“新版降幅”表示耗时或字节数下降；负数表示回退。样本量较小时 P95 会接近最大值，应结合原始样本和后台进程快照阅读，不把单次最好成绩当成结论。

## 边界

本报告只证明这台机器、这份存档和这些二进制的开发 A/B。它不能替代 24 小时长跑、低配/主流/高配三档硬件、GPU/远程桌面、Defender、签名安装、覆盖升级和灰度观察门禁。
`;
}

function writeAtomic(target, text, force) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  if (!force && fs.existsSync(target)) throw new Error(`Output already exists (pass --force): ${target}`);
  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
    if (force && fs.existsSync(target)) fs.rmSync(target);
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
  } else {
    if (!fs.existsSync(options.input) || !fs.statSync(options.input).isFile()) throw new Error(`Input is not a file: ${options.input}`);
    const report = JSON.parse(fs.readFileSync(options.input, "utf8"));
    assertReport(report);
    writeAtomic(options.output, render(report, options.input), options.force);
    console.log(options.output);
  }
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
