const CACHE_NAMESPACE = "dsp-idle-pwa-v2";
const LEGACY_SHELL_PREFIX = "dsp-idle-shell-";
const STATUS_MESSAGE_TYPE = "DSP_PWA_STATUS";
const VERSION_FALLBACK_HEADER = "X-DSP-PWA-Fallback";
const VERSION_STATUS_HEADER = "X-DSP-PWA-Status";

const workerUrl = new URL(self.location.href);
const BUILD_ID = sanitizeToken(workerUrl.searchParams.get("v") || "development");
const ROUTE_BASE = normalizeRouteBase(
  workerUrl.searchParams.get("base") || new URL(self.registration.scope).pathname,
);
const ROUTE_KEY = normalizeRouteKey(workerUrl.searchParams.get("route"), ROUTE_BASE);
const ROUTE_KIND = ROUTE_KEY === "root" ? "root" : ROUTE_KEY === "previous" ? "previous" : "canary";

const SHELL_CACHE_PREFIX = `${CACHE_NAMESPACE}::shell::${ROUTE_KEY}::`;
const SHELL_CACHE_NAME = `${SHELL_CACHE_PREFIX}${BUILD_ID}`;
const VERSION_CACHE_NAME = `${CACHE_NAMESPACE}::version::${ROUTE_KEY}`;
const META_CACHE_NAME = `${CACHE_NAMESPACE}::meta::${ROUTE_KEY}`;
const CACHE_MARKER_URL = new URL(`__dsp_idle_pwa_cache_marker__/${encodeURIComponent(ROUTE_KEY)}`, self.location.origin).href;
const META_RECORD_URL = new URL(`__dsp_idle_pwa_cache_state__/${encodeURIComponent(ROUTE_KEY)}`, self.location.origin).href;
const INDEX_URL = new URL("index.html", new URL(ROUTE_BASE, self.location.origin)).href;
const VERSION_URL = new URL("version.json", new URL(ROUTE_BASE, self.location.origin)).href;
const ASSET_BASE_PATH = new URL("assets/", new URL(ROUTE_BASE, self.location.origin)).pathname;
const APP_SHELL = [
  new URL(ROUTE_BASE, self.location.origin).href,
  INDEX_URL,
  new URL("manifest.webmanifest", new URL(ROUTE_BASE, self.location.origin)).href,
  new URL("icon.svg", new URL(ROUTE_BASE, self.location.origin)).href,
];
const MAX_DISCOVERED_SHELL_ASSETS = 512;

let registrySnapshot = null;
let lastRuntimeStatus = null;

function sanitizeToken(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "development";
}

function normalizeRouteBase(value) {
  try {
    const url = new URL(value || "/", self.location.origin);
    if (url.origin !== self.location.origin) return "/";
    const pathname = url.pathname.replace(/\/{2,}/g, "/");
    return pathname.endsWith("/") ? pathname : `${pathname}/`;
  } catch {
    return "/";
  }
}

function normalizeRouteKey(value, basePath) {
  if (value) return sanitizeToken(value);
  if (basePath === "/") return "root";
  if (/^\/canary\/previous\/?$/i.test(basePath)) return "previous";
  const canary = basePath.match(/^\/canary\/([^/]+)\//i);
  if (canary) return `canary-${sanitizeToken(canary[1])}`;
  return `path-${sanitizeToken(basePath.replace(/^\/+|\/+$/g, "").replace(/\//g, "_"))}`;
}

function isOwnedCache(cacheName) {
  return cacheName.startsWith(`${CACHE_NAMESPACE}::`)
    || /^dsp-idle-shell-(?:development|\d)/.test(cacheName);
}

function isLegacyRootShell(cacheName) {
  return ROUTE_KIND === "root"
    && cacheName.startsWith(LEGACY_SHELL_PREFIX)
    && isOwnedCache(cacheName);
}

function isRouteShellCache(cacheName) {
  return cacheName.startsWith(SHELL_CACHE_PREFIX) || isLegacyRootShell(cacheName);
}

function requestBelongsToRoute(pathname) {
  if (ROUTE_KIND === "root") return !pathname.startsWith("/canary/");
  return pathname.startsWith(ROUTE_BASE);
}

function isHashedShellAsset(pathname) {
  if (!pathname.startsWith(ASSET_BASE_PATH)) return false;
  const fileName = pathname.slice(pathname.lastIndexOf("/") + 1);
  return /-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/.test(fileName);
}

function resolveShellAssetUrl(reference, ownerUrl) {
  const normalized = String(reference).trim();
  if (normalized.startsWith("assets/")) {
    return new URL(normalized, new URL(ROUTE_BASE, self.location.origin));
  }
  return new URL(normalized, ownerUrl);
}

function discoverShellAssetUrls(source, ownerUrl) {
  const references = new Set();
  const patterns = [
    /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    /["'`]([^"'`\s]+\.(?:js|css|woff2?|png|svg|webp|ico|wasm)(?:\?[^"'`\s]*)?)["'`]/gi,
    /url\(\s*["']?([^"')\s]+)["']?\s*\)/gi,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match = null;
    while ((match = pattern.exec(source))) {
      try {
        const url = resolveShellAssetUrl(match[1], ownerUrl);
        if (
          url.origin === self.location.origin
          && requestBelongsToRoute(url.pathname)
          && isHashedShellAsset(url.pathname)
          && !url.pathname.startsWith("/api/")
          && url.pathname !== new URL(self.location.href).pathname
          && url.pathname !== new URL(VERSION_URL).pathname
        ) references.add(url.href);
      } catch {
        // Ignore malformed and non-URL strings in generated JavaScript/CSS.
      }
    }
  }
  return references;
}

function shouldDiscoverNestedAssets(url) {
  return /\.(?:html?|js|css)(?:$|\?)/i.test(url);
}

async function precacheDiscoveredShellAssets(cache) {
  const indexResponse = await cache.match(INDEX_URL);
  if (!indexResponse) throw new Error("Installed shell is missing index.html");
  const queue = [...discoverShellAssetUrls(await indexResponse.clone().text(), INDEX_URL)];
  const visited = new Set(APP_SHELL);

  while (queue.length > 0) {
    if (visited.size > MAX_DISCOVERED_SHELL_ASSETS) throw new Error("Installed shell asset graph exceeds its safe limit");
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);
    const response = await fetch(new Request(url, { cache: "reload", credentials: "same-origin" }));
    if (!response.ok) throw new Error(`Unable to install shell asset (${response.status})`);
    await cache.put(url, response.clone());
    if (shouldDiscoverNestedAssets(url)) {
      const nested = discoverShellAssetUrls(await response.text(), url);
      nested.forEach((candidate) => {
        if (!visited.has(candidate)) queue.push(candidate);
      });
    }
  }
}

async function readRegistry() {
  if (registrySnapshot) return registrySnapshot;
  try {
    const cache = await caches.open(META_CACHE_NAME);
    const response = await cache.match(META_RECORD_URL);
    if (!response) return null;
    const candidate = await response.json();
    if (!candidate || typeof candidate !== "object") return null;
    const current = typeof candidate.current === "string" && isRouteShellCache(candidate.current)
      ? candidate.current
      : null;
    const previous = typeof candidate.previous === "string" && isRouteShellCache(candidate.previous)
      ? candidate.previous
      : null;
    registrySnapshot = { current, previous };
    return registrySnapshot;
  } catch {
    return null;
  }
}

async function writeRegistry(current, previous) {
  const next = { current, previous, buildId: BUILD_ID, routeKey: ROUTE_KEY };
  const cache = await caches.open(META_CACHE_NAME);
  await cache.put(META_RECORD_URL, new Response(JSON.stringify(next), {
    headers: { "Content-Type": "application/json" },
  }));
  registrySnapshot = { current, previous };
}

async function hasCompletedMarker(cacheName) {
  try {
    const cache = await caches.open(cacheName);
    // Legacy workers did not write completion markers. Their install used an
    // atomic addAll for the fixed shell, so index.html is the compatibility
    // proof that distinguishes an active/installed cache from an empty cache
    // left behind by an interrupted legacy install.
    if (isLegacyRootShell(cacheName)) {
      return Boolean(await cache.match(INDEX_URL, { ignoreVary: true }));
    }
    const response = await cache.match(CACHE_MARKER_URL);
    if (!response) return false;
    const marker = await response.json();
    return marker?.cacheName === cacheName && marker?.routeKey === ROUTE_KEY;
  } catch {
    return false;
  }
}

async function findPreviousStableCache(cacheNames, registry) {
  if (
    registry?.current
    && registry.current !== SHELL_CACHE_NAME
    && cacheNames.includes(registry.current)
    && await hasCompletedMarker(registry.current)
  ) {
    return registry.current;
  }
  if (
    registry?.current === SHELL_CACHE_NAME
    && registry.previous
    && cacheNames.includes(registry.previous)
    && await hasCompletedMarker(registry.previous)
  ) {
    return registry.previous;
  }

  const legacy = cacheNames.filter((cacheName) => isLegacyRootShell(cacheName));
  for (let index = legacy.length - 1; index >= 0; index -= 1) {
    if (await hasCompletedMarker(legacy[index])) return legacy[index];
  }

  const candidates = cacheNames.filter((cacheName) => cacheName !== SHELL_CACHE_NAME && cacheName.startsWith(SHELL_CACHE_PREFIX));
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (await hasCompletedMarker(candidates[index])) return candidates[index];
  }
  return null;
}

async function installShell() {
  const cacheExisted = (await caches.keys()).includes(SHELL_CACHE_NAME);
  if (cacheExisted && await hasCompletedMarker(SHELL_CACHE_NAME)) return;
  if (cacheExisted) await caches.delete(SHELL_CACHE_NAME);
  try {
    const cache = await caches.open(SHELL_CACHE_NAME);
    const requests = APP_SHELL.map((url) => new Request(url, { cache: "reload", credentials: "same-origin" }));
    await cache.addAll(requests);
    await precacheDiscoveredShellAssets(cache);
    await cache.put(CACHE_MARKER_URL, new Response(JSON.stringify({
      buildId: BUILD_ID,
      cacheName: SHELL_CACHE_NAME,
      routeKey: ROUTE_KEY,
    }), { headers: { "Content-Type": "application/json" } }));
    // A successful shell install may prime the version fallback, but version
    // metadata is deliberately non-critical and can never fail the install.
    try {
      const response = await fetch(VERSION_URL, { cache: "no-store", credentials: "same-origin" });
      if (await versionResponseIsValid(response)) {
        const versionCache = await caches.open(VERSION_CACHE_NAME);
        await versionCache.put(VERSION_URL, response.clone());
      }
    } catch {
      // The current active worker remains usable when version metadata is
      // temporarily unavailable during a candidate install.
    }
  } catch (error) {
    // A candidate install must never mutate or remove the currently active
    // shell. Build IDs are immutable, so a newly-created failed candidate can
    // be removed safely while the previous worker remains authoritative.
    await caches.delete(SHELL_CACHE_NAME).catch(() => false);
    throw error;
  }
}

async function activateShell() {
  const cacheNames = await caches.keys();
  const registry = await readRegistry();
  const previous = await findPreviousStableCache(cacheNames, registry);

  // Publish the new stable/previous pair before deleting older caches. If the
  // metadata write fails (for example because storage is full), activation
  // fails and the old active worker and shell continue to serve the app.
  await writeRegistry(SHELL_CACHE_NAME, previous);

  const retained = new Set([SHELL_CACHE_NAME, previous, META_CACHE_NAME, VERSION_CACHE_NAME].filter(Boolean));
  const deletions = cacheNames
    .filter((cacheName) => isOwnedCache(cacheName) && isRouteShellCache(cacheName) && !retained.has(cacheName))
    .map((cacheName) => caches.delete(cacheName).catch(() => false));
  await Promise.all(deletions);
  await self.clients.claim();
}

async function matchCache(cacheName, request) {
  if (!cacheName) return null;
  try {
    const cache = await caches.open(cacheName);
    // The same immutable asset can be installed by a worker request without
    // an Origin header and later requested by a module loader with one. Some
    // static servers emit `Vary: Origin`; matching that response literally
    // makes a present same-origin cache entry look absent while offline.
    // Cache names and request routing are already origin/route isolated, so
    // ignoring Vary here cannot cross application, API or origin boundaries.
    return await cache.match(request, { ignoreVary: true }) || null;
  } catch {
    return null;
  }
}

async function shellCacheOrder() {
  const registry = await readRegistry();
  const ordered = [SHELL_CACHE_NAME, registry?.current, registry?.previous];
  return [...new Set(ordered.filter((cacheName) => typeof cacheName === "string" && isRouteShellCache(cacheName)))];
}

async function matchShell(request) {
  const cacheNames = await shellCacheOrder();
  for (let index = 0; index < cacheNames.length; index += 1) {
    const response = await matchCache(cacheNames[index], request);
    if (response) return { response, stableFallback: index > 0 || cacheNames[index] !== SHELL_CACHE_NAME };
  }
  return { response: null, stableFallback: false };
}

async function cacheCurrentShell(request, response) {
  if (!response?.ok) return;
  const url = new URL(typeof request === "string" ? request : request.url);
  if (!isHashedShellAsset(url.pathname)) return;
  try {
    const cache = await caches.open(SHELL_CACHE_NAME);
    await cache.put(request, response);
  } catch {
    // Runtime caching is best-effort. The install-time shell remains intact.
  }
}

async function broadcastStatus(status, details = {}) {
  lastRuntimeStatus = { type: STATUS_MESSAGE_TYPE, status, ...details };
  try {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    clients.forEach((client) => client.postMessage(lastRuntimeStatus));
  } catch {
    // Status reporting must never make an otherwise valid offline response fail.
  }
}

async function fallbackVersionResponse(status) {
  const cached = await matchCache(VERSION_CACHE_NAME, VERSION_URL);
  if (!cached) return null;
  const headers = new Headers(cached.headers);
  headers.set(VERSION_FALLBACK_HEADER, "last-known-version");
  headers.set(VERSION_STATUS_HEADER, status);
  return new Response(await cached.arrayBuffer(), {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  });
}

async function versionResponseIsValid(response) {
  if (!response.ok) return false;
  try {
    const payload = await response.clone().json();
    return Boolean(
      payload
      && typeof payload === "object"
      && typeof payload.buildId === "string"
      && payload.buildId.trim()
      && typeof payload.version === "string"
      && payload.version.trim(),
    );
  } catch {
    return false;
  }
}

async function withVersionStatus(response, status) {
  const headers = new Headers(response.headers);
  headers.set(VERSION_STATUS_HEADER, status);
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function networkFirstVersion(request) {
  try {
    const response = await fetch(request, { cache: "no-store", credentials: "same-origin" });
    if (await versionResponseIsValid(response)) {
      const cache = await caches.open(VERSION_CACHE_NAME);
      await cache.put(VERSION_URL, response.clone());
      return response;
    }
    const fallback = await fallbackVersionResponse("version-check-failed");
    await broadcastStatus("version-check-failed", { routeKey: ROUTE_KEY, usedLastKnownVersion: Boolean(fallback) });
    return fallback || withVersionStatus(response, "version-check-failed");
  } catch {
    const fallback = await fallbackVersionResponse("network-unavailable");
    await broadcastStatus("network-unavailable", { routeKey: ROUTE_KEY, usedLastKnownVersion: Boolean(fallback) });
    return fallback || Response.error();
  }
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    // The install-time index is an immutable stable checkpoint. An older
    // controlling worker may observe a candidate deployment before that
    // candidate finishes installing; overwriting the active cache here would
    // turn the previous-stable shell into a mixed-version fallback.
    if (response.ok) return response;
    const fallback = await matchShell(INDEX_URL);
    if (!fallback.response) return response;
    await broadcastStatus(fallback.stableFallback ? "stable-fallback" : "network-unavailable", {
      routeKey: ROUTE_KEY,
      previousStable: fallback.stableFallback,
    });
    return fallback.response;
  } catch {
    const fallback = await matchShell(INDEX_URL);
    await broadcastStatus(fallback.stableFallback ? "stable-fallback" : "network-unavailable", {
      routeKey: ROUTE_KEY,
      previousStable: fallback.stableFallback,
    });
    return fallback.response || Response.error();
  }
}

async function cacheFirstAsset(request) {
  const cached = await matchShell(request);
  if (cached.response) return cached.response;
  try {
    const response = await fetch(request);
    if (response.ok) void cacheCurrentShell(request, response.clone());
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(installShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(activateShell());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "GET_PWA_STATUS" && lastRuntimeStatus && event.source?.postMessage) {
    event.source.postMessage(lastRuntimeStatus);
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET"
    || url.origin !== self.location.origin
    || url.pathname.startsWith("/api/")
    || !requestBelongsToRoute(url.pathname)
  ) return;

  if (url.pathname === new URL(VERSION_URL).pathname) {
    event.respondWith(networkFirstVersion(event.request));
    return;
  }
  if (event.request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(event.request));
    return;
  }
  event.respondWith(cacheFirstAsset(event.request));
});
