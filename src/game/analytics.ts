import { getOrCreatePlayerId } from "./presence";
import { apiFetch } from "./apiTransport";

export type AnalyticsEventName =
  | "page_view"
  | "game_enter"
  | "new_game"
  | "continue_game"
  | "load_save"
  | "import_save"
  | "cloud_register"
  | "cloud_login"
  | "cloud_upload"
  | "cloud_download"
  | "open_technology"
  | "open_recipes"
  | "open_statistics"
  | "open_star_map"
  | "open_campaign"
  | "building_place"
  | "belt_connect"
  | "research_queue"
  | "mobile_nav_open"
  | "mobile_sheet_open"
  | "mobile_sheet_snap"
  | "mobile_build_select"
  | "mobile_place_success"
  | "mobile_place_cancel"
  | "mobile_connect_success"
  | "mobile_connect_fail"
  | "mobile_inspector_expand"
  | "mobile_workspace_open"
  | "mobile_back_action"
  | "milestone_red_matrix"
  | "milestone_oil_chain"
  | "milestone_yellow_matrix"
  | "milestone_interstellar"
  | "milestone_dyson_swarm"
  | "milestone_universe_matrix"
  | "perf_load_lt_1500"
  | "perf_load_1500_3000"
  | "perf_load_3000_8000"
  | "perf_load_gte_8000"
  | "perf_lcp_lt_2500"
  | "perf_lcp_2500_4000"
  | "perf_lcp_gte_4000"
  | "perf_transfer_lt_1mb"
  | "perf_transfer_1_3mb"
  | "perf_transfer_gte_3mb";

type AnalyticsClient = "desktop-web" | "mobile-web" | "tablet-web" | "pwa" | "desktop-app" | "unknown";
type AnalyticsSource = "direct" | "search" | "social" | "community" | "referral" | "unknown";

interface PendingAnalyticsBatch {
  playerId: string;
  sessionId: string;
  sequence: number;
  activeSeconds: number;
  client: AnalyticsClient;
  source: AnalyticsSource;
  events: Array<{ name: AnalyticsEventName; count: number }>;
}

const SESSION_ID_KEY = "dsp-idle-network.analytics-session.v1";
const SEQUENCE_KEY = "dsp-idle-network.analytics-sequence.v1";
const PENDING_KEY = "dsp-idle-network.analytics-pending.v1";
const SESSION_ID_PATTERN = /^session_[a-z0-9]{24,64}$/;
const FLUSH_INTERVAL_MS = 20_000;
const queue = new Map<AnalyticsEventName, number>();
let installed = false;
let flushing = false;
let pending: PendingAnalyticsBatch | null = null;
let sequence = 0;
let unreportedActiveSeconds = 0;
let lastActiveAt: number | null = null;

function loadEventName(durationMs: number): AnalyticsEventName {
  if (durationMs < 1_500) return "perf_load_lt_1500";
  if (durationMs < 3_000) return "perf_load_1500_3000";
  if (durationMs < 8_000) return "perf_load_3000_8000";
  return "perf_load_gte_8000";
}

function lcpEventName(durationMs: number): AnalyticsEventName {
  if (durationMs < 2_500) return "perf_lcp_lt_2500";
  if (durationMs < 4_000) return "perf_lcp_2500_4000";
  return "perf_lcp_gte_4000";
}

function transferEventName(bytes: number): AnalyticsEventName {
  if (bytes < 1024 ** 2) return "perf_transfer_lt_1mb";
  if (bytes < 3 * 1024 ** 2) return "perf_transfer_1_3mb";
  return "perf_transfer_gte_3mb";
}

function installPagePerformanceTracking(): void {
  const captureLoad = () => window.setTimeout(() => {
    try {
      if (typeof performance.getEntriesByType !== "function") return;
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const durationMs = navigation && navigation.loadEventEnd > navigation.startTime
        ? navigation.loadEventEnd - navigation.startTime
        : performance.now();
      const transferBytes = performance.getEntriesByType("resource")
        .reduce((sum, entry) => sum + Math.max(0, (entry as PerformanceResourceTiming).transferSize || 0), 0);
      trackAnalyticsEvent(loadEventName(durationMs));
      trackAnalyticsEvent(transferEventName(transferBytes));
    } catch {
      // Optional navigation/resource timing must not become a runtime error.
    }
  }, 0);
  if (document.readyState === "complete") captureLoad();
  else window.addEventListener("load", captureLoad, { once: true });

  if (!("PerformanceObserver" in window)) return;
  try {
    let largestContentfulPaintMs = 0;
    let finalized = false;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) largestContentfulPaintMs = Math.max(largestContentfulPaintMs, entry.startTime);
    });
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      observer.disconnect();
      if (largestContentfulPaintMs > 0) trackAnalyticsEvent(lcpEventName(largestContentfulPaintMs));
    };
    observer.observe({ type: "largest-contentful-paint", buffered: true });
    window.setTimeout(finalize, 5_000);
    window.addEventListener("pagehide", finalize, { once: true });
  } catch {
    // Web-vital observation is optional on older browser engines.
  }
}

function createSessionId(): string {
  if (typeof window.crypto?.randomUUID === "function") return `session_${window.crypto.randomUUID().replaceAll("-", "")}`;
  const bytes = window.crypto?.getRandomValues?.(new Uint8Array(16));
  return `session_${bytes ? Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("") : `${Date.now()}${Math.random().toString(36).slice(2)}`}`;
}

function readSessionValue(key: string): string | null {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

function writeSessionValue(key: string, value: string | null): void {
  try {
    if (value == null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // Analytics remains best-effort in private or storage-restricted sessions.
  }
}

function sessionId(): string {
  const stored = readSessionValue(SESSION_ID_KEY);
  if (stored && SESSION_ID_PATTERN.test(stored)) return stored;
  const created = createSessionId();
  writeSessionValue(SESSION_ID_KEY, created);
  return created;
}

function analyticsApiBase(): string | null {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (typeof __APP_PLATFORM__ !== "undefined" && __APP_PLATFORM__ !== "web") return null;
  if (typeof window === "undefined" || window.location.protocol === "file:") return null;
  return "/api";
}

function clientKind(): AnalyticsClient {
  if ((window as Window & { dspDesktop?: unknown }).dspDesktop) return "desktop-app";
  if (window.matchMedia("(display-mode: standalone)").matches) return "pwa";
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  if (!coarse) return "desktop-web";
  return Math.min(window.screen.width, window.screen.height) >= 600 ? "tablet-web" : "mobile-web";
}

function sourceKind(): AnalyticsSource {
  if (!document.referrer) return "direct";
  try {
    const host = new URL(document.referrer).hostname.toLowerCase();
    if (!host || host === window.location.hostname) return "direct";
    if (/baidu|bing|google|sogou|so\.com/.test(host)) return "search";
    if (/weibo|bilibili|douyin|zhihu|xiaohongshu/.test(host)) return "social";
    if (/qq\.com|qun\.qq/.test(host)) return "community";
    return "referral";
  } catch {
    return "unknown";
  }
}

function captureActiveTime(): void {
  const now = Date.now();
  if (lastActiveAt != null) unreportedActiveSeconds += Math.min(60, Math.max(0, (now - lastActiveAt) / 1000));
  lastActiveAt = document.visibilityState === "hidden" ? null : now;
}

function persistPending(): void {
  writeSessionValue(PENDING_KEY, pending ? JSON.stringify(pending) : null);
}

function restorePending(): void {
  sequence = Math.max(0, Number(readSessionValue(SEQUENCE_KEY)) || 0);
  const raw = readSessionValue(PENDING_KEY);
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as PendingAnalyticsBatch;
    if (value && Number.isInteger(value.sequence) && value.sequence > sequence && Array.isArray(value.events)) pending = value;
  } catch {
    writeSessionValue(PENDING_KEY, null);
  }
}

function createPendingBatch(): PendingAnalyticsBatch | null {
  captureActiveTime();
  const activeSeconds = Math.min(300, Math.floor(unreportedActiveSeconds));
  const events = Array.from(queue, ([name, count]) => ({ name, count: Math.min(100, count) }));
  if (events.length === 0 && activeSeconds === 0) return null;
  queue.clear();
  unreportedActiveSeconds = Math.max(0, unreportedActiveSeconds - activeSeconds);
  return {
    playerId: getOrCreatePlayerId(),
    sessionId: sessionId(),
    sequence: sequence + 1,
    activeSeconds,
    client: clientKind(),
    source: sourceKind(),
    events,
  };
}

export async function flushAnalytics(keepalive = false): Promise<void> {
  const base = analyticsApiBase();
  if (!base || flushing) return;
  if (!pending) {
    pending = createPendingBatch();
    if (!pending) return;
    persistPending();
  }
  flushing = true;
  try {
    const response = await apiFetch(`${base}/analytics`, {
      method: "POST",
      body: JSON.stringify(pending),
      headers: { "content-type": "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      keepalive,
    });
    if (!response.ok) return;
    sequence = pending.sequence;
    writeSessionValue(SEQUENCE_KEY, String(sequence));
    pending = null;
    persistPending();
  } catch {
    // Telemetry is optional and must never affect game or save behavior.
  } finally {
    flushing = false;
  }
}

export function trackAnalyticsEvent(name: AnalyticsEventName, count = 1): void {
  if (!Number.isFinite(count) || count <= 0) return;
  queue.set(name, (queue.get(name) ?? 0) + Math.min(100, Math.floor(count)));
}

export function installAnalytics(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  restorePending();
  installPagePerformanceTracking();
  lastActiveAt = document.visibilityState === "hidden" ? null : Date.now();
  trackAnalyticsEvent("page_view");
  window.setTimeout(() => void flushAnalytics(), 800);
  const timer = window.setInterval(() => void flushAnalytics(), FLUSH_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    captureActiveTime();
    if (document.visibilityState === "hidden") void flushAnalytics(true);
  });
  window.addEventListener("pagehide", () => void flushAnalytics(true));
  window.addEventListener("pageshow", () => { lastActiveAt = Date.now(); });
  window.addEventListener("beforeunload", () => window.clearInterval(timer), { once: true });
}
