// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface CacheRecord {
  requests: Map<string, Response>;
  matchOptions?: CacheQueryOptions[];
}

interface WorkerHarness {
  caches: Map<string, CacheRecord>;
  dispatch: (type: "install" | "activate" | "fetch" | "message", event: Record<string, unknown>) => void;
  fetchCalls: Request[];
  setFetch: (handler: (request: Request) => Promise<Response>) => void;
  messages: unknown[];
  claimed: () => number;
  skipped: () => number;
}

const workerPath = decodeURIComponent(new URL("../public/sw.js", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const workerSource = readFileSync(workerPath, "utf8");

function requestKey(request: RequestInfo | URL): string {
  if (request instanceof Request) return request.url;
  return new URL(String(request), "https://game.example/").href;
}

function cloneResponse(response: Response): Response {
  return response.clone();
}

function createHarness(options: {
  workerUrl?: string;
  scope?: string;
  caches?: Map<string, CacheRecord>;
  failCachePut?: (cacheName: string, requestUrl: string) => boolean;
} = {}): WorkerHarness {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const cacheRecords = options.caches ?? new Map<string, CacheRecord>();
  const fetchCalls: Request[] = [];
  const messages: unknown[] = [];
  let claimCount = 0;
  let skipCount = 0;
  let fetchHandler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("version.json")) {
      return new Response(JSON.stringify({ version: "1.0.40", buildId: "build-new" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(`network:${url.pathname}`, { status: 200 });
  };

  const cacheStorage = {
    keys: async () => [...cacheRecords.keys()],
    open: async (name: string) => {
      let record = cacheRecords.get(name);
      if (!record) {
        record = { requests: new Map() };
        cacheRecords.set(name, record);
      }
      return {
        addAll: async (requests: RequestInfo[]) => {
          const staged: Array<[string, Response]> = [];
          for (const request of requests) {
            const normalized = request instanceof Request ? request : new Request(request);
            const response = await fetchHandler(normalized);
            if (!response.ok) throw new Error(`precache failed: ${response.status}`);
            staged.push([requestKey(normalized), cloneResponse(response)]);
          }
          staged.forEach(([key, response]) => record!.requests.set(key, response));
        },
        put: async (request: RequestInfo, response: Response) => {
          const key = requestKey(request);
          if (options.failCachePut?.(name, key)) throw new Error(`cache put failed: ${name}`);
          record!.requests.set(key, cloneResponse(response));
        },
        match: async (request: RequestInfo, matchOptions?: CacheQueryOptions) => {
          if (matchOptions) (record!.matchOptions ??= []).push(matchOptions);
          const response = record!.requests.get(requestKey(request));
          return response ? cloneResponse(response) : undefined;
        },
      };
    },
    delete: async (name: string) => cacheRecords.delete(name),
  };

  const worker = {
    location: { href: options.workerUrl ?? "https://game.example/sw.js?v=build-new&route=root&base=%2F", origin: "https://game.example" },
    registration: { scope: options.scope ?? "https://game.example/" },
    clients: {
      claim: async () => { claimCount += 1; },
      matchAll: async () => [{ postMessage: (message: unknown) => messages.push(message) }],
    },
    skipWaiting: () => { skipCount += 1; },
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => listeners.set(type, listener),
  };

  const workerFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    fetchCalls.push(request);
    return fetchHandler(request);
  };
  // Execute the classic worker script with explicit globals. This avoids
  // mutating Vitest's global service-worker state while exercising the exact
  // public/sw.js bytes shipped by the production build.
  const loadWorker = new Function("self", "caches", "fetch", workerSource);
  loadWorker(worker, cacheStorage, workerFetch);

  return {
    caches: cacheRecords,
    dispatch: (type, event) => {
      const listener = listeners.get(type);
      if (!listener) throw new Error(`No ${type} listener`);
      listener(event);
    },
    fetchCalls,
    setFetch: (handler) => { fetchHandler = handler; },
    messages,
    claimed: () => claimCount,
    skipped: () => skipCount,
  };
}

async function dispatchWait(harness: WorkerHarness, type: "install" | "activate", event: Record<string, unknown> = {}): Promise<void> {
  let completion: Promise<unknown> | null = null;
  harness.dispatch(type, {
    ...event,
    waitUntil: (promise: Promise<unknown>) => { completion = promise; },
  });
  if (!completion) throw new Error(`${type} did not call waitUntil`);
  await completion;
}

async function dispatchFetch(harness: WorkerHarness, request: Request): Promise<Response | null> {
  let response: Promise<Response> | null = null;
  harness.dispatch("fetch", {
    request,
    respondWith: (promise: Promise<Response>) => { response = promise; },
  });
  return response ? response : null;
}

function makeCache(entries: Record<string, string>): CacheRecord {
  return {
    requests: new Map(Object.entries(entries).map(([url, body]) => [url, new Response(body, { status: 200 })])),
  };
}

describe("DSPidle service worker cache ownership", () => {
  it("keeps unrelated same-origin caches and retains exactly one previous root shell", async () => {
    const caches = new Map<string, CacheRecord>([
      ["unrelated-app-cache", makeCache({ "https://game.example/other": "keep" })],
      ["dsp-idle-shell-helper-app", makeCache({ "https://game.example/helper": "keep-too" })],
      ["dsp-idle-shell-1.0.38-old-a", makeCache({ "https://game.example/index.html": "old-a" })],
      ["dsp-idle-shell-1.0.39-old-b", makeCache({ "https://game.example/index.html": "old-b" })],
    ]);
    const harness = createHarness({ caches });

    await dispatchWait(harness, "install");
    await dispatchWait(harness, "activate");

    expect([...caches.keys()]).toContain("unrelated-app-cache");
    expect([...caches.keys()]).toContain("dsp-idle-shell-helper-app");
    expect([...caches.keys()]).toContain("dsp-idle-pwa-v2::shell::root::build-new");
    expect([...caches.keys()].filter((name) => /^dsp-idle-shell-\d/.test(name))).toEqual(["dsp-idle-shell-1.0.39-old-b"]);
    expect(harness.claimed()).toBe(1);
  });

  it("installs online and reopens the current stable shell while offline", async () => {
    const harness = createHarness();
    harness.setFetch(async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/" || pathname === "/index.html") {
        return new Response('<script type="module" src="./assets/entry-abcdef.js"></script>', { status: 200 });
      }
      if (pathname === "/assets/entry-abcdef.js") {
        return new Response('const load = () => import("./launcher-ghijkl.js");', { status: 200 });
      }
      if (pathname === "/assets/launcher-ghijkl.js") return new Response("export const ready = true;", { status: 200 });
      if (pathname === "/version.json") {
        return new Response(JSON.stringify({ version: "1.0.40", buildId: "build-new" }), { status: 200 });
      }
      return new Response("shell-resource", { status: 200 });
    });
    await dispatchWait(harness, "install");
    await dispatchWait(harness, "activate");
    expect(harness.caches.get("dsp-idle-pwa-v2::shell::root::build-new")!.requests.has("https://game.example/assets/entry-abcdef.js")).toBe(true);
    expect(harness.caches.get("dsp-idle-pwa-v2::shell::root::build-new")!.requests.has("https://game.example/assets/launcher-ghijkl.js")).toBe(true);
    harness.setFetch(async () => { throw new TypeError("offline"); });

    const navigation = new Request("https://game.example/factory", { headers: { Accept: "text/html" } });
    Object.defineProperty(navigation, "mode", { configurable: true, value: "navigate" });
    const response = await dispatchFetch(harness, navigation);

    await expect(response!.text()).resolves.toContain("assets/entry-abcdef.js");
    await expect((await dispatchFetch(harness, new Request("https://game.example/assets/launcher-ghijkl.js")))!.text())
      .resolves.toBe("export const ready = true;");
    expect(harness.caches.get("dsp-idle-pwa-v2::shell::root::build-new")!.matchOptions)
      .toContainEqual({ ignoreVary: true });
    expect(harness.messages).toContainEqual(expect.objectContaining({
      type: "DSP_PWA_STATUS",
      status: "network-unavailable",
      previousStable: false,
    }));
  });

  it("resolves generated assets/ references from the release root on a strict static server", async () => {
    const harness = createHarness();
    const expectedAssets = new Map([
      ["/assets/entry-abcdef.js", [
        'const routeChunk = "assets/route-ghijkl.js";',
        'const siblingChunk = "./sibling-mnopqr.js";',
        'const absoluteChunk = "/assets/absolute-stuvwx.js";',
      ].join("\n")],
      ["/assets/route-ghijkl.js", "export const route = true;"],
      ["/assets/sibling-mnopqr.js", "export const sibling = true;"],
      ["/assets/absolute-stuvwx.js", "export const absolute = true;"],
    ]);
    harness.setFetch(async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/" || pathname === "/index.html") {
        return new Response('<script type="module" src="/assets/entry-abcdef.js"></script>', { status: 200 });
      }
      if (expectedAssets.has(pathname)) return new Response(expectedAssets.get(pathname), { status: 200 });
      if (pathname === "/version.json") {
        return new Response(JSON.stringify({ version: "1.1.0", buildId: "build-new" }), { status: 200 });
      }
      if (pathname === "/manifest.webmanifest" || pathname === "/icon.svg") {
        return new Response("shell-resource", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(dispatchWait(harness, "install")).resolves.toBeUndefined();

    const requestedPaths = harness.fetchCalls.map((request) => new URL(request.url).pathname);
    expect(requestedPaths).toEqual(expect.arrayContaining([...expectedAssets.keys()]));
    expect(requestedPaths.some((pathname) => pathname.startsWith("/assets/assets/"))).toBe(false);
  });

  it("keeps generated assets/ references inside an immutable canary route", async () => {
    const harness = createHarness({
      scope: "https://game.example/canary/build-a/",
      workerUrl: "https://game.example/canary/build-a/sw.js?v=build-a&route=canary-build-a&base=%2Fcanary%2Fbuild-a%2F",
    });
    harness.setFetch(async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/canary/build-a/" || pathname === "/canary/build-a/index.html") {
        return new Response('<script type="module" src="./assets/entry-abcdef.js"></script>', { status: 200 });
      }
      if (pathname === "/canary/build-a/assets/entry-abcdef.js") {
        return new Response('const chunk = "assets/chunk-ghijkl.js";', { status: 200 });
      }
      if (pathname === "/canary/build-a/assets/chunk-ghijkl.js") {
        return new Response("export const ready = true;", { status: 200 });
      }
      if (pathname === "/canary/build-a/version.json") {
        return new Response(JSON.stringify({ version: "1.1.0", buildId: "build-a" }), { status: 200 });
      }
      if (pathname === "/canary/build-a/manifest.webmanifest" || pathname === "/canary/build-a/icon.svg") {
        return new Response("shell-resource", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(dispatchWait(harness, "install")).resolves.toBeUndefined();

    const requestedPaths = harness.fetchCalls.map((request) => new URL(request.url).pathname);
    expect(requestedPaths).toContain("/canary/build-a/assets/chunk-ghijkl.js");
    expect(requestedPaths.some((pathname) => pathname.includes("/assets/assets/"))).toBe(false);
  });

  it("keeps the active index immutable while a candidate deployment is visible", async () => {
    const caches = new Map<string, CacheRecord>();
    const stable = createHarness({
      caches,
      workerUrl: "https://game.example/sw.js?v=stable-old&route=root&base=%2F",
    });
    await dispatchWait(stable, "install");
    await dispatchWait(stable, "activate");
    stable.setFetch(async () => new Response("candidate-index", { status: 200 }));

    const navigation = new Request("https://game.example/", { headers: { Accept: "text/html" } });
    Object.defineProperty(navigation, "mode", { configurable: true, value: "navigate" });
    await expect((await dispatchFetch(stable, navigation))!.text()).resolves.toBe("candidate-index");

    const stableIndex = caches.get("dsp-idle-pwa-v2::shell::root::stable-old")!
      .requests.get("https://game.example/index.html")!;
    await expect(stableIndex.clone().text()).resolves.toBe("network:/index.html");
  });

  it("does not destroy the active stable shell when a candidate install fails", async () => {
    const caches = new Map<string, CacheRecord>([
      ["dsp-idle-pwa-v2::shell::root::stable", makeCache({ "https://game.example/index.html": "stable-shell" })],
      ["unrelated-app-cache", makeCache({ "https://game.example/other": "keep" })],
    ]);
    const harness = createHarness({ caches });
    harness.setFetch(async (request) => {
      if (new URL(request.url).pathname === "/manifest.webmanifest") throw new TypeError("network interrupted");
      return new Response("ok", { status: 200 });
    });

    await expect(dispatchWait(harness, "install")).rejects.toThrow("network interrupted");
    expect(caches.has("dsp-idle-pwa-v2::shell::root::stable")).toBe(true);
    expect(await caches.get("dsp-idle-pwa-v2::shell::root::stable")!.requests.get("https://game.example/index.html")!.text()).toBe("stable-shell");
    expect(caches.has("dsp-idle-pwa-v2::shell::root::build-new")).toBe(false);
    expect(caches.has("unrelated-app-cache")).toBe(true);
  });

  it("keeps the active shell authoritative when candidate activation metadata cannot commit", async () => {
    const caches = new Map<string, CacheRecord>();
    const stable = createHarness({
      caches,
      workerUrl: "https://game.example/sw.js?v=stable-old&route=root&base=%2F",
    });
    await dispatchWait(stable, "install");
    await dispatchWait(stable, "activate");

    const candidate = createHarness({
      caches,
      failCachePut: (cacheName) => cacheName === "dsp-idle-pwa-v2::meta::root",
    });
    await dispatchWait(candidate, "install");
    await expect(dispatchWait(candidate, "activate")).rejects.toThrow("cache put failed");

    expect(caches.has("dsp-idle-pwa-v2::shell::root::stable-old")).toBe(true);
    expect(caches.has("dsp-idle-pwa-v2::shell::root::build-new")).toBe(true);
    expect(candidate.claimed()).toBe(0);
    const stableIndex = caches.get("dsp-idle-pwa-v2::shell::root::stable-old")!
      .requests.get("https://game.example/index.html")!;
    await expect(stableIndex.clone().text()).resolves.toBe("network:/index.html");
  });

  it("ignores an incomplete legacy cache left by an interrupted old-worker install", async () => {
    const caches = new Map<string, CacheRecord>([
      ["dsp-idle-shell-1.0.39-complete", makeCache({
        "https://game.example/index.html": "legacy-stable-shell",
        "https://game.example/assets/legacy-abcdef.js": "legacy-startup-asset",
      })],
      ["dsp-idle-shell-1.0.40-incomplete", makeCache({})],
    ]);
    const harness = createHarness({ caches });

    await dispatchWait(harness, "install");
    await dispatchWait(harness, "activate");

    expect(caches.has("dsp-idle-shell-1.0.39-complete")).toBe(true);
    expect(caches.has("dsp-idle-shell-1.0.40-incomplete")).toBe(false);
    harness.setFetch(async () => { throw new TypeError("offline"); });
    const oldAsset = await dispatchFetch(harness, new Request("https://game.example/assets/legacy-abcdef.js"));
    await expect(oldAsset!.text()).resolves.toBe("legacy-startup-asset");
  });

  it("never mutates a completed shell when the same immutable build is registered again", async () => {
    const caches = new Map<string, CacheRecord>();
    const first = createHarness({ caches });
    await dispatchWait(first, "install");
    await dispatchWait(first, "activate");
    const original = await caches.get("dsp-idle-pwa-v2::shell::root::build-new")!
      .requests.get("https://game.example/index.html")!.clone().text();

    const duplicate = createHarness({ caches });
    duplicate.setFetch(async () => { throw new TypeError("candidate network interrupted"); });
    await expect(dispatchWait(duplicate, "install")).resolves.toBeUndefined();

    const preserved = caches.get("dsp-idle-pwa-v2::shell::root::build-new")!
      .requests.get("https://game.example/index.html")!;
    await expect(preserved.clone().text()).resolves.toBe(original);
  });

  it("uses no-store network-first version metadata and falls back to the last known response", async () => {
    const harness = createHarness();
    await dispatchWait(harness, "install");
    await dispatchWait(harness, "activate");

    harness.setFetch(async () => { throw new TypeError("offline"); });
    const response = await dispatchFetch(harness, new Request("https://game.example/version.json", { cache: "no-store" }));

    expect(response).not.toBeNull();
    expect(response!.headers.get("X-DSP-PWA-Fallback")).toBe("last-known-version");
    expect(response!.headers.get("X-DSP-PWA-Status")).toBe("network-unavailable");
    await expect(response!.json()).resolves.toMatchObject({ version: "1.0.40", buildId: "build-new" });
    expect(harness.messages).toContainEqual(expect.objectContaining({
      type: "DSP_PWA_STATUS",
      status: "network-unavailable",
      usedLastKnownVersion: true,
    }));
    expect(harness.fetchCalls.filter((request) => new URL(request.url).pathname === "/version.json"))
      .toSatisfy((requests: Request[]) => requests.length >= 2 && requests.every((request) => request.cache === "no-store"));
  });

  it("rejects invalid network metadata without replacing the last-known version", async () => {
    const harness = createHarness();
    await dispatchWait(harness, "install");
    await dispatchWait(harness, "activate");
    harness.setFetch(async () => new Response(JSON.stringify({ buildId: 40 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await dispatchFetch(harness, new Request("https://game.example/version.json"));

    expect(response!.headers.get("X-DSP-PWA-Status")).toBe("version-check-failed");
    await expect(response!.json()).resolves.toMatchObject({ version: "1.0.40", buildId: "build-new" });
  });

  it("keeps one previous shell across upgrade and serves it only when the current shell is unavailable", async () => {
    const caches = new Map<string, CacheRecord>();
    const oldWorker = createHarness({
      caches,
      workerUrl: "https://game.example/sw.js?v=stable-old&route=root&base=%2F",
    });
    await dispatchWait(oldWorker, "install");
    await dispatchWait(oldWorker, "activate");

    const newWorker = createHarness({ caches });
    await dispatchWait(newWorker, "install");
    await dispatchWait(newWorker, "activate");
    expect(caches.has("dsp-idle-pwa-v2::shell::root::stable-old")).toBe(true);
    expect(caches.has("dsp-idle-pwa-v2::shell::root::build-new")).toBe(true);

    caches.get("dsp-idle-pwa-v2::shell::root::build-new")!.requests.delete("https://game.example/index.html");
    newWorker.setFetch(async () => { throw new TypeError("offline"); });
    const navigation = new Request("https://game.example/", { headers: { Accept: "text/html" } });
    Object.defineProperty(navigation, "mode", { configurable: true, value: "navigate" });
    const response = await dispatchFetch(newWorker, navigation);

    await expect(response!.text()).resolves.toBe("network:/index.html");
    expect(newWorker.messages).toContainEqual(expect.objectContaining({
      type: "DSP_PWA_STATUS",
      status: "stable-fallback",
      previousStable: true,
    }));
  });

  it("supports a code rollback by swapping current and previous completed shells", async () => {
    const caches = new Map<string, CacheRecord>();
    const oldWorker = createHarness({
      caches,
      workerUrl: "https://game.example/sw.js?v=stable-old&route=root&base=%2F",
    });
    await dispatchWait(oldWorker, "install");
    await dispatchWait(oldWorker, "activate");
    const newWorker = createHarness({ caches });
    await dispatchWait(newWorker, "install");
    await dispatchWait(newWorker, "activate");

    const rollbackWorker = createHarness({
      caches,
      workerUrl: "https://game.example/sw.js?v=stable-old&route=root&base=%2F",
    });
    await dispatchWait(rollbackWorker, "install");
    await dispatchWait(rollbackWorker, "activate");

    expect([...caches.keys()].filter((name) => name.startsWith("dsp-idle-pwa-v2::shell::root::"))).toEqual(expect.arrayContaining([
      "dsp-idle-pwa-v2::shell::root::stable-old",
      "dsp-idle-pwa-v2::shell::root::build-new",
    ]));
    const metadata = caches.get("dsp-idle-pwa-v2::meta::root")!.requests
      .get("https://game.example/__dsp_idle_pwa_cache_state__/root")!;
    await expect(metadata.clone().json()).resolves.toMatchObject({
      current: "dsp-idle-pwa-v2::shell::root::stable-old",
      previous: "dsp-idle-pwa-v2::shell::root::build-new",
    });
  });

  it("serves an immutable cross-version hashed asset from the previous shell", async () => {
    const caches = new Map<string, CacheRecord>();
    const oldWorker = createHarness({
      caches,
      workerUrl: "https://game.example/sw.js?v=stable-old&route=root&base=%2F",
    });
    await dispatchWait(oldWorker, "install");
    await dispatchWait(oldWorker, "activate");
    caches.get("dsp-idle-pwa-v2::shell::root::stable-old")!.requests.set(
      "https://game.example/assets/old-hash.js",
      new Response("old-hashed-asset", { status: 200 }),
    );
    const newWorker = createHarness({ caches });
    await dispatchWait(newWorker, "install");
    await dispatchWait(newWorker, "activate");
    newWorker.setFetch(async () => { throw new TypeError("offline"); });

    const response = await dispatchFetch(newWorker, new Request("https://game.example/assets/old-hash.js"));
    await expect(response!.text()).resolves.toBe("old-hashed-asset");
  });

  it("does not let a root worker answer canary requests", async () => {
    const harness = createHarness();
    const response = await dispatchFetch(harness, new Request("https://game.example/canary/build-a/index.html"));
    expect(response).toBeNull();
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it("isolates root, canary and previous route cache names", async () => {
    const caches = new Map<string, CacheRecord>();
    const root = createHarness({ caches });
    const canary = createHarness({
      caches,
      scope: "https://game.example/canary/build-a/",
      workerUrl: "https://game.example/sw.js?v=build-a&route=canary-build-a&base=%2Fcanary%2Fbuild-a%2F",
    });
    const previous = createHarness({
      caches,
      scope: "https://game.example/canary/previous/",
      workerUrl: "https://game.example/sw.js?v=stable-old&route=previous&base=%2Fcanary%2Fprevious%2F",
    });

    await dispatchWait(root, "install");
    await dispatchWait(canary, "install");
    await dispatchWait(previous, "install");

    expect([...caches.keys()]).toEqual(expect.arrayContaining([
      "dsp-idle-pwa-v2::shell::root::build-new",
      "dsp-idle-pwa-v2::shell::canary-build-a::build-a",
      "dsp-idle-pwa-v2::shell::previous::stable-old",
    ]));
  });
});
