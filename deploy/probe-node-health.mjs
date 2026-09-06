import { connect as tlsConnect } from "node:tls";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function probeEndpoint(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetchImpl(url, { cache: "no-store", redirect: "follow", signal: controller.signal });
    const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
    await response.body?.cancel().catch(() => undefined);
    return {
      url: new URL(url).origin + new URL(url).pathname,
      ok: response.ok,
      status: response.status,
      latencyMs,
      contentEncoding: response.headers.get("content-encoding"),
    };
  } catch (error) {
    return {
      url: new URL(url).origin + new URL(url).pathname,
      ok: false,
      status: 0,
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error: error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

function nonNegativeNumber(value, fallback = 0, label = "value") {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

async function diskStatus(directory, minimumFreeRatio, reservedBytes = 0) {
  const stats = await statfs(directory);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 0;
  const reserved = nonNegativeNumber(reservedBytes, 0, "reservedBytes");
  const postReserveFreeBytes = freeBytes - reserved;
  const postReserveFreeRatio = totalBytes > 0 ? postReserveFreeBytes / totalBytes : 0;
  return {
    ok: freeRatio >= minimumFreeRatio && postReserveFreeRatio >= minimumFreeRatio,
    path: path.resolve(directory),
    totalBytes,
    freeBytes,
    freeRatio,
    reservedBytes: reserved,
    postReserveFreeBytes,
    postReserveFreeRatio,
  };
}

async function tlsStatus(host, port, minimumDays) {
  if (!host) return { configured: false, ok: true, daysRemaining: null };
  return new Promise((resolve) => {
    let settled = false;
    const socket = tlsConnect({ host, port, servername: host, rejectUnauthorized: true, timeout: 8_000 });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = () => { socket.destroy(); finish({ configured: true, ok: false, host, port, daysRemaining: null, error: "TLS probe failed" }); };
    socket.once("timeout", fail);
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const expiresAt = Date.parse(certificate.valid_to);
      const daysRemaining = Number.isFinite(expiresAt) ? Math.floor((expiresAt - Date.now()) / 86_400_000) : null;
      socket.end();
      finish({ configured: true, ok: daysRemaining !== null && daysRemaining >= minimumDays, host, port, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, daysRemaining });
    });
  });
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function sendAlert({ url, token, nodeId, status, fetchImpl }) {
  if (!url) return false;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      service: "dsp-idle",
      nodeId,
      checkedAt: status.checkedAt,
      ok: status.ok,
      failedChecks: status.failedChecks,
    }),
  });
  if (!response.ok) throw new Error(`alert webhook returned ${response.status}`);
  return true;
}

export async function probeNodeHealth({
  endpoints = [],
  dataDirectory,
  statusFile,
  nodeId = hostname(),
  tlsHost = "",
  tlsPort = 443,
  endpointTimeoutMs = 8_000,
  maximumLatencyMs = 3_000,
  minimumDiskFreeRatio = 0.15,
  reservedBytes = 0,
  minimumTlsDays = 14,
  alertWebhookUrl = "",
  alertWebhookToken = "",
  fetchImpl = fetch,
} = {}) {
  if (!dataDirectory || !statusFile) throw new Error("dataDirectory and statusFile are required");
  const checkedAt = Date.now();
  const normalizedEndpoints = endpoints.map((value) => value.trim()).filter(Boolean);
  const [endpointResults, disk, tls] = await Promise.all([
    Promise.all(normalizedEndpoints.map((url) => probeEndpoint(url, endpointTimeoutMs, fetchImpl))),
    diskStatus(path.resolve(dataDirectory), minimumDiskFreeRatio, reservedBytes),
    tlsStatus(tlsHost, Number(tlsPort), minimumTlsDays),
  ]);
  const failedChecks = [
    ...endpointResults.filter((entry) => !entry.ok || entry.latencyMs > maximumLatencyMs).map((entry) => `endpoint:${entry.url}`),
    ...(!disk.ok ? ["disk"] : []),
    ...(!tls.ok ? ["tls"] : []),
  ];
  const status = {
    ok: failedChecks.length === 0,
    checkedAt,
    nodeId: String(nodeId).slice(0, 80),
    failedChecks,
    endpoints: endpointResults,
    disk,
    tls,
    thresholds: { maximumLatencyMs, minimumDiskFreeRatio, reservedBytes: nonNegativeNumber(reservedBytes), minimumTlsDays },
  };
  let previous = null;
  try { previous = JSON.parse(await readFile(path.resolve(statusFile), "utf8")); } catch { /* first probe */ }
  if (!status.ok && (previous?.ok !== false || checkedAt - Number(previous?.checkedAt ?? 0) >= 6 * 60 * 60 * 1000)) {
    try { status.alertSent = await sendAlert({ url: alertWebhookUrl, token: alertWebhookToken, nodeId: status.nodeId, status, fetchImpl }); }
    catch { status.alertSent = false; }
  }
  await writeJson(path.resolve(statusFile), status);
  return status;
}

async function startFromCli() {
  const endpoints = (process.env.DSP_MONITOR_ENDPOINTS || "").split(",");
  const explicitReservedBytes = nonNegativeNumber(process.env.DSP_MONITOR_RESERVED_BYTES, 0, "DSP_MONITOR_RESERVED_BYTES");
  const estimatedBackupBytes = nonNegativeNumber(process.env.DSP_MONITOR_ESTIMATED_BACKUP_BYTES, 0, "DSP_MONITOR_ESTIMATED_BACKUP_BYTES");
  const backupCount = Math.floor(nonNegativeNumber(process.env.DSP_MONITOR_BACKUP_COUNT, 0, "DSP_MONITOR_BACKUP_COUNT"));
  const backupOverheadBytes = nonNegativeNumber(process.env.DSP_MONITOR_BACKUP_OVERHEAD_BYTES, 0, "DSP_MONITOR_BACKUP_OVERHEAD_BYTES");
  const reservedBytes = explicitReservedBytes > 0
    ? explicitReservedBytes
    : estimatedBackupBytes * backupCount + backupOverheadBytes;
  const result = await probeNodeHealth({
    endpoints,
    dataDirectory: process.env.DSP_MONITOR_DATA_DIRECTORY || "/var/lib/dsp-idle-cloud",
    statusFile: process.env.DSP_NODE_HEALTH_STATUS_FILE || "/var/lib/dsp-idle-cloud/node-health-status.json",
    nodeId: process.env.DSP_BACKUP_NODE_ID || hostname(),
    tlsHost: process.env.DSP_MONITOR_TLS_HOST || "",
    tlsPort: Number(process.env.DSP_MONITOR_TLS_PORT || 443),
    endpointTimeoutMs: Number(process.env.DSP_MONITOR_TIMEOUT_MS || 8_000),
    maximumLatencyMs: Number(process.env.DSP_MONITOR_MAX_LATENCY_MS || 3_000),
    minimumDiskFreeRatio: Number(process.env.DSP_MONITOR_MIN_DISK_FREE_RATIO || 0.15),
    reservedBytes,
    minimumTlsDays: Number(process.env.DSP_MONITOR_MIN_TLS_DAYS || 14),
    alertWebhookUrl: process.env.DSP_ALERT_WEBHOOK_URL || "",
    alertWebhookToken: process.env.DSP_ALERT_WEBHOOK_TOKEN || "",
  });
  console.log(JSON.stringify({ ok: result.ok, checkedAt: result.checkedAt, failedChecks: result.failedChecks }));
  if (!result.ok) process.exitCode = 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMainModule()) {
  startFromCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
