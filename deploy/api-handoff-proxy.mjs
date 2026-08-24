import http from "node:http";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const API_PROXY_STATE_VERSION = 1;
export const API_PROXY_DEFAULT_HOST = "127.0.0.1";
export const API_PROXY_DEFAULT_PORT = 4330;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const ATOMIC_GET_PATHS = new Set([
  "/api/account/export",
  "/api/account/import/archive",
  "/api/admin/account",
  "/api/admin/cloud-history/prune-preview",
]);

function finiteInteger(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function normalizeHost(value) {
  const host = String(value ?? "").trim();
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("handoff proxy upstream must use a loopback address");
  }
  return host;
}

async function atomicRename(source, destination) {
  const retryable = new Set(["EACCES", "EBUSY", "EPERM"]);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!retryable.has(error?.code) || attempt >= 40) throw error;
      // Windows can briefly lock the destination while the proxy poller reads
      // it. Vary the delay so a writer does not repeatedly collide with the
      // fixed polling cadence; Linux keeps the same atomic rename behavior.
      const delayMs = Math.min(75, 5 + attempt * 2) + (attempt % 7);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function normalizeApiProxyState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("handoff proxy state must be an object");
  }
  if (value.version !== API_PROXY_STATE_VERSION) {
    throw new Error(`unsupported handoff proxy state version: ${value.version}`);
  }
  if (!["forward", "drain", "hold"].includes(value.mode)) {
    throw new Error(`unsupported handoff proxy mode: ${value.mode}`);
  }
  const upstream = value.upstream;
  if (!upstream || typeof upstream !== "object" || Array.isArray(upstream)) {
    throw new Error("handoff proxy upstream is required");
  }
  const releaseId = typeof upstream.releaseId === "string" && /^[A-Za-z0-9._+-]{1,128}$/.test(upstream.releaseId)
    ? upstream.releaseId
    : "unknown";
  const slot = typeof upstream.slot === "string" && /^(?:legacy|blue|green)$/.test(upstream.slot)
    ? upstream.slot
    : "legacy";
  return Object.freeze({
    version: API_PROXY_STATE_VERSION,
    generation: finiteInteger(value.generation, 1, Number.MAX_SAFE_INTEGER, "proxy state generation"),
    mode: value.mode,
    changedAt: Number.isFinite(value.changedAt) ? Math.max(0, Math.floor(value.changedAt)) : Date.now(),
    upstream: Object.freeze({
      host: normalizeHost(upstream.host),
      port: finiteInteger(upstream.port, 1, 65_535, "proxy upstream port"),
      slot,
      releaseId,
    }),
  });
}

async function writeFileAtomically(file, text, mode = 0o640) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(text, "utf8");
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await atomicRename(temporary, file);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readApiProxyState(file) {
  return normalizeApiProxyState(JSON.parse(await readFile(file, "utf8")));
}

export async function writeApiProxyState(file, value) {
  const state = normalizeApiProxyState(value);
  await writeFileAtomically(file, `${JSON.stringify(state)}\n`);
  return state;
}

export async function readApiProxyStatus(file) {
  const value = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || value.version !== API_PROXY_STATE_VERSION) {
    throw new Error("handoff proxy status is invalid");
  }
  return value;
}

export function requestRequiresWriter(method, requestUrl) {
  const normalizedMethod = String(method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) return true;
  let pathname = "/";
  try {
    pathname = new URL(requestUrl || "/", "http://localhost").pathname;
  } catch {
    return true;
  }
  return ATOMIC_GET_PATHS.has(pathname);
}

function sanitizedRequestHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) output[name] = value;
  }
  return output;
}

function sanitizedResponseHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) output[name] = value;
  }
  return output;
}

function sendProxyFailure(response, statusCode, code, message, retryAfter = 1) {
  if (response.headersSent || response.writableEnded) {
    if (!response.destroyed) response.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify({ error: message, code }));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    "retry-after": String(retryAfter),
    connection: "close",
  });
  response.end(body);
}

export function createApiHandoffProxy({
  stateFile,
  statusFile,
  host = API_PROXY_DEFAULT_HOST,
  port = API_PROXY_DEFAULT_PORT,
  pollIntervalMs = 25,
  queueLimit = 512,
  maximumHoldMs = 120_000,
  upstreamConnectTimeoutMs = 5_000,
  logger = console,
} = {}) {
  if (!stateFile || !statusFile) throw new Error("handoff proxy state and status files are required");
  const listenHost = normalizeHost(host);
  const listenPort = finiteInteger(port, 1, 65_535, "proxy listen port");
  const statePollMs = finiteInteger(pollIntervalMs, 10, 5_000, "proxy poll interval");
  const maximumQueue = finiteInteger(queueLimit, 1, 10_000, "proxy queue limit");
  const holdLimitMs = finiteInteger(maximumHoldMs, 1_000, 10 * 60_000, "proxy maximum hold time");
  const connectTimeoutMs = finiteInteger(upstreamConnectTimeoutMs, 100, 60_000, "upstream connect timeout");
  const agent = new http.Agent({ keepAlive: true, maxSockets: 512, maxFreeSockets: 32 });
  const queued = [];
  const counters = {
    acceptedRequests: 0,
    completedRequests: 0,
    failedRequests: 0,
    retriedRequests: 0,
    expiredRequests: 0,
    rejectedRequests: 0,
  };
  let state = null;
  let activeRequests = 0;
  let activeWriterRequests = 0;
  let pollTimer = null;
  let statusTimer = null;
  let statusWrite = Promise.resolve();
  let applyingState = false;
  let closing = false;

  const statusValue = () => ({
    version: API_PROXY_STATE_VERSION,
    pid: process.pid,
    listening: server.listening,
    host: listenHost,
    port: listenPort,
    generation: state?.generation ?? 0,
    mode: state?.mode ?? "starting",
    upstream: state?.upstream ?? null,
    activeRequests,
    activeWriterRequests,
    queuedRequests: queued.length,
    queuedWriterRequests: queued.reduce((sum, entry) => sum + (entry.requiresWriter ? 1 : 0), 0),
    ...counters,
    updatedAt: Date.now(),
  });

  const persistStatus = ({ immediate = false } = {}) => {
    if (closing && !immediate) return;
    if (!immediate && statusTimer) return;
    const run = () => {
      statusTimer = null;
      if (closing && !immediate) return;
      const value = statusValue();
      statusWrite = statusWrite
        .catch(() => undefined)
        .then(() => writeFileAtomically(statusFile, `${JSON.stringify(value)}\n`))
        .catch((error) => logger.error?.("handoff proxy status write failed", error));
    };
    if (immediate) run();
    else statusTimer = setTimeout(run, 10);
  };

  const finishActive = (requiresWriter, failed = false) => {
    activeRequests = Math.max(0, activeRequests - 1);
    if (requiresWriter) activeWriterRequests = Math.max(0, activeWriterRequests - 1);
    if (failed) counters.failedRequests += 1;
    else counters.completedRequests += 1;
    persistStatus();
  };

  const forwardRequest = (entry) => {
    if (closing || entry.response.writableEnded || entry.response.destroyed) return;
    clearTimeout(entry.timer);
    entry.cleanupQueueListeners?.();
    const selectedState = state;
    const method = String(entry.request.method ?? "GET").toUpperCase();
    const contentLength = entry.request.headers["content-length"];
    const hasRequestBody = entry.request.headers["transfer-encoding"] !== undefined
      || (contentLength !== undefined && (!/^\d+$/.test(String(contentLength)) || Number(contentLength) > 0));
    // Node marks requests dispatched through a pooled keep-alive socket with
    // reusedSocket. A peer can close that idle socket at the same instant the
    // proxy reuses it, producing ECONNRESET before any response exists. Retry
    // that exact race once for bodyless, non-writer GET/HEAD requests only.
    // Mutations and atomic account exports remain strictly single-attempt.
    const mayRetryStaleSocket = !entry.requiresWriter && !hasRequestBody && (method === "GET" || method === "HEAD");
    activeRequests += 1;
    if (entry.requiresWriter) activeWriterRequests += 1;
    persistStatus();
    let settled = false;
    let activeUpstreamRequest = null;
    let retryCount = 0;
    let responseCloseListener = null;
    const settle = (failed = false) => {
      if (settled) return;
      settled = true;
      entry.request.removeListener("aborted", abortActiveRequest);
      entry.request.removeListener("error", abortActiveRequest);
      if (responseCloseListener) entry.response.removeListener("close", responseCloseListener);
      finishActive(entry.requiresWriter, failed);
    };
    const abortActiveRequest = () => {
      activeUpstreamRequest?.destroy();
      settle(true);
    };
    responseCloseListener = () => {
      if (entry.response.writableEnded) return;
      activeUpstreamRequest?.destroy();
      settle(true);
    };
    entry.request.once("aborted", abortActiveRequest);
    entry.request.once("error", abortActiveRequest);
    entry.response.once("close", responseCloseListener);
    const attempt = (retry = false) => {
      if (settled) return;
      if (closing || entry.response.writableEnded || entry.response.destroyed) {
        settle(true);
        return;
      }
      let upstreamResponded = false;
      const upstreamRequest = http.request({
        host: selectedState.upstream.host,
        port: selectedState.upstream.port,
        method,
        path: entry.request.url,
        headers: sanitizedRequestHeaders(entry.request.headers),
        agent,
      }, (upstreamResponse) => {
        upstreamResponded = true;
        const responseHeaders = sanitizedResponseHeaders(upstreamResponse.headers);
        if (typeof upstreamResponse.statusMessage === "string" && upstreamResponse.statusMessage) {
          entry.response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, responseHeaders);
        } else {
          entry.response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        }
        upstreamResponse.on("error", (error) => {
          logger.error?.("handoff proxy upstream response failed", error);
          settle(true);
          if (!entry.response.destroyed) entry.response.destroy(error);
        });
        upstreamResponse.pipe(entry.response);
        entry.response.once("finish", () => settle(false));
      });
      activeUpstreamRequest = upstreamRequest;
      let connectionTimer = null;
      const clearConnectionTimer = () => {
        if (connectionTimer) clearTimeout(connectionTimer);
        connectionTimer = null;
      };
      upstreamRequest.once("socket", (socket) => {
        if (!socket.connecting) return;
        connectionTimer = setTimeout(() => upstreamRequest.destroy(new Error("upstream connection timed out")), connectTimeoutMs);
        connectionTimer.unref?.();
        socket.once("connect", clearConnectionTimer);
      });
      upstreamRequest.once("response", clearConnectionTimer);
      upstreamRequest.once("close", clearConnectionTimer);
      upstreamRequest.once("error", (error) => {
        clearConnectionTimer();
        const staleKeepAliveRace = upstreamRequest.reusedSocket === true && error?.code === "ECONNRESET";
        if (!upstreamResponded && staleKeepAliveRace && mayRetryStaleSocket && retryCount === 0
          && !settled && !closing && !entry.response.writableEnded && !entry.response.destroyed) {
          retryCount += 1;
          counters.retriedRequests += 1;
          persistStatus();
          logger.warn?.("handoff proxy retried a stale upstream keep-alive socket", { method, code: error.code });
          setImmediate(() => attempt(true));
          return;
        }
        logger.error?.("handoff proxy upstream request failed", error);
        settle(true);
        if (!upstreamResponded) {
          sendProxyFailure(entry.response, 503, "RELEASE_UPSTREAM_UNAVAILABLE", "服务正在安全切换，请稍后重试");
        }
      });
      if (retry) upstreamRequest.end();
      else {
        entry.request.pipe(upstreamRequest);
        entry.request.resume();
      }
    };
    attempt(false);
  };

  const flushQueued = () => {
    if (!state || state.mode === "hold") return;
    const remaining = [];
    for (const entry of queued.splice(0)) {
      if (state.mode === "drain" && entry.requiresWriter) remaining.push(entry);
      else forwardRequest(entry);
    }
    queued.push(...remaining);
    persistStatus({ immediate: true });
  };

  const queueRequest = (entry) => {
    if (queued.length >= maximumQueue) {
      counters.rejectedRequests += 1;
      sendProxyFailure(entry.response, 503, "RELEASE_QUEUE_FULL", "发布切换队列已满，请稍后重试");
      persistStatus();
      return;
    }
    entry.request.pause();
    const cancelQueued = () => {
      const index = queued.indexOf(entry);
      if (index < 0) return;
      queued.splice(index, 1);
      clearTimeout(entry.timer);
      entry.cleanupQueueListeners?.();
      persistStatus();
    };
    const onResponseClose = () => {
      if (!entry.response.writableEnded) cancelQueued();
    };
    entry.cleanupQueueListeners = () => {
      entry.request.removeListener("aborted", cancelQueued);
      entry.request.removeListener("error", cancelQueued);
      entry.response.removeListener("close", onResponseClose);
      entry.cleanupQueueListeners = null;
    };
    entry.request.once("aborted", cancelQueued);
    entry.request.once("error", cancelQueued);
    entry.response.once("close", onResponseClose);
    entry.timer = setTimeout(() => {
      const index = queued.indexOf(entry);
      if (index >= 0) queued.splice(index, 1);
      entry.cleanupQueueListeners?.();
      counters.expiredRequests += 1;
      sendProxyFailure(entry.response, 503, "RELEASE_QUEUE_TIMEOUT", "发布切换等待超时，请重试");
      persistStatus();
    }, holdLimitMs);
    entry.timer.unref?.();
    queued.push(entry);
    persistStatus();
  };

  const applyState = async () => {
    if (applyingState || closing) return;
    applyingState = true;
    try {
      const candidate = await readApiProxyState(stateFile);
      if (closing) return;
      if (state && candidate.generation < state.generation) {
        logger.error?.("handoff proxy ignored stale state generation", {
          current: state.generation,
          candidate: candidate.generation,
        });
        return;
      }
      if (state && candidate.generation === state.generation) {
        const sameState = candidate.mode === state.mode
          && candidate.upstream.host === state.upstream.host
          && candidate.upstream.port === state.upstream.port
          && candidate.upstream.slot === state.upstream.slot
          && candidate.upstream.releaseId === state.upstream.releaseId;
        if (!sameState) logger.error?.("handoff proxy ignored conflicting state at the current generation");
        return;
      }
      if (!state || candidate.generation !== state.generation || candidate.mode !== state.mode
        || candidate.upstream.port !== state.upstream.port || candidate.upstream.host !== state.upstream.host) {
        state = candidate;
        persistStatus({ immediate: true });
        flushQueued();
      }
    } catch (error) {
      logger.error?.("handoff proxy state reload failed", error);
    } finally {
      applyingState = false;
    }
  };

  const server = http.createServer((request, response) => {
    counters.acceptedRequests += 1;
    const requiresWriter = requestRequiresWriter(request.method, request.url);
    const entry = { request, response, requiresWriter, timer: null };
    if (!state || state.mode === "hold" || (state.mode === "drain" && requiresWriter)) queueRequest(entry);
    else forwardRequest(entry);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  const start = async () => {
    state = await readApiProxyState(stateFile);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, listenHost, resolve);
    });
    server.removeAllListeners("error");
    server.on("error", (error) => logger.error?.("handoff proxy server failed", error));
    persistStatus({ immediate: true });
    pollTimer = setInterval(() => void applyState(), statePollMs);
    pollTimer.unref?.();
    return server.address();
  };

  const close = async () => {
    if (closing) return;
    closing = true;
    if (pollTimer) clearInterval(pollTimer);
    if (statusTimer) clearTimeout(statusTimer);
    await statusWrite.catch(() => undefined);
    for (const entry of queued.splice(0)) {
      clearTimeout(entry.timer);
      entry.cleanupQueueListeners?.();
      sendProxyFailure(entry.response, 503, "RELEASE_PROXY_STOPPING", "服务代理正在安全关闭，请稍后重试");
    }
    await new Promise((resolve) => server.close(() => resolve()));
    agent.destroy();
    persistStatus({ immediate: true });
    await statusWrite.catch(() => undefined);
  };

  return {
    server,
    start,
    close,
    applyState,
    status: statusValue,
  };
}

function directInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (directInvocation()) {
  const proxy = createApiHandoffProxy({
    stateFile: process.env.DSP_API_PROXY_STATE_FILE || "/var/lib/dsp-idle-cloud/release-state/api-proxy.json",
    statusFile: process.env.DSP_API_PROXY_STATUS_FILE || "/run/dsp-idle-cloud/api-proxy-status.json",
    host: process.env.HOST || API_PROXY_DEFAULT_HOST,
    port: Number(process.env.PORT || API_PROXY_DEFAULT_PORT),
    pollIntervalMs: Number(process.env.DSP_API_PROXY_POLL_MS || 25),
    queueLimit: Number(process.env.DSP_API_PROXY_QUEUE_LIMIT || 512),
    maximumHoldMs: Number(process.env.DSP_API_PROXY_MAX_HOLD_MS || 120_000),
  });
  const stop = (signal) => {
    console.log(`DSP API handoff proxy received ${signal}; draining connections`);
    void proxy.close().then(() => process.exit(0), (error) => {
      console.error("DSP API handoff proxy shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
  proxy.start().then((address) => {
    console.log(`DSP API handoff proxy listening on ${typeof address === "object" ? `${address.address}:${address.port}` : address}`);
  }).catch((error) => {
    console.error("DSP API handoff proxy failed to start", error);
    process.exit(78);
  });
}
