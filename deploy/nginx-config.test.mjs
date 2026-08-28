import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./api-handoff-proxy.test.mjs";
import "./release-backup-evidence.test.mjs";
import "./release-switch.test.mjs";

const deployDirectory = path.dirname(fileURLToPath(import.meta.url));
const standaloneConfigs = [
  "nginx-dsp-idle.conf",
  "nginx-dsp-idle-bootstrap.conf",
  "nginx-dsp-idle-hk-bootstrap.conf",
];
const activeCloudProxyTemplates = [
  "nginx-dsp-idle-app.conf",
  ...standaloneConfigs,
];
const allNginxTemplates = [
  ...new Set([
    ...activeCloudProxyTemplates,
    "nginx-dsp-idle-domain.conf",
    "nginx-dsp-idle-download-shanghai.conf",
    "nginx-dsp-idle-download-shanghai-bootstrap.conf",
    "nginx-dsp-idle-old-bridge.conf",
    "nginx-dsp-idle-old-redirect.conf",
  ]),
];

const baselineHeaderNames = [
  "x-content-type-options",
  "x-frame-options",
  "content-security-policy",
  "referrer-policy",
  "permissions-policy",
];

const readDeployFile = (file) => readFile(path.join(deployDirectory, file), "utf8");

function readNginxDurationMs(value, unit) {
  const multipliers = {
    ms: 1,
    s: 1_000,
    m: 60_000,
  };
  return Number(value) * multipliers[unit];
}

function findClosingBrace(source, openingIndex) {
  let depth = 1;
  let quote = null;
  for (let index = openingIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  throw new Error(`unclosed Nginx block at byte ${openingIndex}`);
}

function parseNginxScope(source, start = 0, end = source.length, header = "root") {
  const children = [];
  const directParts = [];
  let cursor = start;
  let segmentStart = start;
  let quote = null;
  for (let index = start; index < end; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === ";") {
      segmentStart = index + 1;
      continue;
    }
    if (character !== "{") continue;
    const closingIndex = findClosingBrace(source, index);
    directParts.push(source.slice(cursor, segmentStart));
    children.push(parseNginxScope(source, index + 1, closingIndex, source.slice(segmentStart, index).trim()));
    cursor = closingIndex + 1;
    segmentStart = cursor;
    index = closingIndex;
  }
  directParts.push(source.slice(cursor, end));
  return { header, direct: directParts.join("\n"), children };
}

function directAddHeaders(scope) {
  const headers = new Map();
  const matches = [...scope.direct.matchAll(/add_header\s+([^\s;]+)\s+("[^"]*"|[^\s;]+)(?:\s+(always))?\s*;/gi)];
  for (const match of matches) {
    const name = match[1].toLowerCase();
    assert.equal(headers.has(name), false, `${scope.header} repeats add_header ${match[1]}`);
    assert.equal(match[3], "always", `${scope.header} add_header ${match[1]} must cover error responses with always`);
    headers.set(name, match[2].startsWith("\"") ? match[2].slice(1, -1) : match[2]);
  }
  const declaredCount = [...scope.direct.matchAll(/\badd_header\b/g)].length;
  assert.equal(matches.length, declaredCount, `${scope.header} contains an unparsed add_header directive`);
  return headers;
}

function walkResponseScopes(scope, inheritedHeaders = new Map(), tls = false, path = []) {
  const ownHeaders = directAddHeaders(scope);
  const effectiveHeaders = ownHeaders.size > 0 ? ownHeaders : inheritedHeaders;
  const ownTls = tls || (scope.header === "server" && /\blisten\s+(?:\[::\]:)?443\b/.test(scope.direct));
  const ownPath = [...path, scope.header];
  const responseScope = scope.header === "server" || scope.header.startsWith("location ");
  const result = responseScope ? [{ scope, effectiveHeaders, tls: ownTls, path: ownPath.join(" > ") }] : [];
  for (const child of scope.children) result.push(...walkResponseScopes(child, effectiveHeaders, ownTls, ownPath));
  return result;
}

function assertSafeCsp(value, label) {
  assert.match(value, /(?:^|;)\s*frame-ancestors\s+'none'(?:;|$)/, `${label} CSP must deny framing`);
  assert.match(value, /(?:^|;)\s*object-src\s+'none'(?:;|$)/, `${label} CSP must deny plugins`);
  const unsafeDirectives = value
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => /(?:^|\s)'unsafe-[^']+'(?:\s|$)/.test(directive));
  assert.ok(
    unsafeDirectives.length === 0 ||
      (unsafeDirectives.length === 1 && /^style-src-attr\s+'unsafe-inline'$/.test(unsafeDirectives[0])),
    `${label} may only use the scoped style-src-attr compatibility allowance`,
  );
  assert.doesNotMatch(value, /(?:^|;)\s*(?:default|script|style|connect|worker|frame)-src\s+[^;]*\*/, `${label} CSP must not use wildcard sources`);
}

async function expandedNginxTemplate(file) {
  let source = await readDeployFile(file);
  if (source.includes("include /etc/nginx/snippets/dsp-idle-app.conf;")) {
    const app = await readDeployFile("nginx-dsp-idle-app.conf");
    source = source.replaceAll("include /etc/nginx/snippets/dsp-idle-app.conf;", app);
  }
  return source;
}

test("active Nginx templates compress static assets while preserving cache boundaries", async () => {
  const configs = await Promise.all(activeCloudProxyTemplates.map(readDeployFile));
  for (const config of configs) {
    assert.match(config, /gzip\s+on;/);
    assert.match(config, /gzip_vary\s+on;/);
    assert.match(config, /gzip_types[^;]*text\/css[^;]*application\/javascript[^;]*application\/json[^;]*image\/svg\+xml;/s);
    assert.match(config, /location \/assets\/[^}]*immutable/s);
    assert.match(config, /location @archived_immutable_asset[^}]*\/var\/www\/dsp-idle\/shared/s);
    assert.match(config, /location = \/version\.json[^}]*no-cache, no-store/s);
    assert.match(config, /location = \/sw\.js[^}]*no-cache, no-store/s);
    assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:4330/);
  }
  const domain = await readFile(path.join(deployDirectory, "nginx-dsp-idle-domain.conf"), "utf8");
  assert.match(domain, /include \/etc\/nginx\/snippets\/dsp-idle-app\.conf;/);
  assert.match(domain, /location \/downloads\/[^}]*return 302 https:\/\/download\.dsponline\.cn\$request_uri;/s);

  const download = await readFile(path.join(deployDirectory, "nginx-dsp-idle-download-shanghai.conf"), "utf8");
  assert.match(download, /server_name download\.dsponline\.cn;/);
  assert.match(download, /location \/downloads\/[^}]*try_files \$uri =404;[^}]*immutable/s);
  assert.match(download, /location = \/version\.json[^}]*no-cache, no-store/s);
  assert.match(download, /location = \/downloads\/android\/stable\.json[^}]*no-cache, no-store/s);
});

test("every Nginx response scope retains the complete security-header baseline", async () => {
  for (const file of allNginxTemplates) {
    const config = await expandedNginxTemplate(file);
    const scopes = walkResponseScopes(parseNginxScope(config));
    assert.ok(scopes.length > 0, `${file} must contain a response scope`);
    for (const { effectiveHeaders, tls, path: scopePath } of scopes) {
      const label = `${file}: ${scopePath}`;
      for (const header of baselineHeaderNames) {
        assert.ok(effectiveHeaders.has(header), `${label} is missing ${header} after Nginx add_header inheritance`);
      }
      assert.equal(effectiveHeaders.get("x-content-type-options"), "nosniff", `${label} must prevent MIME sniffing`);
      assert.equal(effectiveHeaders.get("x-frame-options"), "DENY", `${label} must deny legacy framing`);
      assert.match(effectiveHeaders.get("permissions-policy"), /camera=\(\).*microphone=\(\).*geolocation=\(\)/, `${label} must deny unused device capabilities`);
      assertSafeCsp(effectiveHeaders.get("content-security-policy"), label);
      if (tls) {
        assert.match(
          effectiveHeaders.get("strict-transport-security") ?? "",
          /^max-age=(?:[3-9]\d{7}|[1-9]\d{8,})(?:;|$)/,
          `${label} must retain production HSTS`,
        );
      }
    }
  }
});

test("security-header audit enumerates every shipped Nginx template", async () => {
  const shippedTemplates = (await readdir(deployDirectory))
    .filter((file) => /^nginx.*\.conf$/.test(file))
    .sort();
  assert.deepEqual([...allNginxTemplates].sort(), shippedTemplates);
});

test("application CSP preserves runtime requirements without broad unsafe bypasses", async () => {
  const config = await readDeployFile("nginx-dsp-idle-app.conf");
  const appScope = parseNginxScope(config);
  const csp = directAddHeaders(appScope).get("content-security-policy");
  assert.ok(csp);
  assert.match(csp, /script-src\s+'self'(?:;|$)/);
  assert.match(csp, /worker-src\s+'self'(?:;|$)/);
  assert.match(csp, /connect-src\s+'self'\s+https:\/\/download\.dsponline\.cn(?:;|$)/);
  assert.match(csp, /style-src-attr\s+'unsafe-inline'(?:;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(csp, /style-src(?:\s|$)[^;]*'unsafe-inline'/);
});

test("download-page CSP pins the exact inline stylesheet and keeps downloads cacheable", async () => {
  const [config, template] = await Promise.all([
    readDeployFile("nginx-dsp-idle-download-shanghai.conf"),
    readDeployFile("download-page-template.html"),
  ]);
  const inlineStyle = template.match(/<style>(?<style>[\s\S]*?)<\/style>/)?.groups?.style;
  assert.ok(inlineStyle, "download page must contain the expected inline stylesheet");
  const styleHash = createHash("sha256").update(inlineStyle).digest("base64");
  assert.match(config, new RegExp(`style-src 'self' 'sha256-${styleHash.replaceAll("/", "\\/")}'`));
  assert.match(config, /location \/downloads\/[^}]*try_files \$uri =404;[^}]*default_type application\/octet-stream;[^}]*immutable/s);
  assert.doesNotMatch(config, /proxy_buffering\s+off|slice\s+|max_ranges\s+0/);
});

test("cache, worker scope, gzip and API transfer semantics survive security-header hardening", async () => {
  for (const file of activeCloudProxyTemplates) {
    const config = await readDeployFile(file);
    assert.match(config, /location = \/index\.html[^}]*Cache-Control "no-cache, no-store, must-revalidate" always;/s);
    assert.match(config, /location = \/version\.json[^}]*Cache-Control "no-cache, no-store, must-revalidate" always;/s);
    assert.match(config, /location = \/sw\.js[^}]*Cache-Control "no-cache, no-store, must-revalidate" always;[^}]*Service-Worker-Allowed "\/" always;/s);
    assert.match(config, /location = \/manifest\.webmanifest[^}]*Cache-Control "no-cache" always;/s);
    assert.match(config, /location \/assets\/[^}]*expires 1y;[^}]*Cache-Control "public, max-age=31536000, immutable" always;/s);
    assert.match(config, /location @archived_immutable_asset[^}]*expires 1y;[^}]*Cache-Control "public, max-age=31536000, immutable" always;/s);
    assert.match(config, /location \/api\/[^}]*proxy_pass http:\/\/127\.0\.0\.1:4330;[^}]*proxy_send_timeout 660s;[^}]*proxy_read_timeout 660s;[^}]*proxy_request_buffering off;[^}]*client_max_body_size 128m;/s);
  }
});

test("legacy bridge keeps version and worker cache boundaries with executable worker policy", async () => {
  const config = await readDeployFile("nginx-dsp-idle-old-bridge.conf");
  assert.match(config, /location = \/version\.json[^}]*Cache-Control "no-cache, no-store, must-revalidate" always;/s);
  assert.match(config, /location = \/sw\.js[^}]*script-src 'self'; connect-src 'self'[^}]*Service-Worker-Allowed "\/" always;/s);
});

test("active Nginx cloud proxies cover the shared maximum transfer timeout", async () => {
  const contract = JSON.parse(await readFile(path.join(deployDirectory, "..", "cloud-transfer-contract.json"), "utf8"));
  assert.equal(Number.isSafeInteger(contract.maximumTimeoutMs), true);
  assert.equal(contract.maximumTimeoutMs > 0, true);

  const requiredSafetyMarginMs = 10_000;
  const configuredTimeouts = new Set();
  for (const file of activeCloudProxyTemplates) {
    const config = await readDeployFile(file);
    const apiLocation = config.match(/location \/api\/ \{(?<body>[^}]*)\}/s)?.groups?.body;
    assert.ok(apiLocation, `${file} must define the active /api/ proxy`);

    const timeout = apiLocation.match(/proxy_read_timeout\s+(\d+)(ms|s|m);/);
    assert.ok(timeout, `${file} must define proxy_read_timeout`);
    const timeoutMs = readNginxDurationMs(timeout[1], timeout[2]);
    configuredTimeouts.add(timeoutMs);
    assert.ok(
      timeoutMs >= contract.maximumTimeoutMs + requiredSafetyMarginMs,
      `${file} proxy_read_timeout must cover maximumTimeoutMs plus the safety margin`,
    );
    assert.match(apiLocation, /proxy_send_timeout\s+660s;/);
    assert.match(apiLocation, /proxy_request_buffering\s+off;/);
    assert.match(apiLocation, /client_max_body_size\s+128m;/);
  }

  assert.deepEqual([...configuredTimeouts], [660_000]);
});

test("Hong Kong cloud service authorizes the packaged Android WebView origin", async () => {
  const service = await readFile(path.join(deployDirectory, "dsp-idle-cloud-hk.service"), "utf8");
  const allowedOriginLine = service.split(/\r?\n/).find((line) => line.startsWith("Environment=DSP_ALLOWED_ORIGIN="));
  assert.ok(allowedOriginLine);
  const allowedOrigins = new Set(allowedOriginLine.slice("Environment=DSP_ALLOWED_ORIGIN=".length).split(","));
  assert.equal(allowedOrigins.has("https://dsponline.cn"), true);
  assert.equal(allowedOrigins.has("https://localhost"), true);
  assert.equal(allowedOrigins.has("https://attacker.invalid"), false);
});

test("release templates keep one writer and route public traffic through the handoff proxy", async () => {
  const [legacy, hongKong, active, proxy, preflight, health] = await Promise.all([
    readDeployFile("dsp-idle-cloud.service"),
    readDeployFile("dsp-idle-cloud-hk.service"),
    readDeployFile("dsp-idle-api-active.service"),
    readDeployFile("dsp-idle-api-handoff-proxy.service"),
    readDeployFile("dsp-idle-api-preflight.service"),
    readDeployFile("dsp-idle-healthcheck.service"),
  ]);
  for (const service of [legacy, hongKong]) {
    assert.match(service, /api-writer-lock\.sh/);
    assert.match(service, /TimeoutStopSec=90/);
    assert.match(service, /DSP_API_WRITER_LOCK_FILE=\/run\/dsp-idle-cloud\/writer\.lock/);
    assert.match(service, /EnvironmentFile=\/etc\/dsp-idle-cloud\/runtime\.env/);
    assert.match(service, /RestartPreventExitStatus=75 78/);
    assert.match(service, /StartLimitIntervalSec=60/);
    assert.match(service, /StartLimitBurst=3/);
    assert.match(service, /RuntimeDirectoryPreserve=yes/);
  }
  assert.match(active, /api-active-entry\.sh/);
  assert.match(active, /TimeoutStopSec=90/);
  assert.match(active, /DSP_API_WRITER_LOCK_FILE=\/run\/dsp-idle-cloud\/writer\.lock/);
  assert.match(active, /DSP_RELEASE_ACTIVE_START_FILE=\/var\/lib\/dsp-idle-cloud\/release-state\/pending-switch\.json/);
  assert.match(active, /RestartPreventExitStatus=75 78/);
  assert.match(active, /StartLimitIntervalSec=60/);
  assert.match(active, /StartLimitBurst=3/);
  assert.match(active, /RuntimeDirectoryPreserve=yes/);
  assert.match(active, /dsp-idle-api-active\.service|active cloud API writer/);
  assert.match(proxy, /PORT=4330/);
  assert.match(proxy, /Restart=on-failure/);
  assert.match(proxy, /RestartPreventExitStatus=78/);
  assert.match(proxy, /StartLimitIntervalSec=60/);
  assert.match(proxy, /StartLimitBurst=3/);
  assert.match(proxy, /RuntimeDirectoryPreserve=yes/);
  assert.match(proxy, /DSP_API_PROXY_MAX_HOLD_MS=300000/);
  assert.match(proxy, /TimeoutStopSec=90/);
  assert.match(preflight, /TimeoutStopSec=90/);
  assert.match(preflight, /EnvironmentFile=\/run\/dsp-idle-cloud\/preflight\.env/);
  assert.match(preflight, /release-preflight/);
  assert.match(preflight, /RuntimeDirectoryPreserve=yes/);
  assert.doesNotMatch(preflight, /writer\.lock/);
  assert.match(health, /ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/dsp-idle-release\/current\/probe-api-readiness\.mjs/);
  assert.doesNotMatch(health, /systemctl restart/);
});
