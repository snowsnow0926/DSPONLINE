const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const METHOD_PATTERN = /^[A-Z]+$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PUBLIC_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{12,160}$/;
const CONTROL_OR_BIDI_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

const DEFAULT_ALLOWED_METHODS = Object.freeze(["GET", "POST", "PUT", "DELETE", "OPTIONS"]);
const CURRENT_DSP_HEADER_RULES = Object.freeze({
  // The cloud upload parser owns this field's endpoint-specific error code
  // and legacy compatibility. Header security only bounds its ASCII shape.
  "x-dsp-expected-revision": "bounded-decimal-text",
  "x-dsp-request-id": "operation-id",
  "x-dsp-save-original-bytes": "non-negative-integer",
  "x-dsp-save-compressed-bytes": "non-negative-integer",
  "x-dsp-save-mode": "save-mode",
  "x-dsp-session-mode": "session-mode",
  "x-dsp-csrf-token": "csrf-token",
  "x-dsp-account-import-guard": "sha256",
  "x-dsp-account-import-confirmation": "archive-confirmation",
});

export const CURRENT_REQUEST_HEADER_NAMES = Object.freeze([
  "authorization",
  "content-type",
  "content-encoding",
  "content-length",
  "content-transfer-encoding",
  ...Object.keys(CURRENT_DSP_HEADER_RULES),
]);

export class HttpSecurityError extends Error {
  constructor(code, publicMessage, statusCode = 400) {
    super(publicMessage);
    this.name = "HttpSecurityError";
    this.code = code;
    this.publicMessage = publicMessage;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode = 400) {
  throw new HttpSecurityError(code, message, statusCode);
}

function ownDataValue(value, key) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownEnumerableKeys(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return [];
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function immutableSet(values) {
  const internal = new Set(values);
  return Object.freeze({
    has(value) { return internal.has(value); },
    values() { return internal.values(); },
    [Symbol.iterator]() { return internal[Symbol.iterator](); },
    get size() { return internal.size; },
  });
}

function requestHeadersSource(request) {
  const candidate = ownDataValue(request, "headers");
  return candidate && typeof candidate === "object" ? candidate : request;
}

function rawHeaderPairs(request) {
  const rawHeaders = ownDataValue(request, "rawHeaders");
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return null;
  const pairs = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (typeof rawHeaders[index] !== "string" || typeof rawHeaders[index + 1] !== "string") return null;
    pairs.push([rawHeaders[index], rawHeaders[index + 1]]);
  }
  return pairs;
}

function distinctHeadersSource(request) {
  const source = ownDataValue(request, "headersDistinct");
  return source && typeof source === "object" ? source : null;
}

function headerValues(request, requestedName) {
  const target = requestedName.toLowerCase();
  const raw = rawHeaderPairs(request);
  if (raw) return raw.filter(([name]) => name.toLowerCase() === target).map(([, value]) => value);

  const distinct = distinctHeadersSource(request);
  if (distinct) {
    const values = ownEnumerableKeys(distinct).flatMap((name) => {
      if (name.toLowerCase() !== target) return [];
      const value = ownDataValue(distinct, name);
      return Array.isArray(value) ? value : [value];
    });
    if (values.length > 0) return values;
  }

  const headers = requestHeadersSource(request);
  if (typeof headers?.get === "function") {
    let value = null;
    try { value = headers.get(target); } catch { /* rejected below */ }
    return value === null || value === undefined ? [] : [value];
  }
  return ownEnumerableKeys(headers).flatMap((name) => {
    if (name.toLowerCase() !== target) return [];
    const value = ownDataValue(headers, name);
    return Array.isArray(value) ? value : [value];
  });
}

function allHeaderNames(request) {
  const raw = rawHeaderPairs(request);
  if (raw) return raw.map(([name]) => name.toLowerCase());
  const distinct = distinctHeadersSource(request);
  if (distinct) return ownEnumerableKeys(distinct).map((name) => name.toLowerCase());
  const headers = requestHeadersSource(request);
  if (headers && typeof headers.keys === "function") {
    try { return [...headers.keys()].map((name) => String(name).toLowerCase()); } catch { return []; }
  }
  return ownEnumerableKeys(headers).map((name) => name.toLowerCase());
}

function validHeaderText(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function singleHeader(request, name, { maximumLength = 8_192 } = {}) {
  const values = headerValues(request, name);
  if (values.length === 0) return null;
  if (values.length !== 1) fail("REQUEST_HEADER_DUPLICATE", "请求包含重复的单值请求头");
  const value = values[0];
  if (!validHeaderText(value) || value.length > maximumLength) {
    fail("REQUEST_HEADER_INVALID", "请求头格式无效");
  }
  return value.trim();
}

function parseOrigin(request) {
  const value = singleHeader(request, "origin", { maximumLength: 2_048 });
  if (value === null) return null;
  if (value === "null" || value.includes(",")) fail("CORS_ORIGIN_DENIED", "请求来源未获授权", 403);
  let parsed;
  try { parsed = new URL(value); } catch { fail("CORS_ORIGIN_INVALID", "请求来源格式无效", 403); }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password ||
    parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== value) {
    fail("CORS_ORIGIN_INVALID", "请求来源格式无效", 403);
  }
  return value;
}

function parseContentType(request) {
  const value = singleHeader(request, "content-type", { maximumLength: 512 });
  if (value === null) return null;
  if (value.includes(",")) fail("CONTENT_TYPE_INVALID", "Content-Type 格式无效", 415);
  const parts = value.split(";").map((part) => part.trim());
  const mediaType = parts.shift()?.toLowerCase() ?? "";
  const [type, subtype, extra] = mediaType.split("/");
  if (!type || !subtype || extra !== undefined || !TOKEN_PATTERN.test(type) || !TOKEN_PATTERN.test(subtype)) {
    fail("CONTENT_TYPE_INVALID", "Content-Type 格式无效", 415);
  }
  const parameters = {};
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator <= 0) fail("CONTENT_TYPE_INVALID", "Content-Type 参数无效", 415);
    const key = part.slice(0, separator).trim().toLowerCase();
    let parameterValue = part.slice(separator + 1).trim();
    if (!TOKEN_PATTERN.test(key) || Object.hasOwn(parameters, key)) fail("CONTENT_TYPE_INVALID", "Content-Type 参数无效", 415);
    if (parameterValue.startsWith('"') && parameterValue.endsWith('"') && parameterValue.length >= 2) {
      parameterValue = parameterValue.slice(1, -1);
    }
    if (!parameterValue || !TOKEN_PATTERN.test(parameterValue)) fail("CONTENT_TYPE_INVALID", "Content-Type 参数无效", 415);
    parameters[key] = parameterValue.toLowerCase();
  }
  return Object.freeze({ mediaType, parameters: Object.freeze(parameters) });
}

function parseContentEncoding(request) {
  const value = singleHeader(request, "content-encoding", { maximumLength: 64 });
  if (value === null || value.toLowerCase() === "identity") return "identity";
  if (value.includes(",") || !TOKEN_PATTERN.test(value)) fail("CONTENT_ENCODING_INVALID", "请求压缩格式无效", 415);
  return value.toLowerCase();
}

function parseContentLength(request) {
  const value = singleHeader(request, "content-length", { maximumLength: 32 });
  if (value === null) return null;
  if (!DECIMAL_PATTERN.test(value)) fail("CONTENT_LENGTH_INVALID", "Content-Length 格式无效");
  let parsed;
  try { parsed = BigInt(value); } catch { fail("CONTENT_LENGTH_INVALID", "Content-Length 格式无效"); }
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail("CONTENT_LENGTH_INVALID", "Content-Length 超出安全范围");
  return Number(parsed);
}

function parseAuthorization(request) {
  const value = singleHeader(request, "authorization", { maximumLength: 4_096 });
  if (value === null) return null;
  const match = /^Bearer ([!-~]+)$/i.exec(value);
  if (!match || match[1].length > 4_000) fail("AUTHORIZATION_HEADER_INVALID", "Authorization 请求头无效");
  return Object.freeze({ scheme: "Bearer", credential: match[1] });
}

function parseSafeDecimal(value, code) {
  if (!DECIMAL_PATTERN.test(value)) fail(code, "DSP 请求头数值无效");
  let parsed;
  try { parsed = BigInt(value); } catch { fail(code, "DSP 请求头数值无效"); }
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail(code, "DSP 请求头数值超出安全范围");
  return Number(parsed);
}

function parseDspHeader(name, value) {
  const rule = CURRENT_DSP_HEADER_RULES[name];
  if (rule === "bounded-decimal-text") {
    if (!/^-?[0-9]{1,16}$/.test(value)) fail("EXPECTED_REVISION_INVALID", "预期云修订格式无效");
    return value;
  }
  if (rule === "non-negative-integer") return parseSafeDecimal(value, "DSP_HEADER_NUMBER_INVALID");
  if (rule === "operation-id") {
    if (!OPERATION_ID_PATTERN.test(value)) fail("DSP_REQUEST_ID_INVALID", "DSP 操作标识无效");
    return value;
  }
  if (rule === "save-mode") {
    if (value !== "normal" && value !== "speedrun") fail("DSP_SAVE_MODE_INVALID", "DSP 存档模式请求头无效");
    return value;
  }
  if (rule === "session-mode") {
    // Keep this value aligned with web-session.mjs and the already shipped
    // 1.0.39/1.0.40 clients.  It is a protocol version, not a free-form flag.
    if (value !== "cookie-v1") fail("DSP_SESSION_MODE_INVALID", "DSP 会话模式请求头无效");
    return value;
  }
  if (rule === "csrf-token") {
    // Bound hostile input here; the Web session layer performs the exact
    // cryptographic token comparison and returns its established 403 codes.
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(value)) fail("DSP_CSRF_TOKEN_INVALID", "DSP CSRF 请求头无效");
    return value;
  }
  if (rule === "sha256") {
    if (!SHA256_PATTERN.test(value)) fail("DSP_IMPORT_GUARD_INVALID", "DSP 归档导入 guard 无效");
    return value;
  }
  if (rule === "archive-confirmation") {
    if (!/^REPLACE_CLOUD_SAVES:[a-f0-9]{64}$/.test(value)) {
      fail("DSP_IMPORT_CONFIRMATION_INVALID", "DSP 归档导入确认请求头无效");
    }
    return value;
  }
  fail("DSP_HEADER_UNSUPPORTED", "当前版本不支持该 DSP 请求头");
}

function parseCustomHeaders(request, allowedNames) {
  const allowed = new Set((allowedNames ?? []).map((name) => String(name).toLowerCase()));
  for (const name of allowed) {
    if (!Object.hasOwn(CURRENT_DSP_HEADER_RULES, name)) fail("HTTP_SECURITY_CONFIGURATION_INVALID", "HTTP 安全策略包含未知 DSP 请求头", 500);
  }
  for (const name of new Set(allHeaderNames(request))) {
    if (!name.startsWith("x-dsp-")) continue;
    if (!Object.hasOwn(CURRENT_DSP_HEADER_RULES, name)) fail("DSP_HEADER_UNSUPPORTED", "当前版本不支持该 DSP 请求头");
    if (!allowed.has(name)) fail("DSP_HEADER_NOT_ALLOWED", "当前接口不接受该 DSP 请求头");
  }
  const result = {};
  for (const name of allowed) {
    const value = singleHeader(request, name, { maximumLength: 512 });
    if (value !== null) result[name] = parseDspHeader(name, value);
  }
  const guard = result["x-dsp-account-import-guard"];
  const confirmation = result["x-dsp-account-import-confirmation"];
  if (guard !== undefined && confirmation !== undefined && confirmation !== `REPLACE_CLOUD_SAVES:${guard}`) {
    fail("DSP_IMPORT_CONFIRMATION_MISMATCH", "DSP 归档导入确认请求头与 guard 不匹配");
  }
  return Object.freeze(result);
}

function normalizeAllowedOrigins(values) {
  if (!Array.isArray(values)) fail("HTTP_SECURITY_CONFIGURATION_INVALID", "CORS Origin 白名单配置无效", 500);
  const result = new Set();
  for (const value of values) {
    if (typeof value !== "string" || value === "null" || value === "*" || !validHeaderText(value)) {
      fail("HTTP_SECURITY_CONFIGURATION_INVALID", "CORS Origin 白名单配置无效", 500);
    }
    let parsed;
    try { parsed = new URL(value); } catch { fail("HTTP_SECURITY_CONFIGURATION_INVALID", "CORS Origin 白名单配置无效", 500); }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== value || parsed.pathname !== "/" ||
      parsed.search || parsed.hash || parsed.username || parsed.password) {
      fail("HTTP_SECURITY_CONFIGURATION_INVALID", "CORS Origin 白名单配置无效", 500);
    }
    result.add(value);
  }
  return immutableSet(result);
}

function normalizedHeaderNames(values, label) {
  if (!Array.isArray(values)) fail("HTTP_SECURITY_CONFIGURATION_INVALID", `${label} 配置无效`, 500);
  const result = new Set();
  for (const value of values) {
    const name = typeof value === "string" ? value.toLowerCase() : "";
    if (!HEADER_NAME_PATTERN.test(name)) fail("HTTP_SECURITY_CONFIGURATION_INVALID", `${label} 配置无效`, 500);
    result.add(name);
  }
  return immutableSet(result);
}

export function createCorsPolicy({
  allowedOrigins = [],
  allowedMethods = DEFAULT_ALLOWED_METHODS,
  allowedHeaders = CURRENT_REQUEST_HEADER_NAMES.filter((name) => name !== "content-length"),
  allowCredentials = false,
  maximumAgeSeconds = 600,
} = {}) {
  const origins = normalizeAllowedOrigins(allowedOrigins);
  const configuredMethods = new Set((Array.isArray(allowedMethods) ? allowedMethods : []).map((method) => String(method).toUpperCase()));
  if (configuredMethods.size === 0 || [...configuredMethods].some((method) => !METHOD_PATTERN.test(method)) || !configuredMethods.has("OPTIONS")) {
    fail("HTTP_SECURITY_CONFIGURATION_INVALID", "CORS 方法配置无效", 500);
  }
  const methods = immutableSet(configuredMethods);
  const headers = normalizedHeaderNames(allowedHeaders, "CORS 请求头");
  if (!Number.isSafeInteger(maximumAgeSeconds) || maximumAgeSeconds < 0 || maximumAgeSeconds > 86_400) {
    fail("HTTP_SECURITY_CONFIGURATION_INVALID", "CORS 预检缓存配置无效", 500);
  }
  return Object.freeze({
    allowedOrigins: origins,
    allowedMethods: methods,
    allowedHeaders: headers,
    allowCredentials: allowCredentials === true,
    maximumAgeSeconds,
  });
}

function parseRequestedHeaders(request) {
  const value = singleHeader(request, "access-control-request-headers", { maximumLength: 2_048 });
  if (value === null || value === "") return [];
  const names = value.split(",").map((name) => name.trim().toLowerCase());
  if (names.some((name) => !HEADER_NAME_PATTERN.test(name)) || new Set(names).size !== names.length) {
    fail("CORS_PREFLIGHT_HEADERS_INVALID", "CORS 预检请求头无效", 403);
  }
  return names;
}

function mergeVary(...values) {
  const result = [];
  const seen = new Set();
  for (const value of values.flatMap((candidate) => typeof candidate === "string" ? candidate.split(",") : [])) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    result.push(normalized);
  }
  return result.join(", ");
}

function corsForRequest(request, method, policy) {
  if (!policy) return Object.freeze({ allowed: true, preflight: false, origin: null, headers: Object.freeze({}) });
  const origin = parseOrigin(request);
  if (origin !== null && !policy.allowedOrigins.has(origin)) fail("CORS_ORIGIN_DENIED", "请求来源未获授权", 403);
  const headers = {};
  if (origin !== null) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
    if (policy.allowCredentials) headers["access-control-allow-credentials"] = "true";
  }
  if (method !== "OPTIONS") {
    if (!policy.allowedMethods.has(method)) fail("CORS_METHOD_DENIED", "请求方法未获 CORS 授权", 405);
    return Object.freeze({ allowed: true, preflight: false, origin, headers: Object.freeze(headers) });
  }

  const requestedMethodValue = singleHeader(request, "access-control-request-method", { maximumLength: 32 });
  if (origin === null && requestedMethodValue === null) {
    return Object.freeze({ allowed: true, preflight: false, origin: null, headers: Object.freeze({}) });
  }
  if (origin === null || requestedMethodValue === null) fail("CORS_PREFLIGHT_INVALID", "CORS 预检请求无效", 403);
  const requestedMethod = requestedMethodValue.toUpperCase();
  if (!METHOD_PATTERN.test(requestedMethod) || !policy.allowedMethods.has(requestedMethod) || requestedMethod === "OPTIONS") {
    fail("CORS_METHOD_DENIED", "CORS 预检方法未获授权", 403);
  }
  const requestedHeaders = parseRequestedHeaders(request);
  if (requestedHeaders.some((name) => !policy.allowedHeaders.has(name))) {
    fail("CORS_HEADERS_DENIED", "CORS 预检请求头未获授权", 403);
  }
  headers["access-control-allow-methods"] = [...policy.allowedMethods].join(", ");
  headers["access-control-allow-headers"] = [...policy.allowedHeaders].join(", ");
  headers["access-control-max-age"] = String(policy.maximumAgeSeconds);
  headers.vary = mergeVary(headers.vary, "Access-Control-Request-Method", "Access-Control-Request-Headers");
  return Object.freeze({
    allowed: true,
    preflight: true,
    requestedMethod,
    requestedHeaders: Object.freeze(requestedHeaders),
    origin,
    headers: Object.freeze(headers),
  });
}

function frozenStringSet(values, label) {
  if (!Array.isArray(values) || values.length === 0) fail("HTTP_SECURITY_CONFIGURATION_INVALID", `${label} 配置无效`, 500);
  const set = new Set(values.map((value) => String(value).toLowerCase()));
  return immutableSet(set);
}

function normalizeContentTypeParameterPolicy(mediaTypeLimits, configured) {
  if (configured !== undefined && (!configured || typeof configured !== "object" || Array.isArray(configured))) {
    fail("HTTP_SECURITY_CONFIGURATION_INVALID", "Content-Type 参数策略无效", 500);
  }
  const result = {};
  for (const mediaType of Object.keys(mediaTypeLimits)) {
    const defaults = mediaType === "application/json" || mediaType.endsWith("+json")
      ? { charset: ["utf-8"] }
      : {};
    const source = configured === undefined ? defaults : ownDataValue(configured, mediaType) ?? {};
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      fail("HTTP_SECURITY_CONFIGURATION_INVALID", "Content-Type 参数策略无效", 500);
    }
    const parameters = {};
    for (const rawName of ownEnumerableKeys(source)) {
      const name = rawName.toLowerCase();
      const rawValues = ownDataValue(source, rawName);
      if (!TOKEN_PATTERN.test(name) || !Array.isArray(rawValues) || rawValues.length === 0) {
        fail("HTTP_SECURITY_CONFIGURATION_INVALID", "Content-Type 参数策略无效", 500);
      }
      const values = rawValues.map((value) => typeof value === "string" ? value.toLowerCase() : "");
      if (values.some((value) => !TOKEN_PATTERN.test(value))) {
        fail("HTTP_SECURITY_CONFIGURATION_INVALID", "Content-Type 参数策略无效", 500);
      }
      parameters[name] = Object.freeze([...new Set(values)]);
    }
    result[mediaType] = Object.freeze(parameters);
  }
  return Object.freeze(result);
}

export function createBodyCapability({
  name = "json",
  mediaTypeLimits = { "application/json": 64 * 1024 },
  contentEncodings = ["identity", "gzip"],
  requireContentLength = false,
  allowEmpty = false,
  allowedCustomHeaders = [],
  contentTypeParameters = undefined,
} = {}) {
  if (!mediaTypeLimits || typeof mediaTypeLimits !== "object" || Array.isArray(mediaTypeLimits)) {
    fail("HTTP_SECURITY_CONFIGURATION_INVALID", "请求体媒体类型配置无效", 500);
  }
  const limits = {};
  for (const mediaType of ownEnumerableKeys(mediaTypeLimits)) {
    const normalized = mediaType.toLowerCase();
    const limit = ownDataValue(mediaTypeLimits, mediaType);
    if (!/^[-!#$%&'*+.^_`|~0-9a-z]+\/[-!#$%&'*+.^_`|~0-9a-z]+$/.test(normalized) ||
      !Number.isSafeInteger(limit) || limit < 1) {
      fail("HTTP_SECURITY_CONFIGURATION_INVALID", "请求体媒体类型上限配置无效", 500);
    }
    limits[normalized] = limit;
  }
  if (Object.keys(limits).length === 0) fail("HTTP_SECURITY_CONFIGURATION_INVALID", "请求体媒体类型配置为空", 500);
  const encodings = frozenStringSet(contentEncodings, "请求压缩格式");
  if ([...encodings].some((encoding) => !TOKEN_PATTERN.test(encoding))) {
    fail("HTTP_SECURITY_CONFIGURATION_INVALID", "请求压缩格式配置无效", 500);
  }
  const custom = [...new Set(allowedCustomHeaders.map((header) => String(header).toLowerCase()))];
  for (const header of custom) {
    if (!Object.hasOwn(CURRENT_DSP_HEADER_RULES, header)) fail("HTTP_SECURITY_CONFIGURATION_INVALID", "自定义请求头配置无效", 500);
  }
  return Object.freeze({
    name: String(name).slice(0, 64),
    kind: "body",
    mediaTypeLimits: Object.freeze(limits),
    contentTypeParameters: normalizeContentTypeParameterPolicy(limits, contentTypeParameters),
    contentEncodings: encodings,
    requireContentLength: requireContentLength === true,
    allowEmpty: allowEmpty === true,
    allowedCustomHeaders: Object.freeze(custom),
  });
}

export function noBodyCapability({ allowedCustomHeaders = [] } = {}) {
  const custom = [...new Set(allowedCustomHeaders.map((header) => String(header).toLowerCase()))];
  for (const header of custom) {
    if (!Object.hasOwn(CURRENT_DSP_HEADER_RULES, header)) fail("HTTP_SECURITY_CONFIGURATION_INVALID", "自定义请求头配置无效", 500);
  }
  return Object.freeze({
    name: "none",
    kind: "none",
    mediaTypeLimits: Object.freeze({}),
    contentTypeParameters: Object.freeze({}),
    contentEncodings: immutableSet(["identity"]),
    requireContentLength: false,
    allowEmpty: true,
    allowedCustomHeaders: Object.freeze(custom),
  });
}

export function cloudSaveBodyCapability(contract) {
  if (!contract || typeof contract !== "object") fail("HTTP_SECURITY_CONFIGURATION_INVALID", "云传输契约无效", 500);
  return createBodyCapability({
    name: "cloud-save-upload",
    mediaTypeLimits: {
      "application/json": contract.legacyJsonRequestLimitBytes,
      [contract.directPayloadContentType]: contract.requestCompressedLimitBytes,
    },
    contentEncodings: ["identity", "gzip"],
    allowedCustomHeaders: [
      contract.expectedRevisionHeader,
      contract.requestIdHeader,
      contract.originalBytesHeader,
      contract.compressedBytesHeader,
      "x-dsp-save-mode",
      "x-dsp-session-mode",
      "x-dsp-csrf-token",
    ],
  });
}

export function accountArchiveBodyCapability(maximumBytes) {
  return createBodyCapability({
    name: "account-archive-import",
    mediaTypeLimits: { "application/vnd.dspidle.account-archive+zip": maximumBytes },
    contentEncodings: ["identity"],
    requireContentLength: true,
    allowedCustomHeaders: [
      "x-dsp-account-import-guard",
      "x-dsp-account-import-confirmation",
      "x-dsp-session-mode",
      "x-dsp-csrf-token",
    ],
    // This parameter is already covered by the account archive import tests
    // and therefore remains part of the compatibility boundary.
    contentTypeParameters: {
      "application/vnd.dspidle.account-archive+zip": { charset: ["binary"] },
    },
  });
}

function validateContentTypeParameters(contentType, capability) {
  if (!contentType) return;
  const keys = Object.keys(contentType.parameters);
  if (keys.length === 0) return;
  const policy = ownDataValue(capability?.contentTypeParameters, contentType.mediaType) ?? {};
  for (const key of keys) {
    const allowed = ownDataValue(policy, key);
    if (!Array.isArray(allowed) || !allowed.includes(contentType.parameters[key])) {
      fail("CONTENT_TYPE_PARAMETERS_UNSUPPORTED", "当前接口不支持该 Content-Type 参数", 415);
    }
  }
}

function parseMethod(request) {
  const method = ownDataValue(request, "method") ?? "GET";
  if (typeof method !== "string" || !METHOD_PATTERN.test(method) || method.length > 16) {
    fail("REQUEST_METHOD_INVALID", "请求方法无效", 405);
  }
  return method;
}

export function inspectHttpRequest(request, { corsPolicy = null, bodyCapability = noBodyCapability() } = {}) {
  if (!request || (typeof request !== "object" && typeof request !== "function")) {
    fail("REQUEST_INVALID", "HTTP 请求对象无效");
  }
  const method = parseMethod(request);
  const cors = corsForRequest(request, method, corsPolicy);
  if (cors.preflight) {
    return Object.freeze({ method, preflight: true, cors, authorization: null, body: null, customHeaders: Object.freeze({}) });
  }
  const authorization = parseAuthorization(request);
  const contentType = parseContentType(request);
  const contentEncoding = parseContentEncoding(request);
  const contentLength = parseContentLength(request);
  const customHeaders = parseCustomHeaders(request, bodyCapability.allowedCustomHeaders);
  validateContentTypeParameters(contentType, bodyCapability);

  if (bodyCapability.kind === "none") {
    if (contentLength !== null && contentLength > 0) fail("REQUEST_BODY_NOT_ALLOWED", "当前接口不接受请求正文", 413);
    if (contentEncoding !== "identity") fail("CONTENT_ENCODING_NOT_ALLOWED", "当前接口不接受压缩请求正文", 415);
    return Object.freeze({
      method,
      preflight: false,
      cors,
      authorization,
      customHeaders,
      body: Object.freeze({ contentType, contentEncoding, contentLength, maximumBytes: 0 }),
    });
  }

  if (!contentType || !Object.hasOwn(bodyCapability.mediaTypeLimits, contentType.mediaType)) {
    fail("CONTENT_TYPE_NOT_ALLOWED", "当前接口不接受该 Content-Type", 415);
  }
  if (!bodyCapability.contentEncodings.has(contentEncoding)) {
    fail("CONTENT_ENCODING_NOT_ALLOWED", "当前接口不接受该请求压缩格式", 415);
  }
  if (bodyCapability.requireContentLength && contentLength === null) {
    fail("CONTENT_LENGTH_REQUIRED", "当前接口必须提供 Content-Length", 411);
  }
  if (!bodyCapability.allowEmpty && contentLength === 0) fail("REQUEST_BODY_EMPTY", "请求正文不能为空");
  const maximumBytes = bodyCapability.mediaTypeLimits[contentType.mediaType];
  if (contentLength !== null && contentLength > maximumBytes) {
    fail("REQUEST_BODY_TOO_LARGE", "请求内容超过当前接口允许上限", 413);
  }
  return Object.freeze({
    method,
    preflight: false,
    cors,
    authorization,
    customHeaders,
    body: Object.freeze({ contentType, contentEncoding, contentLength, maximumBytes }),
  });
}

export function securityResponseHeaders({
  privacy = "private",
  responseKind = "api",
  cors = null,
  cacheControl = null,
  secureTransport = false,
} = {}) {
  if (privacy !== "private" && privacy !== "public") {
    fail("HTTP_SECURITY_CONFIGURATION_INVALID", "响应隐私策略无效", 500);
  }
  if (!["api", "error", "download"].includes(responseKind)) {
    fail("HTTP_SECURITY_CONFIGURATION_INVALID", "响应类型策略无效", 500);
  }
  const corsHeaders = cors?.headers && typeof cors.headers === "object" ? cors.headers : {};
  const crossOrigin = typeof ownDataValue(corsHeaders, "access-control-allow-origin") === "string";
  if (cacheControl !== null && !validHeaderText(cacheControl)) {
    fail("HTTP_SECURITY_CONFIGURATION_INVALID", "响应缓存策略无效", 500);
  }
  const headers = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), browsing-topics=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": crossOrigin ? "cross-origin" : "same-site",
    "cache-control": cacheControl ?? (privacy === "private" || responseKind === "error"
      ? "private, no-store"
      : "public, max-age=0, must-revalidate"),
  };
  if (secureTransport) headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  const allowedCorsResponseHeaders = new Set([
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-max-age",
    "access-control-expose-headers",
    "vary",
  ]);
  for (const name of ownEnumerableKeys(corsHeaders)) {
    const value = ownDataValue(corsHeaders, name);
    const normalizedName = name.toLowerCase();
    if (allowedCorsResponseHeaders.has(normalizedName) && typeof value === "string" && validHeaderText(value)) {
      headers[normalizedName] = value;
    }
  }
  return Object.freeze(headers);
}

function utf8Length(value) {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value, maximumBytes) {
  if (utf8Length(value) <= maximumBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = utf8Length(character);
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function unicodeWithoutUnpairedSurrogates(value, rejectInvalid = false) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
        continue;
      }
      if (rejectInvalid) fail("JSON_STRING_UNICODE_INVALID", "JSON 字符串包含无效 Unicode");
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      if (rejectInvalid) fail("JSON_STRING_UNICODE_INVALID", "JSON 字符串包含无效 Unicode");
      continue;
    }
    result += value[index];
  }
  return result;
}

function publicString(value, maximumBytes = 512) {
  if (typeof value !== "string") return null;
  let normalized;
  try { normalized = unicodeWithoutUnpairedSurrogates(value).normalize("NFC"); } catch { normalized = unicodeWithoutUnpairedSurrogates(value); }
  normalized = normalized.replace(CONTROL_OR_BIDI_PATTERN, "");
  return truncateUtf8(normalized, maximumBytes);
}

function sensitivePublicKey(key) {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact === "ip" || compact.includes("token") || compact.includes("password") || compact.includes("passwd") ||
    compact.includes("secret") || compact.includes("email") || compact.includes("checksum") || compact.includes("payload") ||
    compact.includes("authorization") || compact.includes("cookie") || compact.includes("accountid") || compact.includes("userid") ||
    compact.includes("factoryid") || compact.includes("revision") || compact.includes("sessionid") || compact.includes("ipaddress") ||
    compact.includes("internalpath") || compact.includes("absolutepath") || compact.includes("filepath");
}

function validatedJsonString(value, schema) {
  if (typeof value !== "string") fail("JSON_FIELD_TYPE_INVALID", "JSON 字段类型无效");
  let normalized = unicodeWithoutUnpairedSurrogates(value, true);
  try { normalized = normalized.normalize("NFC"); } catch { fail("JSON_STRING_UNICODE_INVALID", "JSON 字符串包含无效 Unicode"); }
  if (schema.trim === true) normalized = normalized.trim();
  const bytes = utf8Length(normalized);
  if (bytes < (schema.minimumBytes ?? 0) || bytes > (schema.maximumBytes ?? 4_096)) {
    fail("JSON_STRING_LENGTH_INVALID", "JSON 字符串长度超出允许范围");
  }
  if (schema.pattern instanceof RegExp && !schema.pattern.test(normalized)) {
    fail("JSON_STRING_FORMAT_INVALID", "JSON 字符串格式无效");
  }
  if (Array.isArray(schema.values) && !schema.values.includes(normalized)) {
    fail("JSON_STRING_VALUE_INVALID", "JSON 字符串取值无效");
  }
  return normalized;
}

function validateJsonValue(value, schema, state, depth) {
  if (!schema || typeof schema !== "object") fail("JSON_SCHEMA_INVALID", "JSON 路由校验规则无效", 500);
  if (depth > state.maximumDepth) fail("JSON_DEPTH_EXCEEDED", "JSON 对象嵌套过深");
  state.nodes += 1;
  if (state.nodes > state.maximumNodes) fail("JSON_NODE_LIMIT_EXCEEDED", "JSON 对象包含过多字段或元素");

  if (schema.type === "string") return validatedJsonString(value, schema);
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || schema.integer === true && !Number.isSafeInteger(value)) {
      fail("JSON_FIELD_TYPE_INVALID", "JSON 数值字段无效");
    }
    if (Number.isFinite(schema.minimum) && value < schema.minimum || Number.isFinite(schema.maximum) && value > schema.maximum) {
      fail("JSON_NUMBER_RANGE_INVALID", "JSON 数值字段超出允许范围");
    }
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail("JSON_FIELD_TYPE_INVALID", "JSON 布尔字段无效");
    return value;
  }
  if (schema.type === "literal") {
    if (!Array.isArray(schema.values) || !schema.values.includes(value)) fail("JSON_LITERAL_INVALID", "JSON 字段取值无效");
    return value;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) fail("JSON_FIELD_TYPE_INVALID", "JSON 数组字段无效");
    if (state.seen.has(value)) fail("JSON_CYCLE_INVALID", "JSON 对象不能包含循环引用");
    const maximumItems = Number.isSafeInteger(schema.maximumItems) ? schema.maximumItems : 100;
    const minimumItems = Number.isSafeInteger(schema.minimumItems) ? schema.minimumItems : 0;
    if (value.length < minimumItems || value.length > maximumItems) fail("JSON_ARRAY_LENGTH_INVALID", "JSON 数组长度超出允许范围");
    state.seen.add(value);
    try {
      return value.map((item) => validateJsonValue(item, schema.items, state, depth + 1));
    } finally {
      state.seen.delete(value);
    }
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("JSON_FIELD_TYPE_INVALID", "JSON 对象字段无效");
    if (state.seen.has(value)) fail("JSON_CYCLE_INVALID", "JSON 对象不能包含循环引用");
    let prototype;
    try { prototype = Object.getPrototypeOf(value); } catch { fail("JSON_OBJECT_INVALID", "JSON 对象结构无效"); }
    if (prototype !== Object.prototype && prototype !== null) fail("JSON_OBJECT_INVALID", "JSON 对象结构无效");
    const fields = schema.fields && typeof schema.fields === "object" ? schema.fields : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const keys = ownEnumerableKeys(value);
    if (schema.allowUnknown !== true && keys.some((key) => !Object.hasOwn(fields, key))) {
      fail("JSON_UNKNOWN_FIELD", "JSON 对象包含当前接口不支持的字段");
    }
    state.seen.add(value);
    try {
      const result = {};
      for (const key of ownEnumerableKeys(fields)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) {
          if (required.has(key)) fail("JSON_REQUIRED_FIELD_MISSING", "JSON 对象缺少必填字段");
          continue;
        }
        result[key] = validateJsonValue(descriptor.value, ownDataValue(fields, key), state, depth + 1);
      }
      return result;
    } finally {
      state.seen.delete(value);
    }
  }
  fail("JSON_SCHEMA_INVALID", "JSON 路由校验规则无效", 500);
}

export function validateJsonDto(value, schema, { maximumDepth = 8, maximumNodes = 1_024 } = {}) {
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 1 || maximumDepth > 32 ||
    !Number.isSafeInteger(maximumNodes) || maximumNodes < 1 || maximumNodes > 100_000) {
    fail("HTTP_SECURITY_CONFIGURATION_INVALID", "JSON DTO 校验上限无效", 500);
  }
  return validateJsonValue(value, schema, { maximumDepth, maximumNodes, nodes: 0, seen: new WeakSet() }, 0);
}

export const ACCOUNT_JSON_SCHEMAS = Object.freeze({
  register: Object.freeze({
    type: "object",
    required: Object.freeze(["username", "password", "displayName"]),
    fields: Object.freeze({
      username: { type: "string", trim: true, minimumBytes: 4, maximumBytes: 24, pattern: /^[A-Za-z0-9_]{4,24}$/ },
      password: { type: "string", minimumBytes: 8, maximumBytes: 512 },
      displayName: { type: "string", trim: true, minimumBytes: 2, maximumBytes: 96 },
      deviceName: { type: "string", trim: true, minimumBytes: 1, maximumBytes: 320 },
      deviceId: { type: "string", minimumBytes: 16, maximumBytes: 96, pattern: /^[A-Za-z0-9_-]{16,96}$/ },
    }),
  }),
  login: Object.freeze({
    type: "object",
    required: Object.freeze(["identifier", "password"]),
    fields: Object.freeze({
      identifier: { type: "string", trim: true, minimumBytes: 1, maximumBytes: 254 },
      password: { type: "string", minimumBytes: 1, maximumBytes: 512 },
      deviceName: { type: "string", trim: true, minimumBytes: 1, maximumBytes: 320 },
      deviceId: { type: "string", minimumBytes: 16, maximumBytes: 96, pattern: /^[A-Za-z0-9_-]{16,96}$/ },
    }),
  }),
  resetPassword: Object.freeze({
    type: "object",
    required: Object.freeze(["token", "password"]),
    fields: Object.freeze({
      token: { type: "string", minimumBytes: 32, maximumBytes: 256 },
      password: { type: "string", minimumBytes: 8, maximumBytes: 512 },
      deviceName: { type: "string", trim: true, minimumBytes: 1, maximumBytes: 320 },
      deviceId: { type: "string", minimumBytes: 16, maximumBytes: 96, pattern: /^[A-Za-z0-9_-]{16,96}$/ },
    }),
  }),
  changePassword: Object.freeze({
    type: "object",
    required: Object.freeze(["currentPassword", "newPassword"]),
    fields: Object.freeze({
      currentPassword: { type: "string", minimumBytes: 1, maximumBytes: 512 },
      newPassword: { type: "string", minimumBytes: 8, maximumBytes: 512 },
    }),
  }),
  tokenOnly: Object.freeze({
    type: "object",
    required: Object.freeze(["token"]),
    fields: Object.freeze({
      token: { type: "string", minimumBytes: 32, maximumBytes: 256 },
    }),
  }),
  emailOnly: Object.freeze({
    type: "object",
    required: Object.freeze(["email"]),
    fields: Object.freeze({
      email: { type: "string", trim: true, minimumBytes: 3, maximumBytes: 254 },
    }),
  }),
  revokeSession: Object.freeze({
    type: "object",
    required: Object.freeze(["sessionId"]),
    fields: Object.freeze({
      sessionId: { type: "string", minimumBytes: 8, maximumBytes: 192, pattern: /^[A-Za-z0-9_-]{8,192}$/ },
    }),
  }),
  deleteAccount: Object.freeze({
    type: "object",
    required: Object.freeze(["confirmation", "password"]),
    fields: Object.freeze({
      confirmation: { type: "literal", values: Object.freeze(["DELETE"]) },
      password: { type: "string", minimumBytes: 1, maximumBytes: 512 },
    }),
  }),
});

const CLIENT_DIAGNOSTICS_SCHEMA = Object.freeze({
  type: "object",
  fields: Object.freeze({
    generatedAt: { type: "number", minimum: 0 },
    application: {
      type: "object",
      fields: {
        name: { type: "string", maximumBytes: 96 },
        version: { type: "string", maximumBytes: 64 },
        build: { type: "string", maximumBytes: 128 },
        displayMode: { type: "string", maximumBytes: 32 },
      },
    },
    environment: {
      type: "object",
      fields: {
        userAgent: { type: "string", maximumBytes: 512 },
        language: { type: "string", maximumBytes: 64 },
        online: { type: "boolean" },
        viewport: {
          type: "object",
          fields: {
            width: { type: "number", minimum: 0, maximum: 100_000 },
            height: { type: "number", minimum: 0, maximum: 100_000 },
            devicePixelRatio: { type: "number", minimum: 0, maximum: 100 },
          },
        },
        coarsePointer: { type: "boolean" },
        reducedMotion: { type: "boolean" },
        memory: {
          type: "object",
          nullable: true,
          fields: {
            used: { type: "number", minimum: 0 },
            limit: { type: "number", minimum: 0 },
          },
        },
      },
    },
    factory: {
      type: "object",
      nullable: true,
      fields: {
        stateVersion: { type: "number", integer: true, minimum: 0, maximum: 10_000 },
        elapsedSeconds: { type: "number", minimum: 0 },
        activePlanetId: { type: "string", maximumBytes: 192 },
        entities: { type: "number", integer: true, minimum: 0 },
        belts: { type: "number", integer: true, minimum: 0 },
        completedTechnologies: { type: "number", integer: true, minimum: 0 },
        paused: { type: "boolean" },
      },
    },
    performanceReport: {
      type: "object",
      nullable: true,
      fields: {
        generatedAt: { type: "number", minimum: 0 },
        deterministic: { type: "boolean" },
        benchmarkMs: { type: "number", minimum: 0 },
        idleSuiteMs: { type: "number", minimum: 0 },
        idleIntegrity: { type: "boolean" },
        recommendedPerformanceMode: { type: "string", maximumBytes: 64 },
      },
    },
    recentErrors: {
      type: "array",
      maximumItems: 20,
      items: {
        type: "object",
        fields: {
          kind: { type: "string", maximumBytes: 40 },
          message: { type: "string", maximumBytes: 2_048 },
          stack: { type: "string", maximumBytes: 8_192 },
          occurredAt: { type: "number", minimum: 0 },
          location: { type: "string", maximumBytes: 1_024 },
        },
      },
    },
  }),
});

const CLIENT_REPORT_HEADER_SCHEMA = Object.freeze({
  type: "object",
  required: Object.freeze(["kind", "message"]),
  fields: Object.freeze({
    kind: { type: "string", trim: true, minimumBytes: 1, maximumBytes: 40, pattern: /^[A-Za-z0-9_-]{1,40}$/ },
    message: { type: "string", trim: true, maximumBytes: 16_000 },
  }),
});

function assertJsonShapeBounds(value, {
  maximumDepth = 8,
  maximumNodes = 1_024,
  maximumArrayItems = 100,
} = {}) {
  const seen = new WeakSet();
  let nodes = 0;
  const visit = (candidate, depth) => {
    nodes += 1;
    if (nodes > maximumNodes) fail("JSON_NODE_LIMIT_EXCEEDED", "JSON 对象包含过多字段或元素");
    if (depth > maximumDepth) fail("JSON_DEPTH_EXCEEDED", "JSON 对象嵌套过深");
    if (!candidate || typeof candidate !== "object") return;
    if (seen.has(candidate)) fail("JSON_CYCLE_INVALID", "JSON 对象不能包含循环引用");
    let prototype;
    try { prototype = Object.getPrototypeOf(candidate); } catch { fail("JSON_OBJECT_INVALID", "JSON 对象结构无效"); }
    if (Array.isArray(candidate)) {
      if (candidate.length > maximumArrayItems) fail("JSON_ARRAY_LENGTH_INVALID", "JSON 数组长度超出允许范围");
    } else if (prototype !== Object.prototype && prototype !== null) {
      fail("JSON_OBJECT_INVALID", "JSON 对象结构无效");
    }
    seen.add(candidate);
    try {
      for (const key of ownEnumerableKeys(candidate)) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("JSON_OBJECT_INVALID", "JSON 对象结构无效");
        visit(descriptor.value, depth + 1);
      }
    } finally {
      seen.delete(candidate);
    }
  };
  visit(value, 0);
}

function redactDiagnosticText(value, maximumBytes) {
  const normalized = publicString(value, maximumBytes);
  if (normalized === null) return "";
  return truncateUtf8(normalized
    .replace(/\bBearer\s+[!-~]{8,}/giu, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu, "[REDACTED_EMAIL]")
    .replace(/\b(?:user|account|session|factory)_[A-Za-z0-9_-]{8,}\b/giu, "[REDACTED_ID]")
    .replace(/\b[a-f0-9]{64}\b/giu, "[REDACTED_DIGEST]")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s<>:"|?*]+[\\/]){1,}[^\s<>:"|?*]*/gu, "[REDACTED_PATH]")
    .replace(/("(?:payload|state|cloudSave)"\s*:\s*")[^"]{16,}/giu, "$1[REDACTED_SAVE]"), maximumBytes);
}

function redactProjectedDiagnostics(value) {
  if (!value || typeof value !== "object") return value;
  const clone = structuredClone(value);
  for (const error of Array.isArray(clone.recentErrors) ? clone.recentErrors : []) {
    if (typeof error.message === "string") error.message = redactDiagnosticText(error.message, 2_048);
    if (typeof error.stack === "string") error.stack = redactDiagnosticText(error.stack, 8_192);
    if (typeof error.location === "string") error.location = redactDiagnosticText(error.location, 1_024);
  }
  return clone;
}

/** Validate and sanitize feedback/error telemetry before it reaches storage. */
export function validateClientReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("JSON_FIELD_TYPE_INVALID", "反馈正文格式无效");
  const allowed = new Set(["kind", "message", "diagnostics"]);
  if (ownEnumerableKeys(value).some((key) => !allowed.has(key))) fail("JSON_UNKNOWN_FIELD", "反馈正文包含当前接口不支持的字段");
  assertJsonShapeBounds(value, { maximumDepth: 8, maximumNodes: 1_024, maximumArrayItems: 100 });
  const header = validateJsonDto({ kind: ownDataValue(value, "kind"), message: ownDataValue(value, "message") }, CLIENT_REPORT_HEADER_SCHEMA);
  const rawDiagnostics = ownDataValue(value, "diagnostics");
  if (rawDiagnostics !== undefined && rawDiagnostics !== null && (typeof rawDiagnostics !== "object" || Array.isArray(rawDiagnostics))) {
    fail("JSON_FIELD_TYPE_INVALID", "诊断摘要格式无效");
  }
  const projected = rawDiagnostics == null
    ? null
    : projectPublicDto(rawDiagnostics, CLIENT_DIAGNOSTICS_SCHEMA, { maximumDepth: 8, maximumBytes: 48 * 1024 });
  return Object.freeze({
    kind: header.kind,
    message: redactDiagnosticText(header.message, 16_000),
    diagnostics: projected == null ? null : redactProjectedDiagnostics(projected),
  });
}

function projectValue(value, schema, state, depth) {
  if (!schema || typeof schema !== "object" || depth > state.maximumDepth) return undefined;
  if (value === null) return schema.nullable === true ? null : undefined;
  if (schema.type === "string") {
    const projected = publicString(value, Number.isSafeInteger(schema.maximumBytes) ? schema.maximumBytes : 512);
    if (projected === null || schema.pattern instanceof RegExp && !schema.pattern.test(projected)) return undefined;
    return projected;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (schema.integer === true && !Number.isSafeInteger(value)) return undefined;
    if (Number.isFinite(schema.minimum) && value < schema.minimum || Number.isFinite(schema.maximum) && value > schema.maximum) return undefined;
    return value;
  }
  if (schema.type === "boolean") return typeof value === "boolean" ? value : undefined;
  if (schema.type === "literal") return Array.isArray(schema.values) && schema.values.includes(value) ? value : undefined;
  if (schema.type === "array") {
    let array = false;
    try { array = Array.isArray(value); } catch { return undefined; }
    if (!array || state.seen.has(value)) return undefined;
    state.seen.add(value);
    const result = [];
    const maximumItems = Number.isSafeInteger(schema.maximumItems) ? Math.max(0, schema.maximumItems) : 100;
    try {
      for (let index = 0; index < Math.min(value.length, maximumItems); index += 1) {
        const item = ownDataValue(value, String(index));
        const projected = projectValue(item, schema.items, state, depth + 1);
        if (projected !== undefined) result.push(projected);
      }
    } finally {
      state.seen.delete(value);
    }
    return result;
  }
  if (schema.type === "object") {
    let array = false;
    try { array = Array.isArray(value); } catch { return undefined; }
    if (!value || typeof value !== "object" || array || state.seen.has(value)) return undefined;
    state.seen.add(value);
    const result = {};
    try {
      const fields = schema.fields && typeof schema.fields === "object" ? schema.fields : {};
      for (const key of ownEnumerableKeys(fields)) {
        if (sensitivePublicKey(key)) continue;
        const projected = projectValue(ownDataValue(value, key), ownDataValue(fields, key), state, depth + 1);
        if (projected !== undefined) result[key] = projected;
      }
    } finally {
      state.seen.delete(value);
    }
    return result;
  }
  return undefined;
}

export function projectPublicDto(value, schema, { maximumDepth = 8, maximumBytes = 256 * 1024 } = {}) {
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 1 || maximumDepth > 32 ||
    !Number.isSafeInteger(maximumBytes) || maximumBytes < 2 || maximumBytes > 4 * 1024 * 1024) {
    fail("HTTP_SECURITY_CONFIGURATION_INVALID", "公开 DTO 投影上限无效", 500);
  }
  const projected = projectValue(value, schema, { maximumDepth, seen: new WeakSet() }, 0);
  if (projected === undefined) return null;
  let encoded;
  try { encoded = JSON.stringify(projected); } catch { return null; }
  if (utf8Length(encoded) > maximumBytes) fail("PUBLIC_DTO_TOO_LARGE", "公开响应超过安全上限", 500);
  return projected;
}

const METRICS_SCHEMA = Object.freeze({
  type: "object",
  fields: Object.freeze({
    energyGeneratedMj: { type: "number", minimum: 0 },
    uploadedWhiteMatrix: { type: "number", minimum: 0 },
    peakWhiteMatrixPerMinute: { type: "number", minimum: 0 },
    peakGenerationKw: { type: "number", minimum: 0 },
    peakThroughputPerMinute: { type: "number", minimum: 0 },
    theoreticalPeakThroughputPerMinute: { type: "number", minimum: 0 },
    activePlanetThroughputPerMinute: { type: "number", minimum: 0 },
    galacticThroughputPerMinute: { type: "number", minimum: 0 },
    peakDysonPowerKw: { type: "number", minimum: 0 },
    exploredSystems: { type: "number", minimum: 0, integer: true },
    colonizedPlanets: { type: "number", minimum: 0, integer: true },
    galaxyScore: { type: "number", minimum: 0 },
    galaxyScoreMetricVersion: { type: "string", maximumBytes: 96 },
    nominalThroughputMetricVersion: { type: "string", maximumBytes: 96 },
    throughputMetricVersion: { type: "string", maximumBytes: 96 },
    throughputWindowSeconds: { type: "number", minimum: 0 },
  }),
});

const LEADERBOARD_ENTRY_SCHEMA = Object.freeze({
  type: "object",
  fields: Object.freeze({
    publicId: { type: "string", maximumBytes: 192, pattern: PUBLIC_IDENTIFIER_PATTERN },
    displayName: { type: "string", maximumBytes: 96 },
    avatar: { type: "string", maximumBytes: 16 },
    seasonId: { type: "string", maximumBytes: 64 },
    metrics: METRICS_SCHEMA,
    submittedAt: { type: "number", minimum: 0 },
    value: { type: "number", minimum: 0 },
    verified: { type: "boolean" },
    rank: { type: "number", minimum: 1, integer: true },
  }),
});

function publicIdentity(entry, publicIdFor, kind) {
  const rawUserId = ownDataValue(entry, "userId");
  const rawAccountId = ownDataValue(entry, "accountId");
  const rawIdentity = typeof rawUserId === "string" ? rawUserId : typeof rawAccountId === "string" ? rawAccountId : null;
  let candidate = ownDataValue(entry, "publicId");
  if (typeof candidate !== "string" && typeof publicIdFor === "function" && rawIdentity) {
    try { candidate = publicIdFor(rawIdentity, kind); } catch { candidate = null; }
  }
  const normalized = publicString(candidate, 192);
  if (!normalized || !PUBLIC_IDENTIFIER_PATTERN.test(normalized) || normalized === rawUserId || normalized === rawAccountId) return null;
  return normalized;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function projectPublicLeaderboard(value, { publicIdFor, maximumEntries = 100 } = {}) {
  const entriesValue = ownDataValue(value, "entries");
  const entries = [];
  for (let index = 0; index < Math.min(safeArray(entriesValue).length, Math.max(0, Math.min(100, maximumEntries))); index += 1) {
    const entry = ownDataValue(entriesValue, String(index));
    const publicId = publicIdentity(entry, publicIdFor, "galaxy");
    if (!publicId) continue;
    const candidate = {
      publicId,
      displayName: ownDataValue(entry, "displayName"),
      avatar: ownDataValue(entry, "avatar"),
      seasonId: ownDataValue(entry, "seasonId"),
      metrics: ownDataValue(entry, "metrics"),
      submittedAt: ownDataValue(entry, "submittedAt"),
      value: ownDataValue(entry, "value"),
      verified: ownDataValue(entry, "verified") === true,
      rank: Number.isSafeInteger(ownDataValue(entry, "rank")) && ownDataValue(entry, "rank") > 0
        ? ownDataValue(entry, "rank")
        : index + 1,
    };
    const projected = projectPublicDto(candidate, LEADERBOARD_ENTRY_SCHEMA);
    if (projected) entries.push({ ...projected, userId: publicId, accountId: publicId });
  }
  return {
    category: publicString(ownDataValue(value, "category"), 64) ?? "galaxy",
    seasonId: publicString(ownDataValue(value, "seasonId"), 64) ?? "season_01",
    entries,
    generatedAt: typeof ownDataValue(value, "generatedAt") === "number" && Number.isFinite(ownDataValue(value, "generatedAt"))
      ? Math.max(0, ownDataValue(value, "generatedAt"))
      : Date.now(),
  };
}

const SPEEDRUN_ENTRY_SCHEMA = Object.freeze({
  type: "object",
  fields: Object.freeze({
    publicId: { type: "string", maximumBytes: 192, pattern: PUBLIC_IDENTIFIER_PATTERN },
    submissionId: { type: "string", maximumBytes: 384 },
    displayName: { type: "string", maximumBytes: 96 },
    avatar: { type: "string", maximumBytes: 16 },
    targetId: { type: "string", maximumBytes: 64 },
    seasonId: { type: "string", maximumBytes: 64 },
    rulesetVersion: { type: "string", maximumBytes: 64 },
    elapsedSeconds: { type: "number", minimum: 0 },
    completedAtSeconds: { type: "number", minimum: 0 },
    completedAt: { type: "number", minimum: 0 },
    receivedAt: { type: "number", minimum: 0 },
    resourceMode: { type: "literal", values: ["finite", "infinite"] },
    verified: { type: "boolean" },
    rank: { type: "number", minimum: 1, integer: true },
  }),
});

export function projectPublicSpeedrunLeaderboard(value, { publicIdFor, maximumEntries = 100 } = {}) {
  const entriesValue = ownDataValue(value, "entries");
  const entries = [];
  for (let index = 0; index < Math.min(safeArray(entriesValue).length, Math.max(0, Math.min(100, maximumEntries))); index += 1) {
    const entry = ownDataValue(entriesValue, String(index));
    const publicId = publicIdentity(entry, publicIdFor, "speedrun");
    if (!publicId) continue;
    const seasonId = publicString(ownDataValue(entry, "seasonId"), 64) ?? "season_01";
    const targetId = publicString(ownDataValue(entry, "targetId"), 64) ?? "unknown";
    const submissionId = `speedrun_${seasonId}_${targetId}_${publicId}`;
    const candidate = {
      publicId,
      submissionId,
      displayName: ownDataValue(entry, "displayName"),
      avatar: ownDataValue(entry, "avatar"),
      targetId,
      seasonId,
      rulesetVersion: ownDataValue(entry, "rulesetVersion"),
      elapsedSeconds: ownDataValue(entry, "elapsedSeconds"),
      completedAtSeconds: ownDataValue(entry, "completedAtSeconds") ?? ownDataValue(entry, "elapsedSeconds"),
      completedAt: ownDataValue(entry, "completedAt"),
      receivedAt: ownDataValue(entry, "receivedAt"),
      resourceMode: ownDataValue(entry, "resourceMode") === "infinite" ? "infinite" : "finite",
      verified: ownDataValue(entry, "verified") === true,
      rank: Number.isSafeInteger(ownDataValue(entry, "rank")) && ownDataValue(entry, "rank") > 0
        ? ownDataValue(entry, "rank")
        : index + 1,
    };
    const projected = projectPublicDto(candidate, SPEEDRUN_ENTRY_SCHEMA);
    if (projected) entries.push({ ...projected, userId: publicId, accountId: publicId });
  }
  return {
    category: publicString(ownDataValue(value, "category"), 64) ?? "speedrun",
    targetId: publicString(ownDataValue(value, "targetId"), 64) ?? "unknown",
    seasonId: publicString(ownDataValue(value, "seasonId"), 64) ?? "season_01",
    rulesetVersion: publicString(ownDataValue(value, "rulesetVersion"), 64) ?? "speedrun-v1",
    entries,
    generatedAt: typeof ownDataValue(value, "generatedAt") === "number" && Number.isFinite(ownDataValue(value, "generatedAt"))
      ? Math.max(0, ownDataValue(value, "generatedAt"))
      : Date.now(),
  };
}

function allowedCodeSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

export function projectPublicError(error, {
  defaultMessage = "服务暂时不可用",
  defaultStatusCode = 500,
  allowedCodes = [],
  messagesByCode = {},
  detailsSchema = null,
} = {}) {
  const trusted = error instanceof HttpSecurityError;
  const rawStatus = trusted ? error.statusCode : ownDataValue(error, "statusCode");
  const statusCode = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus
    : Number.isInteger(defaultStatusCode) && defaultStatusCode >= 400 && defaultStatusCode <= 599 ? defaultStatusCode : 500;
  const rawCode = trusted ? error.code : ownDataValue(error, "code");
  const codeSet = allowedCodeSet(allowedCodes);
  const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{2,95}$/.test(rawCode) && (trusted || codeSet.has(rawCode))
    ? rawCode
    : null;
  const configuredMessage = code ? ownDataValue(messagesByCode, code) : null;
  const message = publicString(
    typeof configuredMessage === "string" ? configuredMessage : trusted ? error.publicMessage : defaultMessage,
    512,
  ) || "服务暂时不可用";
  const body = { error: message, ...(code ? { code } : {}) };
  if (detailsSchema) {
    const details = projectPublicDto(ownDataValue(error, "publicDetails"), detailsSchema, { maximumBytes: 16 * 1024 });
    if (details !== null) body.details = details;
  }
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}
