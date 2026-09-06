import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RANGE_BYTES = 1024;

function absoluteUrl(baseUrl, value) {
  return new URL(value, baseUrl).toString();
}

function cacheControl(response) {
  return response.headers.get("cache-control")?.toLowerCase() || "";
}

function hasNoCache(response) {
  const value = cacheControl(response);
  return value.includes("no-store") || value.includes("no-cache");
}

function hasLongCache(response) {
  const value = cacheControl(response);
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(value)?.[1];
  return value.includes("immutable") || Number(maxAge) >= 86_400;
}

async function readBody(response) {
  return Buffer.from(await response.arrayBuffer());
}

async function request(fetchImpl, url, options = {}) {
  try {
    return await fetchImpl(url, { redirect: "follow", cache: "no-store", ...options });
  } catch (error) {
    throw new Error(`${options.method || "GET"} ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function addFailure(report, check, error) {
  report.errors.push(`${check}: ${error instanceof Error ? error.message : String(error)}`);
}

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function checkFreshResource(report, fetchImpl, url, name, expectedVersion, expectedBuildId) {
  try {
    const response = await request(fetchImpl, url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!hasNoCache(response)) throw new Error("Cache-Control must contain no-store or no-cache");
    const body = await readBody(response);
    if (name === "version.json") {
      let metadata;
      try { metadata = JSON.parse(body.toString("utf8")); }
      catch { throw new Error("response is not valid JSON"); }
      if (expectedVersion && metadata.version !== expectedVersion) {
        throw new Error(`version is ${JSON.stringify(metadata.version)}, expected ${expectedVersion}`);
      }
      if (expectedBuildId && metadata.buildId !== expectedBuildId) {
        throw new Error(`buildId is ${JSON.stringify(metadata.buildId)}, expected ${expectedBuildId}`);
      }
      report.version = { version: metadata.version, buildId: metadata.buildId };
    } else if (expectedVersion && !body.toString("utf8").includes(expectedVersion)) {
      throw new Error(`page does not mention expected version ${expectedVersion}`);
    }
    report.checks.push({ name, ok: true, status: response.status, cacheControl: cacheControl(response) });
  } catch (error) {
    addFailure(report, name, error);
  }
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(value || "");
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === "*" ? null : Number(match[3]) };
}

async function checkArtifact(fetchImpl, baseUrl, artifact, rangeBytes) {
  const name = artifact.name || artifact.path || artifact.url;
  try {
    if (!artifact.url && !artifact.path) throw new Error("artifact needs url or path");
    if (!Number.isSafeInteger(Number(artifact.size)) || Number(artifact.size) < 0) throw new Error("artifact size is required");
    if (!/^[a-f0-9]{64}$/i.test(String(artifact.sha256 || ""))) throw new Error("artifact sha256 is required");
    const url = absoluteUrl(baseUrl, artifact.url || artifact.path);
    const rangeResponse = await request(fetchImpl, url, { headers: { range: `bytes=0-${Math.max(0, rangeBytes - 1)}` } });
    if (rangeResponse.status !== 206) throw new Error(`Range request returned HTTP ${rangeResponse.status}`);
    if (!/bytes/i.test(rangeResponse.headers.get("accept-ranges") || "")) throw new Error("response does not advertise byte ranges");
    const contentRange = parseContentRange(rangeResponse.headers.get("content-range"));
    if (!contentRange || contentRange.total !== Number(artifact.size)) throw new Error("Content-Range total does not match expected size");
    const rangedBody = await readBody(rangeResponse);
    const expectedRangeLength = Math.min(Number(artifact.size), rangeBytes);
    if (rangedBody.byteLength !== expectedRangeLength || contentRange.end - contentRange.start + 1 !== expectedRangeLength) {
      throw new Error("Range body length is invalid");
    }
    if (!hasLongCache(rangeResponse)) throw new Error("artifact Cache-Control must be long-lived or immutable");

    const fullResponse = await request(fetchImpl, url);
    if (!fullResponse.ok) throw new Error(`full download returned HTTP ${fullResponse.status}`);
    if (!hasLongCache(fullResponse)) throw new Error("full artifact Cache-Control must be long-lived or immutable");
    const body = await readBody(fullResponse);
    const actualHash = createHash("sha256").update(body).digest("hex");
    if (body.byteLength !== Number(artifact.size)) throw new Error(`size is ${body.byteLength}, expected ${artifact.size}`);
    if (actualHash !== String(artifact.sha256).toLowerCase()) throw new Error(`sha256 is ${actualHash}, expected ${artifact.sha256}`);
    return { ok: true, check: { name, ok: true, status: fullResponse.status, rangeStatus: rangeResponse.status, size: body.byteLength, sha256: actualHash, cacheControl: cacheControl(fullResponse) } };
  } catch (error) {
    return { ok: false, error: `artifact:${name}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function probeRelease({
  baseUrl,
  pagePath = "/",
  versionPath = "/version.json",
  expectedVersion = "",
  expectedBuildId = "",
  artifacts = [],
  rangeBytes = DEFAULT_RANGE_BYTES,
  concurrency = 4,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!Number.isSafeInteger(Number(rangeBytes)) || Number(rangeBytes) <= 0) throw new Error("rangeBytes must be a positive integer");
  if (!Number.isSafeInteger(Number(concurrency)) || Number(concurrency) <= 0) throw new Error("concurrency must be a positive integer");
  const normalizedBaseUrl = new URL(baseUrl).toString();
  const report = { ok: false, baseUrl: new URL(normalizedBaseUrl).origin, checks: [], errors: [] };
  await checkFreshResource(report, fetchImpl, absoluteUrl(normalizedBaseUrl, pagePath), "download-page", expectedVersion, "");
  await checkFreshResource(report, fetchImpl, absoluteUrl(normalizedBaseUrl, versionPath), "version.json", expectedVersion, expectedBuildId);
  const artifactResults = await mapLimit(artifacts, Number(concurrency), (artifact) => checkArtifact(fetchImpl, normalizedBaseUrl, artifact, Number(rangeBytes)));
  for (const result of artifactResults) {
    if (result.ok) report.checks.push(result.check);
    else report.errors.push(result.error);
  }
  report.ok = report.errors.length === 0;
  return report;
}

export function assertReleaseProbe(report) {
  if (!report?.ok) throw new Error(`Release probe failed:\n${(report?.errors || ["unknown failure"]).join("\n")}`);
  return report;
}

function parseArgs(argv) {
  const args = new Map();
  const artifacts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--artifact") {
      const value = argv[++index];
      if (!value) throw new Error("--artifact requires path=url,size,sha256 or JSON file");
      artifacts.push(value);
      continue;
    }
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    args.set(key.slice(2), value);
  }
  return { args, artifacts };
}

async function parseArtifacts(values, baseUrl) {
  const result = [];
  for (const value of values) {
    if (value.endsWith(".json")) {
      const parsed = JSON.parse(await readFile(path.resolve(value), "utf8"));
      const entries = Array.isArray(parsed) ? parsed : parsed.artifacts;
      if (!Array.isArray(entries)) throw new Error(`Artifact JSON ${value} must contain an artifacts array`);
      result.push(...entries);
      continue;
    }
    const [url, size, sha256] = value.split(",");
    if (!url || size == null || !sha256) throw new Error("--artifact format is URL_OR_PATH,SIZE,SHA256");
    result.push({ url: absoluteUrl(baseUrl, url), size: Number(size), sha256 });
  }
  return result;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMainModule()) {
  try {
    const { args, artifacts } = parseArgs(process.argv.slice(2));
    if (args.has("help") || !args.get("base-url")) throw new Error("Usage: node deploy/probe-release.mjs --base-url URL [--expected-version VERSION] [--expected-build-id ID] [--page-path /] [--version-path /version.json] [--artifact PATH,SIZE,SHA256]");
    const report = await probeRelease({
      baseUrl: args.get("base-url"),
      pagePath: args.get("page-path") || "/",
      versionPath: args.get("version-path") || "/version.json",
      expectedVersion: args.get("expected-version") || "",
      expectedBuildId: args.get("expected-build-id") || "",
      rangeBytes: Number(args.get("range-bytes") || DEFAULT_RANGE_BYTES),
      concurrency: Number(args.get("concurrency") || 4),
      artifacts: await parseArtifacts(artifacts, args.get("base-url")),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
