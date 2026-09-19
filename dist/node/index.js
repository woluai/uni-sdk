import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/core/_internal/retry.ts
var DEFAULT_RETRY = Object.freeze({
  maxRetries: 3,
  maxElapsedMs: 60000,
  initialDelayMs: 500,
  maxDelayMs: 1e4
});
function resolveRetryConfig(override) {
  if (override === false)
    return;
  if (!override)
    return DEFAULT_RETRY;
  return {
    maxRetries: override.maxRetries ?? DEFAULT_RETRY.maxRetries,
    maxElapsedMs: override.maxElapsedMs ?? DEFAULT_RETRY.maxElapsedMs,
    initialDelayMs: override.initialDelayMs ?? DEFAULT_RETRY.initialDelayMs,
    maxDelayMs: override.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs
  };
}
var IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
function isIdempotent(method, explicit) {
  if (explicit !== undefined)
    return explicit;
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}
function isRetryableStatus(status) {
  if (status === 408 || status === 429)
    return true;
  if (status >= 500 && status < 600)
    return true;
  return false;
}
function parseRetryAfterValue(v) {
  if (!v)
    return;
  const trimmed = v.trim();
  if (trimmed === "")
    return;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds))
    return Math.max(0, seconds * 1000);
  const t = Date.parse(trimmed);
  if (!Number.isNaN(t))
    return Math.max(0, t - Date.now());
  return;
}
function parseRetryAfterHeader(res) {
  return parseRetryAfterValue(res.headers.get("retry-after"));
}
function computeBackoff(attempt, cfg, rng = Math.random) {
  const expo = cfg.initialDelayMs * 2 ** attempt;
  const cap = Math.min(cfg.maxDelayMs, expo);
  return Math.floor(rng() * cap);
}
function nextDelay(attempt, cfg, reason, rng = Math.random) {
  if (reason instanceof Response) {
    const retryAfter = parseRetryAfterHeader(reason);
    if (retryAfter !== undefined) {
      return Math.min(retryAfter, cfg.maxDelayMs);
    }
  }
  return computeBackoff(attempt, cfg, rng);
}
function delay(ms, signal) {
  if (ms <= 0)
    return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let onAbort;
    const t = setTimeout(() => {
      if (signal && onAbort)
        signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
function isNetworkErrorRetryable(err) {
  if (!(err instanceof Error))
    return false;
  if (err.name === "AbortError")
    return false;
  if (err.isUnifiedSdkError === true)
    return false;
  return true;
}

// src/core/errors.ts
class UnifiedError extends Error {
  isUnifiedSdkError = true;
  code;
  status;
  constructor(code, message, status, cause) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "UnifiedError";
    this.code = code;
    this.status = status;
  }
}
function subsystemError(code, message) {
  return new UnifiedError(code, message);
}

class StreamInterruptedError extends UnifiedError {
  constructor(cause, message) {
    super("stream_interrupted", message ?? "The model stream ended unexpectedly before completing — the connection dropped mid-response. The model may be slow or the upstream may have timed out; retry, or switch to a different model.", undefined, cause);
    this.name = "StreamInterruptedError";
  }
}

class UnifiedAIError extends UnifiedError {
  body;
  headers;
  requestId;
  constructor(code, message, status, body, headers, cause) {
    super(code, message, status, cause);
    this.name = "UnifiedAIError";
    this.body = body;
    this.headers = headers;
    this.requestId = headers?.["x-request-id"] ?? headers?.["request-id"];
  }
}

class BadRequestError extends UnifiedAIError {
  constructor(message, status, body, headers) {
    super("bad_request", message, status, body, headers);
    this.name = "BadRequestError";
  }
}

class AuthenticationError extends UnifiedAIError {
  constructor(message, status, body, headers, code = "unauthorized", cause) {
    super(code, message, status, body, headers, cause);
    this.name = "AuthenticationError";
  }
}

class UnifiedAIAuthError extends AuthenticationError {
  constructor(code, message, status, body, headers, cause) {
    super(message, status ?? 401, body, headers, code, cause);
    this.name = "UnifiedAIAuthError";
  }
}

class ForbiddenError extends UnifiedAIError {
  constructor(message, status, body, headers, code = "forbidden") {
    super(code, message, status, body, headers);
    this.name = "ForbiddenError";
  }
}

class NotFoundError extends UnifiedAIError {
  constructor(message, status, body, headers) {
    super("not_found", message, status, body, headers);
    this.name = "NotFoundError";
  }
}

class DeprecatedModelError extends UnifiedAIError {
  isDeprecated = true;
  constructor(message, status, body, headers) {
    super("model_deprecated", message, status, body, headers);
    this.name = "DeprecatedModelError";
  }
}
function parseRetryAfter(headers) {
  const ms = parseRetryAfterValue(headers?.["retry-after"]);
  return ms === undefined ? undefined : Math.ceil(ms / 1000);
}

class RateLimitError extends UnifiedAIError {
  retryAfter;
  constructor(message, status, body, headers) {
    super("rate_limited", message, status, body, headers);
    this.name = "RateLimitError";
    this.retryAfter = parseRetryAfter(headers);
  }
}

class UsageLimitError extends UnifiedAIError {
  periodCost;
  limit;
  resetAt;
  isUsageLimit = true;
  constructor(message, status, body, headers) {
    super("usage_limit_exceeded", message, status, body, headers);
    this.name = "UsageLimitError";
    const parsed = parseUsageFields(body);
    this.periodCost = parsed.periodCost;
    this.limit = parsed.limit;
    this.resetAt = parsed.resetAt;
  }
}

class PlanRequiredError extends UnifiedAIError {
  isPlanRequired = true;
  requiredPlan;
  currentPlanId;
  constructor(message, status, body, headers) {
    super("plan_required", message, status, body, headers);
    this.name = "PlanRequiredError";
    const parsed = parsePlanRequiredFields(body);
    this.requiredPlan = parsed.requiredPlan;
    this.currentPlanId = parsed.currentPlanId;
  }
}

class ServerError extends UnifiedAIError {
  constructor(message, status, body, headers) {
    super("server_error", message, status, body, headers);
    this.name = "ServerError";
  }
}
function parsePlanRequiredFields(body) {
  let requiredPlan = "Pro";
  let currentPlanId;
  if (body && typeof body === "object") {
    const obj = body;
    if (typeof obj.required_plan === "string" && obj.required_plan) {
      requiredPlan = obj.required_plan;
    }
    if (typeof obj.current_plan_id === "number" && Number.isFinite(obj.current_plan_id)) {
      currentPlanId = obj.current_plan_id;
    }
  }
  return { requiredPlan, currentPlanId };
}
function isPlanRequiredBody(body) {
  if (!body || typeof body !== "object")
    return false;
  return body.code === "plan_required";
}
var NOT_GRANTED_CODES = new Set(["storage_not_granted", "sync_not_granted", "fs_not_granted"]);
function notGrantedCodeFromBody(body) {
  if (!body || typeof body !== "object")
    return;
  const code = body.code;
  if (typeof code === "string" && NOT_GRANTED_CODES.has(code)) {
    return code;
  }
  return;
}
function parseUsageFields(body) {
  let periodCost;
  let limit;
  let resetAt;
  if (body && typeof body === "object") {
    const obj = body;
    if (typeof obj.period_cost === "number")
      periodCost = obj.period_cost;
    if (typeof obj.limit === "number")
      limit = obj.limit;
    if (typeof obj.reset_at === "string")
      resetAt = obj.reset_at;
    const msg = typeof obj.message === "string" ? obj.message : undefined;
    if (msg && (periodCost === undefined || limit === undefined)) {
      const m = msg.match(/Window\s+cost:\s*\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$([0-9]+(?:\.[0-9]+)?)/i);
      if (m) {
        if (periodCost === undefined)
          periodCost = Number(m[1]);
        if (limit === undefined)
          limit = Number(m[2]);
      }
    }
  }
  return { periodCost, limit, resetAt };
}
function isUsageLimitBody(body) {
  if (!body || typeof body !== "object")
    return false;
  const obj = body;
  if (obj.code === "usage_limit_exceeded")
    return true;
  if (typeof obj.period_cost === "number" && typeof obj.limit === "number")
    return true;
  if (typeof obj.message === "string" && /^\s*usage limit exceeded\b/i.test(obj.message)) {
    return true;
  }
  return false;
}
function isDeprecatedModelBody(body) {
  if (!body || typeof body !== "object")
    return false;
  return body.code === "model_deprecated";
}
function httpErrorCodeFromStatus(status) {
  if (status === 400)
    return "bad_request";
  if (status === 401)
    return "unauthorized";
  if (status === 403)
    return "forbidden";
  if (status === 404)
    return "not_found";
  if (status === 429)
    return "rate_limited";
  if (status >= 500)
    return "server_error";
  return "request_failed";
}
function planRequiredError(currentPlanId = 0, requiredPlan = "Pro") {
  const body = {
    code: "plan_required",
    required_plan: requiredPlan,
    current_plan_id: currentPlanId,
    message: `Cloud sync and persistence require a ${requiredPlan} plan.`
  };
  return new PlanRequiredError(body.message, 403, body);
}
function buildHttpError(message, status, body, headers) {
  if (isDeprecatedModelBody(body)) {
    return new DeprecatedModelError(message, status, body, headers);
  }
  if (isPlanRequiredBody(body)) {
    return new PlanRequiredError(message, status, body, headers);
  }
  const notGranted = notGrantedCodeFromBody(body);
  if (notGranted) {
    return new ForbiddenError(message, status, body, headers, notGranted);
  }
  if (status === 400)
    return new BadRequestError(message, status, body, headers);
  if (status === 401)
    return new AuthenticationError(message, status, body, headers);
  if (status === 403)
    return new ForbiddenError(message, status, body, headers);
  if (status === 404)
    return new NotFoundError(message, status, body, headers);
  if (status === 429) {
    return isUsageLimitBody(body) ? new UsageLimitError(message, status, body, headers) : new RateLimitError(message, status, body, headers);
  }
  if (status >= 500)
    return new ServerError(message, status, body, headers);
  return new UnifiedAIError(httpErrorCodeFromStatus(status), message, status, body, headers);
}
function headersToRecord(h) {
  const out = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return Object.freeze(out);
}

// src/core/core.ts
class Core {
  options;
  constructor(options = {}) {
    this.options = Object.freeze({
      token: options.token,
      apiUrl: options.apiUrl ?? "",
      workspaceId: options.workspaceId ?? "",
      appId: options.appId ?? "",
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      retry: options.retry,
      cache: options.cache,
      onRetry: options.onRetry,
      compression: options.compression,
      storage: options.storage,
      fs: options.fs,
      sync: options.sync,
      callerKind: options.callerKind ?? "app",
      grantStore: options.grantStore
    });
  }
  get defaultCompression() {
    return this.options.compression;
  }
  get apiUrl() {
    return this.options.apiUrl;
  }
  get appId() {
    return this.options.appId;
  }
  get storageBackend() {
    return this.options.storage;
  }
  get fsBackend() {
    return this.options.fs;
  }
  get snapshotBackend() {
    return this.options.sync;
  }
  get callerKind() {
    return this.options.callerKind;
  }
  get grantStore() {
    return this.options.grantStore;
  }
  get serverCapable() {
    return this.options.token !== undefined;
  }
  async request(_path, _options = {}) {
    throw new UnifiedError("not_implemented", "Core.request is not wired up yet");
  }
  async requestBinary(_path, _options = {}) {
    throw new UnifiedError("not_implemented", "Core.requestBinary is not wired up yet");
  }
  async stream(_path, _options = {}) {
    throw new UnifiedError("not_implemented", "Core.stream is not wired up yet");
  }
}
// src/core/session.ts
class Session {
  listeners = new Set;
  _status;
  _expiresAt;
  _identity;
  constructor(initialStatus = "signed_out") {
    this._status = initialStatus;
  }
  get status() {
    return this._status;
  }
  get expiresAt() {
    return this._expiresAt;
  }
  get identity() {
    return this._identity;
  }
  isAuthenticated() {
    if (this._status !== "active")
      return false;
    if (this._expiresAt !== undefined && this._expiresAt <= Date.now())
      return false;
    return true;
  }
  snapshot() {
    return { status: this._status, expiresAt: this._expiresAt, identity: this._identity };
  }
  onChange(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  markSignedIn(opts = {}) {
    this._status = "active";
    this._expiresAt = opts.expiresAt;
    this._identity = opts.identity;
    this.emit("signedIn");
  }
  markRefreshed(opts = {}) {
    if (this._status === "signed_out")
      return;
    this._status = "active";
    this._expiresAt = opts.expiresAt;
    if (opts.identity)
      this._identity = opts.identity;
    this.emit("refreshed");
  }
  markSignedOut() {
    this._status = "signed_out";
    this._expiresAt = undefined;
    this._identity = undefined;
    this.emit("signedOut");
  }
  markExpired() {
    if (this._status !== "active")
      return;
    this._status = "expired";
    this._expiresAt = undefined;
    this._identity = undefined;
    this.emit("expired");
  }
  emitError(error) {
    if (this._status === "signed_out")
      return;
    this.emit("error", error);
  }
  emit(type, error) {
    const event = {
      type,
      session: this.snapshot(),
      ...type === "error" ? { error } : {}
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}
// src/core/_internal/stream.ts
class UnifiedStream {
  source;
  controller;
  extractor;
  aborted = false;
  startedAt = Date.now();
  usage = null;
  constructor(source, controller, extractor) {
    this.source = source;
    this.controller = controller;
    this.extractor = extractor;
  }
  abort() {
    if (this.aborted)
      return;
    this.aborted = true;
    this.controller.abort();
    this.source.return().catch(() => {});
  }
  async* [Symbol.asyncIterator]() {
    try {
      for await (const ev of this.source) {
        if (this.extractor && !this.usage) {
          const raw = this.extractor(ev);
          if (raw) {
            const elapsed = Date.now() - this.startedAt;
            this.usage = {
              input_tokens: raw.input_tokens,
              output_tokens: raw.output_tokens,
              total_tokens: raw.total_tokens,
              elapsed_ms: elapsed,
              tokens_per_second: elapsed > 0 ? Math.round(raw.output_tokens * 1000 / elapsed) : 0
            };
          }
        }
        yield ev;
      }
    } finally {
      if (!this.aborted) {
        this.aborted = true;
        this.controller.abort();
      }
    }
  }
}
// src/core/_internal/sse.ts
async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        const tail = flush(buffer);
        if (tail)
          yield tail;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let sep = findFrameBoundary(buffer);
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
        const msg = parseFrame(frame);
        if (msg)
          yield msg;
        sep = findFrameBoundary(buffer);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}
function findFrameBoundary(buf) {
  const a = buf.indexOf(`

`);
  const b = buf.indexOf(`\r
\r
`);
  if (a === -1)
    return b;
  if (b === -1)
    return a;
  return Math.min(a, b);
}
function flush(buf) {
  if (!buf.trim())
    return null;
  return parseFrame(buf);
}
function parseFrame(raw) {
  const lines = raw.split(/\r?\n/);
  let event;
  let id;
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(":"))
      continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" "))
      value = value.slice(1);
    if (field === "event")
      event = value;
    else if (field === "data")
      dataLines.push(value);
    else if (field === "id")
      id = value;
  }
  if (dataLines.length === 0)
    return null;
  const msg = { data: dataLines.join(`
`) };
  if (event !== undefined)
    msg.event = event;
  if (id !== undefined)
    msg.id = id;
  return msg;
}
// src/core/_internal/http-errors.ts
var MAX_ERROR_BODY_CHARS = 400;
function clip(s) {
  return s.length > MAX_ERROR_BODY_CHARS ? s.slice(0, MAX_ERROR_BODY_CHARS) : s;
}
function formatBody(body) {
  if (body === undefined || body === null)
    return "<empty body>";
  if (typeof body === "string")
    return clip(body);
  try {
    return clip(JSON.stringify(body));
  } catch {
    return "<unserializable body>";
  }
}
function extractServerMessage(body) {
  if (typeof body === "string") {
    const trimmed = body.trim();
    return trimmed ? clip(trimmed) : undefined;
  }
  if (!body || typeof body !== "object")
    return;
  const obj = body;
  if (typeof obj.message === "string" && obj.message)
    return clip(obj.message);
  const err = obj.error;
  if (typeof err === "string" && err)
    return clip(err);
  if (err && typeof err === "object") {
    const m = err.message;
    if (typeof m === "string" && m)
      return clip(m);
  }
  const detail = obj.detail;
  if (typeof detail === "string" && detail)
    return clip(detail);
  if (Array.isArray(detail) && detail.length > 0) {
    const msgs = detail.map((d) => d && typeof d === "object" ? d.msg : undefined).filter((m) => typeof m === "string" && m.length > 0);
    if (msgs.length > 0)
      return clip(msgs.join("; "));
  }
  const errors = obj.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const msgs = errors.map((e) => e && typeof e === "object" ? e.message : undefined).filter((m) => typeof m === "string" && m.length > 0);
    if (msgs.length > 0)
      return clip(msgs.join("; "));
  }
  return;
}
function httpErrorMessage(verb, path, status, body) {
  const base = `${verb} to ${path} returned ${status}`;
  const server = extractServerMessage(body);
  return server ? `${base}: ${server}` : base;
}
async function drainResponse(res) {
  try {
    await res.text();
  } catch {}
}
async function readErrorBody(res) {
  let text;
  try {
    text = await res.text();
  } catch {
    return;
  }
  if (!text)
    return;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
// src/core/_internal/sse-stream.ts
function createSSEStream(config) {
  const { client, path, params, doneSentinel, interpret } = config;
  const controller = new AbortController;
  if (config.signal) {
    if (config.signal.aborted)
      controller.abort();
    else
      config.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const iter = async function* () {
    const body = await client.stream(path, {
      method: "POST",
      body: { ...params, compression: params.compression ?? client.defaultCompression },
      signal: controller.signal
    });
    try {
      for await (const msg of parseSSE(body)) {
        if (doneSentinel !== undefined && msg.data === doneSentinel)
          return;
        let parsed;
        try {
          parsed = JSON.parse(msg.data);
        } catch {
          continue;
        }
        const frame = interpret(parsed, msg.event);
        if (!frame)
          continue;
        yield frame.event;
        if (frame.terminal)
          return;
      }
    } catch (err) {
      if (controller.signal.aborted)
        throw err;
      if (err instanceof UnifiedError)
        throw err;
      throw new StreamInterruptedError(err);
    }
  }();
  const StreamClass = config.streamClass ?? UnifiedStream;
  return new StreamClass(iter, controller, config.usage);
}

// src/resources/chat.ts
class ChatCompletions {
  client;
  constructor(client) {
    this.client = client;
  }
  create(params, options = {}) {
    if (params.stream) {
      return this.createStream(params, options);
    }
    const req = {
      method: "POST",
      body: { ...params, compression: params.compression ?? this.client.defaultCompression }
    };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request("/api/v1/chat/completions", req);
  }
  createStream(params, options) {
    return createSSEStream({
      client: this.client,
      path: "/api/v1/chat/completions",
      params,
      signal: options.signal,
      doneSentinel: "[DONE]",
      interpret: (parsed) => {
        const obj = parsed;
        if (obj.error) {
          throw new UnifiedAIError("request_failed", `chat.completions stream error: ${obj.error.message ?? "unknown"}`, 0, obj.error);
        }
        return { event: parsed };
      },
      usage: (chunk) => {
        const u = chunk.usage;
        if (!u)
          return null;
        return {
          input_tokens: u.prompt_tokens ?? 0,
          output_tokens: u.completion_tokens ?? 0,
          total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)
        };
      }
    });
  }
}

class Chat {
  completions;
  constructor(client) {
    this.completions = new ChatCompletions(client);
  }
}

// src/resources/agent/agent.ts
function errorDetail(err) {
  const out = {};
  if (err instanceof UnifiedError) {
    out.errorCode = err.code;
    if (err.status !== undefined)
      out.errorStatus = err.status;
  }
  if (err instanceof RateLimitError && err.retryAfter !== undefined) {
    out.errorRetryAfter = err.retryAfter;
  }
  return out;
}
function parseToolArguments(raw) {
  if (!raw?.trim())
    return {};
  let value = unwrapToolArgText(raw);
  for (let i = 0;i < 3 && typeof value === "string"; i++) {
    const next = parseJsonLenient(value);
    if (next === undefined)
      break;
    value = next;
  }
  if (Array.isArray(value))
    return value;
  if (value && typeof value === "object") {
    const rec = value;
    if (Object.keys(rec).length === 0) {
      return richestJsonObject(unwrapToolArgText(raw)) ?? rec;
    }
    return rec;
  }
  return richestJsonObject(unwrapToolArgText(raw)) ?? {};
}
function unwrapToolArgText(raw) {
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1])
    text = fenced[1].trim();
  return text;
}
function parseJsonLenient(raw) {
  try {
    return JSON.parse(raw);
  } catch {}
  const noTrailing = raw.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(noTrailing);
  } catch {}
  for (let i = noTrailing.length - 1;i > 8; i--) {
    const ch = noTrailing[i];
    if (ch !== "}" && ch !== "]")
      continue;
    try {
      return JSON.parse(noTrailing.slice(0, i + 1));
    } catch {}
  }
  return;
}
function richestJsonObject(text) {
  let best;
  let bestLen = 0;
  let depth = 0;
  let start = -1;
  for (let i = 0;i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0)
        start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && slice.length > bestLen) {
            best = parsed;
            bestLen = slice.length;
          }
        } catch {}
        start = -1;
      }
    }
  }
  return best;
}
function mergeToolCallArguments(current, incoming) {
  if (incoming == null)
    return current;
  if (typeof incoming === "object") {
    const json = JSON.stringify(incoming);
    if (json === "{}" || json === "[]")
      return current || json;
    if (!current || current === "{}" || parseJsonLenient(current) === undefined || json.length >= current.length) {
      return json;
    }
    return current;
  }
  if (typeof incoming !== "string" || incoming === "")
    return current;
  if (!current)
    return incoming;
  if (current === "{}") {
    const trimmed = incoming.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("["))
      return incoming;
    return current + incoming;
  }
  const incomingParsed = parseJsonLenient(incoming);
  const currentParsed = parseJsonLenient(current);
  if (incomingParsed !== undefined) {
    if (currentParsed === undefined || incoming.length >= current.length)
      return incoming;
    return current;
  }
  if (currentParsed !== undefined)
    return current;
  return current + incoming;
}
async function consumeChatStream(stream, emit, onText) {
  let assistantText = "";
  let finishReason = null;
  let usage = null;
  let model = null;
  const toolAcc = new Map;
  for await (const chunk of stream) {
    if (!model && chunk.model && chunk.model !== "auto") {
      model = chunk.model;
      emit({ type: "model", model });
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      if (typeof delta.content === "string" && delta.content) {
        assistantText += delta.content;
        onText();
        emit({ type: "text_delta", delta: delta.content });
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        emit({ type: "thinking_delta", delta: delta.reasoning_content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          const acc = toolAcc.get(index) ?? { arguments: "" };
          if (tc.id)
            acc.id = tc.id;
          if (tc.function?.name)
            acc.name = tc.function.name;
          const fnArgs = tc.function?.arguments;
          if (fnArgs !== undefined)
            acc.arguments = mergeToolCallArguments(acc.arguments, fnArgs);
          if (typeof tc.thought_signature === "string")
            acc.thoughtSignature = tc.thought_signature;
          toolAcc.set(index, acc);
        }
        let name = "";
        let chars = 0;
        let args = "";
        for (const acc of toolAcc.values())
          if (acc.name) {
            name = acc.name;
            chars = acc.arguments.length;
            args = acc.arguments;
          }
        if (name)
          emit({ type: "tool_partial", name, chars, args });
      }
    }
    if (choice?.finish_reason)
      finishReason = choice.finish_reason;
    if (chunk.usage)
      usage = chunk.usage;
  }
  const toolCalls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([index, acc]) => ({
    id: acc.id || `call_${index}`,
    name: acc.name || "",
    arguments: acc.arguments,
    ...acc.thoughtSignature ? { thoughtSignature: acc.thoughtSignature } : {}
  })).filter((tc) => tc.name);
  return { assistantText, toolCalls, finishReason, usage, model };
}

class Agent {
  completions;
  constructor(client) {
    this.completions = new ChatCompletions(client);
  }
  async run(options) {
    const model = options.model?.trim() ? options.model : "auto";
    const maxSteps = options.maxSteps ?? 40;
    const signal = options.signal ?? new AbortController().signal;
    const emit = options.onEvent ?? (() => {});
    const tools = options.tools ?? [];
    const messages = options.messages ? [...options.messages] : [
      ...options.system ? [{ role: "system", content: options.system }] : [],
      { role: "user", content: options.prompt ?? "" }
    ];
    let producedOutput = false;
    let resolvedModel;
    let lastFinishReason = null;
    let usageTotal;
    for (let step = 0;step < maxSteps; step++) {
      if (signal.aborted)
        return {
          ok: false,
          canceled: true,
          ...resolvedModel ? { model: resolvedModel } : {},
          ...usageTotal ? { usage: usageTotal } : {},
          producedOutput,
          messages
        };
      const steered = options.steer?.();
      if (steered?.length)
        messages.push(...steered);
      const toolMap = new Map(tools.map((t) => [t.definition.function.name, t]));
      let turn;
      try {
        const stream = this.completions.create({
          model,
          messages,
          ...tools.length > 0 ? { tools: tools.map((t) => t.definition), tool_choice: "auto" } : {},
          ...options.maxTokens ? { max_tokens: options.maxTokens } : {},
          stream: true,
          stream_options: { include_usage: true }
        }, { signal });
        turn = await consumeChatStream(stream, emit, () => {
          producedOutput = true;
        });
      } catch (err) {
        if (signal.aborted)
          return {
            ok: false,
            canceled: true,
            ...resolvedModel ? { model: resolvedModel } : {},
            ...usageTotal ? { usage: usageTotal } : {},
            producedOutput,
            messages
          };
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ...errorDetail(err),
          ...resolvedModel ? { model: resolvedModel } : {},
          ...usageTotal ? { usage: usageTotal } : {},
          producedOutput,
          messages
        };
      }
      if (turn.model)
        resolvedModel = turn.model;
      lastFinishReason = turn.finishReason;
      if (turn.usage) {
        const usage = {};
        if (turn.usage.prompt_tokens !== undefined)
          usage.inputTokens = turn.usage.prompt_tokens;
        if (turn.usage.completion_tokens !== undefined) {
          usage.outputTokens = turn.usage.completion_tokens;
        }
        emit({ type: "usage", usage });
        usageTotal ??= { inputTokens: 0, outputTokens: 0 };
        usageTotal.inputTokens += turn.usage.prompt_tokens ?? 0;
        usageTotal.outputTokens += turn.usage.completion_tokens ?? 0;
        if (turn.usage.prompt_tokens !== undefined) {
          usageTotal.lastTurnInputTokens = turn.usage.prompt_tokens;
        }
      }
      const assistantMessage = {
        role: "assistant",
        content: turn.assistantText || null,
        ...turn.toolCalls.length > 0 ? {
          tool_calls: turn.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(parseToolArguments(tc.arguments))
            },
            ...tc.thoughtSignature ? { thought_signature: tc.thoughtSignature } : {}
          }))
        } : {}
      };
      messages.push(assistantMessage);
      if (turn.toolCalls.length === 0 || turn.finishReason !== "tool_calls") {
        if (turn.finishReason === "length" && !turn.assistantText.trim()) {
          return {
            ok: false,
            error: "The model's reply was cut off at the output-token limit before it produced any result — it likely spent the budget on internal reasoning. Retry, or switch to a different (non-reasoning) model.",
            errorCode: "response_truncated",
            ...resolvedModel ? { model: resolvedModel } : {},
            ...usageTotal ? { usage: usageTotal } : {},
            producedOutput,
            messages
          };
        }
        return {
          ok: true,
          ...resolvedModel ? { model: resolvedModel } : {},
          ...usageTotal ? { usage: usageTotal } : {},
          ...lastFinishReason ? { finishReason: lastFinishReason } : {},
          producedOutput,
          messages
        };
      }
      for (const tc of turn.toolCalls) {
        if (signal.aborted)
          return {
            ok: false,
            canceled: true,
            ...resolvedModel ? { model: resolvedModel } : {},
            ...usageTotal ? { usage: usageTotal } : {},
            producedOutput,
            messages
          };
        const input = parseToolArguments(tc.arguments);
        producedOutput = true;
        emit({ type: "tool_use", id: tc.id, name: tc.name, input, raw: tc.arguments });
        const spec = toolMap.get(tc.name);
        let result;
        if (!spec) {
          result = { content: `Unknown tool: ${tc.name}`, isError: true };
        } else {
          try {
            const r = await spec.execute(input, signal);
            result = { content: r.content, isError: r.isError === true };
          } catch (err) {
            result = { content: err instanceof Error ? err.message : String(err), isError: true };
          }
        }
        emit({
          type: "tool_result",
          toolUseId: tc.id,
          content: result.content,
          isError: result.isError
        });
        messages.push({ role: "tool", tool_call_id: tc.id, content: result.content });
      }
    }
    if (producedOutput)
      return {
        ok: true,
        ...resolvedModel ? { model: resolvedModel } : {},
        ...lastFinishReason ? { finishReason: lastFinishReason } : {},
        ...usageTotal ? { usage: usageTotal } : {},
        producedOutput,
        messages
      };
    return {
      ok: false,
      error: "Reached the tool-call limit without output.",
      ...resolvedModel ? { model: resolvedModel } : {},
      ...usageTotal ? { usage: usageTotal } : {},
      producedOutput,
      messages
    };
  }
}
// src/resources/agent/fs-tools.ts
function errText(e) {
  return e instanceof Error ? e.message : String(e);
}
function fsTools(ns) {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "write_file",
          description: "Create or overwrite a file in the project directory.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Project-relative file path." },
              content: { type: "string", description: "Full file contents." }
            },
            required: ["path", "content"]
          }
        }
      },
      async execute(input) {
        const path = String(input.path ?? "");
        try {
          await ns.write(path, String(input.content ?? ""));
          return { content: `Wrote ${path}` };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file from the project directory.",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Project-relative file path." } },
            required: ["path"]
          }
        }
      },
      async execute(input) {
        try {
          return { content: await ns.read(String(input.path ?? "")) };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "edit_file",
          description: "Replace one exact, unique occurrence of a string in a file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              old_string: { type: "string" },
              new_string: { type: "string" }
            },
            required: ["path", "old_string", "new_string"]
          }
        }
      },
      async execute(input) {
        const path = String(input.path ?? "");
        try {
          await ns.edit(path, String(input.old_string ?? ""), String(input.new_string ?? ""));
          return { content: `Edited ${path}` };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_files",
          description: "List files in the project directory.",
          parameters: { type: "object", properties: {} }
        }
      },
      async execute() {
        try {
          const entries = await ns.list();
          return { content: entries.length ? entries.map((e) => e.path).join(`
`) : "(empty)" };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      }
    }
  ];
}
// src/resources/agent/_internal/ddg-search.ts
var DDG_HTML = "https://html.duckduckgo.com/html/";
function decodeBasicEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function stripTags(s) {
  return decodeBasicEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}
function parseDdgHtml(html, maxResults) {
  const hits = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match = linkRe.exec(html);
  while (match !== null && hits.length < maxResults) {
    let href = decodeBasicEntities(match[1] ?? "");
    const title = stripTags(match[2] ?? "");
    try {
      const u = new URL(href, "https://html.duckduckgo.com");
      const uddg = u.searchParams.get("uddg");
      if (uddg)
        href = decodeURIComponent(uddg);
      else
        href = u.href;
    } catch {}
    if (!href || !title) {
      match = linkRe.exec(html);
      continue;
    }
    const window = html.slice(match.index, match.index + 2500);
    const snipMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)/i.exec(window);
    const snippet = snipMatch ? stripTags(snipMatch[1] ?? "") : "";
    hits.push({ title, url: href, snippet });
    match = linkRe.exec(html);
  }
  return hits;
}
function duckDuckGoSearchBackend(fetchImpl = globalThis.fetch.bind(globalThis)) {
  return {
    async search(query, options) {
      const maxResults = options.maxResults ?? 5;
      const body = new URLSearchParams({ q: query });
      const init = {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "UnifiedAI-SDK/0.2 (agent web_search)"
        },
        body,
        redirect: "follow"
      };
      if (options.signal)
        init.signal = options.signal;
      const res = await fetchImpl(DDG_HTML, init);
      if (!res.ok) {
        throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);
      }
      const html = await res.text();
      return parseDdgHtml(html, maxResults);
    }
  };
}

// src/resources/agent/_internal/html-to-text.ts
var ENTITY_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
};
function decodeEntities(s) {
  return s.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  }).replace(/&#(\d+);/g, (_, dec) => {
    const code = Number.parseInt(dec, 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  }).replace(/&([a-zA-Z]+);/g, (match, name) => ENTITY_MAP[name.toLowerCase()] ?? match);
}
function htmlToText(html, maxChars = 64000) {
  let s = html;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|br|hr|blockquote|pre|section|article|header|footer)>/gi, `
`);
  s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, `
`);
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/\n[ \t]+/g, `
`);
  s = s.replace(/[ \t]+\n/g, `
`);
  s = s.replace(/\n{3,}/g, `

`);
  s = s.trim();
  if (s.length > maxChars) {
    return `${s.slice(0, maxChars)}

[truncated at ${maxChars} characters]`;
  }
  return s;
}

// src/resources/agent/_internal/html-meta.ts
var HEAD_CHARS = 120000;
function attr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  const raw = m?.[1] ?? m?.[2] ?? m?.[3];
  if (raw == null || raw === "")
    return;
  return decodeEntities(raw.trim());
}
function relTokens(rel) {
  return (rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}
function resolveUrl(href, baseUrl) {
  if (!href || href.startsWith("data:"))
    return;
  try {
    const u = new URL(href, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:")
      return;
    return u.href;
  } catch {
    return;
  }
}
function collapseTitle(s) {
  return decodeEntities(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function iconRank(rel, type) {
  const t = (type ?? "").toLowerCase();
  if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed"))
    return 100;
  if (rel.includes("icon") || rel.includes("shortcut")) {
    if (t.includes("svg"))
      return 80;
    if (t.includes("png") || t.includes("webp"))
      return 70;
    return 40;
  }
  return 0;
}
function extractHtmlMeta(html, baseUrl) {
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const head = headMatch?.[1] ?? html.slice(0, HEAD_CHARS);
  let title;
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (titleTag?.[1])
    title = collapseTitle(titleTag[1]);
  let ogTitle;
  let ogLogo;
  let bestIcon;
  const metaRe = /<meta\b[^>]*>/gi;
  let meta = metaRe.exec(head);
  while (meta) {
    const tag = meta[0];
    const prop = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    const content = attr(tag, "content");
    if (content) {
      if (prop === "og:title" || prop === "twitter:title")
        ogTitle = collapseTitle(content);
      if (prop === "og:logo")
        ogLogo = content;
    }
    meta = metaRe.exec(head);
  }
  const linkRe = /<link\b[^>]*>/gi;
  let link = linkRe.exec(head);
  while (link) {
    const tag = link[0];
    const rel = relTokens(attr(tag, "rel"));
    const href = attr(tag, "href");
    const rank = iconRank(rel, attr(tag, "type"));
    if (href && rank > 0 && (!bestIcon || rank > bestIcon.rank)) {
      bestIcon = { href, rank };
    }
    link = linkRe.exec(head);
  }
  const iconHref = bestIcon?.href ?? ogLogo;
  const icon = iconHref ? resolveUrl(iconHref, baseUrl) : undefined;
  const resolvedTitle = (ogTitle || title || "").trim() || undefined;
  return { ...resolvedTitle ? { title: resolvedTitle } : {}, ...icon ? { icon } : {} };
}
function formatFetchMeta(url, meta) {
  const lines = [`URL: ${url}`];
  if (meta.title)
    lines.push(`Title: ${meta.title}`);
  if (meta.icon)
    lines.push(`Icon: ${meta.icon}`);
  return lines.join(`
`);
}

// src/resources/agent/_internal/ssrf.ts
function isIpv4Literal(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}
function parseIpv4(host) {
  if (!isIpv4Literal(host))
    return null;
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
}
function isPrivateOrMetadataHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0")
    return true;
  if (h === "::1" || h === "::")
    return true;
  if (h.startsWith("fe80:"))
    return true;
  if (/^f[cd][0-9a-f]{0,2}:/i.test(h))
    return true;
  if (h === "0:0:0:0:0:0:0:1" || h === "0000:0000:0000:0000:0000:0000:0000:0001")
    return true;
  const ip = parseIpv4(h);
  if (!ip)
    return false;
  const [a, b] = ip;
  if (a === 127)
    return true;
  if (a === 10)
    return true;
  if (a === 172 && b >= 16 && b <= 31)
    return true;
  if (a === 192 && b === 168)
    return true;
  if (a === 169 && b === 254)
    return true;
  if (a === 100 && b >= 64 && b <= 127)
    return true;
  if (a === 0)
    return true;
  if (a === 255 && b === 255 && ip[2] === 255 && ip[3] === 255)
    return true;
  return false;
}
function assertSafeFetchUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `Invalid URL: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `Blocked scheme: ${url.protocol} (only http/https allowed)` };
  }
  if (isPrivateOrMetadataHost(url.hostname)) {
    return {
      ok: false,
      error: `Blocked host: ${url.hostname} (private / metadata addresses are not allowed)`
    };
  }
  return { ok: true, url };
}

// src/resources/agent/web-tools.ts
var DEFAULT_TIMEOUT_MS = 1e4;
var DEFAULT_MAX_RESULTS = 5;
var DEFAULT_MAX_FETCH_CHARS = 64000;
var DEFAULT_MAX_FETCH_BYTES = 512000;
function errText2(e) {
  return e instanceof Error ? e.message : String(e);
}
function formatHits(hits) {
  if (hits.length === 0)
    return "No results.";
  return hits.map((h, i) => {
    const snip = h.snippet ? `
   ${h.snippet}` : "";
    return `${i + 1}. ${h.title}
   ${h.url}${snip}`;
  }).join(`

`);
}
function withTimeout(signal, timeoutMs) {
  const ctrl = new AbortController;
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      ctrl.abort(signal.reason);
      return { signal: ctrl.signal, clear: () => {} };
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: ctrl.signal,
    clear: () => {
      clearTimeout(timer);
      if (signal)
        signal.removeEventListener("abort", onAbort);
    }
  };
}
function webTools(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const search = options.search ?? duckDuckGoSearchBackend(fetchImpl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFetchChars = options.maxFetchChars ?? DEFAULT_MAX_FETCH_CHARS;
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the public web (DuckDuckGo). Returns numbered titles, URLs, and snippets. Use web_fetch on a promising URL to read the full page.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query." },
              maxResults: {
                type: "number",
                description: `Max results to return (default ${DEFAULT_MAX_RESULTS}, max 10).`
              }
            },
            required: ["query"]
          }
        }
      },
      async execute(input, signal) {
        const query = String(input.query ?? "").trim();
        if (!query)
          return { content: "query is required", isError: true };
        let maxResults = DEFAULT_MAX_RESULTS;
        if (typeof input.maxResults === "number" && Number.isFinite(input.maxResults)) {
          maxResults = Math.min(10, Math.max(1, Math.floor(input.maxResults)));
        }
        const { signal: timed, clear } = withTimeout(signal, timeoutMs);
        try {
          const hits = await search.search(query, { maxResults, signal: timed });
          return { content: formatHits(hits) };
        } catch (e) {
          if (timed.aborted && !signal.aborted) {
            return { content: errText2(e), isError: true };
          }
          return { content: errText2(e), isError: true };
        } finally {
          clear();
        }
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "web_fetch",
          description: "Fetch a public http(s) URL and return readable text (HTML stripped, truncated). Private/metadata hosts are blocked. Prefer URLs from web_search.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Absolute http(s) URL to fetch." }
            },
            required: ["url"]
          }
        }
      },
      async execute(input, signal) {
        const raw = String(input.url ?? "").trim();
        const checked = assertSafeFetchUrl(raw);
        if (!checked.ok)
          return { content: checked.error, isError: true };
        const { signal: timed, clear } = withTimeout(signal, timeoutMs);
        try {
          let current = checked.url;
          let res = null;
          for (let hop = 0;hop < 5; hop++) {
            res = await fetchImpl(current.href, {
              method: "GET",
              redirect: "manual",
              signal: timed,
              headers: {
                "user-agent": "UnifiedAI-SDK/0.2 (agent web_fetch)",
                accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8"
              }
            });
            if (res.status >= 300 && res.status < 400) {
              const loc = res.headers.get("location");
              if (!loc) {
                return { content: `Redirect without Location (HTTP ${res.status})`, isError: true };
              }
              let next;
              try {
                next = new URL(loc, current);
              } catch {
                return { content: `Invalid redirect Location: ${loc}`, isError: true };
              }
              const recheck = assertSafeFetchUrl(next.href);
              if (!recheck.ok)
                return { content: recheck.error, isError: true };
              if (isPrivateOrMetadataHost(recheck.url.hostname)) {
                return {
                  content: `Blocked redirect host: ${recheck.url.hostname}`,
                  isError: true
                };
              }
              current = recheck.url;
              continue;
            }
            break;
          }
          if (!res)
            return { content: "Fetch failed", isError: true };
          if (!res.ok) {
            return { content: `HTTP ${res.status} fetching ${current.href}`, isError: true };
          }
          const finalCheck = assertSafeFetchUrl(current.href);
          if (!finalCheck.ok)
            return { content: finalCheck.error, isError: true };
          const buf = await readBodyCapped(res, DEFAULT_MAX_FETCH_BYTES, timed);
          const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
          const isHtml = ctype.includes("html") || /^\s*</.test(buf);
          const meta = isHtml ? extractHtmlMeta(buf, current.href) : {};
          let text;
          if (isHtml) {
            text = htmlToText(buf, maxFetchChars);
          } else {
            text = buf.length > maxFetchChars ? `${buf.slice(0, maxFetchChars)}

[truncated at ${maxFetchChars} characters]` : buf;
          }
          if (!text.trim()) {
            const header = formatFetchMeta(current.href, meta);
            return { content: meta.title || meta.icon ? header : "(empty page)" };
          }
          return { content: `${formatFetchMeta(current.href, meta)}

${text}` };
        } catch (e) {
          return { content: errText2(e), isError: true };
        } finally {
          clear();
        }
      }
    }
  ];
}
async function readBodyCapped(res, maxBytes, signal) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const t = await res.text();
    return t.length > maxBytes ? t.slice(0, maxBytes) : t;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder;
  let out = "";
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted)
        throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done)
        break;
      if (!value)
        continue;
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (bytes >= maxBytes) {
        out += decoder.decode();
        await reader.cancel().catch(() => {});
        return out.slice(0, maxBytes);
      }
    }
    out += decoder.decode();
    return out;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}
// src/resources/agent/storage-tools.ts
function errText3(e) {
  return e instanceof Error ? e.message : String(e);
}
function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return { value };
}
function storageTools(ns, opts = {}) {
  const allowed = opts.collections ? new Set(opts.collections) : null;
  const write = opts.write === true;
  const collection = (name) => {
    if (allowed && !allowed.has(name)) {
      throw new Error(`collection "${name}" is not in the tool allowlist`);
    }
    return ns.collection(name, { key: "id" });
  };
  const tools = [
    {
      definition: {
        type: "function",
        function: {
          name: "storage_get",
          description: "Get one record by collection and id from the bound namespace.",
          parameters: {
            type: "object",
            properties: {
              collection: { type: "string" },
              id: { type: "string" }
            },
            required: ["collection", "id"]
          }
        }
      },
      async execute(input) {
        try {
          const rec = await collection(String(input.collection ?? "")).get(String(input.id ?? ""));
          return { content: rec ? JSON.stringify(rec) : "null" };
        } catch (e) {
          return { content: errText3(e), isError: true };
        }
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "storage_query",
          description: "List records in a collection. Optional equality `where` object.",
          parameters: {
            type: "object",
            properties: {
              collection: { type: "string" },
              where: { type: "object", additionalProperties: true },
              limit: { type: "number" }
            },
            required: ["collection"]
          }
        }
      },
      async execute(input) {
        try {
          const where = input.where && typeof input.where === "object" ? input.where : undefined;
          const limit = typeof input.limit === "number" ? input.limit : undefined;
          const rows = await collection(String(input.collection ?? "")).query({
            ...where ? { where } : {},
            ...limit !== undefined ? { limit } : {}
          });
          return { content: JSON.stringify(rows) };
        } catch (e) {
          return { content: errText3(e), isError: true };
        }
      }
    }
  ];
  if (write) {
    tools.push({
      definition: {
        type: "function",
        function: {
          name: "storage_put",
          description: "Insert or replace a record. `record` must include an `id` string key.",
          parameters: {
            type: "object",
            properties: {
              collection: { type: "string" },
              record: { type: "object", additionalProperties: true }
            },
            required: ["collection", "record"]
          }
        }
      },
      async execute(input) {
        try {
          const record = asRecord(input.record);
          if (!record.id) {
            return { content: "record.id is required", isError: true };
          }
          const ref = await collection(String(input.collection ?? "")).put(record);
          return { content: JSON.stringify(ref) };
        } catch (e) {
          return { content: errText3(e), isError: true };
        }
      }
    }, {
      definition: {
        type: "function",
        function: {
          name: "storage_delete",
          description: "Delete a record by collection and id.",
          parameters: {
            type: "object",
            properties: {
              collection: { type: "string" },
              id: { type: "string" }
            },
            required: ["collection", "id"]
          }
        }
      },
      async execute(input) {
        try {
          const deleted = await collection(String(input.collection ?? "")).delete(String(input.id ?? ""));
          return { content: deleted ? "deleted" : "not found" };
        } catch (e) {
          return { content: errText3(e), isError: true };
        }
      }
    });
  }
  return tools;
}
// src/resources/agent/sync-tools.ts
function errText4(e) {
  return e instanceof Error ? e.message : String(e);
}
function syncTools(ws, ns, opts = {}) {
  const allowed = opts.collections ? new Set(opts.collections) : null;
  const write = opts.write === true;
  const check = (collection) => {
    if (allowed && !allowed.has(collection)) {
      throw new Error(`collection "${collection}" is not in the tool allowlist`);
    }
  };
  const tools = [
    {
      definition: {
        type: "function",
        function: {
          name: "sync_get",
          description: "Get one live sync record by collection and id.",
          parameters: {
            type: "object",
            properties: {
              collection: { type: "string" },
              id: { type: "string" }
            },
            required: ["collection", "id"]
          }
        }
      },
      execute(input) {
        try {
          const collection = String(input.collection ?? "");
          check(collection);
          const rec = ws.collection(ns, collection).get(String(input.id ?? ""));
          return { content: rec ? JSON.stringify(rec.metadata) : "null" };
        } catch (e) {
          return { content: errText4(e), isError: true };
        }
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "sync_list",
          description: "List live records in a collection. Optional equality `where` object.",
          parameters: {
            type: "object",
            properties: {
              collection: { type: "string" },
              where: { type: "object", additionalProperties: true }
            },
            required: ["collection"]
          }
        }
      },
      execute(input) {
        try {
          const collection = String(input.collection ?? "");
          check(collection);
          const where = input.where && typeof input.where === "object" ? input.where : undefined;
          const rows = ws.collection(ns, collection).list(where ? { where } : undefined).map((r) => ({ id: r.id, ...r.metadata }));
          return { content: JSON.stringify(rows) };
        } catch (e) {
          return { content: errText4(e), isError: true };
        }
      }
    }
  ];
  if (write) {
    tools.push({
      definition: {
        type: "function",
        function: {
          name: "sync_apply",
          description: "Apply one mutation: pass exactly one of patch, replace (object), or delete (true).",
          parameters: {
            type: "object",
            properties: {
              collection: { type: "string" },
              id: { type: "string" },
              patch: { type: "object", additionalProperties: true },
              replace: { type: "object", additionalProperties: true },
              delete: { type: "boolean" }
            },
            required: ["collection", "id"]
          }
        }
      },
      async execute(input) {
        try {
          const collection = String(input.collection ?? "");
          check(collection);
          const op = {
            ns,
            collection,
            id: String(input.id ?? "")
          };
          if (input.delete === true)
            op.delete = true;
          else if (input.replace && typeof input.replace === "object") {
            op.replace = input.replace;
          } else if (input.patch && typeof input.patch === "object") {
            op.patch = input.patch;
          } else {
            return {
              content: "exactly one of patch, replace, or delete is required",
              isError: true
            };
          }
          const results = await ws.apply([op]);
          return { content: JSON.stringify(results[0] ?? null) };
        } catch (e) {
          return { content: errText4(e), isError: true };
        }
      }
    });
  }
  return tools;
}
// src/resources/audio.ts
var ACCEPTED_AUDIO_TYPES = ["audio/", "application/octet-stream"];

class Audio {
  client;
  constructor(client) {
    this.client = client;
  }
  speech(params, options = {}) {
    const req = {
      method: "POST",
      body: params,
      acceptedContentTypes: ACCEPTED_AUDIO_TYPES
    };
    if (options.signal)
      req.signal = options.signal;
    return this.client.requestBinary("/api/v1/audio/speech", req).then((r) => ({
      audio: r.bytes,
      contentType: r.contentType
    }));
  }
}
// src/resources/_internal/poll.ts
function defaultAbortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}
function sleep(ms, signal, abortError) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject((abortError ?? defaultAbortError)());
      return;
    }
    if (ms <= 0)
      return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject((abortError ?? defaultAbortError)());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
async function pollUntil(opts) {
  const deadline = Date.now() + opts.timeoutMs;
  let last;
  for (;; ) {
    if (opts.signal?.aborted)
      throw (opts.abortError ?? defaultAbortError)();
    if (opts.eagerDeadline && Date.now() >= deadline)
      return opts.onTimeout(last);
    last = await opts.poll();
    if (opts.isDone(last))
      return last;
    const remaining = deadline - Date.now();
    if (opts.eagerDeadline ? remaining <= 0 : remaining < 0)
      return opts.onTimeout(last);
    await sleep(opts.eagerDeadline ? Math.min(opts.intervalMs, remaining) : opts.intervalMs, opts.signal, opts.abortError);
  }
}

// src/resources/actions.ts
class Actions {
  client;
  constructor(client) {
    this.client = client;
  }
  registerApp(input) {
    return this.client.request("/api/v1/registry/apps", {
      method: "POST",
      body: input
    });
  }
  async listApps() {
    const res = await this.client.request("/api/v1/registry/apps", {
      method: "GET"
    });
    return res.apps;
  }
  async register(actions) {
    const res = await this.client.request("/api/v1/registry/actions", {
      method: "POST",
      body: { actions }
    });
    return res.actions;
  }
  async list(appId) {
    const req = { method: "GET" };
    if (appId)
      req.query = { appId };
    const res = await this.client.request("/api/v1/registry/actions", req);
    return res.actions;
  }
  invoke(appId, actionId, args) {
    const body = { appId, actionId };
    if (args !== undefined)
      body.args = args;
    return this.client.request("/api/v1/registry/invocations", {
      method: "POST",
      body
    });
  }
  result(id) {
    return this.client.request(`/api/v1/registry/invocations/${encodeURIComponent(id)}`, { method: "GET" });
  }
  async awaitResult(id, options = {}) {
    return pollUntil({
      timeoutMs: options.timeoutMs ?? 30000,
      intervalMs: options.intervalMs ?? 400,
      poll: () => this.result(id),
      isDone: (r) => r.status === "done",
      onTimeout: (last) => last
    });
  }
  setWebhook(url) {
    return this.client.request("/api/v1/registry/webhook", {
      method: "POST",
      body: { url }
    });
  }
  async pull() {
    const res = await this.client.request("/api/v1/registry/invocations/pending", { method: "GET" });
    return res.invocations;
  }
  respond(id, payload) {
    return this.client.request(`/api/v1/registry/invocations/${encodeURIComponent(id)}/respond`, { method: "POST", body: payload });
  }
  serve(handlers, options = {}) {
    const intervalMs = options.intervalMs ?? 500;
    let stopped = false;
    const runJob = async (job) => {
      try {
        const handler = handlers[job.actionId];
        if (!handler) {
          await this.respond(job.id, { error: { code: "unknown_action", message: job.actionId } });
          return;
        }
        try {
          const result = await handler(job.args);
          await this.respond(job.id, { result });
        } catch (err) {
          await this.respond(job.id, {
            error: {
              code: "handler_error",
              message: err instanceof Error ? err.message : "handler failed"
            }
          });
        }
      } catch {}
    };
    const loop = async () => {
      let backoff = intervalMs;
      while (!stopped) {
        try {
          const jobs = await this.pull();
          for (const job of jobs) {
            if (stopped)
              return;
            await runJob(job);
          }
          backoff = intervalMs;
        } catch {
          backoff = Math.min(backoff * 2, 30000);
        }
        await new Promise((res) => setTimeout(res, backoff));
      }
    };
    loop();
    return () => {
      stopped = true;
    };
  }
}
// src/core/_internal/base64.ts
function nodeBuffer() {
  return globalThis.Buffer;
}
function bytesToBase64(bytes) {
  const B = nodeBuffer();
  if (B !== undefined)
    return B.from(bytes).toString("base64");
  if (typeof btoa === "function") {
    let bin = "";
    const CHUNK = 4096;
    for (let i = 0;i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, i + CHUNK);
      bin += String.fromCharCode(...slice);
    }
    return btoa(bin);
  }
  throw new Error("no base64 encoder available (neither Buffer nor btoa)");
}
function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64ToBytes(b64) {
  const cleaned = b64.replace(/\s+/g, "");
  const B = nodeBuffer();
  if (B !== undefined)
    return new Uint8Array(B.from(cleaned, "base64"));
  if (typeof atob === "function") {
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0;i < bin.length; i++)
      out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error("no base64 decoder available (neither Buffer nor atob)");
}

// src/resources/artifacts.ts
function encodePreview(p) {
  const c = p.content;
  const bytes = typeof c === "string" ? new TextEncoder().encode(c) : c instanceof Uint8Array ? c : new Uint8Array(c);
  return {
    previewB64: bytesToBase64(bytes),
    ...p.mime !== undefined ? { previewMime: p.mime } : {}
  };
}

class Artifacts {
  client;
  constructor(client) {
    this.client = client;
  }
  create(input) {
    const body = {
      kind: input.kind,
      title: input.title,
      content: input.content,
      text: input.text
    };
    if (input.projectId !== undefined)
      body.projectId = input.projectId;
    if (input.preview)
      Object.assign(body, encodePreview(input.preview));
    return this.client.request("/api/v1/artifacts", { method: "POST", body });
  }
  async list(options = {}) {
    const req = { method: "GET" };
    const query = {};
    if (options.projectId)
      query.projectId = options.projectId;
    if (options.kind)
      query.kind = options.kind;
    if (Object.keys(query).length)
      req.query = query;
    if (options.signal)
      req.signal = options.signal;
    const { artifacts } = await this.client.request("/api/v1/artifacts", req);
    return artifacts;
  }
  get(id) {
    return this.client.request(`/api/v1/artifacts/${encodeURIComponent(id)}`, { method: "GET" });
  }
  addVersion(id, input) {
    const body = { content: input.content, text: input.text };
    if (input.preview)
      Object.assign(body, encodePreview(input.preview));
    return this.client.request(`/api/v1/artifacts/${encodeURIComponent(id)}/versions`, { method: "POST", body });
  }
  async getVersion(id, version) {
    try {
      const res = await this.client.request(`/api/v1/artifacts/${encodeURIComponent(id)}/versions/${version}`, { method: "GET" });
      return res.version;
    } catch (err) {
      if (err instanceof NotFoundError)
        return null;
      throw err;
    }
  }
  async previewUrl(id, version) {
    try {
      const req = { method: "GET" };
      if (version !== undefined)
        req.query = { v: String(version) };
      return await this.client.request(`/api/v1/artifacts/${encodeURIComponent(id)}/preview`, req);
    } catch (err) {
      if (err instanceof NotFoundError)
        return null;
      throw err;
    }
  }
  async resolveRef(ref) {
    const m = /^artifact:\/\/([^@/]+)(?:@(\d+))?$/.exec(ref.trim());
    if (!m || !m[1])
      return null;
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return null;
    }
    try {
      if (m[2]) {
        const version = await this.getVersion(id, Number(m[2]));
        if (!version)
          return null;
        const { artifact: artifact2 } = await this.get(id);
        return { artifact: artifact2, version };
      }
      const { artifact, latest } = await this.get(id);
      return latest ? { artifact, version: latest } : null;
    } catch (err) {
      if (err instanceof NotFoundError)
        return null;
      throw err;
    }
  }
}
// src/resources/calendar/_internal/zoned.ts
var fmtCache = new Map;
function formatterFor(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    fmtCache.set(tz, f);
  }
  return f;
}
function utcToZonedFields(epochMs, tz) {
  const parts = formatterFor(tz).formatToParts(new Date(epochMs));
  const num = (type) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  let hour = num("hour");
  if (hour === 24)
    hour = 0;
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour,
    minute: num("minute"),
    second: num("second")
  };
}
function getTimeZoneOffsetMs(epochMs, tz) {
  const f = utcToZonedFields(epochMs, tz);
  const asUTC = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUTC - epochMs;
}
function zonedFieldsToUtc(f, tz) {
  const ts0 = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second, f.ms ?? 0);
  const off0 = getTimeZoneOffsetMs(ts0, tz);
  const utc1 = ts0 - off0;
  const off1 = getTimeZoneOffsetMs(utc1, tz);
  return off1 === off0 ? utc1 : ts0 - off1;
}
var WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
function weekdayOf(year, month, day) {
  const idx = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return WEEKDAYS[idx] ?? "SU";
}
function weekdayIndex(w) {
  return WEEKDAYS.indexOf(w);
}
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// src/resources/calendar/datetime.ts
function inputError(message) {
  return new UnifiedError("invalid_input", message);
}
function pad(n) {
  return String(n).padStart(2, "0");
}
function dateStringInZone(epochMs, tz) {
  const f = utcToZonedFields(epochMs, tz);
  return `${f.year}-${pad(f.month)}-${pad(f.day)}`;
}
function parseDateString(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m)
    throw inputError(`invalid date string "${s}"; expected YYYY-MM-DD`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw inputError(`invalid date string "${s}"; month/day out of range`);
  }
  return { year, month, day };
}
function startOfDayInZone(epochMs, tz) {
  const f = utcToZonedFields(epochMs, tz);
  return zonedFieldsToUtc({ year: f.year, month: f.month, day: f.day, hour: 0, minute: 0, second: 0 }, tz);
}
function startOfDayForDate(dateStr, tz) {
  const d = parseDateString(dateStr);
  return zonedFieldsToUtc({ year: d.year, month: d.month, day: d.day, hour: 0, minute: 0, second: 0 }, tz);
}
function startOfWeekInZone(epochMs, tz, weekStart = "MO") {
  const f = utcToZonedFields(epochMs, tz);
  const back = (weekdayIndex(weekdayOf(f.year, f.month, f.day)) - weekdayIndex(weekStart) + 7) % 7;
  return zonedFieldsToUtc({ year: f.year, month: f.month, day: f.day - back, hour: 0, minute: 0, second: 0 }, tz);
}
function startOfMonthInZone(epochMs, tz) {
  const f = utcToZonedFields(epochMs, tz);
  return zonedFieldsToUtc({ year: f.year, month: f.month, day: 1, hour: 0, minute: 0, second: 0 }, tz);
}
function addDaysInZone(epochMs, days, tz) {
  const f = utcToZonedFields(epochMs, tz);
  return zonedFieldsToUtc({ ...f, day: f.day + days }, tz);
}
function addMonthsInZone(epochMs, months, tz) {
  const f = utcToZonedFields(epochMs, tz);
  const probe = new Date(Date.UTC(f.year, f.month - 1 + months, 1));
  const year = probe.getUTCFullYear();
  const month = probe.getUTCMonth() + 1;
  const day = Math.min(f.day, daysInMonth(year, month));
  return zonedFieldsToUtc({ ...f, year, month, day }, tz);
}
function addDaysToDateString(s, days) {
  const d = parseDateString(s);
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
function isSameDayInZone(a, b, tz) {
  return dateStringInZone(a, tz) === dateStringInZone(b, tz);
}
function dayRange(epochMs, tz) {
  const start = startOfDayInZone(epochMs, tz);
  return { start, end: addDaysInZone(start, 1, tz) };
}
function weekRange(epochMs, tz, weekStart = "MO") {
  const start = startOfWeekInZone(epochMs, tz, weekStart);
  return { start, end: addDaysInZone(start, 7, tz) };
}
function monthGrid(year, month, tz, weekStart = "MO") {
  const firstOfMonth = `${year}-${pad(month)}-01`;
  const leading = (weekdayIndex(weekdayOf(year, month, 1)) - weekdayIndex(weekStart) + 7) % 7;
  const gridStartDate = addDaysToDateString(firstOfMonth, -leading);
  const cells = [];
  let date = gridStartDate;
  for (let i = 0;i < 42; i++) {
    const d = parseDateString(date);
    const nextDate = addDaysToDateString(date, 1);
    cells.push({
      date,
      start: startOfDayForDate(date, tz),
      end: startOfDayForDate(nextDate, tz),
      dayOfMonth: d.day,
      weekday: weekdayOf(d.year, d.month, d.day),
      inCurrentMonth: d.year === year && d.month === month
    });
    date = nextDate;
  }
  return cells;
}

// src/resources/calendar/recurrence.ts
var MAX_ITER = 1e4;
var DEFAULT_LIMIT = 1000;
function pad2(n) {
  return String(n).padStart(2, "0");
}
function dateKeyOf(d) {
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
}
function dateNum(d) {
  return d.year * 1e4 + d.month * 100 + d.day;
}
function addDaysToDate(d, days) {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}
function dateDiffDays(a, b) {
  const pa = parseDateString(a);
  const pb = parseDateString(b);
  const ms = Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day);
  return Math.round(ms / 86400000);
}
function mergeOverride(item, patch) {
  return { ...item, ...patch };
}
function moOffset(w) {
  return (weekdayIndex(w) - weekdayIndex("MO") + 7) % 7;
}
function resolveNthWeekday(year, month, sel) {
  const nth = sel.nth;
  if (!Number.isInteger(nth) || nth === 0 || nth < -5 || nth > 5)
    return;
  const dim = daysInMonth(year, month);
  if (nth > 0) {
    const firstW = weekdayOf(year, month, 1);
    const day2 = 1 + (weekdayIndex(sel.weekday) - weekdayIndex(firstW) + 7) % 7 + (nth - 1) * 7;
    return day2 <= dim ? day2 : undefined;
  }
  const lastW = weekdayOf(year, month, dim);
  const day = dim - (weekdayIndex(lastW) - weekdayIndex(sel.weekday) + 7) % 7 - (-nth - 1) * 7;
  return day >= 1 ? day : undefined;
}
function* candidateDates(rule, anchor) {
  const interval = Math.max(1, rule.interval ?? 1);
  const anchorNum = dateNum(anchor);
  if (rule.freq === "daily") {
    let d = anchor;
    while (true) {
      yield d;
      d = addDaysToDate(d, interval);
    }
  } else if (rule.freq === "weekly") {
    const days = rule.byDay?.length ? rule.byDay : [weekdayOf(anchor.year, anchor.month, anchor.day)];
    const offsets = [...new Set(days.map(moOffset))].sort((a, b) => a - b);
    const anchorOff = moOffset(weekdayOf(anchor.year, anchor.month, anchor.day));
    let blockStart = addDaysToDate(anchor, -anchorOff);
    while (true) {
      for (const off of offsets) {
        const d = addDaysToDate(blockStart, off);
        if (dateNum(d) < anchorNum)
          continue;
        yield d;
      }
      blockStart = addDaysToDate(blockStart, interval * 7);
    }
  } else if (rule.freq === "monthly") {
    let year = anchor.year;
    let month = anchor.month;
    while (true) {
      const dim = daysInMonth(year, month);
      let days;
      if (rule.byWeekday?.length) {
        const resolved = rule.byWeekday.map((sel) => resolveNthWeekday(year, month, sel)).filter((d) => d !== undefined);
        days = [...new Set(resolved)].sort((a, b) => a - b);
      } else if (rule.byMonthDay?.length) {
        const resolved = rule.byMonthDay.map((d) => d < 0 ? dim + 1 + d : d).filter((d) => d >= 1 && d <= dim);
        days = [...new Set(resolved)].sort((a, b) => a - b);
      } else {
        days = anchor.day <= dim ? [anchor.day] : [];
      }
      for (const day of days) {
        const d = { year, month, day };
        if (dateNum(d) < anchorNum)
          continue;
        yield d;
      }
      month += interval;
      while (month > 12) {
        month -= 12;
        year += 1;
      }
    }
  } else {
    let year = anchor.year;
    while (true) {
      if (anchor.day <= daysInMonth(year, anchor.month)) {
        yield { year, month: anchor.month, day: anchor.day };
      }
      year += interval;
    }
  }
}
function expandOccurrences(item, rangeStart, rangeEnd, opts) {
  const tz = item.timeZone;
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const results = [];
  let anchor;
  let timeOfDay;
  let durationMs = 0;
  let durationDays = 1;
  if (item.allDay) {
    anchor = parseDateString(item.startDate);
    timeOfDay = { hour: 0, minute: 0, second: 0 };
    durationDays = dateDiffDays(item.startDate, item.endDate) + 1;
    if (durationDays < 1)
      durationDays = 1;
  } else {
    const f = utcToZonedFields(item.start, tz);
    anchor = { year: f.year, month: f.month, day: f.day };
    timeOfDay = { hour: f.hour, minute: f.minute, second: f.second };
    durationMs = item.end - item.start;
  }
  const overrides = new Map(item.overrides?.map((o) => [o.originalStart, o]) ?? []);
  const exdates = new Set(item.exdates ?? []);
  function effectiveInterval(originalStart, slotDateKey, patch) {
    if (item.allDay) {
      const startDate = patch?.startDate ?? slotDateKey;
      const endDate = patch?.endDate ?? addDaysToDateString(startDate, durationDays - 1);
      return {
        start: startOfDayForDate(startDate, tz),
        end: startOfDayForDate(addDaysToDateString(endDate, 1), tz),
        startDate,
        endDate
      };
    }
    const start = patch?.start ?? originalStart;
    const end = patch?.end ?? start + durationMs;
    return { start, end };
  }
  function pushOccurrence(originalStart, originalStartKey, eff, effItem, isOverride) {
    const occ = {
      itemId: item.id,
      calendarId: item.calendarId,
      kind: effItem.kind,
      allDay: item.allDay,
      title: effItem.title,
      start: eff.start,
      end: eff.end,
      occurrenceKey: `${item.id}::${originalStartKey}`,
      originalStart,
      isOverride,
      item: effItem
    };
    if (eff.startDate !== undefined)
      occ.startDate = eff.startDate;
    if (eff.endDate !== undefined)
      occ.endDate = eff.endDate;
    results.push(occ);
  }
  if (!item.recurrence) {
    const originalStart = item.allDay ? startOfDayForDate(item.startDate, tz) : item.start;
    const originalStartKey = item.allDay ? item.startDate : String(originalStart);
    const eff = effectiveInterval(originalStart, item.allDay ? item.startDate : "", undefined);
    if (eff.start < rangeEnd && eff.end > rangeStart) {
      pushOccurrence(originalStart, originalStartKey, eff, item, false);
    }
    return results;
  }
  const rule = item.recurrence;
  const visitedKeys = new Set;
  let generatedCount = 0;
  let iter = 0;
  for (const d of candidateDates(rule, anchor)) {
    const localFields = { year: d.year, month: d.month, day: d.day, ...timeOfDay };
    const originalStart = zonedFieldsToUtc(localFields, tz);
    const slotDateKey = dateKeyOf(d);
    const originalStartKey = item.allDay ? slotDateKey : String(originalStart);
    generatedCount += 1;
    if (rule.count !== undefined && generatedCount > rule.count)
      break;
    if (rule.until !== undefined && slotDateKey > rule.until)
      break;
    iter += 1;
    if (iter > MAX_ITER)
      break;
    if (originalStart >= rangeEnd)
      break;
    const ov = overrides.get(originalStartKey);
    if (!ov) {
      const baseEnd = item.allDay ? startOfDayForDate(addDaysToDateString(slotDateKey, durationDays), tz) : originalStart + durationMs;
      if (baseEnd <= rangeStart) {
        visitedKeys.add(originalStartKey);
        continue;
      }
    }
    if (exdates.has(originalStartKey)) {
      visitedKeys.add(originalStartKey);
      continue;
    }
    if (ov?.deleted) {
      visitedKeys.add(originalStartKey);
      continue;
    }
    const effItem = ov?.patch ? mergeOverride(item, ov.patch) : item;
    const eff = effectiveInterval(originalStart, slotDateKey, ov?.patch);
    if (eff.start < rangeEnd && eff.end > rangeStart) {
      pushOccurrence(originalStart, originalStartKey, eff, effItem, Boolean(ov));
      if (results.length >= limit)
        break;
    }
    visitedKeys.add(originalStartKey);
  }
  for (const ov of overrides.values()) {
    if (ov.deleted || !ov.patch || visitedKeys.has(ov.originalStart))
      continue;
    if (results.length >= limit)
      break;
    if (exdates.has(ov.originalStart))
      continue;
    let originalStart;
    let slotDateKey;
    if (item.allDay) {
      slotDateKey = ov.originalStart;
      try {
        originalStart = startOfDayForDate(slotDateKey, tz);
      } catch {
        continue;
      }
    } else {
      originalStart = Number(ov.originalStart);
      if (!Number.isFinite(originalStart))
        continue;
      slotDateKey = "";
    }
    const eff = effectiveInterval(originalStart, slotDateKey, ov.patch);
    if (eff.start < rangeEnd && eff.end > rangeStart) {
      pushOccurrence(originalStart, ov.originalStart, eff, mergeOverride(item, ov.patch), true);
    }
  }
  results.sort((a, b) => a.start - b.start);
  return results;
}

// src/resources/calendar/_internal/guards.ts
function asString(v) {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asBool(v) {
  return typeof v === "boolean" ? v : undefined;
}
function asStringArray(v) {
  if (!Array.isArray(v))
    return;
  return v.filter((x) => typeof x === "string");
}
function asObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : undefined;
}

// src/resources/calendar/sync-adapter.ts
var CALENDAR_NS = "calendar";
var ITEMS_COLLECTION = "items";
var CALENDARS_COLLECTION = "calendars";
function newId() {
  const c = globalThis.crypto;
  if (c?.randomUUID)
    return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.random() * 16 | 0;
    const v = ch === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
function dropUndefined(bag) {
  const out = {};
  for (const [k, v] of Object.entries(bag)) {
    if (v !== undefined)
      out[k] = v;
  }
  return out;
}
function itemToMetadata(item) {
  return dropUndefined({ ...item });
}
function calendarToMetadata(cal) {
  return dropUndefined({ ...cal });
}
var KINDS = ["event", "task", "milestone", "log"];
var FREQS = ["daily", "weekly", "monthly", "yearly"];
var WEEKDAYS2 = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function asWeekday(v) {
  return typeof v === "string" && WEEKDAYS2.includes(v) ? v : undefined;
}
function parseRecurrence(v) {
  const obj = asObject(v);
  if (!obj)
    return;
  const freq = asString(obj.freq);
  if (!freq || !FREQS.includes(freq))
    return;
  const rule = { freq };
  const interval = asNumber(obj.interval);
  if (interval !== undefined)
    rule.interval = Math.max(1, Math.floor(interval));
  if (Array.isArray(obj.byDay)) {
    const byDay = obj.byDay.map(asWeekday).filter((w) => w !== undefined);
    if (byDay.length)
      rule.byDay = byDay;
  }
  if (Array.isArray(obj.byMonthDay)) {
    const byMonthDay = obj.byMonthDay.filter((d) => typeof d === "number" && Number.isInteger(d) && d !== 0 && d >= -31 && d <= 31);
    if (byMonthDay.length)
      rule.byMonthDay = byMonthDay;
  }
  if (Array.isArray(obj.byWeekday)) {
    const byWeekday = [];
    for (const entry of obj.byWeekday) {
      const o = asObject(entry);
      if (!o)
        continue;
      const nth = asNumber(o.nth);
      const weekday = asWeekday(o.weekday);
      if (nth === undefined || !Number.isInteger(nth) || nth === 0 || nth < -5 || nth > 5) {
        continue;
      }
      if (!weekday)
        continue;
      byWeekday.push({ nth, weekday });
    }
    if (byWeekday.length)
      rule.byWeekday = byWeekday;
  }
  const until = asString(obj.until);
  if (until !== undefined && DATE_RE.test(until))
    rule.until = until;
  const count = asNumber(obj.count);
  if (count !== undefined && count >= 1)
    rule.count = Math.floor(count);
  return rule;
}
function parseOverrides(v) {
  if (!Array.isArray(v))
    return;
  const out = [];
  for (const entry of v) {
    const o = asObject(entry);
    if (!o)
      continue;
    const originalStart = asString(o.originalStart);
    if (originalStart === undefined)
      continue;
    const ov = { originalStart };
    const deleted = asBool(o.deleted);
    if (deleted !== undefined)
      ov.deleted = deleted;
    const patch = asObject(o.patch);
    if (patch !== undefined)
      ov.patch = patch;
    out.push(ov);
  }
  return out.length ? out : undefined;
}
function parseLinks(v) {
  if (!Array.isArray(v))
    return;
  const out = [];
  for (const entry of v) {
    const o = asObject(entry);
    if (!o)
      continue;
    const type = asString(o.type);
    const value = asString(o.value);
    if (type !== "conversation" && type !== "url" && type !== "entity" || value === undefined) {
      continue;
    }
    const link = { type, value };
    const label = asString(o.label);
    if (label !== undefined)
      link.label = label;
    out.push(link);
  }
  return out.length ? out : undefined;
}
function parseCalendarItem(metadata) {
  const id = asString(metadata.id);
  const calendarId = asString(metadata.calendarId);
  const timeZone = asString(metadata.timeZone);
  const allDay = asBool(metadata.allDay);
  const createdAt = asNumber(metadata.createdAt);
  const updatedAt = asNumber(metadata.updatedAt);
  if (id === undefined || calendarId === undefined || timeZone === undefined || allDay === undefined || createdAt === undefined || updatedAt === undefined) {
    return null;
  }
  const title = asString(metadata.title) ?? "";
  const rawKind = asString(metadata.kind);
  const kind = KINDS.includes(rawKind ?? "") ? rawKind : "event";
  let base;
  if (allDay) {
    const startDate = asString(metadata.startDate);
    const endDate = asString(metadata.endDate);
    if (startDate === undefined || endDate === undefined || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      return null;
    }
    base = {
      id,
      calendarId,
      kind,
      timeZone,
      allDay: true,
      title,
      startDate,
      endDate,
      createdAt,
      updatedAt
    };
  } else {
    const start = asNumber(metadata.start);
    let end = asNumber(metadata.end);
    if (start === undefined || end === undefined)
      return null;
    if (end < start)
      end = start;
    base = {
      id,
      calendarId,
      kind,
      timeZone,
      allDay: false,
      title,
      start,
      end,
      createdAt,
      updatedAt
    };
  }
  const recurrence = parseRecurrence(metadata.recurrence);
  if (recurrence !== undefined)
    base.recurrence = recurrence;
  const exdates = asStringArray(metadata.exdates);
  if (exdates?.length)
    base.exdates = exdates;
  const overrides = parseOverrides(metadata.overrides);
  if (overrides !== undefined)
    base.overrides = overrides;
  const links = parseLinks(metadata.links);
  if (links !== undefined)
    base.links = links;
  const tags = asStringArray(metadata.tags);
  if (tags?.length)
    base.tags = tags;
  const color = asString(metadata.color);
  if (color !== undefined)
    base.color = color;
  const location2 = asString(metadata.location);
  if (location2 !== undefined)
    base.location = location2;
  const description = asString(metadata.description);
  if (description !== undefined)
    base.description = description;
  const done = asBool(metadata.done);
  if (done !== undefined)
    base.done = done;
  const completedAt = asNumber(metadata.completedAt);
  if (completedAt !== undefined)
    base.completedAt = completedAt;
  return base;
}
function parseCalendar(metadata) {
  const id = asString(metadata.id);
  const name = asString(metadata.name);
  const createdAt = asNumber(metadata.createdAt);
  const updatedAt = asNumber(metadata.updatedAt);
  if (id === undefined || name === undefined || createdAt === undefined || updatedAt === undefined) {
    return null;
  }
  const cal = { id, name, createdAt, updatedAt };
  const color = asString(metadata.color);
  if (color !== undefined)
    cal.color = color;
  const timeZone = asString(metadata.timeZone);
  if (timeZone !== undefined)
    cal.timeZone = timeZone;
  const hidden = asBool(metadata.hidden);
  if (hidden !== undefined)
    cal.hidden = hidden;
  return cal;
}
function createItemOp(item) {
  return {
    ns: CALENDAR_NS,
    collection: ITEMS_COLLECTION,
    id: item.id,
    replace: itemToMetadata(item)
  };
}
function updateItemOp(id, patch) {
  return { ns: CALENDAR_NS, collection: ITEMS_COLLECTION, id, patch };
}
function deleteItemOp(id) {
  return { ns: CALENDAR_NS, collection: ITEMS_COLLECTION, id, delete: true };
}
function setOverrideOp(item, override) {
  const existing = item.overrides ?? [];
  const idx = existing.findIndex((o) => o.originalStart === override.originalStart);
  const next = idx >= 0 ? existing.map((o, i) => i === idx ? override : o) : [...existing, override];
  return updateItemOp(item.id, { overrides: next, updatedAt: Date.now() });
}
function addExdateOp(item, key) {
  const existing = item.exdates ?? [];
  const next = existing.includes(key) ? existing : [...existing, key];
  return updateItemOp(item.id, { exdates: next, updatedAt: Date.now() });
}
function createCalendarOp(cal) {
  return {
    ns: CALENDAR_NS,
    collection: CALENDARS_COLLECTION,
    id: cal.id,
    replace: calendarToMetadata(cal)
  };
}
function updateCalendarOp(id, patch) {
  return { ns: CALENDAR_NS, collection: CALENDARS_COLLECTION, id, patch };
}
function deleteCalendarOp(id) {
  return { ns: CALENDAR_NS, collection: CALENDARS_COLLECTION, id, delete: true };
}

// src/resources/calendar/calendar.ts
class Calendar {
  monthGrid(year, month, tz, weekStart) {
    return monthGrid(year, month, tz, weekStart);
  }
  weekRange(epochMs, tz, weekStart) {
    return weekRange(epochMs, tz, weekStart);
  }
  dayRange(epochMs, tz) {
    return dayRange(epochMs, tz);
  }
  startOfDay(epochMs, tz) {
    return startOfDayInZone(epochMs, tz);
  }
  startOfWeek(epochMs, tz, weekStart) {
    return startOfWeekInZone(epochMs, tz, weekStart);
  }
  startOfMonth(epochMs, tz) {
    return startOfMonthInZone(epochMs, tz);
  }
  addDays(epochMs, days, tz) {
    return addDaysInZone(epochMs, days, tz);
  }
  addMonths(epochMs, months, tz) {
    return addMonthsInZone(epochMs, months, tz);
  }
  isSameDay(a, b, tz) {
    return isSameDayInZone(a, b, tz);
  }
  expand(item, rangeStart, rangeEnd, opts) {
    return expandOccurrences(item, rangeStart, rangeEnd, opts);
  }
  newId() {
    return newId();
  }
  toMetadata(item) {
    return itemToMetadata(item);
  }
  parseItem(metadata) {
    return parseCalendarItem(metadata);
  }
  createItemOp(item) {
    return createItemOp(item);
  }
  updateItemOp(id, patch) {
    return updateItemOp(id, patch);
  }
  deleteItemOp(id) {
    return deleteItemOp(id);
  }
  setOverrideOp(item, override) {
    return setOverrideOp(item, override);
  }
  addExdateOp(item, key) {
    return addExdateOp(item, key);
  }
}
// src/resources/memory.ts
class Memory {
  client;
  constructor(client) {
    this.client = client;
  }
  async append(events, projectId) {
    const body = { events };
    if (projectId !== undefined)
      body.projectId = projectId;
    const res = await this.client.request("/api/v1/memory/events", {
      method: "POST",
      body
    });
    return res.events;
  }
  sync(options = {}) {
    const req = { method: "GET" };
    const query = {};
    if (options.since !== undefined)
      query.since = String(options.since);
    if (options.projectId)
      query.projectId = options.projectId;
    if (Object.keys(query).length)
      req.query = query;
    if (options.signal)
      req.signal = options.signal;
    return this.client.request("/api/v1/memory/events", req);
  }
  async query(query, options = {}) {
    const body = { query };
    if (options.k !== undefined)
      body.k = options.k;
    if (options.projectId)
      body.projectId = options.projectId;
    if (options.hybrid)
      body.hybrid = true;
    const res = await this.client.request("/api/v1/memory/query", {
      method: "POST",
      body
    });
    return res.results;
  }
}
// src/resources/embeddings.ts
var DEFAULT_BATCH_SIZE = 96;

class Embeddings {
  client;
  constructor(client) {
    this.client = client;
  }
  create(params, options = {}) {
    const req = { method: "POST", body: params, idempotent: true };
    if (options.signal)
      req.signal = options.signal;
    if (options.cache)
      req.cache = true;
    return this.client.request("/api/v1/embeddings", req);
  }
  async createBatch(params, options = {}) {
    const inputs = params.input;
    if (inputs.length === 0) {
      throw new Error("embeddings.createBatch requires a non-empty input array");
    }
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    const data = [];
    const usage = { prompt_tokens: 0, total_tokens: 0 };
    let model;
    for (let start = 0;start < inputs.length; start += batchSize) {
      const chunk = inputs.slice(start, start + batchSize);
      const res = await this.create({ ...params, input: chunk }, options);
      if (model === undefined)
        model = res.model;
      usage.prompt_tokens += res.usage.prompt_tokens;
      usage.total_tokens += res.usage.total_tokens;
      for (const item of res.data) {
        data.push({ ...item, index: start + item.index });
      }
    }
    return {
      object: "list",
      data,
      model: model ?? params.model,
      usage
    };
  }
}
// src/resources/decisions.ts
class Decisions {
  client;
  constructor(client) {
    this.client = client;
  }
  async decide(state, questions, options = {}) {
    const req = {
      method: "POST",
      idempotent: true,
      body: { state, questions, ...options.model ? { model: options.model } : {} }
    };
    if (options.signal)
      req.signal = options.signal;
    const res = await this.client.request("/api/v1/decisions", req);
    for (const a of Object.values(res.answers ?? {})) {
      if (typeof a.confidence !== "number") {
        a.confidence = typeof a.noul === "number" ? Math.abs(a.noul - 0.5) * 2 : 0;
      }
    }
    return res;
  }
}
function confident(answer, threshold = 0.8) {
  return !!answer && answer.confidence >= threshold;
}
// src/core/_internal/progress.ts
function safeEmit(listener, loaded, total) {
  if (!listener)
    return;
  try {
    listener({
      loaded,
      total,
      percent: total > 0 ? Math.floor(loaded / total * 100) : 0
    });
  } catch {}
}

// src/resources/_internal/chunkedUpload.ts
var CHUNKED_UPLOAD_THRESHOLD = 5 * 1024 * 1024;
var PER_CHUNK_RETRIES = 6;
var RETRY_BASE_MS = 250;
var RETRY_CAP_MS = 5000;
function backoffMs(attempt) {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
}
function isRetryable(err) {
  if (!(err instanceof UnifiedAIError))
    return true;
  const status = err.status;
  if (status === undefined)
    return true;
  if (status === 408 || status === 429)
    return true;
  return status >= 500 && status < 600;
}
async function putChunkWithRetry(client, uploadId, index, bytes, signal) {
  let lastErr;
  for (let attempt = 0;attempt <= PER_CHUNK_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw new UnifiedError("aborted", "files.create aborted between chunk attempts");
    }
    try {
      return await client.request(`/api/v1/files/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, {
        method: "PUT",
        body: bytes,
        contentType: "application/octet-stream",
        retry: false,
        ...signal && { signal }
      });
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === PER_CHUNK_RETRIES)
        throw err;
      await sleep(backoffMs(attempt), signal, () => new UnifiedError("aborted", "files.create aborted during chunk retry backoff"));
    }
  }
  throw lastErr ?? new Error("putChunkWithRetry exited without return or throw");
}
async function performChunkedUpload(client, opts) {
  if (opts.signal?.aborted) {
    throw new UnifiedError("aborted", "files.create aborted before chunked upload began");
  }
  const totalBytes = opts.blob.size;
  let uploadId;
  let chunkSize;
  let receivedChunks = new Set;
  let needsClearOnAbort = false;
  try {
    if (opts.resumeFrom) {
      needsClearOnAbort = true;
      const state = await client.request(`/api/v1/files/uploads/${encodeURIComponent(opts.resumeFrom)}`, {
        method: "GET",
        retry: false,
        ...opts.signal && { signal: opts.signal }
      });
      if (state.total_bytes !== totalBytes) {
        throw new UnifiedError("invalid_input", `resume session expected ${state.total_bytes} bytes; current payload is ${totalBytes}`);
      }
      if (state.mime_type !== opts.mimeType) {
        throw new UnifiedError("invalid_input", `resume session has mime_type ${state.mime_type}; current payload is ${opts.mimeType} (different file?)`);
      }
      if (state.filename !== opts.filename) {
        throw new UnifiedError("invalid_input", `resume session has filename ${state.filename}; current payload is ${opts.filename} (different file?)`);
      }
      uploadId = state.upload_id;
      chunkSize = state.chunk_size;
      const expectedTotalChunks = totalBytes === 0 ? 0 : Math.ceil(totalBytes / chunkSize);
      if (totalBytes > 0) {
        for (const idx of state.received_chunks) {
          if (!Number.isInteger(idx) || idx < 0 || idx >= expectedTotalChunks) {
            throw new UnifiedError("invalid_input", `resume session has chunk index ${idx} out of range [0, ${expectedTotalChunks}) — server may have changed chunk_size between init and resume`);
          }
        }
      }
      receivedChunks = new Set(state.received_chunks);
    } else {
      const init = await client.request("/api/v1/files/uploads", {
        method: "POST",
        body: {
          filename: opts.filename,
          mime_type: opts.mimeType,
          total_bytes: totalBytes,
          ...opts.purpose ? { purpose: opts.purpose } : {}
        },
        retry: false,
        ...opts.signal && { signal: opts.signal }
      });
      uploadId = init.upload_id;
      chunkSize = init.chunk_size;
      if (opts.onPersistUploadId) {
        try {
          await opts.onPersistUploadId(uploadId);
          needsClearOnAbort = true;
        } catch {}
      }
    }
    const totalChunks = totalBytes === 0 ? 0 : Math.ceil(totalBytes / chunkSize);
    safeEmit(opts.onProgress, 0, totalBytes);
    let loaded = 0;
    for (const idx of receivedChunks) {
      const isLast = idx === totalChunks - 1;
      loaded += isLast ? totalBytes - chunkSize * idx : chunkSize;
    }
    if (loaded > 0)
      safeEmit(opts.onProgress, loaded, totalBytes);
    for (let i = 0;i < totalChunks; i++) {
      if (receivedChunks.has(i))
        continue;
      if (opts.signal?.aborted) {
        throw new UnifiedError("aborted", "files.create aborted between chunks");
      }
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalBytes);
      const chunkBytes = new Uint8Array(await opts.blob.slice(start, end).arrayBuffer());
      await putChunkWithRetry(client, uploadId, i, chunkBytes, opts.signal);
      loaded += chunkBytes.byteLength;
      safeEmit(opts.onProgress, loaded, totalBytes);
    }
    const file = await client.request(`/api/v1/files/uploads/${encodeURIComponent(uploadId)}/complete`, {
      method: "POST",
      retry: false,
      ...opts.signal && { signal: opts.signal }
    });
    if (opts.onPersistUploadId) {
      try {
        await opts.onPersistUploadId(null);
      } catch {}
    }
    return file;
  } catch (err) {
    const isAborted = err instanceof UnifiedError && err.code === "aborted" || err instanceof Error && err.name === "AbortError" || opts.signal?.aborted === true;
    if (isAborted && needsClearOnAbort && opts.onPersistUploadId) {
      try {
        await opts.onPersistUploadId(null);
      } catch {}
    }
    throw err;
  }
}

// src/resources/_internal/contentDisposition.ts
function parseContentDispositionFilename(header) {
  if (!header)
    return;
  const extended = /filename\*\s*=\s*([^']+)'([^']*)'([^;]+)/i.exec(header);
  if (extended) {
    const value = extended[3]?.trim();
    if (value) {
      try {
        return decodeURIComponent(value);
      } catch {}
    }
  }
  const legacy = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i.exec(header);
  if (legacy) {
    const raw = legacy[1] ?? legacy[2];
    if (raw)
      return raw.replace(/\\(.)/g, "$1");
  }
  return;
}

// src/resources/_internal/mime.ts
var MAGIC = [
  { mime: "image/png", bytes: [137, 80, 78, 71, 13, 10, 26, 10] },
  { mime: "image/jpeg", bytes: [255, 216, 255] },
  { mime: "image/gif", bytes: [71, 73, 70, 56] },
  { mime: "application/pdf", bytes: [37, 80, 68, 70] },
  { mime: "audio/mpeg", bytes: [73, 68, 51] },
  { mime: "audio/mpeg", bytes: [255, 251] },
  { mime: "audio/mpeg", bytes: [255, 243] },
  { mime: "audio/mpeg", bytes: [255, 242] },
  { mime: "video/webm", bytes: [26, 69, 223, 163] }
];
var RIFF = [82, 73, 70, 70];
var WEBP_FORM = [87, 69, 66, 80];
var WAVE_FORM = [87, 65, 86, 69];
var FTYP = [102, 116, 121, 112];
var MP4_BRANDS = new Set(["mp41", "mp42", "isom", "iso2", "avc1", "dash"]);
var M4A_BRANDS = new Set(["M4A ", "M4B "]);
var MOV_BRANDS = new Set(["qt  "]);
var EXT_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm"
};
function sniffMime(bytes) {
  for (const m of MAGIC) {
    if (matchMagic(bytes, m.bytes, m.offset ?? 0))
      return m.mime;
  }
  if (matchMagic(bytes, RIFF, 0)) {
    if (matchMagic(bytes, WEBP_FORM, 8))
      return "image/webp";
    if (matchMagic(bytes, WAVE_FORM, 8))
      return "audio/wav";
  }
  if (matchMagic(bytes, FTYP, 4) && bytes.length >= 12) {
    const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
    if (M4A_BRANDS.has(brand))
      return "audio/mp4";
    if (MOV_BRANDS.has(brand))
      return "video/quicktime";
    if (MP4_BRANDS.has(brand))
      return "video/mp4";
    return "video/mp4";
  }
  return null;
}
function detectMime(source, bytes) {
  if (typeof Blob !== "undefined" && source instanceof Blob && source.type)
    return source.type;
  if (typeof source === "object" && source !== null && typeof source.arrayBuffer === "function") {
    const t = source.type;
    if (typeof t === "string" && t.length > 0)
      return t;
  }
  const fname = filenameOf(source);
  if (fname) {
    const ext = fname.split(".").pop()?.toLowerCase();
    if (ext && EXT_MIME[ext])
      return EXT_MIME[ext];
  }
  return sniffMime(bytes);
}
function matchMagic(bytes, sig, offset) {
  if (bytes.length < offset + sig.length)
    return false;
  for (let i = 0;i < sig.length; i++)
    if (bytes[offset + i] !== sig[i])
      return false;
  return true;
}
function filenameOf(source) {
  if (source === null || source === undefined)
    return;
  if (typeof source !== "object")
    return;
  const n = source.name;
  return typeof n === "string" ? n : undefined;
}

// src/resources/files.ts
function inputError2(message) {
  return new UnifiedError("invalid_input", message);
}
var DEFAULT_CT = "application/octet-stream";
var EXT_FOR_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};
function defaultFilenameFor(mime) {
  const ext = mime ? EXT_FOR_MIME[mime] : undefined;
  return ext ? `upload${ext}` : "upload";
}
function rejectDiscriminatedObject(source) {
  const s = source;
  const hits = [];
  if (typeof s.fileId === "string")
    hits.push("fileId");
  if (typeof s.url === "string")
    hits.push("url");
  if (typeof s.data === "string")
    hits.push("data");
  if (hits.length > 1) {
    throw inputError2(`files.upload source has overlapping transports (${hits.join(", ")}); pass a single Blob/Buffer/Uint8Array/ArrayBuffer or base64 data URL`);
  }
  if (typeof s.fileId === "string") {
    throw inputError2("files.upload does not accept `{ fileId }` — a fileId is the OUTPUT of upload. Pass it directly to images.edit / responses.create / chat.completions.create instead.");
  }
  if (typeof s.url === "string") {
    throw inputError2("files.upload does not accept `{ url }` — hosted URLs cannot be re-uploaded. Fetch the bytes yourself (`await (await fetch(url)).blob()`) and pass the Blob.");
  }
  if (typeof s.data === "string") {
    throw inputError2("files.upload does not accept `{ data, mimeType }` — pass a base64 data URL string (`data:<mime>;base64,<payload>`) or decode the bytes yourself.");
  }
  throw inputError2("unsupported file source; expected Blob/File/Buffer/Uint8Array/ArrayBuffer or a base64 data URL");
}
async function normalise(source, opts) {
  if (typeof source === "string") {
    if (!source.startsWith("data:")) {
      throw inputError2("string source must be a base64 data URL. Hosted URLs and raw base64 cannot be uploaded directly; " + "fetch the bytes yourself and pass a Blob/Uint8Array.");
    }
    const comma = source.indexOf(",");
    if (comma < 0)
      throw inputError2("malformed data URL (missing comma)");
    const meta = source.slice(5, comma);
    const payload = source.slice(comma + 1);
    if (!/;base64(?:;|$)/i.test(meta)) {
      throw inputError2("data URL must be base64-encoded (data:<mime>;base64,<payload>)");
    }
    const mimeFromUrl = meta.split(";")[0] || undefined;
    const bytes = base64ToBytes(payload);
    const mime = opts.contentType || mimeFromUrl || sniffMime(bytes) || DEFAULT_CT;
    return {
      blob: new Blob([bytes], { type: mime }),
      filename: opts.filename || defaultFilenameFor(mime)
    };
  }
  if (typeof Response !== "undefined" && source instanceof Response) {
    throw inputError2("fetch Response is not a supported file source. Convert it first via `await res.blob()`.");
  }
  if (typeof Request !== "undefined" && source instanceof Request) {
    throw inputError2("fetch Request is not a supported file source. Pass the underlying body bytes or a Blob.");
  }
  if (source instanceof Uint8Array) {
    const mime = opts.contentType || sniffMime(source) || DEFAULT_CT;
    return {
      blob: new Blob([source], { type: mime }),
      filename: opts.filename || defaultFilenameFor(mime)
    };
  }
  if (source instanceof ArrayBuffer) {
    const view = new Uint8Array(source);
    const mime = opts.contentType || sniffMime(view) || DEFAULT_CT;
    return {
      blob: new Blob([source], { type: mime }),
      filename: opts.filename || defaultFilenameFor(mime)
    };
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    const sourceType = source.type || "";
    let mime = opts.contentType || sourceType || "";
    if (!mime) {
      const bytes = new Uint8Array(await source.arrayBuffer());
      mime = sniffMime(bytes) || DEFAULT_CT;
      const sourceName2 = source.name;
      const filename2 = opts.filename || (typeof sourceName2 === "string" && sourceName2 ? sourceName2 : defaultFilenameFor(mime));
      return { blob: new Blob([bytes], { type: mime }), filename: filename2 };
    }
    const sourceName = source.name;
    const filename = opts.filename || (typeof sourceName === "string" && sourceName ? sourceName : defaultFilenameFor(mime));
    const blob = mime === sourceType ? source : new Blob([source], { type: mime });
    return { blob, filename };
  }
  if (typeof source === "object" && source !== null) {
    const s = source;
    if (typeof s.fileId === "string" || typeof s.url === "string" || typeof s.data === "string") {
      rejectDiscriminatedObject(source);
    }
  }
  if (typeof source === "object" && source !== null && typeof source.arrayBuffer === "function" && typeof source.size === "number") {
    const s = source;
    const buf = await s.arrayBuffer();
    const view = new Uint8Array(buf);
    const sourceType = typeof s.type === "string" ? s.type : "";
    const mime = opts.contentType || sourceType || sniffMime(view) || DEFAULT_CT;
    const sourceName = typeof s.name === "string" ? s.name : "";
    return {
      blob: new Blob([buf], { type: mime }),
      filename: opts.filename || sourceName || defaultFilenameFor(mime)
    };
  }
  if (typeof source === "object" && source !== null) {
    rejectDiscriminatedObject(source);
  }
  throw inputError2("unsupported file source; expected Blob/File/Buffer/Uint8Array/ArrayBuffer or a base64 data URL");
}

class Files {
  client;
  constructor(client) {
    this.client = client;
  }
  async upload(source, options = {}) {
    if (options.signal?.aborted) {
      throw new UnifiedError("aborted", "files.upload aborted before request was sent");
    }
    const { blob, filename } = await normalise(source, options);
    if (options.signal?.aborted) {
      throw new UnifiedError("aborted", "files.upload aborted before request was sent");
    }
    const form = new FormData;
    form.append("file", blob, filename || defaultFilenameFor(blob.type));
    const req = { method: "POST", body: form };
    if (options.signal)
      req.signal = options.signal;
    if (options.onProgress)
      req.onUploadProgress = options.onProgress;
    return this.client.request("/api/v1/images/uploads", req);
  }
  async create(source, options = {}) {
    if (options.signal?.aborted) {
      throw new UnifiedError("aborted", "files.create aborted before request was sent");
    }
    const { blob, filename } = await normalise(source, options);
    if (options.signal?.aborted) {
      throw new UnifiedError("aborted", "files.create aborted before request was sent");
    }
    const threshold = options.chunkedUploadThreshold ?? CHUNKED_UPLOAD_THRESHOLD;
    if (options.resumeFrom || blob.size > threshold) {
      return performChunkedUpload(this.client, {
        blob,
        filename: filename || defaultFilenameFor(blob.type),
        mimeType: blob.type || "application/octet-stream",
        ...options.purpose !== undefined && { purpose: options.purpose },
        ...options.resumeFrom !== undefined && { resumeFrom: options.resumeFrom },
        ...options.onProgress !== undefined && { onProgress: options.onProgress },
        ...options.onPersistUploadId !== undefined && {
          onPersistUploadId: options.onPersistUploadId
        },
        ...options.signal !== undefined && { signal: options.signal }
      });
    }
    const form = new FormData;
    form.append("file", blob, filename || defaultFilenameFor(blob.type));
    if (options.purpose)
      form.append("purpose", options.purpose);
    const req = { method: "POST", body: form };
    if (options.signal)
      req.signal = options.signal;
    if (options.onProgress)
      req.onUploadProgress = options.onProgress;
    return this.client.request("/api/v1/files", req);
  }
  async list(options = {}) {
    const req = { method: "GET" };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request("/api/v1/files", req);
  }
  async retrieve(id, options = {}) {
    if (!id)
      throw new UnifiedError("invalid_input", "files.retrieve requires a non-empty id");
    const req = { method: "GET" };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request(`/api/v1/files/${encodeURIComponent(id)}`, req);
  }
  async del(id, options = {}) {
    if (!id)
      throw new UnifiedError("invalid_input", "files.del requires a non-empty id");
    const req = { method: "DELETE" };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request(`/api/v1/files/${encodeURIComponent(id)}`, req);
  }
  async content(id, options = {}) {
    if (!id)
      throw new UnifiedError("invalid_input", "files.content requires a non-empty id");
    const req = { method: "GET" };
    if (options.signal)
      req.signal = options.signal;
    const { bytes, contentType, headers } = await this.client.requestBinary(`/api/v1/files/${encodeURIComponent(id)}/content`, req);
    const cd = headers["content-disposition"];
    const filename = parseContentDispositionFilename(cd);
    return filename ? { bytes, contentType, filename } : { bytes, contentType };
  }
}
// src/resources/_kv/namespace.ts
class BackendResolver {
  injected;
  serverCapable;
  createCloud;
  cloud = null;
  constructor(injected, serverCapable, createCloud) {
    this.injected = injected;
    this.serverCapable = serverCapable;
    this.createCloud = createCloud;
  }
  resolve() {
    const inj = this.injected();
    if (inj)
      return inj;
    if (this.serverCapable()) {
      this.cloud ??= this.createCloud();
      return this.cloud;
    }
    return null;
  }
  available() {
    const b = this.resolve();
    return !!b && b.available();
  }
}
function deriveNamespace(clientAppId, targetAppId, requestedMode) {
  const own = (clientAppId || "").trim() || "default";
  const id = targetAppId?.trim() || own;
  const crossApp = id !== own;
  return { id, mode: requestedMode ?? (crossApp ? "read" : "readwrite") };
}
function requireAvailableBackend(backend, subsystem) {
  if (!backend || !backend.available()) {
    throw subsystemError(`${subsystem}_unavailable`, `no ${subsystem} backend is available in this runtime`);
  }
  return backend;
}
function assertWritableNamespace(mode, ns, subsystem) {
  if (mode === "read") {
    throw subsystemError(`${subsystem}_read_only`, `namespace "${ns}" is read-only`);
  }
}

// src/resources/fs/cloud.ts
class CloudFsBackend {
  client;
  name = "cloud-fs";
  constructor(client) {
    this.client = client;
  }
  post(path, body) {
    return this.client.request(`/api/v1/fs${path}`, { method: "POST", body });
  }
  available() {
    return true;
  }
  async read(ns, path) {
    const { blobB64 } = await this.post("/read", { ns, path });
    return blobB64 ? base64ToBytes(blobB64) : null;
  }
  async write(req) {
    await this.post("/write", {
      ns: req.ns,
      path: req.path,
      blobB64: bytesToBase64(req.bytes)
    });
  }
  async list(ns, prefix) {
    const { entries } = await this.post("/list", {
      ns,
      prefix: prefix ?? null
    });
    return entries;
  }
  async stat(ns, path) {
    const { stat } = await this.post("/stat", { ns, path });
    return stat;
  }
  async delete(ns, path) {
    const { deleted } = await this.post("/delete", { ns, path });
    return deleted;
  }
}

// src/resources/fs/errors.ts
var fsError = subsystemError;

// src/resources/fs/path.ts
function normalizeRelPath(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw fsError("invalid_path", "path must be a non-empty string");
  }
  const raw = input.replace(/\\/g, "/");
  if (raw.startsWith("/")) {
    throw fsError("invalid_path", `path must be relative, got "${input}"`);
  }
  if (/^[a-zA-Z]:/.test(raw)) {
    throw fsError("invalid_path", `path must not be absolute, got "${input}"`);
  }
  const out = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".")
      continue;
    if (seg === "..") {
      if (out.length === 0) {
        throw fsError("invalid_path", `path escapes the namespace root: "${input}"`);
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) {
    throw fsError("invalid_path", `path resolves to the namespace root: "${input}"`);
  }
  return out.join("/");
}
function normalizePrefix(input) {
  if (input === undefined || input === "" || input === "/" || input === ".")
    return "";
  return normalizeRelPath(input);
}
function normalizeNs(input) {
  const ns = (input ?? "").trim();
  if (ns === "")
    return "default";
  if (ns === "." || ns === ".." || /[/\\\0]/.test(ns)) {
    throw fsError("invalid_input", `invalid namespace: ${JSON.stringify(input)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(ns)) {
    throw fsError("invalid_input", `invalid namespace: ${JSON.stringify(input)}`);
  }
  return ns.toLowerCase();
}

// src/resources/fs/fs.ts
var utf8Encoder = new TextEncoder;
var utf8Decoder = new TextDecoder;

class FsNamespaceImpl {
  backend;
  id;
  mode;
  constructor(backend, id, mode) {
    this.backend = backend;
    this.id = id;
    this.mode = mode;
  }
  requireBackend() {
    return requireAvailableBackend(this.backend, "fs");
  }
  assertWritable() {
    assertWritableNamespace(this.mode, this.id, "fs");
  }
  async read(path) {
    return utf8Decoder.decode(await this.readBytes(path));
  }
  async readBytes(path) {
    const backend = this.requireBackend();
    const rel = normalizeRelPath(path);
    const bytes = await backend.read(this.id, rel);
    if (bytes === null)
      throw fsError("not_found", `no such file: "${rel}"`);
    return bytes;
  }
  async write(path, content) {
    this.assertWritable();
    const backend = this.requireBackend();
    const rel = normalizeRelPath(path);
    const bytes = typeof content === "string" ? utf8Encoder.encode(content) : content;
    await backend.write({ ns: this.id, path: rel, bytes });
  }
  async edit(path, oldString, newString) {
    this.assertWritable();
    const backend = this.requireBackend();
    const rel = normalizeRelPath(path);
    const existing = await backend.read(this.id, rel);
    if (existing === null)
      throw fsError("edit_not_found", `no such file: "${rel}"`);
    const text = utf8Decoder.decode(existing);
    const first = text.indexOf(oldString);
    if (first === -1) {
      throw fsError("edit_not_found", `old_string not found in "${rel}"`);
    }
    if (oldString && text.indexOf(oldString, first + oldString.length) !== -1) {
      throw fsError("edit_not_unique", `old_string is not unique in "${rel}"; include more surrounding context`);
    }
    const next = text.slice(0, first) + newString + text.slice(first + oldString.length);
    await backend.write({ ns: this.id, path: rel, bytes: utf8Encoder.encode(next) });
  }
  async list(opts = {}) {
    const backend = this.requireBackend();
    const prefix = normalizePrefix(opts.prefix);
    const entries = await backend.list(this.id, prefix || undefined);
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return entries;
  }
  async exists(path) {
    return await this.stat(path) !== null;
  }
  async stat(path) {
    const backend = this.requireBackend();
    const rel = normalizeRelPath(path);
    return backend.stat(this.id, rel);
  }
  async delete(path) {
    this.assertWritable();
    const backend = this.requireBackend();
    const rel = normalizeRelPath(path);
    return backend.delete(this.id, rel);
  }
}

class Fs {
  client;
  resolver;
  constructor(client) {
    this.client = client;
    this.resolver = new BackendResolver(() => client.fsBackend, () => client.serverCapable, () => new CloudFsBackend(client));
  }
  available() {
    return this.resolver.available();
  }
  namespace(appId, opts = {}) {
    const { id, mode } = deriveNamespace(this.client.appId, appId, opts.mode);
    return new FsNamespaceImpl(this.resolver.resolve(), id, mode);
  }
}
// src/resources/helpers.ts
function inputError3(message) {
  return new UnifiedError("invalid_input", message);
}
async function normaliseSource(source, opts) {
  if (typeof source === "string") {
    if (isDataUrl(source)) {
      if (!isBase64DataUrl(source)) {
        throw inputError3("data URL must be base64-encoded (data:<mime>;base64,<payload>). " + "URL-encoded data URLs are not supported.");
      }
      return {
        url: source,
        mimeType: opts.mimeType ?? mimeFromDataUrl(source),
        filename: opts.filename
      };
    }
    if (isHttpUrl(source) || isGsUrl(source)) {
      return { url: source, mimeType: opts.mimeType, filename: opts.filename };
    }
    throw inputError3("string source must be an http(s) URL, data URL, or gs:// URL. " + "Pass raw base64 as `{ data, mimeType }` instead.");
  }
  if (typeof Response !== "undefined" && source instanceof Response) {
    throw inputError3("fetch Response is not a supported multimodal source. Convert it first " + "via `await res.blob()` or `new Uint8Array(await res.arrayBuffer())`.");
  }
  if (typeof Request !== "undefined" && source instanceof Request) {
    throw inputError3("fetch Request is not a supported multimodal source. Pass the underlying " + "URL string or body bytes instead.");
  }
  if (typeof source === "object" && source !== null && !isBinaryLike(source)) {
    const hits = [];
    if (typeof source.fileId === "string")
      hits.push("fileId");
    if (typeof source.url === "string")
      hits.push("url");
    if (typeof source.data === "string")
      hits.push("data");
    if (hits.length > 1) {
      throw inputError3(`multimodal source has overlapping transports (${hits.join(", ")}); set exactly one of fileId / url / data`);
    }
    if (hits.length === 0) {
      throw inputError3("multimodal object source must set one of `fileId`, `url`, or `data` (with `mimeType`)");
    }
    if (isFileIdInput(source)) {
      return {
        fileId: source.fileId,
        mimeType: opts.mimeType ?? source.mimeType,
        filename: opts.filename
      };
    }
    if (isUrlInput(source)) {
      return {
        url: source.url,
        mimeType: opts.mimeType ?? source.mimeType,
        filename: opts.filename
      };
    }
    if (isRawBase64Input(source)) {
      return {
        base64: source.data,
        mimeType: opts.mimeType ?? source.mimeType,
        filename: opts.filename
      };
    }
    if (typeof source.data === "string") {
      throw inputError3("raw base64 source requires `mimeType` (got `{ data }` without `mimeType`)");
    }
  }
  const bytes = await toBytes(source);
  const mime = opts.mimeType ?? detectMime(source, bytes) ?? undefined;
  return {
    base64: bytesToBase64(bytes),
    mimeType: mime,
    filename: opts.filename ?? filenameOf(source)
  };
}
function isBinaryLike(s) {
  if (s instanceof Uint8Array)
    return true;
  if (s instanceof ArrayBuffer)
    return true;
  if (typeof Blob !== "undefined" && s instanceof Blob)
    return true;
  if (typeof Response !== "undefined" && s instanceof Response)
    return false;
  if (typeof Request !== "undefined" && s instanceof Request)
    return false;
  return typeof s === "object" && s !== null && typeof s.arrayBuffer === "function" && typeof s.size === "number";
}
function isFileIdInput(s) {
  return typeof s === "object" && s !== null && typeof s.fileId === "string";
}
function isUrlInput(s) {
  return typeof s === "object" && s !== null && typeof s.url === "string";
}
function isRawBase64Input(s) {
  return typeof s === "object" && s !== null && typeof s.data === "string" && typeof s.mimeType === "string";
}
async function toBytes(source) {
  if (source instanceof Uint8Array)
    return source;
  if (source instanceof ArrayBuffer)
    return new Uint8Array(source);
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    return new Uint8Array(await source.arrayBuffer());
  }
  if (typeof source === "object" && source !== null && typeof source.arrayBuffer === "function" && typeof source.size === "number") {
    const buf = await source.arrayBuffer();
    return new Uint8Array(buf);
  }
  throw inputError3("unsupported multimodal source; expected Blob/File/Buffer/Uint8Array/ArrayBuffer");
}
function isDataUrl(s) {
  return s.startsWith("data:");
}
function isBase64DataUrl(s) {
  if (!isDataUrl(s))
    return false;
  const i = s.indexOf(",");
  if (i < 0)
    return false;
  return /;base64(?:;|$)/i.test(s.slice(5, i));
}
function isHttpUrl(s) {
  return s.startsWith("http://") || s.startsWith("https://");
}
function isGsUrl(s) {
  return s.startsWith("gs://");
}
function mimeFromDataUrl(s) {
  if (!isDataUrl(s))
    return;
  const m = s.match(/^data:([^;,]+)[;,]/);
  return m ? m[1] : undefined;
}
function dataUrlFor(n, kind) {
  if (n.url)
    return n.url;
  if (n.base64 === undefined) {
    throw inputError3(`cannot build ${kind} part: source had no bytes or URL`);
  }
  const mime = n.mimeType ?? defaultMimeFor(kind);
  return `data:${mime};base64,${n.base64}`;
}
function defaultMimeFor(kind) {
  switch (kind) {
    case "image":
      return "application/octet-stream";
    case "audio":
      return "audio/mpeg";
    case "video":
      return "video/mp4";
    case "file":
      return "application/octet-stream";
  }
}
async function toChatImagePart(source, opts = {}) {
  const n = await normaliseSource(source, opts);
  if (n.fileId) {
    throw inputError3("chat.completions image_url does not accept file_id. Use sdk.helpers.toResponsesImagePart " + "or sdk.helpers.toChatFilePart instead.");
  }
  const part = { type: "image_url", image_url: { url: dataUrlFor(n, "image") } };
  if (opts.detail)
    part.image_url.detail = opts.detail;
  return part;
}
async function toChatAudioPart(source, opts = {}) {
  const n = await normaliseSource(source, opts);
  if (n.fileId || n.url) {
    throw inputError3("chat.completions input_audio requires inline base64. Use a Blob/Buffer/Uint8Array, " + "or for hosted audio use sdk.helpers.toChatFilePart.");
  }
  if (n.base64 === undefined) {
    throw inputError3("audio part requires bytes");
  }
  const format = opts.format ?? formatFromMime(n.mimeType);
  if (!format) {
    throw inputError3("audio format could not be inferred; pass `{ format: 'wav' | 'mp3' }`");
  }
  return { type: "input_audio", input_audio: { data: n.base64, format } };
}
async function toChatVideoPart(source, opts = {}) {
  const n = await normaliseSource(source, opts);
  if (n.fileId) {
    throw inputError3("chat.completions video_url does not accept file_id. Use sdk.helpers.toChatFilePart instead.");
  }
  return { type: "video_url", video_url: { url: dataUrlFor(n, "video") } };
}
async function toChatFilePart(source, opts = {}) {
  const n = await normaliseSource(source, opts);
  const file = {};
  if (n.fileId)
    file.file_id = n.fileId;
  else if (n.url && !isDataUrl(n.url))
    file.file_url = n.url;
  else
    file.file_data = dataUrlFor(n, "file");
  if (n.filename)
    file.filename = n.filename;
  return { type: "file", file };
}
async function toResponsesImagePart(source, opts = {}) {
  const n = await normaliseSource(source, opts);
  const part = { type: "input_image" };
  if (n.fileId)
    part.file_id = n.fileId;
  else
    part.image_url = dataUrlFor(n, "image");
  if (opts.detail)
    part.detail = opts.detail;
  return part;
}
async function toResponsesAudioPart(source, opts = {}) {
  const { input_audio } = await toChatAudioPart(source, opts);
  return { type: "input_audio", input_audio };
}
async function toResponsesVideoPart(source, opts = {}) {
  const n = await normaliseSource(source, opts);
  const part = { type: "input_video" };
  if (n.fileId)
    part.file_id = n.fileId;
  else if (n.url && !isDataUrl(n.url))
    part.video_url = n.url;
  else
    part.file_data = dataUrlFor(n, "video");
  return part;
}
async function toResponsesFilePart(source, opts = {}) {
  const n = await normaliseSource(source, opts);
  const part = { type: "input_file" };
  if (n.fileId)
    part.file_id = n.fileId;
  else if (n.url && !isDataUrl(n.url))
    part.file_url = n.url;
  else
    part.file_data = dataUrlFor(n, "file");
  if (n.filename)
    part.filename = n.filename;
  return part;
}
var ANTHROPIC_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
]);
async function toMessagesImagePart(source, opts = {}) {
  const n = await normaliseSource(source, opts);
  if (n.fileId)
    return { type: "image", source: { type: "file", file_id: n.fileId } };
  if (n.url && !isDataUrl(n.url))
    return { type: "image", source: { type: "url", url: n.url } };
  const data = n.base64 ?? base64FromDataUrl(n.url);
  const mime = n.mimeType ?? mimeFromDataUrl(n.url ?? "");
  if (!mime || !ANTHROPIC_IMAGE_MIME.has(mime)) {
    throw inputError3(`messages image requires media_type in ${[...ANTHROPIC_IMAGE_MIME].join(", ")}; got ${mime ?? "<unknown>"}`);
  }
  if (!data) {
    throw inputError3("messages image requires base64 data");
  }
  return { type: "image", source: { type: "base64", media_type: mime, data } };
}
async function toMessagesDocumentPart(source, opts = {}) {
  const n = await normaliseSource(source, opts);
  if (n.fileId)
    return { type: "document", source: { type: "file", file_id: n.fileId } };
  if (n.url && !isDataUrl(n.url))
    return { type: "document", source: { type: "url", url: n.url } };
  const data = n.base64 ?? base64FromDataUrl(n.url);
  const mime = n.mimeType ?? mimeFromDataUrl(n.url ?? "");
  if (mime !== "application/pdf") {
    throw inputError3(`messages document requires application/pdf; got ${mime ?? "<unknown>"}`);
  }
  if (!data) {
    throw inputError3("messages document requires base64 data");
  }
  return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
}
function base64FromDataUrl(url) {
  if (!url || !isBase64DataUrl(url))
    return;
  const i = url.indexOf(",");
  return url.slice(i + 1);
}
function formatFromMime(mime) {
  if (!mime)
    return;
  if (mime === "audio/wav" || mime === "audio/x-wav")
    return "wav";
  if (mime === "audio/mpeg" || mime === "audio/mp3")
    return "mp3";
  return;
}

class Helpers {
  toImagePart(source, opts) {
    return toChatImagePart(source, opts);
  }
  toAudioPart(source, opts) {
    return toChatAudioPart(source, opts);
  }
  toVideoPart(source, opts) {
    return toChatVideoPart(source, opts);
  }
  toFilePart(source, opts) {
    return toChatFilePart(source, opts);
  }
  toChatImagePart(source, opts) {
    return toChatImagePart(source, opts);
  }
  toChatAudioPart(source, opts) {
    return toChatAudioPart(source, opts);
  }
  toChatVideoPart(source, opts) {
    return toChatVideoPart(source, opts);
  }
  toChatFilePart(source, opts) {
    return toChatFilePart(source, opts);
  }
  toResponsesImagePart(source, opts) {
    return toResponsesImagePart(source, opts);
  }
  toResponsesAudioPart(source, opts) {
    return toResponsesAudioPart(source, opts);
  }
  toResponsesVideoPart(source, opts) {
    return toResponsesVideoPart(source, opts);
  }
  toResponsesFilePart(source, opts) {
    return toResponsesFilePart(source, opts);
  }
  toMessagesImagePart(source, opts) {
    return toMessagesImagePart(source, opts);
  }
  toMessagesDocumentPart(source, opts) {
    return toMessagesDocumentPart(source, opts);
  }
}
// src/resources/images.ts
class Images {
  client;
  constructor(client) {
    this.client = client;
  }
  generate(params, options = {}) {
    const req = { method: "POST", body: params, idempotent: true };
    if (options.signal)
      req.signal = options.signal;
    if (options.cache)
      req.cache = true;
    return this.client.request("/api/v1/images/generations", req);
  }
  edit(params, options = {}) {
    const req = { method: "POST", body: params };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request("/api/v1/images/edits", req);
  }
  upload(params, options = {}) {
    const form = new FormData;
    form.append("file", params.file, params.filename || "image.png");
    const req = { method: "POST", body: form };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request("/api/v1/images/uploads", req);
  }
  createVariation(params, options = {}) {
    const form = new FormData;
    form.append("image", params.image, params.filename ?? "image.png");
    if (params.n !== undefined)
      form.append("n", String(params.n));
    if (params.size !== undefined)
      form.append("size", params.size);
    if (params.response_format !== undefined)
      form.append("response_format", params.response_format);
    if (params.user !== undefined)
      form.append("user", params.user);
    if (params.conversation_id !== undefined)
      form.append("conversation_id", params.conversation_id);
    const req = { method: "POST", body: form };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request("/api/v1/images/variations", req);
  }
}
// src/resources/messages.ts
class MessageStream extends UnifiedStream {
  finalPromise = null;
  finalMessage() {
    if (!this.finalPromise)
      this.finalPromise = aggregateFinalMessage(this);
    return this.finalPromise;
  }
}
async function aggregateFinalMessage(stream) {
  let message = null;
  const partialJson = {};
  for await (const ev of stream) {
    switch (ev.type) {
      case "message_start": {
        const m = ev.message;
        message = {
          id: m.id,
          type: "message",
          role: m.role,
          model: m.model,
          content: [],
          stop_reason: m.stop_reason ?? null,
          stop_sequence: m.stop_sequence ?? null,
          usage: {
            input_tokens: m.usage?.input_tokens ?? 0,
            output_tokens: m.usage?.output_tokens ?? 0
          }
        };
        break;
      }
      case "content_block_start": {
        if (!message)
          break;
        const block = JSON.parse(JSON.stringify(ev.content_block));
        if (block.type === "tool_use") {
          block.input = block.input ?? {};
          partialJson[ev.index] = "";
        }
        message.content[ev.index] = block;
        break;
      }
      case "content_block_delta": {
        if (!message)
          break;
        const block = message.content[ev.index];
        if (!block)
          break;
        const d = ev.delta;
        if (d.type === "text_delta" && block.type === "text") {
          block.text += d.text;
        } else if (d.type === "input_json_delta" && block.type === "tool_use") {
          partialJson[ev.index] = (partialJson[ev.index] ?? "") + d.partial_json;
        } else if (d.type === "thinking_delta" && block.type === "thinking") {
          block.thinking += d.thinking;
        } else if (d.type === "signature_delta" && block.type === "thinking") {
          block.signature = d.signature;
        }
        break;
      }
      case "content_block_stop": {
        if (!message)
          break;
        const block = message.content[ev.index];
        if (block?.type === "tool_use") {
          const raw = partialJson[ev.index];
          if (raw && raw.length > 0) {
            try {
              block.input = JSON.parse(raw);
            } catch {}
          }
          delete partialJson[ev.index];
        }
        break;
      }
      case "message_delta": {
        if (!message)
          break;
        if (ev.delta.stop_reason !== undefined)
          message.stop_reason = ev.delta.stop_reason;
        if (ev.delta.stop_sequence !== undefined)
          message.stop_sequence = ev.delta.stop_sequence;
        if (ev.usage?.output_tokens !== undefined) {
          message.usage.output_tokens = ev.usage.output_tokens;
        }
        break;
      }
      case "message_stop":
      case "ping":
      case "error":
        break;
    }
  }
  if (!message) {
    throw new UnifiedAIError("request_failed", "messages stream ended before message_start", 0, null);
  }
  return message;
}

class Messages {
  client;
  constructor(client) {
    this.client = client;
  }
  create(params, options = {}) {
    if (params.stream) {
      return this.createStream(params, options);
    }
    const req = {
      method: "POST",
      body: { ...params, compression: params.compression ?? this.client.defaultCompression }
    };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request("/v1/messages", req);
  }
  createStream(params, options) {
    let inputTokens = 0;
    return createSSEStream({
      client: this.client,
      path: "/v1/messages",
      params,
      signal: options.signal,
      streamClass: MessageStream,
      interpret: (parsed, eventName) => {
        const type = eventName ?? (typeof parsed.type === "string" ? parsed.type : undefined);
        if (!type)
          return null;
        if (type === "error") {
          const err = parsed.error ?? parsed;
          throw new UnifiedAIError("request_failed", `messages stream error: ${err.message ?? "unknown"}`, 0, parsed);
        }
        return {
          event: { ...parsed, type },
          terminal: type === "message_stop"
        };
      },
      usage: (ev) => {
        if (ev.type === "message_start") {
          const u = ev.message?.usage;
          if (u)
            inputTokens = u.input_tokens ?? 0;
          return null;
        }
        if (ev.type === "message_delta") {
          const out = ev.usage?.output_tokens ?? 0;
          return {
            input_tokens: inputTokens,
            output_tokens: out,
            total_tokens: inputTokens + out
          };
        }
        return null;
      }
    });
  }
}
// src/resources/models.ts
class Models {
  client;
  constructor(client) {
    this.client = client;
  }
  list(options = {}) {
    const req = { method: "GET" };
    if (options.signal)
      req.signal = options.signal;
    const path = options.include?.length ? `/api/v1/models?include=${encodeURIComponent(options.include.join(","))}` : "/api/v1/models";
    return this.client.request(path, req);
  }
}
// src/resources/autoModel.ts
var LONG_TEXT = 1200;
var DEEP_WORDS = /\b(plan|architect|architecture|design the|refactor|debug|diagnose|root cause|trade[- ]?offs?|why does|why is|prove|derive|migrate|strategy)\b/i;
var DESIGN_WORDS = /\b(design|mockup|wireframe|ui|ux|layout|typography|palette|brand|logo|poster|landing page)\b/i;
function firstByHint(models, hints) {
  for (const hint of hints) {
    const match = models.find((m) => `${m.id} ${m.name}`.toLowerCase().includes(hint));
    if (match)
      return match;
  }
  return;
}
function roleFor(req) {
  if (req.needsVision)
    return "vision";
  if (DESIGN_WORDS.test(req.text) && !req.codeWork)
    return "design";
  if (req.effort === "high")
    return "deep";
  if (req.effort === "low")
    return "fast";
  if (req.codeWork)
    return "deep";
  if (DEEP_WORDS.test(req.text))
    return "deep";
  if (req.text.length >= LONG_TEXT)
    return "deep";
  return "fast";
}
// src/resources/autoRouter.ts
function firstJsonObject(raw) {
  const start = raw.indexOf("{");
  if (start < 0)
    return null;
  let depth = 0;
  for (let i = start;i < raw.length; i++) {
    if (raw[i] === "{")
      depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
function usableText(models) {
  return models.filter((m) => m.type === "text");
}
function defaultConfig(models) {
  const text = usableText(models);
  const everyday = firstByHint(text, ["haiku", "flash", "mini", "composer", "lite", "small", "fast", "turbo"]) ?? text[0];
  const everydayId = everyday?.id ?? null;
  const pick = (hints) => firstByHint(text, hints)?.id ?? everydayId;
  const vision = models.find((m) => m.type === "text" && m.image_inp);
  const profiles = [
    {
      id: "everyday",
      name: "Everyday",
      modelId: everydayId,
      useWhen: "Short questions, low effort, and anything nothing else claims."
    },
    {
      id: "planner",
      name: "Planner",
      modelId: pick(["fable", "opus", "ultra", "pro", "thinking", "reasoner", "sonnet"]),
      useWhen: "Hard changes that need a plan first: the steps, and an acceptance criterion for each, before anyone touches a file.",
      costsMore: true
    },
    {
      id: "executor",
      name: "Executor",
      modelId: pick(["grok", "sonnet", "cursor-agent", "agent", "pro"]),
      useWhen: "Carries out a step of a plan against real files, then reports what changed."
    },
    {
      id: "fast-worker",
      name: "Fast worker",
      modelId: pick(["composer", "haiku", "flash", "mini"]),
      useWhen: "Mechanical steps with a precise spec — renames, boilerplate, formatting, a test that mirrors an existing one."
    },
    {
      id: "tester",
      name: "Tester",
      modelId: pick(["opus", "fable", "sonnet", "pro"]),
      useWhen: "Checks a change against its acceptance criteria — runs what matters, returns pass or fail with the evidence.",
      costsMore: true
    },
    {
      id: "design",
      name: "Design",
      modelId: pick(["kimi", "gemini", "gpt", "sonnet"]),
      useWhen: "Layout, type, palette, brand — when no workspace is attached."
    },
    {
      id: "vision",
      name: "Reading an image",
      modelId: vision?.id ?? null,
      useWhen: "A picture or a PDF on the turn. A requirement, not a tier — never held back."
    }
  ];
  const sequences = [
    {
      id: "build",
      name: "Build",
      useWhen: "Changes across several files, or anything that says implement, migrate or refactor.",
      stages: [
        { kind: "plan", profileIds: ["planner"] },
        { kind: "work", profileIds: ["executor", "fast-worker"] },
        { kind: "test", profileIds: ["tester"] }
      ],
      retries: 2
    },
    {
      id: "small-change",
      name: "Small change",
      useWhen: "A fix you can describe in one sentence.",
      stages: [
        { kind: "work", profileIds: ["fast-worker"] },
        { kind: "test", profileIds: ["tester"] }
      ],
      retries: 1
    }
  ];
  return {
    dispatcherModelId: everydayId,
    everydayId: "everyday",
    profiles,
    sequences,
    stepUp: "stay",
    hintsFallback: true
  };
}
function profileById(config, id) {
  return config.profiles.find((p) => p.id === id);
}
function sequenceById(config, id) {
  return config.sequences.find((s) => s.id === id);
}
function stageLabel(config, stage) {
  const names = stage.profileIds.map((id) => profileById(config, id)?.name ?? id);
  return names[0] ?? stage.kind;
}
function dispatchPrompt(config, text, ctx) {
  const lines = [];
  for (const profile of config.profiles) {
    if (profile.modelId === null)
      continue;
    lines.push(`- ${profile.id} — ${profile.name}: ${profile.useWhen}`);
  }
  for (const seq of config.sequences) {
    const stageNames = seq.stages.map((s) => stageLabel(config, s)).join(" → ");
    lines.push(`- ${seq.id} — ${seq.name} (${stageNames}): ${seq.useWhen}`);
  }
  const notes = [
    "Pick exactly one id.",
    "Prefer a single profile unless the request needs a plan across several steps."
  ];
  if (ctx?.codeWork)
    notes.push("A code workspace is attached.");
  else if (ctx?.codeWork === false)
    notes.push("No workspace is attached: nothing can be written to disk or run, so prefer a single profile unless the request only needs a plan.");
  if (ctx?.needsVision)
    notes.push("The turn carries an image; pick a profile that can read one.");
  return [
    "Choose which of these should handle this request:",
    ...lines,
    ...notes,
    "",
    "Request:",
    "```",
    text,
    "```",
    `Reply with JSON only: {"pick":"<id>","why":"<one short line>"}`
  ].join(`
`);
}
function parseDispatch(raw, config) {
  const parsed = firstJsonObject(raw);
  if (!parsed || typeof parsed.pick !== "string")
    return null;
  const pick = parsed.pick;
  const why = typeof parsed.why === "string" ? parsed.why : "";
  if (profileById(config, pick))
    return { kind: "profile", id: pick, why };
  if (sequenceById(config, pick))
    return { kind: "sequence", id: pick, why };
  return null;
}
function fallbackDispatch(config, req) {
  const role = roleFor(req);
  const everyday = { kind: "profile", id: config.everydayId, why: "built-in hint" };
  if (role === "vision") {
    const vision = profileById(config, "vision");
    return vision?.modelId ? { kind: "profile", id: "vision", why: "built-in hint" } : everyday;
  }
  if (role === "design") {
    const design = profileById(config, "design");
    return design?.modelId ? { kind: "profile", id: "design", why: "built-in hint" } : everyday;
  }
  if (role === "deep") {
    const seq = config.sequences.find((s) => s.stages.some((st) => st.kind === "plan"));
    return seq ? { kind: "sequence", id: seq.id, why: "built-in hint" } : everyday;
  }
  return everyday;
}
function costsMore(pick, config) {
  if (pick.kind === "profile")
    return profileById(config, pick.id)?.costsMore ?? false;
  const seq = sequenceById(config, pick.id);
  if (!seq)
    return false;
  return seq.stages.some((stage) => stage.profileIds.some((id) => profileById(config, id)?.costsMore));
}
function gate(pick, config, opts) {
  if (!costsMore(pick, config))
    return { action: "run" };
  if (config.stepUp === "auto" || opts?.sessionAllowed)
    return { action: "run" };
  if (config.stepUp === "ask")
    return { action: "ask" };
  return { action: "hold", declined: pick };
}
function pickWorker(step, stage) {
  return step.mechanical && stage.profileIds[1] ? stage.profileIds[1] : stage.profileIds[0];
}
function planPrompt(request) {
  return [
    `Plan how to do this: ${request}`,
    "Do not edit any file. Produce 2–7 steps in order.",
    "Each step has a short title, one acceptance criterion the tester can check, and mechanical=true when the step is a precise spec a cheaper model can carry out (renames, boilerplate, formatting).",
    `Reply with JSON only: {"steps":[{"title":"…","criterion":"…","mechanical":false}]}`
  ].join(`
`);
}
function parsePlan(raw) {
  const parsed = firstJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.steps))
    return null;
  if (parsed.steps.length < 1 || parsed.steps.length > 12)
    return null;
  const steps = [];
  for (const raw2 of parsed.steps) {
    const s = raw2;
    if (typeof s.title !== "string" || !s.title || typeof s.criterion !== "string" || !s.criterion) {
      return null;
    }
    steps.push({ title: s.title, criterion: s.criterion, mechanical: Boolean(s.mechanical) });
  }
  return steps;
}
function stepPrompt(request, step, ctx) {
  const lines = [
    `Step ${ctx.index + 1} of ${ctx.total} of a plan for: ${request}.`,
    `Do this step: ${step.title}.`,
    `It is done when: ${step.criterion}.`
  ];
  if (ctx.priorNotes.length) {
    lines.push("Notes from earlier steps:");
    for (const note of ctx.priorNotes)
      lines.push(`- ${note}`);
  }
  if (ctx.failure)
    lines.push(`The tester failed this step: ${ctx.failure}. Fix that.`);
  lines.push("End with one short paragraph of what changed.");
  return lines.join(`
`);
}
function testPrompt(request, steps, workNotes) {
  const lines = [`Check this work against its plan for: ${request}.`, "Criteria:"];
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step.criterion}`));
  if (workNotes.length) {
    lines.push("What was done:");
    for (const note of workNotes)
      lines.push(`- ${note}`);
  }
  lines.push("Check every criterion. Run what you need to. Do not fix anything.");
  lines.push(`Reply with JSON only: {"results":[{"criterion":"…","pass":true,"evidence":"…"}]}`);
  return lines.join(`
`);
}
function parseTestReport(raw, steps) {
  const parsed = firstJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.results))
    return null;
  const results = parsed.results;
  return steps.map((step, i) => {
    const r = results[i];
    return {
      criterion: step.criterion,
      pass: r ? Boolean(r.pass) : false,
      evidence: r && typeof r.evidence === "string" ? r.evidence : r ? "" : "not reported"
    };
  });
}
// src/resources/projects.ts
var utf8Encoder2 = new TextEncoder;
function encodeSnapshot(s) {
  const c = s.content;
  let bytes;
  let encoding;
  if (typeof c === "string") {
    bytes = utf8Encoder2.encode(c);
    encoding = "utf8";
  } else if (c instanceof Uint8Array) {
    bytes = c;
    encoding = "binary";
  } else {
    bytes = new Uint8Array(c);
    encoding = "arraybuffer";
  }
  return {
    snapshotB64: bytesToBase64(bytes),
    snapshotEncoding: encoding,
    ...s.preview !== undefined ? { snapshotPreview: s.preview } : {}
  };
}

class Projects {
  client;
  constructor(client) {
    this.client = client;
  }
  create(input) {
    return this.client.request("/api/v1/projects", {
      method: "POST",
      body: { name: input.name, ...input.metadata ? { metadata: input.metadata } : {} }
    });
  }
  async list(options = {}) {
    const req = { method: "GET" };
    if (options.archived)
      req.query = { archived: "1" };
    if (options.signal)
      req.signal = options.signal;
    const { projects } = await this.client.request("/api/v1/projects", req);
    return projects;
  }
  async get(id) {
    const { project } = await this.client.request(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "GET" });
    return project;
  }
  update(id, patch) {
    return this.client.request(`/api/v1/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch
    });
  }
  archive(id) {
    return this.update(id, { archived: true });
  }
  unarchive(id) {
    return this.update(id, { archived: false });
  }
  async delete(id) {
    const { deleted } = await this.client.request(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
    return deleted;
  }
  async links(projectId) {
    const { links } = await this.client.request(`/api/v1/projects/${encodeURIComponent(projectId)}/links`, { method: "GET" });
    return links;
  }
  addLink(projectId, input) {
    const body = {
      targetApp: input.targetApp,
      targetKind: input.targetKind,
      artifactType: input.artifactType
    };
    if (input.targetAppId !== undefined)
      body.targetAppId = input.targetAppId;
    if (input.collection !== undefined)
      body.collection = input.collection;
    if (input.id !== undefined)
      body.id = input.id;
    if (input.path !== undefined)
      body.path = input.path;
    if (input.fragment !== undefined)
      body.fragment = input.fragment;
    if (input.label !== undefined)
      body.label = input.label;
    if (input.role !== undefined)
      body.role = input.role;
    if (input.addedByApp !== undefined)
      body.addedByApp = input.addedByApp;
    if (input.snapshot)
      Object.assign(body, encodeSnapshot(input.snapshot));
    return this.client.request(`/api/v1/projects/${encodeURIComponent(projectId)}/links`, { method: "POST", body });
  }
  async removeLink(projectId, linkId) {
    const { deleted } = await this.client.request(`/api/v1/projects/${encodeURIComponent(projectId)}/links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
    return deleted;
  }
  async members(projectId) {
    const { members } = await this.client.request(`/api/v1/projects/${encodeURIComponent(projectId)}/members`, { method: "GET" });
    return members;
  }
  addMember(projectId, userId, role = "member") {
    return this.client.request(`/api/v1/projects/${encodeURIComponent(projectId)}/members`, {
      method: "POST",
      body: { userId, role }
    });
  }
  async removeMember(projectId, userId) {
    const { removed } = await this.client.request(`/api/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
    return removed;
  }
}
// src/resources/references.ts
var SCHEME = "uniref://";
var utf8Decoder2 = new TextDecoder;
function decode(w) {
  let text = null;
  let bytes = null;
  if (w.blobB64 != null) {
    const raw = base64ToBytes(w.blobB64);
    if (w.blobEncoding === "utf8")
      text = utf8Decoder2.decode(raw);
    else
      bytes = raw;
  }
  return {
    linkId: w.linkId,
    projectId: w.projectId,
    targetApp: w.targetApp,
    targetKind: w.targetKind,
    fragment: w.fragment ?? {},
    artifactType: w.artifactType,
    label: w.label,
    kind: w.kind,
    found: w.found,
    stale: w.stale,
    updatedAt: w.updatedAt,
    metadata: w.metadata,
    encoding: w.blobEncoding,
    text,
    bytes
  };
}
function linkIdOf(ref) {
  if (typeof ref !== "string")
    return ref.linkId;
  if (ref.startsWith(SCHEME))
    return References.parse(ref).linkId;
  return ref;
}

class References {
  client;
  constructor(client) {
    this.client = client;
  }
  static format(projectId, linkId) {
    return `${SCHEME}${projectId}/${linkId}`;
  }
  format(projectId, linkId) {
    return References.format(projectId, linkId);
  }
  static parse(uri) {
    if (!uri.startsWith(SCHEME)) {
      throw new Error(`not a reference URI: ${uri}`);
    }
    const [projectId, linkId] = uri.slice(SCHEME.length).split("/");
    if (!projectId || !linkId)
      throw new Error(`malformed reference URI: ${uri}`);
    return { projectId, linkId };
  }
  parse(uri) {
    return References.parse(uri);
  }
  async resolve(ref, options = {}) {
    const linkId = linkIdOf(ref);
    const req = { method: "GET" };
    if (options.signal)
      req.signal = options.signal;
    const { reference } = await this.client.request(`/api/v1/references/${encodeURIComponent(linkId)}/resolve`, req);
    return decode(reference);
  }
  async resync(ref, snapshot) {
    const linkId = linkIdOf(ref);
    const c = snapshot.content;
    let bytes;
    let encoding;
    if (typeof c === "string") {
      bytes = new TextEncoder().encode(c);
      encoding = "utf8";
    } else if (c instanceof Uint8Array) {
      bytes = c;
      encoding = "binary";
    } else {
      bytes = new Uint8Array(c);
      encoding = "arraybuffer";
    }
    const snapshotB64 = bytesToBase64(bytes);
    const { reference } = await this.client.request(`/api/v1/references/${encodeURIComponent(linkId)}/resync`, {
      method: "POST",
      body: {
        snapshotB64,
        snapshotEncoding: encoding,
        ...snapshot.preview !== undefined ? { snapshotPreview: snapshot.preview } : {}
      }
    });
    return decode(reference);
  }
}
// src/resources/responses.ts
class Responses {
  client;
  constructor(client) {
    this.client = client;
  }
  create(params, options = {}) {
    if (params.stream) {
      return this.createStream(params, options);
    }
    const req = {
      method: "POST",
      body: { ...params, compression: params.compression ?? this.client.defaultCompression }
    };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request("/api/v1/responses", req);
  }
  createStream(params, options) {
    return createSSEStream({
      client: this.client,
      path: "/api/v1/responses",
      params,
      signal: options.signal,
      interpret: (parsed, eventName) => {
        const type = eventName ?? (typeof parsed.type === "string" ? parsed.type : undefined);
        if (!type)
          return null;
        if (type === "error") {
          const err = parsed.error ?? parsed;
          const m = typeof err.message === "string" ? err.message : "unknown";
          throw new UnifiedAIError("request_failed", `responses stream error: ${m}`, 0, parsed);
        }
        return {
          event: { ...parsed, type },
          terminal: type === "response.completed"
        };
      },
      usage: (ev) => {
        if (ev.type !== "response.completed")
          return null;
        const u = ev.response?.usage;
        if (!u)
          return null;
        return {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
        };
      }
    });
  }
}
// src/resources/openArtifact.ts
var OPEN_ARTIFACT_ACTION = "openArtifact";
var OPEN_ARTIFACT_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    objectId: {
      type: "string",
      description: "App-local id of the artifact to open."
    },
    path: {
      type: "string",
      description: "Storage path, for file-backed artifacts that have no object id."
    },
    collection: {
      type: "string",
      description: "App-local collection the object lives in, when the caller knows it."
    },
    kind: {
      type: "string",
      description: "The app's own artifact kind, for apps that route differently per kind."
    },
    fragment: {
      type: "object",
      additionalProperties: true,
      description: "App-interpreted portion locator (the ProjectLink/reference `fragment`). Absent or {} means the whole artifact."
    }
  }
};
var OPEN_ARTIFACT_SPEC = {
  id: OPEN_ARTIFACT_ACTION,
  title: "Open an artifact",
  description: "Bring one of this app's artifacts on screen. Invoked by the shell when the user follows a cross-app pointer — a search result, an @-mention, a project link, a reference. Not intended for agent use; the app's own open actions are the model-facing ones.",
  params: OPEN_ARTIFACT_PARAMS_SCHEMA,
  tier: "safe",
  mutates: false,
  exposeToMcp: false
};
function cleanFragment(fragment) {
  if (!fragment || typeof fragment !== "object")
    return;
  return Object.keys(fragment).length > 0 ? fragment : undefined;
}
function toOpenArtifactParams(ref) {
  const out = {};
  if (ref.objectId)
    out.objectId = ref.objectId;
  if (ref.path)
    out.path = ref.path;
  if (ref.collection)
    out.collection = ref.collection;
  if (ref.kind)
    out.kind = ref.kind;
  const fragment = cleanFragment(ref.fragment);
  if (fragment)
    out.fragment = fragment;
  return out;
}
function isResolvableArtifactRef(ref) {
  return Boolean(ref.app && (ref.objectId || ref.path));
}
function artifactRefFromLink(link) {
  const fragment = cleanFragment(link.fragment);
  return {
    app: link.targetApp,
    objectId: link.objectId,
    path: link.path,
    collection: link.collection,
    projectId: link.projectId,
    kind: link.artifactType,
    label: link.label,
    ...fragment ? { fragment } : {}
  };
}
function artifactRefFromHit(app, hit) {
  const openRef = hit.openRef;
  return {
    app,
    objectId: openRef?.objectId ?? hit.id,
    collection: openRef?.collection ?? null,
    projectId: openRef?.projectId ?? hit.projectId ?? null,
    kind: hit.kind,
    label: hit.title,
    ...openRef?.action ? { action: openRef.action, params: openRef.params } : {}
  };
}
// src/resources/_kv/sharing.ts
var grantSeq = 0;
function nextGrantId() {
  grantSeq += 1;
  return `ngr_${grantSeq.toString(36)}`;
}
function granteeKey(g) {
  return g.type === "agent" ? "agent" : `app:${g.appId}`;
}
function validateGrantee(g) {
  if (g.type === "agent")
    return { type: "agent" };
  if (g.type === "app") {
    const appId = g.appId.trim();
    if (!appId) {
      throw subsystemError("invalid_input", "grantee.appId must be a non-empty string");
    }
    return { type: "app", appId };
  }
  throw subsystemError("invalid_input", 'grantee.type must be "app" or "agent"');
}

class MemoryGrantStore {
  byId = new Map;
  byNsGrantee = new Map;
  list(ns) {
    const out = [];
    for (const g of this.byId.values()) {
      if (g.ns === ns)
        out.push({ ...g, grantee: { ...g.grantee } });
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }
  get(id) {
    const g = this.byId.get(id);
    return g ? { ...g, grantee: { ...g.grantee } } : undefined;
  }
  upsert(ns, grantee, mode) {
    const g = validateGrantee(grantee);
    const key = `${ns}\x00${granteeKey(g)}`;
    const now = Date.now();
    const existingId = this.byNsGrantee.get(key);
    if (existingId) {
      const prev = this.byId.get(existingId);
      if (prev) {
        const next = { ...prev, mode, updatedAt: now, grantee: g };
        this.byId.set(existingId, next);
        return { ...next, grantee: { ...next.grantee } };
      }
    }
    const id = nextGrantId();
    const grant = {
      id,
      ns,
      grantee: g,
      mode,
      createdAt: now,
      updatedAt: now
    };
    this.byId.set(id, grant);
    this.byNsGrantee.set(key, id);
    return { ...grant, grantee: { ...grant.grantee } };
  }
  delete(id) {
    const g = this.byId.get(id);
    if (!g)
      return false;
    this.byId.delete(id);
    this.byNsGrantee.delete(`${g.ns}\x00${granteeKey(g.grantee)}`);
    return true;
  }
  allows(caller, ns, mode) {
    return namespaceAccess(this, caller, ns, mode);
  }
}
function namespaceAccess(store, caller, ns, mode) {
  const own = (caller.appId || "").trim();
  if (own && ns === own)
    return true;
  for (const g of store.list(ns)) {
    if (!granteeMatches(g.grantee, caller))
      continue;
    if (mode === "read" || g.mode === "readwrite")
      return true;
  }
  return false;
}
function granteeMatches(grantee, caller) {
  if (grantee.type === "agent")
    return caller.kind === "agent";
  return caller.kind === "app" && grantee.appId === caller.appId;
}
function notGrantedError(subsystem, ns) {
  return subsystemError(`${subsystem}_not_granted`, `no grant to access namespace "${ns}"`);
}

// src/resources/_kv/grants.ts
class NamespaceSharing {
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  caller() {
    return { appId: this.opts.ownNs(), kind: this.opts.client.callerKind };
  }
  own() {
    const ns = this.opts.ownNs().trim();
    if (!ns) {
      throw new UnifiedError("invalid_input", `cannot manage ${this.opts.resource} grants without an appId`);
    }
    return ns;
  }
  resolveNs(ns) {
    const trimmed = ns?.trim();
    return trimmed || this.own();
  }
  async list(opts = {}) {
    const ns = this.resolveNs(opts.ns);
    this.assertOwner(ns);
    if (this.opts.local)
      return this.opts.local.list(ns);
    const res = await this.opts.client.request(this.collectionPath(), {
      method: "GET",
      query: { ns }
    });
    return res.grants;
  }
  async grant(input) {
    const ns = this.resolveNs(input.ns);
    this.assertOwner(ns);
    const mode = input.mode ?? "read";
    if (this.opts.local)
      return this.opts.local.upsert(ns, input.grantee, mode);
    return this.opts.client.request(this.collectionPath(), {
      method: "POST",
      body: { ns, grantee: input.grantee, mode }
    });
  }
  async revoke(id) {
    if (!id.trim())
      throw new UnifiedError("invalid_input", "grant id is required");
    if (this.opts.local) {
      const g = this.opts.local.get(id);
      if (g)
        this.assertOwner(g.ns);
      return this.opts.local.delete(id);
    }
    const res = await this.opts.client.request(this.itemPath(id), {
      method: "DELETE"
    });
    return res.revoked;
  }
  assertLocalAccess(targetNs, mode) {
    const local = this.opts.local;
    if (!local)
      return;
    if (namespaceAccess(local, this.caller(), targetNs, mode))
      return;
    throw notGrantedError(this.opts.resource, targetNs);
  }
  assertOwner(ns) {
    if (ns !== this.own()) {
      throw new UnifiedError("invalid_input", `only the owning app can manage grants for namespace "${ns}"`);
    }
  }
  collectionPath() {
    return `/api/v1/${this.opts.resource}/grants`;
  }
  itemPath(id) {
    return `${this.collectionPath()}/${encodeURIComponent(id)}`;
  }
}

// src/resources/storage/errors.ts
var storageError = subsystemError;
function storageAbortError(what, reason) {
  return new UnifiedError("aborted", `${what} was aborted`, undefined, reason);
}
function throwIfAborted(signal, what, cause) {
  if (!signal?.aborted)
    return;
  throw storageAbortError(what, signal.reason ?? cause);
}

// src/resources/storage/cloud.ts
class CloudStorageBackend {
  client;
  name = "cloud";
  constructor(client) {
    this.client = client;
  }
  post(path, body, opts) {
    const req = { method: "POST", body };
    if (opts?.signal)
      req.signal = opts.signal;
    return this.client.request(`/api/v1/storage${path}`, req);
  }
  available() {
    return true;
  }
  ensureCollection() {
    return Promise.resolve();
  }
  put(req) {
    return this.post("/put", {
      ns: req.ns,
      collection: req.collection,
      id: req.id,
      metadata: req.metadata,
      versioned: req.versioned,
      blobB64: req.blob ? bytesToBase64(req.blob) : null,
      blobEncoding: req.blobEncoding ?? null
    });
  }
  async get(ns, collection, id, opts) {
    const { record } = await this.post("/get", { ns, collection, id }, opts);
    return record;
  }
  query(ns, collection, query, opts) {
    return this.post("/query-v2", { ns, collection, query }, opts);
  }
  async count(ns, collection, query, opts) {
    throwIfAborted(opts?.signal, `count on "${collection}"`);
    const { limit: _limit, after: _after, ...rest } = query;
    const { count } = await this.post("/count-v2", { ns, collection, query: rest }, opts);
    return count;
  }
  async delete(ns, collection, id) {
    const { deleted } = await this.post("/delete", { ns, collection, id });
    return deleted;
  }
  async readBlob(ns, collection, id, opts) {
    const { blobB64 } = await this.post("/read-blob", { ns, collection, id }, opts);
    return blobB64 ? base64ToBytes(blobB64) : null;
  }
  async listVersions(ns, collection, id) {
    const { versions } = await this.post("/list-versions", {
      ns,
      collection,
      id
    });
    return versions;
  }
  async getVersion(ns, collection, id, version) {
    const { record } = await this.post("/get-version", {
      ns,
      collection,
      id,
      version
    });
    return record;
  }
  async readVersionBlob(ns, collection, id, version) {
    const { blobB64 } = await this.post("/read-version-blob", {
      ns,
      collection,
      id,
      version
    });
    return blobB64 ? base64ToBytes(blobB64) : null;
  }
  revert(ns, collection, id, version) {
    return this.post("/revert", { ns, collection, id, version });
  }
}

// src/resources/_kv/keys.ts
function pkOf(ns, collection, id) {
  return JSON.stringify([ns, collection, id]);
}
function cpkOf(ns, collection) {
  return JSON.stringify([ns, collection]);
}
function vpkOf(ns, collection, id, version) {
  return JSON.stringify([ns, collection, id, version]);
}

// src/resources/storage/predicate.ts
var SEARCH_TEXT_FIELD = "searchText";
var MAX_IN = 50;
var MAX_PAGE = 1000;
var DEFAULT_PAGE = 100;
var OPS = new Set(["eq", "neq", "in", "gt", "gte", "lt", "lte", "exists", "match"]);
var RANGE_OPS = new Set(["gt", "gte", "lt", "lte"]);
function isScalar(v) {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}
function assertScalar(v, field, op) {
  if (isScalar(v))
    return v;
  throw storageError("invalid_input", `where.${field}.${op} needs a string, number, or boolean (got ${describe(v)})`);
}
function describe(v) {
  if (v === null)
    return "null";
  if (Array.isArray(v))
    return "an array";
  return typeof v;
}
function isOperatorObject(v, field) {
  if (typeof v !== "object" || v === null)
    return false;
  if (Array.isArray(v) || v instanceof Uint8Array || v instanceof ArrayBuffer)
    return false;
  if (v instanceof Date)
    return false;
  const keys = Object.keys(v);
  if (keys.length === 0)
    return false;
  if (keys.every((k) => OPS.has(k)))
    return true;
  const unknown = keys.filter((k) => !OPS.has(k));
  if (unknown.length < keys.length) {
    throw storageError("invalid_input", `where.${field} has unknown operator(s): ${unknown.join(", ")} — ` + `valid operators are ${[...OPS].join(", ")}`);
  }
  return false;
}
function rangeType(value) {
  return typeof value === "number" ? "number" : "text";
}
function compileOp(field, op, raw) {
  if (op === "exists") {
    if (typeof raw !== "boolean") {
      throw storageError("invalid_input", `where.${field}.exists needs a boolean`);
    }
    return { field, op: "exists", value: raw };
  }
  if (op === "in") {
    if (!Array.isArray(raw)) {
      throw storageError("invalid_input", `where.${field}.in needs an array`);
    }
    if (raw.length > MAX_IN) {
      throw storageError("invalid_input", `where.${field}.in has ${raw.length} items (max ${MAX_IN}) — split the query`);
    }
    return { field, op: "in", value: raw.map((v) => assertScalar(v, field, "in")) };
  }
  if (op === "match") {
    if (field !== SEARCH_TEXT_FIELD) {
      throw storageError("invalid_input", `where.${field}.match is not supported — full-text \`match\` only works on ` + `"${SEARCH_TEXT_FIELD}", the one field with a full-text index. Put the ` + `searchable text in a "${SEARCH_TEXT_FIELD}" field.`);
    }
    if (typeof raw !== "string" || raw.length === 0) {
      throw storageError("invalid_input", `where.${field}.match needs a non-empty string`);
    }
    return { field, op: "match", value: raw };
  }
  const value = assertScalar(raw, field, op);
  if (RANGE_OPS.has(op)) {
    return { field, op, value, type: rangeType(value) };
  }
  return { field, op, value };
}
function compileWhere(where) {
  if (!where)
    return [];
  const out = [];
  for (const field of Object.keys(where)) {
    const raw = where[field];
    if (raw === undefined || raw === null) {
      out.push({ field, op: "exists", value: false });
      continue;
    }
    if (isOperatorObject(raw, field)) {
      for (const op of Object.keys(raw))
        out.push(compileOp(field, op, raw[op]));
      continue;
    }
    out.push(compileOp(field, "eq", raw));
  }
  return out;
}
function jsonbRank(v) {
  if (v === null || v === undefined)
    return 0;
  if (typeof v === "string")
    return 1;
  if (typeof v === "number")
    return 2;
  if (typeof v === "boolean")
    return 3;
  if (Array.isArray(v))
    return 4;
  return 5;
}
function compareValues(a, b, type) {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn)
    return an && bn ? 0 : an ? 1 : -1;
  if (type === "number") {
    const ra = jsonbRank(a);
    const rb = jsonbRank(b);
    if (ra !== rb)
      return ra < rb ? -1 : 1;
    if (typeof a === "number" && typeof b === "number")
      return a === b ? 0 : a < b ? -1 : 1;
    if (typeof a === "boolean" && typeof b === "boolean")
      return a === b ? 0 : a ? 1 : -1;
  }
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa.localeCompare(sb);
}
function tokens(s) {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
function websearchMatch(haystack, query) {
  const hay = tokens(haystack);
  const joined = ` ${hay.join(" ")} `;
  const phrases = [...query.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
  const rest = query.replace(/"[^"]*"/g, " ");
  for (const phrase of phrases) {
    const p = tokens(phrase);
    if (p.length === 0)
      continue;
    if (!joined.includes(` ${p.join(" ")} `))
      return false;
  }
  const terms = rest.split(/\s+/).filter(Boolean);
  let sawPositive = phrases.some((p) => tokens(p).length > 0);
  for (const term of terms) {
    if (term.toLowerCase() === "or")
      continue;
    const negated = term.startsWith("-");
    const body = tokens(negated ? term.slice(1) : term);
    if (body.length === 0)
      continue;
    const present = body.every((t) => hay.includes(t));
    if (negated) {
      if (present)
        return false;
    } else {
      sawPositive = true;
      if (!present)
        return false;
    }
  }
  return sawPositive || terms.length === 0;
}
function matchesClause(metadata, w) {
  const present = Object.hasOwn(metadata, w.field) && metadata[w.field] !== undefined && metadata[w.field] !== null;
  if (w.op === "exists")
    return present === (w.value === true);
  if (!present)
    return false;
  const actual = metadata[w.field];
  switch (w.op) {
    case "eq":
      return String(actual) === String(w.value);
    case "neq":
      return String(actual) !== String(w.value);
    case "in":
      return Array.isArray(w.value) && w.value.map((v) => String(v)).includes(String(actual));
    case "gt":
      return compareValues(actual, w.value, w.type) > 0;
    case "gte":
      return compareValues(actual, w.value, w.type) >= 0;
    case "lt":
      return compareValues(actual, w.value, w.type) < 0;
    case "lte":
      return compareValues(actual, w.value, w.type) <= 0;
    case "match":
      return typeof actual === "string" && websearchMatch(actual, String(w.value));
    default:
      return false;
  }
}
function matchesWhere(metadata, clauses) {
  if (!clauses || clauses.length === 0)
    return true;
  for (const w of clauses)
    if (!matchesClause(metadata, w))
      return false;
  return true;
}
var utf8Encoder3 = new TextEncoder;
var utf8Decoder3 = new TextDecoder;
function encodeCursor(cursor) {
  return bytesToBase64Url(utf8Encoder3.encode(JSON.stringify(cursor)));
}
function decodeCursor(token) {
  let parsed;
  try {
    const padded = token.replace(/-/g, "+").replace(/_/g, "/");
    parsed = JSON.parse(utf8Decoder3.decode(base64ToBytes(padded)));
  } catch {
    throw storageError("invalid_input", "invalid pagination cursor");
  }
  const c = parsed;
  if (!c || typeof c !== "object" || c.v !== 1 || typeof c.i !== "string" || c.o !== undefined && typeof c.o !== "string" && typeof c.o !== "number") {
    throw storageError("invalid_input", "invalid pagination cursor");
  }
  return c;
}
function cursorForRow(orderValue, id) {
  const o = typeof orderValue === "string" || typeof orderValue === "number" ? orderValue : undefined;
  return encodeCursor(o === undefined ? { v: 1, i: id } : { v: 1, o, i: id });
}
function clampPage(raw) {
  if (raw === undefined)
    return DEFAULT_PAGE;
  if (!Number.isFinite(raw) || raw <= 0)
    return DEFAULT_PAGE;
  return Math.min(MAX_PAGE, Math.trunc(raw));
}

// src/resources/storage/memory.ts
function stripNulls(value) {
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined)
      continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v) && v.constructor === Object ? stripNulls(v) : v;
  }
  return out;
}
function toRecord(row) {
  return {
    id: row.id,
    metadata: row.metadata,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasBlob: row.hasBlob,
    ...row.blobEncoding ? { blobEncoding: row.blobEncoding } : {}
  };
}

class MemoryBackend {
  name = "memory";
  grants;
  objects = new Map;
  blobs = new Map;
  versions = new Map;
  constructor(opts = {}) {
    this.grants = opts.grants ?? new MemoryGrantStore;
  }
  available() {
    return true;
  }
  ensureCollection() {
    return Promise.resolve();
  }
  put(req) {
    const now = Date.now();
    const metadata = stripNulls(req.metadata);
    const pk = pkOf(req.ns, req.collection, req.id);
    const existing = this.objects.get(pk);
    const version = (existing?.version ?? 0) + 1;
    const createdAt = existing?.createdAt ?? now;
    const row = {
      ns: req.ns,
      collection: req.collection,
      id: req.id,
      cpk: cpkOf(req.ns, req.collection),
      metadata,
      version,
      createdAt,
      updatedAt: now,
      hasBlob: req.blob !== undefined,
      ...req.blobEncoding ? { blobEncoding: req.blobEncoding } : {}
    };
    this.objects.set(pk, row);
    if (req.blob !== undefined)
      this.blobs.set(pk, req.blob.slice());
    else
      this.blobs.delete(pk);
    if (req.versioned) {
      this.versions.set(vpkOf(req.ns, req.collection, req.id, version), {
        opk: pk,
        version,
        metadata,
        createdAt: now,
        hasBlob: req.blob !== undefined,
        ...req.blobEncoding ? { blobEncoding: req.blobEncoding } : {},
        ...req.blob !== undefined ? { bytes: req.blob.slice() } : {}
      });
    }
    return Promise.resolve({ id: req.id, version, updatedAt: now });
  }
  get(ns, collection, id, opts) {
    throwIfAborted(opts?.signal, `get on "${collection}"`);
    const row = this.objects.get(pkOf(ns, collection, id));
    return Promise.resolve(row ? toRecord(row) : null);
  }
  matching(ns, collection, q) {
    const cpk = cpkOf(ns, collection);
    const rows = [];
    for (const row of this.objects.values()) {
      if (row.cpk === cpk && matchesWhere(row.metadata, q.where))
        rows.push(row);
    }
    return rows;
  }
  query(ns, collection, q, opts) {
    throwIfAborted(opts?.signal, `query on "${collection}"`);
    const field = q.orderBy?.field;
    const type = q.orderBy?.type;
    const dir = q.orderBy?.dir === "desc" ? -1 : 1;
    const rows = this.matching(ns, collection, q);
    rows.sort((a, b) => {
      if (field) {
        const c = compareValues(a.metadata[field], b.metadata[field], type) * dir;
        if (c !== 0)
          return c;
      }
      return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
    });
    let page = rows;
    if (q.after) {
      const cursor = decodeCursor(q.after);
      if (field) {
        page = rows.filter((r) => {
          const c = compareValues(r.metadata[field], cursor.o, type) * dir;
          return c > 0 || c === 0 && r.id > cursor.i;
        });
      } else {
        page = rows.filter((r) => r.id > cursor.i);
      }
    }
    const limit = clampPage(q.limit);
    const hasMore = page.length > limit;
    const slice = hasMore ? page.slice(0, limit) : page;
    const last = slice[slice.length - 1];
    return Promise.resolve({
      records: slice.map(toRecord),
      ...hasMore && last ? { nextCursor: cursorForRow(field ? last.metadata[field] : undefined, last.id) } : {}
    });
  }
  count(ns, collection, q, opts) {
    throwIfAborted(opts?.signal, `count on "${collection}"`);
    return Promise.resolve(this.matching(ns, collection, q).length);
  }
  delete(ns, collection, id) {
    const pk = pkOf(ns, collection, id);
    const existed = this.objects.delete(pk);
    this.blobs.delete(pk);
    for (const [vpk, v] of this.versions)
      if (v.opk === pk)
        this.versions.delete(vpk);
    return Promise.resolve(existed);
  }
  readBlob(ns, collection, id, opts) {
    throwIfAborted(opts?.signal, `readBlob on "${collection}"`);
    const b = this.blobs.get(pkOf(ns, collection, id));
    return Promise.resolve(b ? b.slice() : null);
  }
  listVersions(ns, collection, id) {
    const opk = pkOf(ns, collection, id);
    const out = [];
    for (const v of this.versions.values()) {
      if (v.opk === opk)
        out.push({ version: v.version, createdAt: v.createdAt, hasBlob: v.hasBlob });
    }
    out.sort((a, b) => b.version - a.version);
    return Promise.resolve(out);
  }
  getVersion(ns, collection, id, version) {
    const v = this.versions.get(vpkOf(ns, collection, id, version));
    if (!v)
      return Promise.resolve(null);
    return Promise.resolve({
      id,
      metadata: v.metadata,
      version: v.version,
      createdAt: v.createdAt,
      updatedAt: v.createdAt,
      hasBlob: v.hasBlob,
      ...v.blobEncoding ? { blobEncoding: v.blobEncoding } : {}
    });
  }
  readVersionBlob(ns, collection, id, version) {
    const v = this.versions.get(vpkOf(ns, collection, id, version));
    return Promise.resolve(v?.bytes ? v.bytes.slice() : null);
  }
  async revert(ns, collection, id, version) {
    const v = this.versions.get(vpkOf(ns, collection, id, version));
    if (!v)
      throw storageError("not_found", `version ${version} not found for "${id}"`);
    return this.put({
      ns,
      collection,
      id,
      metadata: v.metadata,
      versioned: true,
      ...v.bytes !== undefined ? { blob: v.bytes.slice() } : {},
      ...v.blobEncoding ? { blobEncoding: v.blobEncoding } : {}
    });
  }
}

// src/resources/storage/storage.ts
var utf8Encoder4 = new TextEncoder;
var utf8Decoder4 = new TextDecoder;
var MAX_SCAN_PAGES = 100;
function encodeBlob(raw) {
  if (typeof raw === "string")
    return { bytes: utf8Encoder4.encode(raw), encoding: "utf8" };
  if (raw instanceof Uint8Array)
    return { bytes: raw, encoding: "binary" };
  if (raw instanceof ArrayBuffer)
    return { bytes: new Uint8Array(raw), encoding: "arraybuffer" };
  throw storageError("invalid_input", "blob field must be a string, Uint8Array, or ArrayBuffer");
}
function decodeBlob(bytes, encoding) {
  if (encoding === "utf8")
    return utf8Decoder4.decode(bytes);
  if (encoding === "arraybuffer")
    return bytes.slice().buffer;
  return bytes;
}

class CollectionImpl {
  backend;
  ns;
  name;
  schema;
  mode;
  sharing;
  blobField;
  versioned;
  ensurePromise = null;
  constructor(backend, ns, name, schema, mode, sharing) {
    this.backend = backend;
    this.ns = ns;
    this.name = name;
    this.schema = schema;
    this.mode = mode;
    this.sharing = sharing;
    this.blobField = schema.blob;
    this.versioned = schema.versioned === true;
  }
  requireBackend() {
    return requireAvailableBackend(this.backend, "storage");
  }
  assertReadable() {
    this.sharing.assertLocalAccess(this.ns, "read");
  }
  assertWritable() {
    assertWritableNamespace(this.mode, this.ns, "storage");
    this.sharing.assertLocalAccess(this.ns, "readwrite");
  }
  ensure(backend) {
    if (!this.ensurePromise) {
      this.ensurePromise = backend.ensureCollection(this.ns, this.name, {
        key: this.schema.key,
        indexes: Array.from(this.schema.indexes ?? []),
        ...this.blobField ? { blobField: this.blobField } : {},
        versioned: this.versioned
      });
    }
    return this.ensurePromise;
  }
  idOf(value) {
    const keyVal = value[this.schema.key];
    const id = keyVal === undefined || keyVal === null ? "" : String(keyVal);
    if (!id) {
      throw storageError("invalid_input", `record is missing required key "${this.schema.key}"`);
    }
    return id;
  }
  hydrate(rec, blob) {
    const out = { ...rec.metadata };
    if (this.blobField && blob) {
      out[this.blobField] = decodeBlob(blob, rec.blobEncoding);
    }
    return out;
  }
  fieldType(field) {
    const declared = this.schema.fieldTypes?.[field];
    return declared ?? "text";
  }
  toBackendQuery(q) {
    const orderField = typeof q.orderBy === "string" ? q.orderBy : q.orderBy?.field;
    if (this.blobField) {
      if (q.where && this.blobField in q.where) {
        throw storageError("invalid_input", `cannot filter on blob field "${this.blobField}"`);
      }
      if (orderField === this.blobField) {
        throw storageError("invalid_input", `cannot order by blob field "${this.blobField}"`);
      }
    }
    const out = {};
    const where = compileWhere(q.where);
    if (where.length > 0)
      out.where = where;
    if (orderField) {
      const explicit = typeof q.orderBy === "string" ? undefined : q.orderBy;
      out.orderBy = {
        field: orderField,
        type: explicit?.type ?? this.fieldType(orderField),
        dir: explicit?.dir ?? q.order ?? "asc"
      };
    }
    if (q.limit !== undefined)
      out.limit = q.limit;
    if (q.after !== undefined)
      out.after = q.after;
    return out;
  }
  async abortable(signal, what, run) {
    throwIfAborted(signal, what);
    try {
      return await run();
    } catch (err) {
      throwIfAborted(signal, what, err);
      throw err;
    }
  }
  async put(value) {
    this.assertWritable();
    const backend = this.requireBackend();
    await this.ensure(backend);
    const id = this.idOf(value);
    const metadata = { ...value };
    let blob;
    let blobEncoding;
    if (this.blobField) {
      const raw = metadata[this.blobField];
      delete metadata[this.blobField];
      if (raw !== undefined && raw !== null) {
        const enc = encodeBlob(raw);
        blob = enc.bytes;
        blobEncoding = enc.encoding;
      }
    }
    const req = {
      ns: this.ns,
      collection: this.name,
      id,
      metadata,
      versioned: this.versioned,
      ...blob !== undefined && blobEncoding !== undefined ? { blob, blobEncoding } : {}
    };
    return backend.put(req);
  }
  async get(id, opts = {}) {
    this.assertReadable();
    const signal = opts.signal;
    const what = `get on "${this.name}"`;
    const backend = this.requireBackend();
    throwIfAborted(signal, what);
    await this.ensure(backend);
    const call = signal ? { signal } : undefined;
    const rec = await this.abortable(signal, what, () => backend.get(this.ns, this.name, id, call));
    if (!rec)
      return null;
    const blob = this.blobField && rec.hasBlob ? await this.abortable(signal, what, () => backend.readBlob(this.ns, this.name, id, call)) : null;
    return this.hydrate(rec, blob);
  }
  async query(q = {}) {
    this.assertReadable();
    const signal = q.signal;
    const what = `query on "${this.name}"`;
    const backend = this.requireBackend();
    throwIfAborted(signal, what);
    await this.ensure(backend);
    const bq = this.toBackendQuery(q);
    const call = signal ? { signal } : undefined;
    const want = q.limit;
    const rows = [];
    let after = bq.after;
    let seen;
    for (let pages = 0;; pages++) {
      const remaining = want === undefined ? MAX_PAGE : want - rows.length;
      if (remaining <= 0)
        break;
      const page = await this.abortable(signal, what, () => backend.query(this.ns, this.name, {
        ...bq,
        limit: Math.min(MAX_PAGE, remaining),
        ...after === undefined ? {} : { after }
      }, call));
      rows.push(...page.records);
      if (!page.nextCursor)
        break;
      if (want !== undefined && rows.length >= want)
        break;
      if (page.nextCursor === seen)
        break;
      seen = page.nextCursor;
      after = page.nextCursor;
      if (pages + 1 >= MAX_SCAN_PAGES) {
        throw storageError("invalid_input", `query on "${this.name}" exceeded ${MAX_SCAN_PAGES * MAX_PAGE} rows — pass a limit, narrow the where, or page with page()/after`);
      }
    }
    const out = want === undefined ? rows : rows.slice(0, want);
    return out.map((r) => ({ ...r.metadata }));
  }
  async page(q = {}) {
    this.assertReadable();
    const signal = q.signal;
    const what = `page on "${this.name}"`;
    const backend = this.requireBackend();
    throwIfAborted(signal, what);
    await this.ensure(backend);
    const call = signal ? { signal } : undefined;
    const { records, nextCursor } = await this.abortable(signal, what, () => backend.query(this.ns, this.name, this.toBackendQuery(q), call));
    return {
      items: records.map((r) => ({ ...r.metadata })),
      ...nextCursor ? { nextCursor } : {}
    };
  }
  async count(q = {}) {
    this.assertReadable();
    const signal = q.signal;
    const what = `count on "${this.name}"`;
    const backend = this.requireBackend();
    throwIfAborted(signal, what);
    await this.ensure(backend);
    const bq = this.toBackendQuery(q);
    const call = signal ? { signal } : undefined;
    return this.abortable(signal, what, () => backend.count(this.ns, this.name, bq.where ? { where: bq.where } : {}, call));
  }
  async delete(id) {
    this.assertWritable();
    const backend = this.requireBackend();
    await this.ensure(backend);
    return backend.delete(this.ns, this.name, id);
  }
  del(id) {
    return this.delete(id);
  }
  async blob(id) {
    this.assertReadable();
    const backend = this.requireBackend();
    await this.ensure(backend);
    return backend.readBlob(this.ns, this.name, id);
  }
  async versions(id) {
    this.assertReadable();
    const backend = this.requireBackend();
    await this.ensure(backend);
    const list = await backend.listVersions(this.ns, this.name, id);
    return list.map((v) => ({ version: v.version, createdAt: v.createdAt }));
  }
  async getVersion(id, version) {
    this.assertReadable();
    const backend = this.requireBackend();
    await this.ensure(backend);
    const rec = await backend.getVersion(this.ns, this.name, id, version);
    if (!rec)
      return null;
    const blob = this.blobField && rec.hasBlob ? await backend.readVersionBlob(this.ns, this.name, id, version) : null;
    return this.hydrate(rec, blob);
  }
  async revert(id, version) {
    this.assertWritable();
    const backend = this.requireBackend();
    await this.ensure(backend);
    return backend.revert(this.ns, this.name, id, version);
  }
}

class NamespaceImpl {
  backend;
  id;
  mode;
  sharing;
  constructor(backend, id, mode, sharing) {
    this.backend = backend;
    this.id = id;
    this.mode = mode;
    this.sharing = sharing;
  }
  collection(name, schema) {
    return new CollectionImpl(this.backend, this.id, name, schema, this.mode, this.sharing);
  }
}

class Storage {
  client;
  resolver;
  #sharing;
  constructor(client) {
    this.client = client;
    this.resolver = new BackendResolver(() => client.storageBackend, () => client.serverCapable, () => new CloudStorageBackend(client));
  }
  available() {
    return this.resolver.available();
  }
  get grants() {
    if (!this.#sharing) {
      this.#sharing = new NamespaceSharing({
        resource: "storage",
        client: this.client,
        local: this.localGrantStore(),
        ownNs: () => this.client.appId
      });
    }
    return this.#sharing;
  }
  namespace(appId, opts = {}) {
    const { id, mode } = deriveNamespace(this.client.appId, appId, opts.mode);
    const sharing = this.grants;
    sharing.assertLocalAccess(id, mode);
    return new NamespaceImpl(this.resolver.resolve(), id, mode, sharing);
  }
  localGrantStore() {
    if (this.client.grantStore)
      return this.client.grantStore;
    const backend = this.client.storageBackend;
    return backend instanceof MemoryBackend ? backend.grants : null;
  }
}
// src/core/_internal/observable.ts
class Observable {
  listeners = new Set;
  value;
  constructor(initial) {
    this.value = initial;
  }
  get() {
    return this.value;
  }
  set(value) {
    this.value = value;
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch {}
    }
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

// src/resources/sync/errors.ts
var syncError = subsystemError;
function isEpochMismatch(err) {
  if (!err || typeof err !== "object")
    return false;
  const e = err;
  if (e.status !== 409)
    return false;
  const body = e.body;
  return !!body && typeof body === "object" && body.code === "cursor_epoch_mismatch";
}

// src/resources/sync/merge.ts
function mergePatch(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === null)
      delete out[key];
    else
      out[key] = value;
  }
  return out;
}

// src/resources/sync/snapshot.ts
var encoder = new TextEncoder;
var decoder = new TextDecoder;
function encodeSnapshot2(workspaceId, cursor, records, savedAt) {
  const envelope = { v: 1, workspaceId, cursor, savedAt, records };
  return encoder.encode(JSON.stringify(envelope));
}
function decodeSnapshot(bytes, expectedWorkspaceId) {
  try {
    const parsed = JSON.parse(decoder.decode(bytes));
    if (!parsed || parsed.v !== 1)
      return null;
    if (parsed.workspaceId !== expectedWorkspaceId)
      return null;
    if (!Array.isArray(parsed.records))
      return null;
    return {
      v: 1,
      workspaceId: parsed.workspaceId,
      cursor: parsed.cursor ?? null,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      records: parsed.records
    };
  } catch {
    return null;
  }
}

// src/resources/sync/workspace.ts
var PAGE_LIMIT = 500;
var SNAPSHOT_DEBOUNCE_MS = 2000;
var BACKOFF_CAP_MS = 60000;
var DEFAULT_POLL_MS = 5000;
var MIN_POLL_MS = 1000;
var OFFLINE_AFTER_FAILURES = 2;
var defaultTiming = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted)
      return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  })
};
function fromWire(rec) {
  return {
    ns: rec.ns,
    collection: rec.collection,
    id: rec.id,
    metadata: { ...rec.metadata ?? {} },
    version: rec.version,
    deleted: false,
    syncId: rec.syncId,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    hasBlob: rec.hasBlob,
    ...rec.blobEncoding !== undefined ? { blobEncoding: rec.blobEncoding } : {}
  };
}
function cloneRecord(rec) {
  return { ...rec, metadata: { ...rec.metadata } };
}
function matchesEquality(metadata, where) {
  if (!where)
    return true;
  for (const k of Object.keys(where)) {
    if (metadata[k] !== where[k])
      return false;
  }
  return true;
}
function toWireOp(op) {
  const w = { ns: op.ns, collection: op.collection, id: op.id };
  if (op.patch !== undefined)
    w.patch = op.patch;
  if (op.replace !== undefined) {
    w.replace = true;
    w.patch = op.replace;
  }
  if (op.delete !== undefined)
    w.delete = op.delete;
  if (op.blobHash !== undefined)
    w.blob_hash = op.blobHash;
  if (op.blobEncoding !== undefined)
    w.blob_encoding = op.blobEncoding;
  if (op.bytes !== undefined)
    w.bytes = bytesToBase64(op.bytes);
  return w;
}

class WorkspaceSync {
  client;
  workspaceId;
  backend;
  timing;
  status;
  pollIntervalMs;
  store = new Map;
  seenSyncId = new Map;
  collectionListeners = new Map;
  statusObs;
  cursor = null;
  bootstrapped = false;
  running = false;
  failures = 0;
  startPromise = null;
  syncInflight = null;
  loopPromise = null;
  saveTimer = null;
  abort = new AbortController;
  constructor(client, workspaceId, backend = null, opts = {}, timing = defaultTiming) {
    this.client = client;
    this.workspaceId = workspaceId;
    this.backend = backend;
    this.timing = timing;
    this.pollIntervalMs = Math.max(MIN_POLL_MS, opts.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.statusObs = new Observable({ state: "idle" });
    this.status = this.statusObs;
  }
  start() {
    if (!this.startPromise)
      this.startPromise = this.doStart();
    return this.startPromise;
  }
  async stop() {
    this.running = false;
    this.abort.abort();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.backend) {
      try {
        await this.flushSnapshot();
      } catch {}
    }
  }
  sync() {
    if (!this.syncInflight) {
      this.syncInflight = this.runCatchUp().finally(() => {
        this.syncInflight = null;
      });
    }
    return this.syncInflight;
  }
  collection(ns, collection) {
    const cpk = cpkOf(ns, collection);
    return {
      get: (id) => {
        const rec = this.getRecord(ns, collection, id);
        return rec ? cloneRecord(rec) : null;
      },
      list: (filter) => {
        const rows = this.listCollection(ns, collection).map(cloneRecord);
        const where = filter?.where;
        return where ? rows.filter((r) => matchesEquality(r.metadata, where)) : rows;
      },
      subscribe: (listener) => {
        let set = this.collectionListeners.get(cpk);
        if (!set) {
          set = new Set;
          this.collectionListeners.set(cpk, set);
        }
        set.add(listener);
        return () => {
          set?.delete(listener);
        };
      }
    };
  }
  async apply(ops) {
    if (ops.length < 1 || ops.length > 200) {
      throw syncError("invalid_input", "apply() expects between 1 and 200 ops");
    }
    const pre = [];
    const seenPk = new Set;
    const touched = new Set;
    for (const op of ops) {
      const pk = pkOf(op.ns, op.collection, op.id);
      if (!seenPk.has(pk)) {
        seenPk.add(pk);
        const cur = this.getRecord(op.ns, op.collection, op.id);
        pre.push({
          ns: op.ns,
          collection: op.collection,
          id: op.id,
          record: cur ? cloneRecord(cur) : null,
          seen: this.seenSyncId.get(pk)
        });
      }
      this.applyOpLocally(op);
      touched.add(cpkOf(op.ns, op.collection));
    }
    this.notifyCollections(touched);
    try {
      const res = await this.client.request(this.path("/apply"), {
        method: "POST",
        body: { ops: ops.map(toWireOp) },
        retry: false
      });
      for (const r of res.results) {
        const rec = this.getRecord(r.ns, r.collection, r.id);
        if (rec) {
          rec.syncId = r.syncId;
          rec.version = r.version;
        }
        this.seenSyncId.set(pkOf(r.ns, r.collection, r.id), r.syncId);
      }
      this.scheduleSnapshotSave();
      return res.results;
    } catch (err) {
      for (const e of pre) {
        if (e.record)
          this.setRecord(e.record);
        else
          this.removeRecord(e.ns, e.collection, e.id);
        const pk = pkOf(e.ns, e.collection, e.id);
        if (e.seen === undefined)
          this.seenSyncId.delete(pk);
        else
          this.seenSyncId.set(pk, e.seen);
      }
      this.notifyCollections(touched);
      throw err;
    }
  }
  async doStart() {
    this.running = true;
    if (this.backend) {
      this.setStatus({ state: "hydrating" });
      try {
        const bytes = await this.backend.load(this.workspaceId);
        if (bytes) {
          const snap = decodeSnapshot(bytes, this.workspaceId);
          if (snap)
            this.applySnapshot(snap);
        }
      } catch {}
    }
    this.loopPromise = this.pollLoop();
  }
  async pollLoop() {
    let backoff = this.pollIntervalMs;
    while (this.running) {
      const wasOffline = this.statusObs.get().state === "offline";
      let ok = false;
      try {
        await this.sync();
        ok = true;
      } catch (err) {
        this.recordFailure(err);
      }
      if (!this.running)
        break;
      if (ok) {
        const recovered = wasOffline;
        this.failures = 0;
        this.setStatus({ state: "live", lastSyncAt: this.timing.now() });
        backoff = this.pollIntervalMs;
        await this.timing.sleep(recovered ? 0 : this.pollIntervalMs, this.abort.signal);
      } else {
        const delay2 = backoff;
        backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
        await this.timing.sleep(delay2, this.abort.signal);
      }
    }
  }
  recordFailure(err) {
    this.failures += 1;
    if (this.failures >= OFFLINE_AFTER_FAILURES) {
      this.setStatus({ state: "offline", error: err });
    }
  }
  async runCatchUp() {
    const touched = new Set;
    try {
      if (!this.bootstrapped)
        await this.bootstrap(touched);
      await this.deltaDrain(touched);
    } catch (err) {
      if (!isEpochMismatch(err))
        throw err;
      this.clearStore();
      if (this.backend) {
        try {
          await this.backend.clear(this.workspaceId);
        } catch {}
      }
      this.cursor = null;
      this.bootstrapped = false;
      const reset = new Set;
      await this.bootstrap(reset);
      await this.deltaDrain(reset);
      this.notifyAllSubscribers();
      this.scheduleSnapshotSave();
      return;
    }
    this.notifyCollections(touched);
    this.scheduleSnapshotSave();
  }
  async bootstrap(touched) {
    this.setStatus({ state: "bootstrapping" });
    const staleCandidates = new Set(this.allLiveRecords().map((r) => pkOf(r.ns, r.collection, r.id)));
    const seenKeys = new Set;
    let cursor;
    for (;; ) {
      const res = await this.client.request(this.path("/bootstrap"), {
        method: "GET",
        query: { ...cursor !== undefined ? { cursor } : {}, limit: PAGE_LIMIT },
        retry: false
      });
      for (const rec of res.records)
        seenKeys.add(pkOf(rec.ns, rec.collection, rec.id));
      this.ingest(res.records, touched);
      cursor = res.cursor;
      if (res.complete) {
        this.cursor = res.cursor;
        this.bootstrapped = true;
        this.reconcileStale(staleCandidates, seenKeys, touched);
        break;
      }
    }
  }
  reconcileStale(candidates, seen, touched) {
    if (candidates.size === 0)
      return;
    for (const rec of this.allLiveRecords()) {
      const key = pkOf(rec.ns, rec.collection, rec.id);
      if (candidates.has(key) && !seen.has(key)) {
        if (this.removeRecord(rec.ns, rec.collection, rec.id))
          touched.add(cpkOf(rec.ns, rec.collection));
        this.seenSyncId.delete(key);
      }
    }
  }
  async deltaDrain(touched) {
    for (;; ) {
      const res = await this.client.request(this.path("/delta"), {
        method: "GET",
        query: { ...this.cursor !== null ? { cursor: this.cursor } : {}, limit: PAGE_LIMIT },
        retry: false
      });
      this.ingest(res.records, touched);
      this.cursor = res.cursor;
      if (!res.hasMore)
        break;
    }
  }
  ingest(records, touched) {
    for (const rec of records) {
      const pk = pkOf(rec.ns, rec.collection, rec.id);
      const seen = this.seenSyncId.get(pk);
      if (seen !== undefined && seen >= rec.syncId)
        continue;
      this.seenSyncId.set(pk, rec.syncId);
      const cpk = cpkOf(rec.ns, rec.collection);
      if (rec.deleted) {
        if (this.removeRecord(rec.ns, rec.collection, rec.id))
          touched.add(cpk);
      } else {
        this.setRecord(fromWire(rec));
        touched.add(cpk);
      }
    }
  }
  applyOpLocally(op) {
    if (op.delete) {
      this.removeRecord(op.ns, op.collection, op.id);
      return;
    }
    const existing = this.getRecord(op.ns, op.collection, op.id);
    const now = this.timing.now();
    let metadata;
    if (op.replace !== undefined)
      metadata = { ...op.replace };
    else if (op.patch !== undefined)
      metadata = mergePatch(existing?.metadata ?? {}, op.patch);
    else
      metadata = existing ? { ...existing.metadata } : {};
    const hasBlob = op.blobHash !== undefined || op.bytes !== undefined ? true : existing?.hasBlob ?? false;
    const blobEncoding = op.blobEncoding ?? existing?.blobEncoding;
    const rec = {
      ns: op.ns,
      collection: op.collection,
      id: op.id,
      metadata,
      version: existing?.version ?? 0,
      deleted: false,
      syncId: existing?.syncId ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      hasBlob,
      ...blobEncoding !== undefined ? { blobEncoding } : {}
    };
    this.setRecord(rec);
  }
  applySnapshot(snap) {
    this.clearStore();
    for (const rec of snap.records) {
      this.setRecord({ ...rec, deleted: false, metadata: { ...rec.metadata } });
      this.seenSyncId.set(pkOf(rec.ns, rec.collection, rec.id), rec.syncId);
    }
    this.cursor = snap.cursor ?? null;
    this.bootstrapped = this.cursor !== null;
  }
  scheduleSnapshotSave() {
    if (!this.backend)
      return;
    if (this.saveTimer)
      clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.flushSnapshot();
    }, SNAPSHOT_DEBOUNCE_MS);
  }
  async flushSnapshot() {
    if (!this.backend)
      return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const bytes = encodeSnapshot2(this.workspaceId, this.cursor, this.allLiveRecords(), this.timing.now());
    await this.backend.save(this.workspaceId, bytes);
  }
  setStatus(next) {
    const cur = this.statusObs.get();
    const lastSyncAt = next.lastSyncAt ?? cur.lastSyncAt;
    const status = {
      state: next.state,
      ...lastSyncAt !== undefined ? { lastSyncAt } : {},
      ...next.error !== undefined && next.state !== "live" ? { error: next.error } : {}
    };
    this.statusObs.set(status);
  }
  getRecord(ns, collection, id) {
    return this.store.get(cpkOf(ns, collection))?.get(id);
  }
  setRecord(rec) {
    const cpk = cpkOf(rec.ns, rec.collection);
    let m = this.store.get(cpk);
    if (!m) {
      m = new Map;
      this.store.set(cpk, m);
    }
    m.set(rec.id, rec);
  }
  removeRecord(ns, collection, id) {
    return this.store.get(cpkOf(ns, collection))?.delete(id) ?? false;
  }
  listCollection(ns, collection) {
    const m = this.store.get(cpkOf(ns, collection));
    return m ? [...m.values()] : [];
  }
  allLiveRecords() {
    const out = [];
    for (const m of this.store.values())
      for (const rec of m.values())
        out.push(rec);
    return out;
  }
  clearStore() {
    this.store.clear();
    this.seenSyncId.clear();
  }
  notifyCollections(touched) {
    for (const cpk of touched)
      this.fireCollection(cpk);
  }
  notifyAllSubscribers() {
    for (const cpk of this.collectionListeners.keys())
      this.fireCollection(cpk);
  }
  fireCollection(cpk) {
    const set = this.collectionListeners.get(cpk);
    if (!set)
      return;
    for (const listener of set) {
      try {
        listener();
      } catch {}
    }
  }
  path(suffix) {
    return `/api/v1/sync/${encodeURIComponent(this.workspaceId)}${suffix}`;
  }
}

// src/resources/sync/sync.ts
class Sync {
  client;
  workspaces = new Map;
  #sharing;
  constructor(client) {
    this.client = client;
  }
  get grants() {
    if (!this.#sharing) {
      this.#sharing = new NamespaceSharing({
        resource: "sync",
        client: this.client,
        local: this.client.grantStore ?? null,
        ownNs: () => this.client.appId
      });
    }
    return this.#sharing;
  }
  async listWorkspaces() {
    const res = await this.client.request("/api/v1/sync/workspaces", {
      method: "GET",
      retry: false
    });
    return res.workspaces;
  }
  workspace(workspaceId, opts = {}) {
    let ws = this.workspaces.get(workspaceId);
    if (!ws) {
      ws = new WorkspaceSync(this.client, workspaceId, this.resolveBackend(), opts);
      this.workspaces.set(workspaceId, ws);
    }
    return ws;
  }
  resolveBackend() {
    return this.client.snapshotBackend ?? null;
  }
}
// src/resources/usage.ts
var PLAN_FREE_ID = 0;
function isCloudPlan(plan) {
  return Number.isFinite(plan.id) && plan.id > PLAN_FREE_ID;
}

class Usage {
  client;
  constructor(client) {
    this.client = client;
  }
  get(options = {}) {
    const req = { method: "GET" };
    if (options.signal)
      req.signal = options.signal;
    if (options.scope)
      req.query = { scope: options.scope };
    return this.client.request("/api/v1/usage", req);
  }
}
function formatTokenCount(n) {
  if (!Number.isFinite(n) || n < 0)
    return "0";
  if (n >= 1e6)
    return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1000)
    return `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}
function formatUsd(n) {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}
function formatTimeUntil(target, now = Date.now()) {
  if (target == null)
    return null;
  const t = target instanceof Date ? target.getTime() : new Date(target).getTime();
  if (!Number.isFinite(t))
    return null;
  const ms = t - now;
  if (ms <= 0)
    return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 60)
    return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)
    return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
function summarizeUsage(usage, options = {}) {
  const warnThreshold = options.warnThreshold ?? 0.9;
  const now = options.now ?? Date.now();
  const { plan, period, daily, credits } = usage;
  const dailyMetered = daily.limit > 0;
  const ratio = dailyMetered ? Math.min(1, Math.max(0, daily.used / daily.limit)) : null;
  const totalTokens = period.input_tokens + period.output_tokens;
  return {
    planName: plan.name,
    daily: {
      used: daily.used,
      limit: dailyMetered ? daily.limit : null,
      usedLabel: formatTokenCount(daily.used),
      limitLabel: dailyMetered ? formatTokenCount(daily.limit) : null,
      ratio,
      percent: ratio === null ? null : Math.round(ratio * 100),
      isMetered: dailyMetered,
      isNearLimit: ratio !== null && ratio >= warnThreshold,
      isOverLimit: ratio !== null && ratio >= 1,
      resetsInLabel: formatTimeUntil(daily.resets_at, now)
    },
    period: {
      inputTokens: period.input_tokens,
      outputTokens: period.output_tokens,
      totalTokens,
      requestCount: period.request_count,
      cost: period.cost,
      inputLabel: formatTokenCount(period.input_tokens),
      outputLabel: formatTokenCount(period.output_tokens),
      totalLabel: formatTokenCount(totalTokens),
      requestsLabel: formatTokenCount(period.request_count),
      costLabel: formatUsd(period.cost),
      resetsInLabel: formatTimeUntil(period.resets_at, now),
      daysRemaining: period.days_remaining
    },
    credits: {
      balance: credits.balance,
      balanceLabel: formatUsd(credits.balance),
      hasBalance: credits.balance !== 0
    },
    subscription: {
      expiresAt: plan.plan_expires_at,
      renewsAt: plan.renews_at,
      autoRenew: plan.auto_renew,
      hasTerm: plan.plan_expires_at !== null,
      status: plan.plan_expires_at === null ? null : plan.auto_renew ? "renews" : "expires",
      endsInLabel: formatTimeUntil(plan.plan_expires_at, now)
    }
  };
}
// src/resources/users.ts
var MAX_LIST_IDS = 100;

class Users {
  client;
  constructor(client) {
    this.client = client;
  }
  me(options = {}) {
    const req = { method: "GET" };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request("/api/v1/me", req);
  }
  get(id, options = {}) {
    const req = { method: "GET" };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request(`/api/v1/users/${encodeURIComponent(id)}`, req);
  }
  async list(ids, options = {}) {
    const deduped = Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
    if (deduped.length === 0)
      return { users: [] };
    if (deduped.length > MAX_LIST_IDS) {
      throw new UnifiedError("invalid_input", `users.list accepts at most ${MAX_LIST_IDS} ids, got ${deduped.length}`);
    }
    const req = { method: "GET", query: { ids: deduped.join(",") } };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request("/api/v1/users", req);
  }
}
// src/resources/videos.ts
var ACCEPTED_VIDEO_TYPES = ["video/"];
function encodeVideoId(id) {
  return encodeURIComponent(id);
}

class Videos {
  client;
  constructor(client) {
    this.client = client;
  }
  create(params, options = {}) {
    const form = new FormData;
    form.append("prompt", params.prompt);
    form.append("model", params.model);
    if (params.seconds !== undefined)
      form.append("seconds", params.seconds);
    if (params.size !== undefined)
      form.append("size", params.size);
    if (params.generate_audio !== undefined) {
      form.append("generate_audio", String(params.generate_audio));
    }
    if (params.input_reference) {
      form.append("input_reference", params.input_reference, params.input_reference_filename || "reference.png");
    }
    const req = { method: "POST", body: form };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request("/api/v1/videos", req);
  }
  retrieve(videoId, options = {}) {
    const req = { method: "GET" };
    if (options.signal)
      req.signal = options.signal;
    return this.client.request(`/api/v1/videos/${encodeVideoId(videoId)}`, req);
  }
  content(videoId, options = {}) {
    const req = { method: "GET", acceptedContentTypes: ACCEPTED_VIDEO_TYPES };
    if (options.signal)
      req.signal = options.signal;
    return this.client.requestBinary(`/api/v1/videos/${encodeVideoId(videoId)}/content`, req).then((r) => ({ bytes: r.bytes, mimeType: r.contentType || "video/mp4" }));
  }
  async waitUntilReady(videoId, options = {}) {
    const timeoutMs = options.timeoutMs ?? 600000;
    return pollUntil({
      timeoutMs,
      intervalMs: options.pollIntervalMs ?? 5000,
      ...options.signal && { signal: options.signal },
      poll: () => {
        const reqOpts = {};
        if (options.signal)
          reqOpts.signal = options.signal;
        return this.retrieve(videoId, reqOpts);
      },
      isDone: (v) => v.status === "completed" || v.status === "failed",
      eagerDeadline: true,
      abortError: () => {
        const err = new Error("Video poll aborted");
        err.name = "AbortError";
        return err;
      },
      onTimeout: (last) => {
        throw new Error(last ? `Video ${videoId} did not reach a terminal state within ${timeoutMs}ms (last status: ${last.status})` : `Video ${videoId} did not reach a terminal state within ${timeoutMs}ms`);
      }
    });
  }
}
// src/localAgents/config.ts
var config = {};
function configureLocalAgents(next) {
  config = { ...config, ...next };
}
function localAgentsConfig() {
  return config;
}
async function unifiedToken() {
  const client = config.client;
  if (!client)
    return null;
  try {
    const token = await client.accessToken();
    return token || null;
  } catch {
    return null;
  }
}
function unifiedApiUrl() {
  return config.client?.apiUrl ?? "";
}
function relayWsBase() {
  const explicit = config.wsBaseUrl?.trim();
  if (explicit)
    return withApiPrefix(explicit);
  const api = unifiedApiUrl().trim();
  if (api && /^https?:\/\//i.test(api))
    return withApiPrefix(api);
  const origin = typeof location !== "undefined" ? location.origin : "http://localhost";
  return `${origin}/api/v1`;
}
function withApiPrefix(base) {
  const trimmed = base.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

// src/localAgents/dirListing.ts
function normalizeDirListing(value) {
  const v = value ?? {};
  const entries = Array.isArray(v.entries) ? v.entries.filter((e) => !!e && typeof e.name === "string" && typeof e.path === "string").map((e) => ({
    name: e.name,
    path: e.path,
    git: e.git === true
  })) : [];
  const suggested = Array.isArray(v.suggested) ? v.suggested.filter((s) => typeof s === "string") : null;
  return {
    path: typeof v.path === "string" ? v.path : null,
    parent: typeof v.parent === "string" ? v.parent : null,
    home: typeof v.home === "string" ? v.home : "",
    sep: typeof v.sep === "string" ? v.sep : "/",
    entries,
    ...typeof v.root === "string" && v.root ? { root: v.root } : {},
    ...suggested ? { suggested } : {},
    ...v.truncated === true ? { truncated: true } : {},
    ...v.restricted === true ? { restricted: true } : {}
  };
}

// src/localAgents/bridgeClient.ts
var BRIDGE_PORTS = [47825, 47826, 47827, 47828, 47829];
var PORT_KEY = "unified.agentBridge.port";
var TOKEN_KEY = "unified.agentBridge.token";
var SERVICE = "unified-agent-bridge";
var PROBE_TIMEOUT_MS = 1200;
var REQUEST_TIMEOUT_MS = 15000;
function readLocal(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writeLocal(key, value) {
  try {
    if (value === null)
      globalThis.localStorage?.removeItem(key);
    else
      globalThis.localStorage?.setItem(key, value);
  } catch {}
}
function bridgeToken() {
  return readLocal(TOKEN_KEY);
}
function hasBridgeToken() {
  return !!bridgeToken();
}
function clearBridgeToken() {
  writeLocal(TOKEN_KEY, null);
}
var cachedPort = null;
var scanFoundNothing = false;
function bridgeOrigin(port) {
  return `http://127.0.0.1:${port}`;
}
async function probe(port) {
  try {
    const res = await fetch(`${bridgeOrigin(port)}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (!res.ok)
      return false;
    const body = await res.json();
    return body?.service === SERVICE;
  } catch {
    return false;
  }
}
async function discoverBridge(force = false) {
  if (!force && cachedPort !== null)
    return cachedPort;
  if (!force && scanFoundNothing)
    return null;
  const remembered = Number(readLocal(PORT_KEY));
  const order = BRIDGE_PORTS.includes(remembered) ? [remembered, ...BRIDGE_PORTS.filter((p) => p !== remembered)] : [...BRIDGE_PORTS];
  for (const port of order) {
    if (await probe(port)) {
      cachedPort = port;
      writeLocal(PORT_KEY, String(port));
      return port;
    }
  }
  cachedPort = null;
  scanFoundNothing = true;
  writeLocal(PORT_KEY, null);
  return null;
}
function invalidateBridgePort() {
  cachedPort = null;
  scanFoundNothing = false;
}
async function bridgeHealth() {
  const port = await discoverBridge(true);
  return { ok: port !== null, port };
}
async function requirePort() {
  const port = await discoverBridge();
  if (port === null)
    throw new Error("The desktop app isn't running on this machine.");
  return port;
}
async function pairBridge(name = defaultPairName(), silent = false) {
  const port = await discoverBridge(true);
  if (port === null)
    throw new Error("The desktop app isn't running on this machine.");
  const account = await unifiedToken();
  const res = await fetch(`${bridgeOrigin(port)}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      ...silent ? { silent: true } : {},
      ...account ? { token: account } : {}
    })
  });
  if (res.status === 403)
    throw new Error("The desktop app declined this connection.");
  if (!res.ok)
    throw new Error(`Pairing failed (HTTP ${res.status}).`);
  const body = await res.json();
  if (typeof body?.token !== "string" || !body.token)
    throw new Error("Pairing returned no token.");
  writeLocal(TOKEN_KEY, body.token);
  return body.token;
}
function defaultPairName() {
  const name = localAgentsConfig().clientName?.trim() || "UnifiedAI app";
  if (typeof location === "undefined")
    return `${name} (browser)`;
  return `${name} — ${location.host}`;
}
var reauthorizing = null;
function ensureBridgeToken() {
  if (!reauthorizing) {
    reauthorizing = pairBridge(defaultPairName(), true).finally(() => {
      reauthorizing = null;
    });
  }
  return reauthorizing;
}
async function send(path, opts, token) {
  const port = await requirePort();
  return await fetch(`${bridgeOrigin(port)}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...opts.body !== undefined ? { "Content-Type": "application/json" } : {}
    },
    ...opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {},
    ...opts.noTimeout ? {} : { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  });
}
async function authed(path, opts = {}) {
  const token = bridgeToken();
  if (!token)
    throw new Error("Not connected to the desktop app.");
  let res;
  try {
    res = await send(path, opts, token);
  } catch {
    invalidateBridgePort();
    await discoverBridge(true);
    res = await send(path, opts, token);
  }
  if (res.status === 401) {
    const fresh = await ensureBridgeToken();
    res = await send(path, opts, fresh);
  }
  if (!res.ok)
    throw new Error(`Agent bridge request failed (HTTP ${res.status}).`);
  return res;
}
async function authedJson(path, opts = {}) {
  const res = await authed(path, opts);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
function bridgeDetect() {
  return authedJson("/detect");
}
async function bridgeCursorModels(json) {
  const body = await authedJson(`/cursor/models?format=${json ? "json" : "text"}`);
  return body?.output ?? "";
}
async function bridgeStartRun(body) {
  await authed("/runs", { method: "POST", body });
}
async function bridgeStopRun(runId) {
  await authed(`/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", body: {} });
}
async function bridgeMcpResult(id, result) {
  await authed("/mcp/result", { method: "POST", body: { id, result } });
}
async function bridgeListDir(path) {
  const body = await authedJson("/list-dir", {
    method: "POST",
    body: path !== undefined ? { path } : {}
  });
  return normalizeDirListing(body);
}
async function bridgePickFolder() {
  const body = await authedJson("/pick-folder", {
    method: "POST",
    body: {},
    noTimeout: true
  });
  return body?.path ?? null;
}
async function openRunEvents(runId, handlers) {
  const controller = new AbortController;
  const token = bridgeToken();
  if (!token)
    throw new Error("Not connected to the desktop app.");
  const port = await requirePort();
  const attach = async (bearer) => await fetch(`${bridgeOrigin(port)}/runs/${encodeURIComponent(runId)}/events`, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: "text/event-stream" },
    signal: controller.signal
  });
  let res = await attach(token);
  if (res.status === 401)
    res = await attach(await ensureBridgeToken());
  if (!res.ok || !res.body) {
    controller.abort();
    throw new Error(`Could not open the run stream (HTTP ${res.status}).`);
  }
  pump(res.body, handlers, controller.signal);
  return { close: () => controller.abort() };
}
async function pump(body, handlers, signal) {
  const reader = body.getReader();
  const decoder2 = new TextDecoder;
  let buffer = "";
  let sawExit = false;
  const trackingHandlers = {
    ...handlers,
    onExit: (exit) => {
      sawExit = true;
      handlers.onExit(exit);
    }
  };
  try {
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      buffer += decoder2.decode(value, { stream: true });
      let split;
      while ((split = indexOfFrameEnd(buffer)) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split).replace(/^(\r?\n){2}/, "");
        dispatchFrame(frame, trackingHandlers);
      }
    }
    if (!sawExit && !signal.aborted) {
      handlers.onError?.("Agent bridge stream ended before the run finished");
    }
  } catch (err) {
    if (!signal.aborted) {
      handlers.onError?.(err instanceof Error ? err.message : String(err));
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
function indexOfFrameEnd(buffer) {
  const lf = buffer.indexOf(`

`);
  const crlf = buffer.indexOf(`\r
\r
`);
  if (lf === -1)
    return crlf;
  if (crlf === -1)
    return lf;
  return Math.min(lf, crlf);
}
function dispatchFrame(frame, handlers) {
  let name = "message";
  const dataLines = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (rawLine.startsWith(":"))
      continue;
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    const value = colon === -1 ? "" : rawLine.slice(colon + 1).replace(/^ /, "");
    if (field === "event")
      name = value;
    else if (field === "data")
      dataLines.push(value);
  }
  if (!dataLines.length)
    return;
  let data;
  try {
    data = JSON.parse(dataLines.join(`
`));
  } catch {
    return;
  }
  switch (name) {
    case "line":
      if (typeof data.line === "string")
        handlers.onLine(data.line);
      break;
    case "exit":
      handlers.onExit({
        code: typeof data.code === "number" ? data.code : null,
        canceled: data.canceled === true,
        stderr: typeof data.stderr === "string" ? data.stderr : ""
      });
      break;
    case "mcp-list":
      if (typeof data.id === "string")
        handlers.onMcpList?.(data.id);
      break;
    case "mcp-call":
      if (typeof data.id === "string" && typeof data.name === "string") {
        handlers.onMcpCall?.(data.id, data.name, data.arguments);
      }
      break;
  }
}
// src/localAgents/relayClient.ts
var REQUEST_TIMEOUT_MS2 = 30000;
var BACKOFF_MIN_MS = 500;
var BACKOFF_MAX_MS = 15000;
async function listRelayHosts() {
  const token = await unifiedToken();
  if (!token)
    return [];
  const base = unifiedApiUrl().replace(/\/+$/, "");
  const res = await fetch(`${base}/api/v1/relay/hosts`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok)
    throw new Error(`Relay host listing failed (HTTP ${res.status}).`);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : data?.hosts ?? [];
  if (!Array.isArray(rows))
    return [];
  return rows.filter(isRelayHost);
}
function isRelayHost(value) {
  const v = value;
  return !!v && typeof v.deviceId === "string" && typeof v.deviceName === "string";
}
function relayWsUrl(path) {
  const url = new URL(`${relayWsBase()}/relay${path}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
async function bearerSubprotocol() {
  const token = await unifiedToken();
  return token ? `unified-bearer.${token}` : null;
}
var CLIENT_ID_KEY = "unified.agentRelay.clientId";
function clientDeviceId() {
  try {
    const existing = globalThis.localStorage?.getItem(CLIENT_ID_KEY);
    if (existing)
      return existing;
    const fresh = crypto.randomUUID();
    globalThis.localStorage?.setItem(CLIENT_ID_KEY, fresh);
    return fresh;
  } catch {
    return "browser";
  }
}
function clientDeviceName() {
  const name = localAgentsConfig().clientName?.trim() || "UnifiedAI app";
  if (typeof location === "undefined")
    return name;
  return `${name} (${location.host})`;
}
var connections = new Map;
function connectRelayHost(deviceId) {
  const existing = connections.get(deviceId);
  if (existing)
    return existing;
  const conn = createConnection(deviceId);
  connections.set(deviceId, conn);
  return conn;
}
function closeRelayHost(deviceId) {
  connections.get(deviceId)?.close();
  connections.delete(deviceId);
}
function closeAllRelayHosts() {
  for (const id of [...connections.keys()])
    closeRelayHost(id);
}
function createConnection(deviceId) {
  const approval = new Observable("unknown");
  const connected = new Observable(false);
  const host = new Observable(null);
  const lastError = new Observable(null);
  const pending = new Map;
  const runs = new Map;
  const readyWaiters = [];
  let socket = null;
  let backoff = BACKOFF_MIN_MS;
  let retryTimer = null;
  let closedByUs = false;
  function settleReady() {
    if (approval.get() !== "approved" || !connected.get())
      return;
    while (readyWaiters.length)
      readyWaiters.shift()?.resolve();
  }
  function failReady(message) {
    while (readyWaiters.length)
      readyWaiters.shift()?.reject(new Error(message));
  }
  function notReadyReason() {
    if (!connected.get())
      return lastError.get() ?? "Couldn't reach that computer.";
    if (approval.get() === "denied")
      return "That computer declined this device.";
    return "That computer didn't answer in time.";
  }
  function send2(frame) {
    if (socket?.readyState !== 1) {
      throw new Error("Not connected to that computer.");
    }
    socket.send(JSON.stringify(frame));
  }
  function request(frame, timeoutMs = REQUEST_TIMEOUT_MS2) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      if (timeoutMs !== null) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("The other computer didn't answer in time."));
        }, timeoutMs);
      }
      pending.set(id, entry);
      try {
        send2({ ...frame, id });
      } catch (err) {
        pending.delete(id);
        if (entry.timer)
          clearTimeout(entry.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
  function resolvePending(id, frame) {
    const entry = pending.get(id);
    if (!entry)
      return;
    pending.delete(id);
    if (entry.timer)
      clearTimeout(entry.timer);
    entry.resolve(frame);
  }
  function rejectPending(id, message) {
    const entry = pending.get(id);
    if (!entry)
      return;
    pending.delete(id);
    if (entry.timer)
      clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }
  function handleFrame(frame) {
    switch (frame.type) {
      case "attached": {
        const h = frame.host;
        if (h && typeof h.deviceId === "string")
          host.set(h);
        try {
          send2({ type: "approve?" });
        } catch {}
        break;
      }
      case "approval": {
        const state = frame.state;
        approval.set(state === "approved" || state === "pending" || state === "denied" ? state : "unknown");
        if (approval.get() === "approved")
          settleReady();
        if (approval.get() === "denied") {
          failReady("That computer declined this device.");
          lastError.set("That computer declined this device.");
        }
        break;
      }
      case "host-closed":
        lastError.set("That computer went offline.");
        endAllRuns("the host went offline");
        break;
      case "detect-result":
      case "cursor-models-result":
      case "pick-folder-result":
      case "list-dir-result":
      case "repo-root-result":
        if (typeof frame.id === "string")
          resolvePending(frame.id, frame);
        break;
      case "line": {
        const run = typeof frame.runId === "string" ? runs.get(frame.runId) : undefined;
        if (run && typeof frame.line === "string")
          run.onLine(frame.line);
        break;
      }
      case "exit": {
        const runId = typeof frame.runId === "string" ? frame.runId : "";
        const run = runs.get(runId);
        if (!run)
          break;
        runs.delete(runId);
        run.onExit({
          code: typeof frame.code === "number" ? frame.code : null,
          canceled: frame.canceled === true,
          stderr: typeof frame.stderr === "string" ? frame.stderr : ""
        });
        break;
      }
      case "mcp-list": {
        const run = typeof frame.runId === "string" ? runs.get(frame.runId) : undefined;
        if (run && typeof frame.id === "string")
          run.onMcpList?.(frame.id);
        break;
      }
      case "mcp-call": {
        const run = typeof frame.runId === "string" ? runs.get(frame.runId) : undefined;
        if (run && typeof frame.id === "string" && typeof frame.name === "string") {
          run.onMcpCall?.(frame.id, frame.name, frame.arguments);
        }
        break;
      }
      case "error": {
        const message = typeof frame.message === "string" ? frame.message : "Relay error";
        lastError.set(message);
        if (typeof frame.id === "string")
          rejectPending(frame.id, message);
        if (typeof frame.runId === "string") {
          const run = runs.get(frame.runId);
          if (run) {
            runs.delete(frame.runId);
            run.onExit({ code: null, canceled: false, stderr: message });
          }
        }
        break;
      }
    }
  }
  function endAllRuns(reason) {
    for (const [runId, handlers] of [...runs]) {
      runs.delete(runId);
      handlers.onExit({ code: null, canceled: false, stderr: `Relay connection lost: ${reason}` });
    }
    for (const id of [...pending.keys()])
      rejectPending(id, `Relay connection lost: ${reason}`);
  }
  async function open() {
    if (closedByUs)
      return;
    const proto = await bearerSubprotocol();
    if (closedByUs)
      return;
    if (!proto) {
      lastError.set("Not signed in.");
      failReady("Not signed in.");
      return;
    }
    let ws;
    try {
      const hints = new URLSearchParams({
        deviceId: clientDeviceId(),
        deviceName: clientDeviceName()
      });
      ws = new WebSocket(`${relayWsUrl(`/connect/${encodeURIComponent(deviceId)}`)}?${hints}`, [
        proto
      ]);
    } catch (err) {
      lastError.set(err instanceof Error ? err.message : String(err));
      scheduleRetry();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      connected.set(true);
      backoff = BACKOFF_MIN_MS;
      lastError.set(null);
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string")
        return;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      handleFrame(frame);
    };
    ws.onclose = (event) => {
      connected.set(false);
      if (socket === ws)
        socket = null;
      endAllRuns("socket closed");
      if (event.code === 4403 || event.code === 4404) {
        if (event.code === 4403)
          approval.set("denied");
        lastError.set(event.code === 4404 ? "That computer is offline." : "That computer isn't yours to use.");
        failReady(lastError.get() ?? "Relay closed.");
        return;
      }
      scheduleRetry();
    };
    ws.onerror = () => {
      lastError.set("Relay connection error.");
    };
  }
  function scheduleRetry() {
    if (closedByUs || retryTimer)
      return;
    const delay2 = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, delay2);
  }
  open();
  const conn = {
    deviceId,
    approval,
    connected,
    host,
    lastError,
    ready(timeoutMs = REQUEST_TIMEOUT_MS2) {
      if (connected.get() && approval.get() === "approved")
        return Promise.resolve();
      if (approval.get() === "denied") {
        return Promise.reject(new Error("That computer declined this device."));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(notReadyReason())), timeoutMs);
        readyWaiters.push({
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          }
        });
        settleReady();
      });
    },
    async detect() {
      await conn.ready();
      const frame = await request({ type: "detect" });
      return {
        claudeCode: normalizeDetect(frame.claudeCode),
        cursor: normalizeDetect(frame.cursor)
      };
    },
    async cursorModels(json) {
      await conn.ready();
      const frame = await request({ type: "cursor-models", format: json ? "json" : "text" });
      return typeof frame.output === "string" ? frame.output : "";
    },
    async pickFolder() {
      await conn.ready();
      const frame = await request({ type: "pick-folder" }, null);
      return typeof frame.path === "string" ? frame.path : null;
    },
    async listDir(path) {
      await conn.ready();
      const frame = await request({
        type: "list-dir",
        ...path !== undefined ? { path } : {}
      });
      return normalizeDirListing(frame);
    },
    async repoRoots(paths) {
      if (!paths.length)
        return [];
      await conn.ready();
      const frame = await request({ type: "repo-root", paths });
      const roots = Array.isArray(frame.roots) ? frame.roots : [];
      return paths.map((_, i) => {
        const r = roots[i];
        return typeof r === "string" && r ? r : null;
      });
    },
    async startRun(args, handlers) {
      await conn.ready();
      runs.set(args.runId, handlers);
      try {
        send2({ type: "start", ...args });
      } catch (err) {
        runs.delete(args.runId);
        throw err;
      }
    },
    stopRun(runId) {
      try {
        send2({ type: "stop", runId });
      } catch {}
    },
    mcpResult(id, result) {
      try {
        send2({ type: "mcp-result", id, result });
      } catch {}
    },
    close() {
      closedByUs = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      endAllRuns("disconnected");
      socket?.close();
      socket = null;
      connected.set(false);
    }
  };
  return conn;
}
function normalizeDetect(value) {
  const v = value;
  return {
    found: v?.found === true,
    path: typeof v?.path === "string" ? v.path : null
  };
}
// src/localAgents/transport.ts
var PREF_KEY = "unified.agentCompute.source";
function initialStatus() {
  return {
    connected: false,
    source: null,
    pref: loadPref(),
    bridgeAvailable: null,
    bridgePaired: hasBridgeToken(),
    bridgeDeviceId: null,
    bridgeDeviceName: null,
    bridgeCapabilities: null,
    relayHosts: [],
    resolving: false,
    lastError: null
  };
}
var status = new Observable(initialStatus());
function patch(next) {
  status.set({ ...status.get(), ...next });
}
function getLocalAgentStatus() {
  return status.get();
}
function onLocalAgentStatusChange(listener) {
  return status.subscribe(listener);
}
function isDesktopConnected() {
  return status.get().connected;
}
function loadPref() {
  try {
    const raw = globalThis.localStorage?.getItem(PREF_KEY) ?? null;
    if (!raw)
      return { kind: "auto" };
    const parsed = JSON.parse(raw);
    if (parsed?.kind === "relay" && typeof parsed.deviceId === "string")
      return parsed;
    if (parsed?.kind === "bridge" || parsed?.kind === "auto")
      return { kind: parsed.kind };
  } catch {}
  return { kind: "auto" };
}
function savePref(pref) {
  try {
    if (pref.kind === "auto")
      globalThis.localStorage?.removeItem(PREF_KEY);
    else
      globalThis.localStorage?.setItem(PREF_KEY, JSON.stringify(pref));
  } catch {}
}
var resolvePromise = null;
function resolveLocalAgentSource() {
  if (!resolvePromise) {
    patch({ resolving: true });
    resolvePromise = resolveSourceFor(status.get().pref).then((source) => {
      patch({ source, connected: source !== null, resolving: false });
      return source;
    }, (err) => {
      patch({
        source: null,
        connected: false,
        resolving: false,
        lastError: err instanceof Error ? err.message : String(err)
      });
      return null;
    });
  }
  return resolvePromise;
}
function setLocalAgentSource(pref) {
  patch({ pref });
  savePref(pref);
  if (pref.kind !== "relay")
    closeAllRelayHosts();
  return refreshLocalAgents();
}
function refreshLocalAgents() {
  resolvePromise = null;
  invalidateBridgePort();
  adoptRefused = "no";
  return resolveLocalAgentSource();
}
async function resolveSourceFor(pref) {
  if (pref.kind === "bridge") {
    return await bridgeUsable() ? { kind: "bridge" } : null;
  }
  if (pref.kind === "relay") {
    const hosts2 = await refreshRelayHosts();
    const host = hosts2.find((h) => h.deviceId === pref.deviceId);
    return {
      kind: "relay",
      deviceId: pref.deviceId,
      deviceName: host?.deviceName ?? pref.deviceId
    };
  }
  if (await bridgeUsable())
    return { kind: "bridge" };
  const hosts = await refreshRelayHosts();
  const first = hosts[0];
  if (first)
    return { kind: "relay", deviceId: first.deviceId, deviceName: first.deviceName };
  return null;
}
async function probeBridge() {
  const port = await discoverBridge();
  patch({ bridgeAvailable: port !== null });
  if (port === null)
    return false;
  if (hasBridgeToken())
    await refreshBridgeIdentity();
  return true;
}
async function bridgeUsable() {
  if (!await probeBridge())
    return false;
  if (!hasBridgeToken()) {
    await adoptApprovedOrigin();
    if (hasBridgeToken())
      await refreshBridgeIdentity();
  }
  return hasBridgeToken();
}
var adoptRefused = "no";
async function adoptApprovedOrigin() {
  if (hasBridgeToken())
    return;
  if (adoptRefused === "with-credential")
    return;
  if (adoptRefused === "without-credential" && await unifiedToken() === null)
    return;
  try {
    await ensureBridgeToken();
    patch({ bridgePaired: true, lastError: null });
    adoptRefused = "no";
  } catch {
    adoptRefused = await unifiedToken() === null ? "without-credential" : "with-credential";
  }
}
async function refreshBridgeIdentity() {
  try {
    const detected = await bridgeDetect();
    patch({
      bridgeDeviceId: typeof detected.deviceId === "string" ? detected.deviceId : null,
      bridgeDeviceName: typeof detected.deviceName === "string" ? detected.deviceName : null,
      bridgeCapabilities: {
        claudeCode: detected.claudeCode?.found === true,
        cursor: detected.cursor?.found === true
      }
    });
  } catch {
    patch({ bridgeDeviceId: null, bridgeDeviceName: null, bridgeCapabilities: null });
  }
}
async function checkDesktopAvailable() {
  invalidateBridgePort();
  return await probeBridge();
}
async function connectDesktop(name) {
  const label = name ?? defaultPairName();
  try {
    await pairBridge(label, hasBridgeToken());
  } catch (err) {
    if (!hasBridgeToken())
      throw err;
    clearBridgeToken();
    await pairBridge(label);
  }
  adoptRefused = "no";
  patch({ bridgePaired: true, bridgeAvailable: true, lastError: null });
  return await setLocalAgentSource({ kind: "bridge" });
}
async function disconnectDesktop() {
  clearBridgeToken();
  adoptRefused = "no";
  patch({ bridgePaired: false });
  if (status.get().pref.kind === "bridge")
    await setLocalAgentSource({ kind: "auto" });
  else
    await refreshLocalAgents();
}
async function refreshRelayHosts() {
  try {
    const hosts = await listRelayHosts();
    patch({ relayHosts: hosts });
    return hosts;
  } catch {
    patch({ relayHosts: [] });
    return [];
  }
}
function listLocalAgentDevices(snapshot) {
  const s = snapshot ?? getLocalAgentStatus();
  const devices = [];
  const bridged = s.bridgeAvailable === true && s.bridgePaired === true;
  const selfHost = bridged && s.bridgeDeviceId ? s.relayHosts.find((h) => h.deviceId === s.bridgeDeviceId) ?? null : null;
  if (bridged) {
    const merged = mergeCaps(s.bridgeCapabilities, hostCaps(selfHost));
    devices.push({
      id: "bridge",
      kind: "bridge",
      name: "This computer",
      online: true,
      ...s.bridgeDeviceName || selfHost?.deviceName ? { machineName: s.bridgeDeviceName || selfHost?.deviceName } : {},
      ...merged ? { capabilities: merged } : {},
      pref: { kind: "bridge" }
    });
  }
  for (const host of s.relayHosts) {
    if (selfHost && host.deviceId === selfHost.deviceId)
      continue;
    devices.push({
      id: host.deviceId,
      kind: "relay",
      name: host.deviceName || host.deviceId,
      online: true,
      capabilities: hostCaps(host) ?? { claudeCode: false, cursor: false },
      pref: { kind: "relay", deviceId: host.deviceId }
    });
  }
  return devices;
}
function hostCaps(host) {
  if (!host)
    return null;
  return {
    claudeCode: host.capabilities?.claudeCode?.found === true,
    cursor: host.capabilities?.cursor?.found === true
  };
}
function mergeCaps(a, b) {
  if (!a)
    return b;
  if (!b)
    return a;
  return { claudeCode: a.claudeCode || b.claudeCode, cursor: a.cursor || b.cursor };
}
async function refreshLocalAgentDevices() {
  invalidateBridgePort();
  adoptRefused = "no";
  patch({ bridgePaired: hasBridgeToken() });
  await Promise.all([bridgeUsable(), refreshRelayHosts()]);
  return listLocalAgentDevices();
}
var NOT_FOUND = {
  claudeCode: { found: false, path: null },
  cursor: { found: false, path: null }
};
function sourceFor(pref) {
  return pref ? resolveSourceFor(pref) : resolveLocalAgentSource();
}
async function detectAgents(pref) {
  const source = await sourceFor(pref);
  if (!source)
    return NOT_FOUND;
  if (source.kind === "bridge") {
    try {
      const { claudeCode, cursor } = await bridgeDetect();
      return { claudeCode, cursor };
    } catch {
      return NOT_FOUND;
    }
  }
  const host = status.get().relayHosts.find((h) => h.deviceId === source.deviceId);
  if (!host)
    return NOT_FOUND;
  return {
    claudeCode: { found: host.capabilities?.claudeCode?.found === true, path: null },
    cursor: { found: host.capabilities?.cursor?.found === true, path: null }
  };
}
async function cursorModelsOutput(json, pref) {
  const source = await sourceFor(pref);
  if (!source)
    return { ok: false, output: "" };
  try {
    if (source.kind === "bridge") {
      const output2 = await bridgeCursorModels(json);
      return { ok: !!output2.trim(), output: output2 };
    }
    const output = await connectRelayHost(source.deviceId).cursorModels(json);
    return { ok: !!output.trim(), output };
  } catch {
    return { ok: false, output: "" };
  }
}
async function pickWorkspaceFolder(pref) {
  const source = await sourceFor(pref);
  if (!source)
    return null;
  if (source.kind === "bridge")
    return await bridgePickFolder();
  return await connectRelayHost(source.deviceId).pickFolder();
}
async function listLocalAgentDir(path, pref) {
  const source = await sourceFor(pref);
  if (!source)
    return null;
  if (source.kind === "bridge")
    return await bridgeListDir(path);
  return await connectRelayHost(source.deviceId).listDir(path);
}
async function startAgentRun(lane, args, handlers, pref) {
  const source = await sourceFor(pref);
  if (!source)
    throw new Error("No computer available to run local coding agents.");
  return source.kind === "bridge" ? await startBridgeRun(lane, args, handlers) : await startRelayRun(source.deviceId, lane, args, handlers);
}
function startPayload(lane, args) {
  return {
    runId: args.runId,
    prompt: args.prompt,
    model: args.model,
    ...lane === "claude-code" ? { effort: args.effort ?? null, systemPrompt: args.systemPrompt ?? null } : {},
    resume: args.resume ?? null,
    workspace: args.workspace ?? null,
    trustWorkspace: args.trustWorkspace ?? false,
    extraDirs: args.extraDirs ?? [],
    mcp: args.mcp
  };
}
function mcpRouter(handlers, answer) {
  return {
    onMcpList: (id) => answer(id, { tools: handlers.onMcpList() }),
    onMcpCall: (id, name, args) => {
      handlers.onMcpCall(name, args).then((result) => answer(id, result), (err) => answer(id, {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true
      }));
    }
  };
}
async function startBridgeRun(lane, args, handlers) {
  const answer = (id, result) => {
    bridgeMcpResult(id, result).catch(() => {});
  };
  const mcp = mcpRouter(handlers, answer);
  let stream = null;
  let done = false;
  const finish = (exit) => {
    if (done)
      return;
    done = true;
    stream?.close();
    handlers.onExit(exit);
  };
  stream = await openRunEvents(args.runId, {
    onLine: handlers.onLine,
    onExit: finish,
    onMcpList: mcp.onMcpList,
    onMcpCall: mcp.onMcpCall,
    onError: (message) => finish({ code: null, canceled: false, stderr: message })
  });
  try {
    await bridgeStartRun({ lane, ...startPayload(lane, args) });
  } catch (err) {
    stream.close();
    throw err;
  }
  return {
    stop() {
      bridgeStopRun(args.runId).catch(() => {});
    }
  };
}
async function startRelayRun(deviceId, lane, args, handlers) {
  const conn = connectRelayHost(deviceId);
  const answer = (id, result) => conn.mcpResult(id, result);
  const mcp = mcpRouter(handlers, answer);
  await conn.startRun({ lane, ...startPayload(lane, args) }, {
    onLine: handlers.onLine,
    onExit: handlers.onExit,
    onMcpList: mcp.onMcpList,
    onMcpCall: mcp.onMcpCall
  });
  return {
    stop() {
      conn.stopRun(args.runId);
    }
  };
}
function _resetLocalAgentState() {
  resolvePromise = null;
  adoptRefused = "no";
  invalidateBridgePort();
  closeAllRelayHosts();
  status.set(initialStatus());
}
// src/localAgents/_internal/cursorModelList.ts
function variantKey(effortId, modeIds) {
  return [effortId ?? "", ...[...modeIds].sort()].join("+");
}
var EFFORT_LEVEL_LABELS = [
  { id: "none", label: "None" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" }
];
function titleCase(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
function effortLabel(id) {
  return EFFORT_LEVEL_LABELS.find((l) => l.id === id)?.label ?? titleCase(id);
}
var MODE_META = {
  fast: { label: "Fast", hint: "Prioritize speed over depth" },
  thinking: { label: "Thinking", hint: "Show extended reasoning" }
};
function modeLabel(id) {
  return MODE_META[id]?.label ?? titleCase(id);
}
function modeHint(id) {
  return MODE_META[id]?.hint;
}
var ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
var ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
var DEFAULT_MARK_RE = /\(\s*(?:(?:default|current|selected)\s*,?\s*)+\)|\*\s*$|^\*\s*/i;
function looksLikeId(token) {
  return ID_RE.test(token) && token.length <= 64;
}
var BARE_IDS = new Set([
  "auto",
  "composer",
  "fusion",
  "grok",
  "codex",
  "sonnet",
  "opus",
  "haiku",
  "gemini"
]);
function plausibleTextId(token) {
  return looksLikeId(token) && (/[\d-]/.test(token) || BARE_IDS.has(token));
}
function prettifyModelId(id) {
  if (id === "auto")
    return "Auto";
  return id.split(/[-_]/).filter(Boolean).map((part) => {
    if (/^(gpt|o\d)$/i.test(part))
      return part.toUpperCase();
    if (/^\d/.test(part))
      return part;
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(" ");
}
function fromJsonValue(value) {
  const pick = (obj, keys) => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim())
        return v.trim();
    }
    return;
  };
  let list = null;
  if (Array.isArray(value))
    list = value;
  else if (value && typeof value === "object") {
    const obj = value;
    for (const k of ["models", "data", "items", "result"]) {
      if (Array.isArray(obj[k])) {
        list = obj[k];
        break;
      }
    }
  }
  if (!list)
    return [];
  const out = [];
  for (const item of list) {
    if (typeof item === "string") {
      if (looksLikeId(item))
        out.push({ id: item, name: prettifyModelId(item) });
      continue;
    }
    if (!item || typeof item !== "object")
      continue;
    const obj = item;
    const id = pick(obj, ["id", "model", "slug", "value", "name"]);
    if (!id || !looksLikeId(id))
      continue;
    const name = pick(obj, ["displayName", "display_name", "label", "title", "name"]);
    const isDefault = obj.default === true || obj.isDefault === true || obj.is_default === true;
    out.push({
      id,
      name: name && name !== id ? name : prettifyModelId(id),
      ...isDefault ? { isDefault: true } : {}
    });
  }
  return out;
}
function fromText(raw) {
  const out = [];
  for (const rawLine of raw.replace(ANSI_RE, "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.endsWith(":"))
      continue;
    if (/[`<>]|--/.test(line))
      continue;
    if (/^(usage|options?|commands?|available models|models)\b/i.test(line) && !/[-–:]\s/.test(line)) {
      continue;
    }
    const isDefault = DEFAULT_MARK_RE.test(line);
    line = line.replace(DEFAULT_MARK_RE, "").trim();
    line = line.replace(/^[-*•>]\s+/, "");
    const paren = /^(.*?)\s*\(([a-z0-9][a-z0-9._-]*)\)\s*$/.exec(line);
    if (paren && plausibleTextId(paren[2])) {
      const id2 = paren[2];
      const name = paren[1].trim() || prettifyModelId(id2);
      out.push({ id: id2, name, ...isDefault ? { isDefault: true } : {} });
      continue;
    }
    const m = /^([^\s:—–-]+(?:-[^\s:—–]+)*)\s*(?:[—–:-]\s*|\s{2,}|\s+)?(.*)$/.exec(line);
    if (!m)
      continue;
    const id = m[1];
    if (!plausibleTextId(id))
      continue;
    const rest = m[2].trim();
    out.push({ id, name: rest || prettifyModelId(id), ...isDefault ? { isDefault: true } : {} });
  }
  return out;
}
function parseCursorModelList(raw) {
  const trimmed = raw.replace(ANSI_RE, "").trim();
  if (!trimmed)
    return [];
  let entries = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      entries = fromJsonValue(JSON.parse(trimmed));
    } catch {
      entries = [];
    }
  }
  if (!entries.length)
    entries = fromText(trimmed);
  const seen = new Set;
  return entries.filter((e) => {
    if (seen.has(e.id))
      return false;
    seen.add(e.id);
    return true;
  });
}
var CURSOR_FAMILIES = ["grok", "composer", "kimi"];
var EFFORT_TOKENS = new Set([
  "fast",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "none",
  "minimal",
  "thinking"
]);
var EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
var MODE_FLAGS = new Set(["fast", "thinking"]);
var MODE_ORDER = ["fast", "thinking"];
function splitVariant(id) {
  const toks = tokensOf(id);
  const suffix = [];
  while (toks.length > 1 && EFFORT_TOKENS.has(toks[toks.length - 1]))
    suffix.unshift(toks.pop());
  const level = suffix.find((t) => EFFORT_LEVELS.includes(t)) ?? null;
  const flags = suffix.filter((t) => MODE_FLAGS.has(t)).sort();
  return { base: toks.join("-"), level, flags };
}
var EFFORT_WORDS_RE = /\b(fast|low|medium|high|extra high|xhigh|max|none|minimal|thinking)\b/gi;
var tokensOf = (id) => id.split(/[-_]/).filter(Boolean);
function familyOf(id, families = CURSOR_FAMILIES) {
  const toks = tokensOf(id);
  return families.find((f) => toks.includes(f)) ?? null;
}
function baseModelId(id) {
  const toks = tokensOf(id);
  while (toks.length > 1 && EFFORT_TOKENS.has(toks[toks.length - 1]))
    toks.pop();
  return toks.join("-");
}
function versionOf(base, family) {
  const toks = tokensOf(base);
  const after = toks.slice(toks.indexOf(family) + 1);
  const vt = after.find((t) => /\d/.test(t));
  if (!vt)
    return [];
  return vt.replace(/^[a-z]+/i, "").split(".").map((n) => Number(n) || 0);
}
function compareVersions(a, b) {
  for (let i = 0;i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d)
      return d;
  }
  return 0;
}
function effortWordCount(name) {
  return (name.match(EFFORT_WORDS_RE) ?? []).length;
}
function pickLatestPerFamily(entries, families = CURSOR_FAMILIES) {
  const out = entries.filter((e) => e.id === "auto").slice(0, 1);
  for (const family of families) {
    const members = entries.filter((e) => e.id !== "auto" && familyOf(e.id, families) === family);
    if (!members.length)
      continue;
    let bestBase = null;
    let bestVersion = [];
    for (const m of members) {
      const base = baseModelId(m.id);
      const v = versionOf(base, family);
      if (bestBase === null || compareVersions(v, bestVersion) > 0) {
        bestBase = base;
        bestVersion = v;
      }
    }
    const siblings = members.filter((m) => baseModelId(m.id) === bestBase).sort((a, b) => effortWordCount(a.name) - effortWordCount(b.name) || Number(a.id.endsWith("-fast")) - Number(b.id.endsWith("-fast")) || a.id.length - b.id.length);
    const canonical = siblings[0];
    const canon = splitVariant(canonical.id);
    const rows = siblings.map((v) => ({ v, parts: splitVariant(v.id) })).filter(({ parts }) => canon.flags.every((f) => parts.flags.includes(f)));
    const variants = {};
    const extras = new Set;
    for (const { v, parts } of rows) {
      const extra = parts.flags.filter((f) => !canon.flags.includes(f));
      for (const f of extra)
        extras.add(f);
      variants[variantKey(parts.level, extra)] = v.id;
    }
    const levels = rows.filter(({ parts }) => parts.level && parts.flags.length === canon.flags.length).sort((a, b) => EFFORT_LEVELS.indexOf(a.parts.level) - EFFORT_LEVELS.indexOf(b.parts.level)).map(({ v, parts }) => ({
      id: parts.level,
      cliId: v.id,
      ...v.id === canonical.id ? { default: true } : {}
    }));
    const modes = [...extras].sort((a, b) => MODE_ORDER.indexOf(a) - MODE_ORDER.indexOf(b));
    out.push({
      ...canonical,
      ...levels.length >= 2 ? { efforts: levels } : {},
      ...modes.length ? { modes } : {},
      ...levels.length >= 2 || modes.length ? { variants } : {}
    });
  }
  return out;
}

// src/localAgents/catalog.ts
var CLAUDE_CODE_MODEL_PREFIX = "claude-code/";
var CURSOR_MODEL_PREFIX = "cursor/";
function isLocalAgentModel(modelId) {
  if (!modelId)
    return false;
  return modelId.startsWith(CLAUDE_CODE_MODEL_PREFIX) || modelId.startsWith(CURSOR_MODEL_PREFIX);
}
function laneForModel(modelId) {
  if (modelId.startsWith(CLAUDE_CODE_MODEL_PREFIX))
    return "claude-code";
  if (modelId.startsWith(CURSOR_MODEL_PREFIX))
    return "cursor";
  return null;
}
var LEGACY_AUTO_ALIAS = "auto";
function claudeCodeCliModel(modelId) {
  const alias = modelId.slice(CLAUDE_CODE_MODEL_PREFIX.length);
  return alias === LEGACY_AUTO_ALIAS ? null : alias;
}
var DEFAULT_EFFORT_ID = "medium";
var CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"].map((id) => ({
  id,
  label: effortLabel(id),
  ...id === DEFAULT_EFFORT_ID ? { default: true } : {}
}));
var CLAUDE_MODELS = [
  { alias: "opus", name: "Claude Opus", effort: true },
  { alias: "sonnet", name: "Claude Sonnet", effort: true },
  { alias: "haiku", name: "Claude Haiku" },
  { alias: "fable", name: "Claude Fable", effort: true }
];
function claudeCodeModelName(alias) {
  if (alias === LEGACY_AUTO_ALIAS)
    return "Claude Code";
  return CLAUDE_MODELS.find((m) => m.alias === alias)?.name ?? `Claude ${alias}`;
}
var CLAUDE_CODE_CONTEXT_SIZE = 200000;
var CURSOR_CONTEXT_SIZE = 200000;
function claudeCodeModels() {
  return CLAUDE_MODELS.map((m) => ({
    id: `${CLAUDE_CODE_MODEL_PREFIX}${m.alias}`,
    "model-id": `${CLAUDE_CODE_MODEL_PREFIX}${m.alias}`,
    name: m.name,
    author: "Claude Code",
    type: "text",
    owned_by: "claude-code",
    context_size: CLAUDE_CODE_CONTEXT_SIZE,
    ...m.effort ? { efforts: CLAUDE_EFFORTS } : {}
  }));
}
function cursorCliModel(modelId) {
  const cli = modelId.slice(CURSOR_MODEL_PREFIX.length);
  return cli === "auto" ? null : cli;
}
var FALLBACK_CURSOR_MODELS = [{ id: "auto", name: "Cursor Agent" }];
var FORMAT_KEY = "unified.cursor.modelsFormat";
function preferredFormat() {
  try {
    const raw = globalThis.localStorage?.getItem(FORMAT_KEY) ?? null;
    return raw === "json" ? true : raw === "plain" ? false : null;
  } catch {
    return null;
  }
}
function rememberFormat(json) {
  try {
    globalThis.localStorage?.setItem(FORMAT_KEY, json ? "json" : "plain");
  } catch {}
}
var modelListPromises = new Map;
function prefKey(pref) {
  if (!pref)
    return "auto";
  return pref.kind === "relay" ? `relay:${pref.deviceId}` : pref.kind;
}
function listCursorModels(pref) {
  const key = prefKey(pref);
  let promise = modelListPromises.get(key);
  if (!promise) {
    promise = (async () => {
      const first = preferredFormat() ?? true;
      for (const json of [first, !first]) {
        try {
          const out = await cursorModelsOutput(json, pref);
          if (!out.ok)
            continue;
          const entries = parseCursorModelList(out.output);
          if (entries.length) {
            rememberFormat(json);
            return entries;
          }
        } catch {}
      }
      return FALLBACK_CURSOR_MODELS;
    })();
    modelListPromises.set(key, promise);
  }
  return promise;
}
function invalidateCursorModels() {
  modelListPromises.clear();
}
async function cursorModels(pref) {
  const ordered = pickLatestPerFamily(await listCursorModels(pref));
  return ordered.map((m) => ({
    id: `${CURSOR_MODEL_PREFIX}${m.id}`,
    "model-id": `${CURSOR_MODEL_PREFIX}${m.id}`,
    name: m.id === "auto" ? "Cursor Agent" : m.name,
    author: "Cursor",
    type: "text",
    owned_by: "cursor",
    context_size: CURSOR_CONTEXT_SIZE,
    ...m.efforts ? {
      efforts: m.efforts.map((e) => ({
        id: e.id,
        label: effortLabel(e.id),
        modelId: `${CURSOR_MODEL_PREFIX}${e.cliId}`,
        ...e.default ? { default: true } : {}
      }))
    } : {},
    ...m.modes ? {
      modes: m.modes.map((id) => {
        const hint = modeHint(id);
        return { id, label: modeLabel(id), ...hint ? { hint } : {} };
      })
    } : {},
    ...m.variants ? {
      variants: Object.fromEntries(Object.entries(m.variants).map(([k, cliId]) => [k, `${CURSOR_MODEL_PREFIX}${cliId}`]))
    } : {}
  }));
}
async function listLocalModels(pref) {
  let detected;
  try {
    detected = await detectAgents(pref);
  } catch {
    return [];
  }
  const out = [];
  if (detected.claudeCode.found)
    out.push(...claudeCodeModels());
  if (detected.cursor.found) {
    try {
      out.push(...await cursorModels(pref));
    } catch {}
  }
  return out;
}
function placeholderLocalModel(modelId) {
  if (modelId.startsWith(CLAUDE_CODE_MODEL_PREFIX)) {
    return {
      id: modelId,
      "model-id": modelId,
      name: claudeCodeModelName(modelId.slice(CLAUDE_CODE_MODEL_PREFIX.length)),
      author: "Claude Code",
      owned_by: "claude-code"
    };
  }
  if (modelId.startsWith(CURSOR_MODEL_PREFIX)) {
    const cli = modelId.slice(CURSOR_MODEL_PREFIX.length);
    return {
      id: modelId,
      "model-id": modelId,
      name: cli === "auto" ? "Cursor Agent" : prettifyModelId(cli.replace(/^cursor-/, "")),
      author: "Cursor",
      owned_by: "cursor"
    };
  }
  return null;
}
// src/localAgents/_internal/prompt.ts
function foldHistoryPrompt(messages, userText, hasSession) {
  if (hasSession)
    return userText;
  const history = messages.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim());
  if (history.length && history[history.length - 1]?.content === userText)
    history.pop();
  if (!history.length)
    return userText;
  const transcript = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join(`

`);
  return `Earlier conversation for context:

${transcript}

---

${userText}`;
}
function systemText(messages) {
  return messages.filter((m) => m.role === "system" && typeof m.content === "string").map((m) => m.content.trim()).filter(Boolean).join(`

`);
}
function withSystemPrompt(system, prompt) {
  if (!system)
    return prompt;
  return `<system-instructions>
${system}
</system-instructions>

${prompt}`;
}
var CLAUDE_CODE_SESSIONS_KEY = "unified.claudeCodeSessions";
var CURSOR_SESSIONS_KEY = "unified.cursorSessions";
var EPHEMERAL_CONVERSATION_PREFIX = "ephemeral:";
function isEphemeralConversation(conversationId) {
  return conversationId.startsWith(EPHEMERAL_CONVERSATION_PREFIX);
}
function sessionScope(conversationId, workspace) {
  return workspace ? `${conversationId} ws:${workspace}` : conversationId;
}
function loadSessions(key) {
  try {
    const raw = globalThis.localStorage?.getItem(key) ?? null;
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function sessionFor(key, conversationId) {
  if (isEphemeralConversation(conversationId))
    return null;
  return loadSessions(key)[conversationId] ?? null;
}
function forgetSession(key, conversationId) {
  try {
    const sessions = loadSessions(key);
    delete sessions[conversationId];
    globalThis.localStorage?.setItem(key, JSON.stringify(sessions));
  } catch {}
}
function rememberSession(key, conversationId, sessionId) {
  if (isEphemeralConversation(conversationId))
    return;
  try {
    const sessions = loadSessions(key);
    sessions[conversationId] = sessionId;
    globalThis.localStorage?.setItem(key, JSON.stringify(sessions));
  } catch {}
}

// src/localAgents/_internal/toolServer.ts
function stableStringify(value) {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
function inflightKey(name, args) {
  return `${name} ${stableStringify(args)}`;
}
function toMcpToolDef(spec) {
  const fn = spec.definition.function;
  return {
    name: fn.name,
    description: fn.description ?? "",
    inputSchema: fn.parameters ?? {
      type: "object",
      properties: {}
    }
  };
}
function createToolServer(tools, signal) {
  const inflight = new Map;
  async function execute(name, args) {
    const spec = tools?.find((t) => t.definition.function.name === name);
    if (!spec) {
      return {
        content: [{ type: "text", text: `tool "${name}" is not available` }],
        isError: true
      };
    }
    const input = args && typeof args === "object" ? args : {};
    try {
      const result = await spec.execute(input, signal);
      return { content: [{ type: "text", text: result.content }], isError: !!result.isError };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true
      };
    }
  }
  return {
    list() {
      return (tools ?? []).map(toMcpToolDef);
    },
    call(name, args) {
      const key = inflightKey(name, args);
      let call = inflight.get(key);
      if (!call) {
        call = execute(name, args).finally(() => {
          if (inflight.get(key) === call)
            inflight.delete(key);
        });
        inflight.set(key, call);
      }
      return call;
    }
  };
}

// src/localAgents/_internal/translators.ts
var TOOL_RESULT_MAX_CHARS = 4000;
var MCP_TOOL_PREFIX = "mcp__unifiedapp__";
function claudeToolName(name) {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}
function stringifyToolResult(content) {
  let text;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.map((block) => {
      const b = block;
      return typeof b?.text === "string" ? b.text : JSON.stringify(block);
    }).join(`
`);
  } else {
    try {
      text = JSON.stringify(content ?? "");
    } catch {
      text = "[unserializable tool result]";
    }
  }
  return text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}…` : text;
}
function createClaudeCodeStreamTranslator(onEvent) {
  let allText = "";
  let seenText = "";
  let seenThinking = "";
  let lastAggregate = "";
  let toolActivity = false;
  let sessionId;
  let result = null;
  const partialTools = new Map;
  const emitText = (delta) => {
    if (!delta)
      return;
    allText += delta;
    onEvent({ type: "text_delta", delta });
  };
  const emitSuffix = (full, seen, emit) => {
    if (full.startsWith(seen)) {
      const suffix = full.slice(seen.length);
      if (suffix.trim())
        emit(suffix);
      return full;
    }
    emit(full);
    return full;
  };
  const handleStreamEvent = (event) => {
    const index = typeof event.index === "number" ? event.index : 0;
    switch (event.type) {
      case "message_start":
        seenText = "";
        seenThinking = "";
        break;
      case "content_block_start": {
        const block = event.content_block ?? {};
        if (block.type === "tool_use" && typeof block.name === "string") {
          partialTools.set(index, { name: claudeToolName(block.name), args: "" });
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          seenText += delta.text;
          emitText(delta.text);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          seenThinking += delta.thinking;
          onEvent({ type: "thinking_delta", delta: delta.thinking });
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const pending = partialTools.get(index);
          if (pending) {
            pending.args += delta.partial_json;
            onEvent({
              type: "tool_partial",
              name: pending.name,
              chars: pending.args.length,
              args: pending.args
            });
          }
        }
        break;
      }
      case "content_block_stop":
        partialTools.delete(index);
        break;
    }
  };
  const handleAssistantMessage = (message) => {
    if (message.model === "<synthetic>")
      return;
    const content = Array.isArray(message.content) ? message.content : [];
    const textBlocks = content.filter((b) => b?.type === "text");
    const thinkingBlocks = content.filter((b) => b?.type === "thinking");
    const fullThinking = thinkingBlocks.map((b) => b.thinking ?? "").join("");
    if (fullThinking) {
      seenThinking = emitSuffix(fullThinking, seenThinking, (d) => onEvent({ type: "thinking_delta", delta: d }));
    }
    const fullText = textBlocks.map((b) => b.text ?? "").join("");
    if (fullText && fullText.trim() !== lastAggregate.trim()) {
      seenText = emitSuffix(fullText, seenText, emitText);
      lastAggregate = fullText;
    }
    for (const block of content) {
      const b = block;
      if (b?.type !== "tool_use" || typeof b.name !== "string")
        continue;
      toolActivity = true;
      onEvent({
        type: "tool_use",
        id: typeof b.id === "string" ? b.id : crypto.randomUUID(),
        name: claudeToolName(b.name),
        input: b.input && typeof b.input === "object" ? b.input : {}
      });
      seenText = "";
      lastAggregate = "";
    }
  };
  const handleLine = (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof ev.session_id === "string" && ev.session_id)
      sessionId = ev.session_id;
    if (ev.parent_tool_use_id)
      return;
    switch (ev.type) {
      case "stream_event":
        handleStreamEvent(ev.event ?? {});
        break;
      case "assistant":
        handleAssistantMessage(ev.message ?? {});
        break;
      case "user": {
        const message = ev.message ?? {};
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          const b = block;
          if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string")
            continue;
          onEvent({
            type: "tool_result",
            toolUseId: b.tool_use_id,
            content: stringifyToolResult(b.content),
            isError: b.is_error === true
          });
        }
        break;
      }
      case "result": {
        const usage = ev.usage ?? {};
        const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        if (inputTokens || outputTokens) {
          onEvent({ type: "usage", usage: { inputTokens, outputTokens } });
        }
        result = {
          isError: ev.is_error === true,
          text: typeof ev.result === "string" ? ev.result : "",
          ...sessionId !== undefined ? { sessionId } : {}
        };
        break;
      }
    }
  };
  return {
    handleLine,
    emitText,
    get allText() {
      return allText;
    },
    get toolActivity() {
      return toolActivity;
    },
    get sessionId() {
      return sessionId;
    },
    get result() {
      return result;
    }
  };
}
var AUTH_FAILURE_RE = /failed to authenticate|oauth session expired|invalid api key|not logged in|please run .*(login|auth)/i;
function explainFailure(detail) {
  const text = detail.trim();
  if (!AUTH_FAILURE_RE.test(text))
    return text;
  return `Claude Code isn't signed in. Run \`claude\` in a terminal and sign in, then retry this message. (${text})`;
}
function isMissingSession(stderr) {
  return /no conversation found/i.test(stderr);
}
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function safeStringify(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "[unserializable tool result]";
  }
}
function mcpToolResultText(result) {
  const blocks = result.content;
  if (!Array.isArray(blocks))
    return null;
  const text = blocks.filter((b) => isRecord(b) && typeof b.text === "string").map((b) => b.text).join(`
`).trim();
  return text || null;
}
function cursorToolName(toolCall) {
  const key = Object.keys(toolCall)[0];
  if (!key)
    return { name: "tool", body: {} };
  const body = toolCall[key];
  return {
    name: key.replace(/ToolCall$/, ""),
    body: body && typeof body === "object" ? body : {}
  };
}
function createCursorStreamTranslator(onEvent) {
  let allText = "";
  let segmentText = "";
  let lastAggregate = "";
  let toolActivity = false;
  let result = null;
  const emitText = (delta) => {
    if (!delta)
      return;
    allText += delta;
    onEvent({ type: "text_delta", delta });
  };
  const handleLine = (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    switch (ev.type) {
      case "assistant": {
        const message = ev.message;
        const text = (message?.content ?? []).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
        if (!text)
          break;
        const isDelta = "timestamp_ms" in ev && !("model_call_id" in ev);
        if (isDelta) {
          segmentText += text;
          emitText(text);
        } else {
          if (text.startsWith(segmentText)) {
            const suffix = text.slice(segmentText.length);
            if (suffix.trim())
              emitText(suffix);
            segmentText = text;
          } else if (text.trim() !== lastAggregate.trim()) {
            emitText(text);
            segmentText += text;
          }
          lastAggregate = text;
        }
        break;
      }
      case "thinking": {
        if (ev.subtype === "delta" && typeof ev.text === "string" && ev.text) {
          onEvent({ type: "thinking_delta", delta: ev.text });
        }
        break;
      }
      case "tool_call": {
        const callId = typeof ev.call_id === "string" ? ev.call_id : crypto.randomUUID();
        let { name, body } = cursorToolName(ev.tool_call ?? {});
        let args = body.args;
        if (name === "mcp") {
          const a = args ?? {};
          if (typeof a.name === "string")
            name = a.name.replace(/^unifiedapp-/, "");
          args = a.args;
        }
        toolActivity = true;
        segmentText = "";
        lastAggregate = "";
        if (ev.subtype === "started") {
          onEvent({
            type: "tool_use",
            id: callId,
            name,
            input: args && typeof args === "object" ? args : {}
          });
        } else if (ev.subtype === "completed") {
          const res = body.result;
          let isError;
          let content;
          if (!res) {
            isError = true;
            content = "[no tool result]";
          } else if ("success" in res) {
            if (isRecord(res.success)) {
              isError = res.success.isError === true;
              content = mcpToolResultText(res.success) ?? safeStringify(res.success);
            } else {
              isError = false;
              content = safeStringify(res.success);
            }
          } else {
            isError = true;
            content = safeStringify(res);
          }
          if (content.length > TOOL_RESULT_MAX_CHARS) {
            content = `${content.slice(0, TOOL_RESULT_MAX_CHARS)}…`;
          }
          onEvent({ type: "tool_result", toolUseId: callId, content, isError });
        }
        break;
      }
      case "result": {
        result = {
          isError: ev.is_error === true,
          text: typeof ev.result === "string" ? ev.result : "",
          ...typeof ev.session_id === "string" ? { sessionId: ev.session_id } : {}
        };
        break;
      }
    }
  };
  return {
    handleLine,
    emitText,
    get allText() {
      return allText;
    },
    get toolActivity() {
      return toolActivity;
    },
    get result() {
      return result;
    }
  };
}

// src/localAgents/run.ts
function latestUserText(messages) {
  for (let i = (messages?.length ?? 0) - 1;i >= 0; i--) {
    const m = messages?.[i];
    if (!m || m.role !== "user")
      continue;
    if (typeof m.content === "string")
      return m.content;
    if (Array.isArray(m.content))
      return flattenParts(m.content);
  }
  return "";
}
function flattenParts(parts) {
  return parts.map((p) => p && typeof p === "object" && ("text" in p) ? String(p.text ?? "") : "").filter(Boolean).join(`
`);
}
function runAttempt(lane, opts, messages, userText, system, signal, onEvent, resume, scope) {
  const modelId = opts.model;
  const runId = crypto.randomUUID();
  const folded = foldHistoryPrompt(messages, userText, !!resume);
  const prompt = lane === "claude-code" ? folded : withSystemPrompt(system, folded);
  const tools = createToolServer(opts.tools, signal);
  const mcp = !!opts.tools?.length;
  const translator = lane === "claude-code" ? createClaudeCodeStreamTranslator(onEvent) : createCursorStreamTranslator(onEvent);
  const sessionsKey = lane === "claude-code" ? CLAUDE_CODE_SESSIONS_KEY : CURSOR_SESSIONS_KEY;
  return new Promise((resolve) => {
    let settled = false;
    let handle = null;
    const finish = (result) => {
      if (settled)
        return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      handle?.stop();
    };
    signal.addEventListener("abort", onAbort);
    const produced = () => translator.allText.length > 0 || translator.toolActivity;
    const fail = (error, sessionMissing = false) => finish({
      ok: false,
      error,
      ...sessionMissing ? { sessionMissing: true } : {},
      model: modelId,
      producedOutput: produced(),
      messages
    });
    (async () => {
      try {
        if (signal.aborted) {
          finish({ ok: false, canceled: true, model: modelId, producedOutput: false, messages });
          return;
        }
        handle = await startAgentRun(lane, {
          runId,
          prompt,
          model: lane === "claude-code" ? claudeCodeCliModel(modelId) : cursorCliModel(modelId),
          ...lane === "claude-code" ? { effort: opts.effort ?? null, systemPrompt: system || null } : {},
          resume,
          workspace: opts.workspace ?? null,
          trustWorkspace: opts.trustWorkspace ?? false,
          extraDirs: opts.extraDirs ?? [],
          mcp
        }, {
          onLine: (line) => translator.handleLine(line),
          onMcpList: () => tools.list(),
          onMcpCall: (name, args) => tools.call(name, args),
          onExit({ code, canceled, stderr }) {
            if (canceled || signal.aborted) {
              finish({
                ok: false,
                canceled: true,
                model: modelId,
                producedOutput: produced(),
                messages
              });
              return;
            }
            const sessionId = translator.result?.sessionId ?? translator.sessionId;
            if (sessionId)
              rememberSession(sessionsKey, scope, sessionId);
            const result = translator.result;
            if (result && !result.isError) {
              if (!translator.allText && result.text)
                translator.emitText(result.text);
              finish({
                ok: true,
                model: modelId,
                producedOutput: produced(),
                messages: [...messages, { role: "assistant", content: translator.allText }]
              });
              return;
            }
            const detail = result?.text.trim() || stderr.trim() || `${lane} exited with code ${code ?? "unknown"}`;
            fail(lane === "claude-code" ? explainFailure(detail) : detail, lane === "claude-code" && isMissingSession(stderr));
          }
        }, opts.source);
        if (signal.aborted)
          handle.stop();
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    })();
  });
}
async function runLocalAgent(opts) {
  const lane = laneForModel(opts.model);
  if (!lane)
    throw new Error(`"${opts.model}" is not a local agent model.`);
  const messages = opts.messages ?? [];
  const promptText = typeof opts.prompt === "string" ? opts.prompt : Array.isArray(opts.prompt) ? flattenParts(opts.prompt) : latestUserText(messages);
  const signal = opts.signal ?? new AbortController().signal;
  const onEvent = opts.onEvent ?? (() => {});
  const conversationId = opts.conversationId ?? `${EPHEMERAL_CONVERSATION_PREFIX}${crypto.randomUUID()}`;
  const scope = sessionScope(conversationId, opts.workspace);
  const sessionsKey = lane === "claude-code" ? CLAUDE_CODE_SESSIONS_KEY : CURSOR_SESSIONS_KEY;
  const resume = sessionFor(sessionsKey, scope);
  const system = opts.system ?? systemText(messages);
  const attempt = await runAttempt(lane, opts, messages, promptText, system, signal, onEvent, resume, scope);
  if (resume && attempt.sessionMissing && !attempt.producedOutput && !signal.aborted) {
    forgetSession(sessionsKey, scope);
    const retry = await runAttempt(lane, opts, messages, promptText, system, signal, onEvent, null, scope);
    return published(retry);
  }
  return published(attempt);
}
function published(attempt) {
  const { sessionMissing: _sessionMissing, ...result } = attempt;
  return result;
}
// src/core/_internal/pkce.ts
var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
function randomString(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0;i < len; i++) {
    const b = bytes[i] ?? 0;
    out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}
function generateVerifier() {
  return randomString(64);
}
function generateState() {
  return randomString(32);
}
async function challengeFor(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToBase64Url(new Uint8Array(digest));
}

// src/core/_internal/tokens.ts
function isTokenSet(value) {
  if (!value || typeof value !== "object")
    return false;
  const v = value;
  return typeof v.access_token === "string" && typeof v.refresh_token === "string" && typeof v.expires_at === "number" && typeof v.user_id === "string" && typeof v.client_id === "string";
}

// src/core/_internal/token-endpoint.ts
async function postTokenGrant(args) {
  const { tokenUrl, body, fetch: fetch2, makeError } = args;
  let res;
  try {
    res = await fetch2(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    throw makeError(`token endpoint ${tokenUrl} unreachable`);
  }
  if (!res.ok) {
    await drainResponse(res);
    throw makeError(`token endpoint returned ${res.status}`, res.status);
  }
  const parsed = await res.json();
  if (!isTokenSet(parsed)) {
    throw makeError("token endpoint returned malformed payload");
  }
  return parsed;
}

// src/auth/browser-sign-in.ts
async function signInWithBrowser(args) {
  const { clientId, authorizeUrl, tokenUrl, openUrl, loopback } = args;
  const fetchImpl = args.fetch ?? globalThis.fetch;
  const verifier = generateVerifier();
  const challenge = await challengeFor(verifier);
  const state = generateState();
  const handle = await loopback.start();
  try {
    const url = new URL(authorizeUrl);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", handle.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    await openUrl(url.toString());
    const code = await handle.waitForCode(state);
    return await postTokenGrant({
      tokenUrl,
      fetch: fetchImpl,
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: handle.redirectUri
      },
      makeError: (msg, status2) => new UnifiedError("auth_token_exchange_failed", msg, status2)
    });
  } finally {
    await loopback.stop();
  }
}
var runBrowserPkce = signInWithBrowser;

// src/core/_internal/cache.ts
var DEFAULT_CACHE = Object.freeze({
  maxEntries: 256,
  ttlMs: 5 * 60000
});
function resolveCacheConfig(override) {
  if (override === false || override === undefined)
    return;
  return {
    maxEntries: override.maxEntries ?? DEFAULT_CACHE.maxEntries,
    ttlMs: override.ttlMs ?? DEFAULT_CACHE.ttlMs
  };
}
function clone(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

class LruCache {
  store = new Map;
  cfg;
  constructor(cfg) {
    this.cfg = cfg;
  }
  get(key) {
    const entry = this.store.get(key);
    if (!entry)
      return;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return clone(entry.value);
  }
  set(key, value) {
    if (this.store.has(key))
      this.store.delete(key);
    this.store.set(key, { value: clone(value), expiresAt: Date.now() + this.cfg.ttlMs });
    while (this.store.size > this.cfg.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined)
        break;
      this.store.delete(oldest);
    }
  }
  clear() {
    this.store.clear();
  }
  get size() {
    return this.store.size;
  }
}
function stableStringify2(value) {
  const seen = new WeakSet;
  const walk = (v) => {
    if (v === null || typeof v !== "object")
      return v;
    if (seen.has(v))
      return "[circular]";
    seen.add(v);
    if (Array.isArray(v))
      return v.map(walk);
    const obj = v;
    const out = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = walk(obj[k]);
    }
    return out;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return String(value);
  }
}
function fnv1a(input) {
  let hash = 2166136261;
  for (let i = 0;i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function cacheKey(method, path, body, query) {
  const canonical = `${method.toUpperCase()}|${path}|${stableStringify2(query ?? null)}|${stableStringify2(body ?? null)}`;
  return `${fnv1a(canonical)}|${canonical.length}`;
}

// src/core/_internal/upload-progress.ts
var PROGRESS_BLOB_MAX_BYTES = 100 * 1024 * 1024;
function estimateFormDataBytes(form) {
  let total = 0;
  let partCount = 0;
  const encoder2 = typeof TextEncoder !== "undefined" ? new TextEncoder : undefined;
  for (const [name, value] of form.entries()) {
    partCount += 1;
    total += encoder2 ? encoder2.encode(name).length : name.length;
    if (typeof value === "string") {
      total += encoder2 ? encoder2.encode(value).length : value.length;
    } else {
      total += value.size;
    }
  }
  total += partCount * 200 + 50;
  return total;
}
function progressStream(blob, onProgress) {
  const total = blob.size;
  const reader = blob.stream().getReader();
  let loaded = 0;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      loaded += value.byteLength;
      controller.enqueue(value);
      safeEmit(onProgress, loaded, total);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    }
  });
}
async function prepareUploadProgress(form, onProgress) {
  if (typeof onProgress !== "function")
    return;
  const estimatedBytes = estimateFormDataBytes(form);
  const blob = estimatedBytes <= PROGRESS_BLOB_MAX_BYTES ? await new Response(form).blob() : undefined;
  return new UploadProgress(onProgress, blob, estimatedBytes);
}

class UploadProgress {
  onProgress;
  blob;
  estimatedBytes;
  constructor(onProgress, blob, estimatedBytes) {
    this.onProgress = onProgress;
    this.blob = blob;
    this.estimatedBytes = estimatedBytes;
  }
  beginAttempt() {
    safeEmit(this.onProgress, 0, this.blob?.size ?? this.estimatedBytes);
  }
  body() {
    if (!this.blob)
      return;
    return { stream: progressStream(this.blob, this.onProgress), contentType: this.blob.type };
  }
  finish() {
    if (this.blob)
      return;
    safeEmit(this.onProgress, this.estimatedBytes, this.estimatedBytes);
  }
}

// src/core/client.ts
var DEFAULT_API_URL = "https://api.unifiedai.app";
function envVar(name) {
  if (typeof process === "undefined" || !process.env)
    return;
  return process.env[name];
}
function oauthUnavailable(reason) {
  return new UnifiedError("not_implemented", `${reason}. Pass \`token\` for trusted-token mode, or import UnifiedAI from '@unifiedai/sdk/node' for OAuth.`);
}

class UnifiedAI extends Core {
  #models;
  #usage;
  #users;
  #chat;
  #responses;
  #messages;
  #images;
  #files;
  #audio;
  #videos;
  #embeddings;
  #decisions;
  #helpers;
  #calendar;
  #projects;
  #references;
  #artifacts;
  #memory;
  #actions;
  #storage;
  #fs;
  #sync;
  #agent;
  get models() {
    return this.#models ??= new Models(this);
  }
  get usage() {
    return this.#usage ??= new Usage(this);
  }
  get users() {
    return this.#users ??= new Users(this);
  }
  get chat() {
    return this.#chat ??= new Chat(this);
  }
  get responses() {
    return this.#responses ??= new Responses(this);
  }
  get messages() {
    return this.#messages ??= new Messages(this);
  }
  get images() {
    return this.#images ??= new Images(this);
  }
  get files() {
    return this.#files ??= new Files(this);
  }
  get audio() {
    return this.#audio ??= new Audio(this);
  }
  get videos() {
    return this.#videos ??= new Videos(this);
  }
  get embeddings() {
    return this.#embeddings ??= new Embeddings(this);
  }
  get decisions() {
    return this.#decisions ??= new Decisions(this);
  }
  get helpers() {
    return this.#helpers ??= new Helpers;
  }
  get calendar() {
    return this.#calendar ??= new Calendar;
  }
  get projects() {
    return this.#projects ??= new Projects(this);
  }
  get references() {
    return this.#references ??= new References(this);
  }
  get artifacts() {
    return this.#artifacts ??= new Artifacts(this);
  }
  get memory() {
    return this.#memory ??= new Memory(this);
  }
  get actions() {
    return this.#actions ??= new Actions(this);
  }
  get storage() {
    return this.#storage ??= new Storage(this);
  }
  get fs() {
    return this.#fs ??= new Fs(this);
  }
  get sync() {
    return this.#sync ??= new Sync(this);
  }
  get agent() {
    return this.#agent ??= new Agent(this);
  }
  session;
  trustedRefreshPromise;
  responseCache;
  constructor(options = {}) {
    super({
      ...options,
      apiUrl: options.apiUrl ?? envVar("UNIFIEDAI_API_URL") ?? DEFAULT_API_URL
    });
    const cacheCfg = resolveCacheConfig(this.options.cache);
    this.responseCache = cacheCfg ? new LruCache(cacheCfg) : undefined;
    this.session = new Session(this.options.token !== undefined ? "active" : "signed_out");
  }
  bootstrap() {
    if (this.options.token !== undefined)
      return Promise.resolve();
    return Promise.reject(oauthUnavailable("OAuth bootstrap is unavailable in the browser entry"));
  }
  identity() {
    throw new UnifiedError("not_bootstrapped", "identity() requires the node entry or a subclass that owns user-session state.");
  }
  accessToken() {
    return this.getInitialAccessToken();
  }
  async signOut() {
    this.session.markSignedOut();
  }
  async throwHttpError(op, path, res) {
    const status2 = res.status;
    const body = await readErrorBody(res);
    throw buildHttpError(httpErrorMessage(op, path, status2, body), status2, body, headersToRecord(res.headers));
  }
  async request(path, options = {}) {
    const method = options.method ?? "GET";
    let key;
    if (options.cache && this.responseCache) {
      key = cacheKey(method, path, options.body, options.query);
      const hit = this.responseCache.get(key);
      if (hit !== undefined)
        return hit;
    }
    const url = this.buildUrl(path, options.query);
    const isMultipart = typeof FormData !== "undefined" && options.body instanceof FormData;
    const isBinaryBody = options.body instanceof ArrayBuffer || options.body instanceof Uint8Array || typeof Blob !== "undefined" && options.body instanceof Blob;
    const upload = isMultipart ? await prepareUploadProgress(options.body, options.onUploadProgress) : undefined;
    const bodyInit = isMultipart ? options.body : isBinaryBody ? options.body : options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const send2 = (accessToken) => {
      upload?.beginAttempt();
      const init = {
        method: options.method ?? "GET",
        headers: this.buildHeaders(accessToken, bodyInit !== undefined && !isMultipart && !isBinaryBody)
      };
      const wrapped = upload?.body();
      if (wrapped) {
        init.body = wrapped.stream;
        init.duplex = "half";
        init.headers["content-type"] = wrapped.contentType;
      } else if (bodyInit !== undefined) {
        init.body = bodyInit;
        if (isBinaryBody) {
          init.headers["content-type"] = options.contentType ?? "application/octet-stream";
        }
      }
      if (options.signal)
        init.signal = options.signal;
      return this.options.fetch(url, init);
    };
    const res = await this.executeWithRetry(send2, method, options);
    if (res.ok)
      upload?.finish();
    if (!res.ok) {
      await this.throwHttpError("request", path, res);
    }
    if (res.status === 204)
      return;
    const parsed = await res.json();
    if (key !== undefined && this.responseCache) {
      this.responseCache.set(key, parsed);
    }
    return parsed;
  }
  async requestBinary(path, options = {}) {
    const url = this.buildUrl(path, options.query);
    const isMultipart = typeof FormData !== "undefined" && options.body instanceof FormData;
    const bodyInit = isMultipart ? options.body : options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const send2 = (accessToken) => {
      const init = {
        method: options.method ?? "GET",
        headers: this.buildHeaders(accessToken, bodyInit !== undefined && !isMultipart)
      };
      if (bodyInit !== undefined)
        init.body = bodyInit;
      if (options.signal)
        init.signal = options.signal;
      return this.options.fetch(url, init);
    };
    const res = await this.executeWithRetry(send2, options.method ?? "GET", options);
    if (!res.ok) {
      await this.throwHttpError("requestBinary", path, res);
    }
    const rawCt = res.headers.get("content-type") ?? "";
    const headers = headersToRecord(res.headers);
    if (res.status === 204) {
      await drainResponse(res);
      throw new UnifiedAIError("request_failed", `requestBinary to ${path} returned 204 No Content (no bytes to return)`, 204, undefined, headers);
    }
    if (options.acceptedContentTypes && options.acceptedContentTypes.length > 0) {
      const ct = (rawCt.split(";")[0] ?? "").trim().toLowerCase();
      const ok = options.acceptedContentTypes.some((accepted) => {
        const a = accepted.toLowerCase();
        return a.endsWith("/") ? ct.startsWith(a) : ct === a;
      });
      if (!ok) {
        const peek = await readErrorBody(res) ?? "";
        throw new UnifiedAIError("request_failed", `requestBinary to ${path} expected one of [${options.acceptedContentTypes.join(", ")}], got ${rawCt || "<none>"}`, res.status, peek, headers);
      }
    }
    const bytes = await res.arrayBuffer();
    return { bytes, contentType: rawCt, headers };
  }
  async stream(path, options = {}) {
    const url = this.buildUrl(path, options.query);
    const bodyText = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const send2 = (accessToken) => {
      const headers = this.buildHeaders(accessToken, bodyText !== undefined);
      headers.accept = "text/event-stream";
      const init = {
        method: options.method ?? "GET",
        headers
      };
      if (bodyText !== undefined)
        init.body = bodyText;
      if (options.signal)
        init.signal = options.signal;
      return this.options.fetch(url, init);
    };
    const res = await this.executeWithRetry(send2, options.method ?? "GET", options);
    if (!res.ok) {
      await this.throwHttpError("stream", path, res);
    }
    if (!res.body) {
      throw new UnifiedAIError("request_failed", `stream to ${path} returned no body`, res.status, undefined, headersToRecord(res.headers));
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("text/event-stream")) {
      const body = await readErrorBody(res);
      throw new UnifiedAIError("request_failed", `stream to ${path} expected text/event-stream, got ${ct || "<none>"}`, res.status, body, headersToRecord(res.headers));
    }
    return res.body;
  }
  async executeWithRetry(send2, method, options) {
    const cfg = resolveRetryConfig(options.retry ?? this.options.retry);
    const idempotent = isIdempotent(method, options.idempotent);
    const listeners = [];
    if (this.options.onRetry)
      listeners.push(this.options.onRetry);
    if (options.onRetry)
      listeners.push(options.onRetry);
    const startedAt = Date.now();
    let attempt = 0;
    let currentToken = await this.getInitialAccessToken();
    const runOnce = async () => {
      let res = await send2(currentToken);
      if (res.status === 401) {
        try {
          await drainResponse(res);
        } catch {}
        let freshToken;
        try {
          freshToken = await this.refreshAccessToken();
        } catch (err) {
          await this.onAuthFailure();
          if (err instanceof UnifiedError)
            throw err;
          throw new UnifiedAIAuthError("auth_refresh_failed", err instanceof Error ? err.message : "refresh failed", undefined, undefined, undefined, err);
        }
        currentToken = freshToken;
        res = await send2(freshToken);
        if (res.status === 401) {
          const body = await readErrorBody(res);
          await this.onAuthFailure();
          throw new UnifiedAIAuthError("auth_retry_still_unauthorized", `request still 401 after refresh: ${formatBody(body)}`, 401, body, headersToRecord(res.headers));
        }
      }
      return res;
    };
    while (true) {
      let res;
      let err;
      try {
        res = await runOnce();
      } catch (e) {
        err = e;
      }
      const usageLimited429 = !!cfg && res?.status === 429 && await this.is429UsageLimit(res);
      const retryable = cfg ? res ? res.status === 429 ? !usageLimited429 : isRetryableStatus(res.status) && idempotent : isNetworkErrorRetryable(err) && idempotent : false;
      if (!retryable || !cfg) {
        if (err !== undefined)
          throw err;
        return res;
      }
      if (attempt >= cfg.maxRetries) {
        if (err !== undefined)
          throw err;
        return res;
      }
      const reason = res ?? err;
      const wait = nextDelay(attempt, cfg, reason);
      const elapsed = Date.now() - startedAt;
      if (elapsed + wait > cfg.maxElapsedMs) {
        if (err !== undefined)
          throw err;
        return res;
      }
      const event = {
        attempt: attempt + 1,
        delayMs: wait,
        status: res?.status,
        reason
      };
      for (const l of listeners) {
        try {
          l(event);
        } catch {}
      }
      if (res)
        await drainResponse(res);
      await delay(wait, options.signal);
      if (options.signal?.aborted) {
        const reason2 = options.signal.reason;
        const abortError = typeof DOMException !== "undefined" ? new DOMException("Aborted", "AbortError") : Object.assign(new Error("Aborted"), { name: "AbortError" });
        if (reason2 !== undefined) {
          abortError.cause = reason2;
        }
        throw abortError;
      }
      attempt += 1;
    }
  }
  async is429UsageLimit(res) {
    try {
      return isUsageLimitBody(await readErrorBody(res.clone()));
    } catch {
      return false;
    }
  }
  async getInitialAccessToken() {
    if (this.options.token !== undefined)
      return this.resolveTrustedToken();
    throw oauthUnavailable("no token configured");
  }
  async refreshAccessToken() {
    if (this.options.token !== undefined) {
      if (this.trustedRefreshPromise)
        return this.trustedRefreshPromise;
      const p = this.resolveTrustedToken().finally(() => {
        if (this.trustedRefreshPromise === p)
          this.trustedRefreshPromise = undefined;
      });
      this.trustedRefreshPromise = p;
      p.then(() => this.session.markRefreshed(), () => {});
      return p;
    }
    throw oauthUnavailable("no refresh strategy available");
  }
  async onAuthFailure() {
    this.session.markExpired();
  }
  async resolveTrustedToken() {
    const t = this.options.token;
    if (t === undefined) {
      throw new UnifiedError("not_bootstrapped", "trusted token provider not set");
    }
    return typeof t === "function" ? await t() : t;
  }
  buildUrl(path, query) {
    const base = this.options.apiUrl;
    const full = base ? `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}` : path;
    if (!query)
      return full;
    const params = new URLSearchParams;
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined)
        params.set(k, String(v));
    }
    const qs = params.toString();
    if (!qs)
      return full;
    return `${full}${full.includes("?") ? "&" : "?"}${qs}`;
  }
  buildHeaders(accessToken, hasBody) {
    const h = {};
    if (accessToken)
      h.authorization = `Bearer ${accessToken}`;
    if (hasBody)
      h["content-type"] = "application/json";
    const appId = this.appId.trim();
    if (appId)
      h["x-unified-app"] = appId;
    if (this.callerKind === "agent")
      h["x-unified-caller"] = "agent";
    return h;
  }
}

// src/node/_internal/discovery.ts
import { join as join2 } from "node:path";

// src/node/_internal/discovery-file.ts
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
function defaultDiscoveryDir() {
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "UnifiedAI");
  }
  return join(homedir(), ".unifiedai");
}
async function readDiscoveryJson(path, isValid) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// src/node/_internal/discovery.ts
function defaultDiscoveryPath() {
  return join2(defaultDiscoveryDir(), "desktop.json");
}
function createDefaultDiscoveryReader(path = defaultDiscoveryPath()) {
  return {
    read() {
      return readDiscoveryJson(path, (parsed) => {
        const p = parsed;
        return typeof p?.port === "number" && typeof p?.pid === "number" && typeof p?.started_at === "number";
      });
    }
  };
}

// src/node/_internal/env.ts
var defaultEnvReader = {
  read() {
    const portStr = process.env.UNIFIEDAI_HANDOFF_PORT;
    const port = portStr ? Number.parseInt(portStr, 10) : Number.NaN;
    return {
      handoffPort: Number.isFinite(port) ? port : undefined,
      clientId: process.env.UNIFIEDAI_CLIENT_ID,
      handoffToken: process.env.UNIFIEDAI_HANDOFF_TOKEN,
      authorizeUrl: process.env.UNIFIEDAI_AUTHORIZE_URL,
      tokenUrl: process.env.UNIFIEDAI_TOKEN_URL,
      revokeUrl: process.env.UNIFIEDAI_REVOKE_URL
    };
  }
};

// src/node/_internal/fetch-timeout.ts
function coerceTimeoutMs(requested, fallbackMs) {
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : fallbackMs;
}
async function withTimeoutSignal(timeoutMs, fn, outerSignal) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onOuterAbort = () => controller.abort(outerSignal?.reason);
  if (outerSignal) {
    if (outerSignal.aborted)
      controller.abort(outerSignal.reason);
    else
      outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

// src/node/_internal/handoff.ts
var DEFAULT_HANDOFF_TIMEOUT_MS = 3000;
async function requestHandoff(args) {
  const { port, clientId, fetch: fetch2, signal, handoffToken } = args;
  const url = `http://127.0.0.1:${port}/handoff`;
  const headers = { "content-type": "application/json" };
  if (handoffToken) {
    headers["x-handoff-token"] = handoffToken;
  }
  return withTimeoutSignal(coerceTimeoutMs(args.timeoutMs, DEFAULT_HANDOFF_TIMEOUT_MS), async (deadlineSignal) => {
    let res;
    try {
      res = await fetch2(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ client_id: clientId }),
        signal: deadlineSignal
      });
    } catch {
      throw new UnifiedError("handoff_unreachable", `desktop handoff at ${url} unreachable`);
    }
    if (res.status === 404) {
      throw new UnifiedError("app_not_installed", `client_id ${clientId} not installed on desktop`, 404);
    }
    if (!res.ok) {
      throw new UnifiedError("handoff_unreachable", `desktop handoff returned ${res.status}`, res.status);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new UnifiedError("handoff_unreachable", "desktop handoff returned malformed payload");
    }
    if (!isTokenSet(body)) {
      throw new UnifiedError("handoff_unreachable", "desktop handoff returned malformed payload");
    }
    return body;
  }, signal);
}

// src/node/_internal/keychain.ts
var SERVICE2 = "com.unifiedai.sdk";
var loaded = null;
async function loadKeyring() {
  if (loaded)
    return loaded;
  try {
    loaded = await import("@napi-rs/keyring");
    return loaded;
  } catch {
    throw new UnifiedError("keychain_unavailable", "OS keychain module not available");
  }
}
function createDefaultKeychain() {
  return {
    async get(clientId) {
      const { Entry } = await loadKeyring();
      const entry = new Entry(SERVICE2, clientId);
      let raw;
      try {
        raw = entry.getPassword();
      } catch {
        return null;
      }
      if (!raw)
        return null;
      try {
        const parsed = JSON.parse(raw);
        return isTokenSet(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async set(clientId, tokens2) {
      const { Entry } = await loadKeyring();
      new Entry(SERVICE2, clientId).setPassword(JSON.stringify(tokens2));
    },
    async clear(clientId) {
      const { Entry } = await loadKeyring();
      try {
        new Entry(SERVICE2, clientId).deletePassword();
      } catch {}
    }
  };
}

// src/node/_internal/loopback.ts
import { createServer } from "node:http";
var DEFAULT_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
function createNodeLoopback(options = {}) {
  const requested = options.timeoutMs;
  const timeoutMs = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_SIGN_IN_TIMEOUT_MS;
  let server = null;
  let codePromise = null;
  let timer = null;
  let cancelPending = null;
  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    async start() {
      let resolveCode;
      let rejectCode;
      codePromise = new Promise((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
      });
      codePromise.catch(() => {});
      let settled = false;
      const settle = (fn) => {
        if (settled)
          return;
        settled = true;
        clearTimer();
        fn();
      };
      cancelPending = () => settle(() => {});
      let expectedState = null;
      server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const err = url.searchParams.get("error");
        if (err) {
          res.writeHead(200, { "content-type": "text/html" }).end("<h1>Sign-in cancelled</h1><p>You can close this window.</p>");
          settle(() => rejectCode(new UnifiedError("auth_user_cancelled", `oauth error: ${err}`)));
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          res.writeHead(400).end();
          settle(() => rejectCode(new UnifiedError("auth_token_exchange_failed", "callback missing code/state")));
          return;
        }
        if (expectedState !== null && state !== expectedState) {
          res.writeHead(400, { "content-type": "text/html" }).end("<h1>Invalid sign-in callback</h1><p>State mismatch; still waiting.</p>");
          return;
        }
        res.writeHead(200, { "content-type": "text/html" }).end("<h1>Signed in</h1><p>You can close this window.</p>");
        settle(() => resolveCode({ code, state }));
      });
      const s = server;
      await new Promise((resolve, reject) => {
        s.once("error", reject);
        s.listen(0, "127.0.0.1", () => resolve());
      });
      timer = setTimeout(() => {
        settle(() => rejectCode(new UnifiedError("auth_timeout", `browser sign-in timed out after ${timeoutMs}ms waiting for the OAuth redirect`)));
      }, timeoutMs);
      timer.unref?.();
      const addr = s.address();
      const port = addr.port;
      const pending = codePromise;
      return {
        redirectUri: `http://127.0.0.1:${port}/callback`,
        async waitForCode(expected) {
          expectedState = expected;
          const { code, state } = await pending;
          if (state !== expected) {
            throw new UnifiedError("auth_state_mismatch", "oauth state mismatch");
          }
          return code;
        }
      };
    },
    async stop() {
      cancelPending?.();
      cancelPending = null;
      clearTimer();
      if (server) {
        const s = server;
        server = null;
        await new Promise((resolve) => s.close(() => resolve()));
      }
    }
  };
}

// src/node/_internal/open-url.ts
import { spawn } from "node:child_process";
import { platform as platform2 } from "node:os";
function makeOpenUrl(spawnImpl, platformImpl) {
  return (url) => {
    const p = platformImpl();
    const cmd = p === "darwin" ? "open" : p === "win32" ? "rundll32" : "xdg-open";
    const args = p === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    return new Promise((resolve, reject) => {
      const child = spawnImpl(cmd, args, { detached: true, stdio: "ignore" });
      child.once("error", (cause) => {
        reject(new UnifiedError("browser_open_failed", `Failed to open browser via "${cmd}": ${cause.message}`));
      });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  };
}
var defaultOpenUrl = makeOpenUrl(spawn, platform2);

// src/node/_internal/refresh.ts
function refreshTokens(args) {
  return postTokenGrant({
    tokenUrl: args.tokenUrl,
    fetch: args.fetch,
    body: {
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: args.clientId
    },
    makeError: (msg, status2) => new UnifiedAIAuthError("auth_refresh_failed", msg, status2)
  });
}

// src/node/_internal/revoke.ts
var DEFAULT_REVOKE_TIMEOUT_MS = 5000;
async function revokeToken(args) {
  const body = {
    token: args.token,
    client_id: args.clientId
  };
  if (args.tokenTypeHint)
    body.token_type_hint = args.tokenTypeHint;
  try {
    await withTimeoutSignal(coerceTimeoutMs(args.timeoutMs, DEFAULT_REVOKE_TIMEOUT_MS), (signal) => args.fetch(args.revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    }));
  } catch {}
}
function deriveRevokeUrl(tokenUrl) {
  return tokenUrl.replace(/\/oauth\/token(\b|$)/, "/oauth/revoke$1");
}

// src/node/client.ts
var DEFAULT_AUTHORIZE_URL = "https://web.unifiedai.app/oauth/authorize";
var DEFAULT_TOKEN_URL = "https://api.unifiedai.app/oauth/token";
function abortedSignInError(cause) {
  return new UnifiedError("aborted", "sign-in aborted: signOut() was called while bootstrap was in flight", undefined, cause);
}
var DEFAULT_REFRESH_SKEW_SECONDS = 60;
var MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

class UnifiedAI2 extends UnifiedAI {
  authorizeUrl;
  tokenUrl;
  revokeUrl;
  env;
  discovery;
  keychain;
  openUrl;
  loopback;
  revokeTimeoutMs;
  refreshSkewSeconds;
  onAuthEvent;
  autoBootstrapArmed = true;
  bootstrapPromise;
  refreshPromise;
  proactiveTimer;
  tokens;
  lastClientId;
  sessionGeneration = 0;
  constructor(options = {}) {
    super(options);
    this.env = options.env ?? defaultEnvReader;
    const envSnapshot = this.env.read();
    this.authorizeUrl = options.authorizeUrl ?? envSnapshot.authorizeUrl ?? DEFAULT_AUTHORIZE_URL;
    this.tokenUrl = options.tokenUrl ?? envSnapshot.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.revokeUrl = options.revokeUrl ?? envSnapshot.revokeUrl ?? deriveRevokeUrl(this.tokenUrl);
    this.discovery = options.discovery ?? createDefaultDiscoveryReader();
    this.keychain = options.keychain ?? createDefaultKeychain();
    this.openUrl = options.openUrl ?? defaultOpenUrl;
    this.loopback = options.loopback ?? createNodeLoopback(options.signInTimeoutMs !== undefined ? { timeoutMs: options.signInTimeoutMs } : {});
    this.revokeTimeoutMs = options.revokeTimeoutMs;
    this.refreshSkewSeconds = options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS;
    this.onAuthEvent = options.onAuthEvent;
  }
  emitAuthEvent(event) {
    if (!this.onAuthEvent)
      return;
    try {
      this.onAuthEvent(event);
    } catch {}
  }
  get serverCapable() {
    return true;
  }
  bootstrap() {
    if (this.options.token !== undefined)
      return Promise.resolve();
    if (!this.bootstrapPromise) {
      const generationAtStart = this.sessionGeneration;
      const p = this.doBootstrap(generationAtStart).then(() => {
        if (this.sessionGeneration !== generationAtStart) {
          throw abortedSignInError();
        }
        this.autoBootstrapArmed = false;
        if (this.tokens) {
          this.session.markSignedIn({
            expiresAt: this.tokens.expires_at * 1000,
            identity: this.identityFromTokens(this.tokens)
          });
          this.scheduleProactiveRefresh();
        }
      }).catch((err) => {
        if (this.bootstrapPromise === p)
          this.bootstrapPromise = undefined;
        throw err;
      });
      this.bootstrapPromise = p;
    }
    return this.bootstrapPromise;
  }
  identity() {
    if (this.options.token !== undefined) {
      throw new UnifiedError("not_bootstrapped", "identity() is unavailable in trusted-token mode; the host owns the user session");
    }
    if (!this.tokens) {
      throw new UnifiedError("not_bootstrapped", "call bootstrap() before identity()");
    }
    return { user_id: this.tokens.user_id, client_id: this.tokens.client_id };
  }
  async signOut() {
    if (this.options.token !== undefined) {
      return super.signOut();
    }
    this.autoBootstrapArmed = false;
    this.emitAuthEvent({ type: "sign_out" });
    let clientId;
    try {
      clientId = this.resolveClientId();
    } catch {}
    let snapshot = this.tokens ?? null;
    if (!snapshot && clientId) {
      try {
        snapshot = await this.keychain.get(clientId) ?? null;
      } catch {
        snapshot = null;
      }
    }
    let clearFailed = false;
    let clearError;
    try {
      await this.clearLocalSession(clientId, { throwOnKeychain: true });
    } catch (err) {
      clearFailed = true;
      clearError = err;
    }
    this.session.markSignedOut();
    let revokeError;
    let revokeFailed = false;
    if (snapshot) {
      try {
        await revokeToken({
          revokeUrl: this.revokeUrl,
          clientId: snapshot.client_id,
          token: snapshot.refresh_token,
          tokenTypeHint: "refresh_token",
          fetch: this.options.fetch,
          ...this.revokeTimeoutMs !== undefined ? { timeoutMs: this.revokeTimeoutMs } : {}
        });
      } catch (err) {
        revokeFailed = true;
        revokeError = err;
      }
    }
    if (clearFailed && revokeFailed) {
      throw new AggregateError([clearError, revokeError], "signOut: keychain.clear and revoke both failed");
    }
    if (clearFailed)
      throw clearError;
    if (revokeFailed)
      throw revokeError;
  }
  async getInitialAccessToken() {
    if (this.options.token !== undefined)
      return super.getInitialAccessToken();
    if (!this.tokens && this.autoBootstrapArmed) {
      await this.bootstrap();
    }
    if (!this.tokens) {
      throw new UnifiedError("not_bootstrapped", "call bootstrap() before making requests");
    }
    return this.tokens.access_token;
  }
  async refreshAccessToken() {
    if (this.options.token !== undefined)
      return super.refreshAccessToken();
    const fresh = await this.ensureFreshToken();
    return fresh.access_token;
  }
  async onAuthFailure() {
    if (this.options.token !== undefined)
      return super.onAuthFailure();
    const clientId = this.tokens?.client_id ?? this.lastClientId;
    await this.clearLocalSession(clientId);
    this.session.markExpired();
  }
  ensureFreshToken() {
    if (this.refreshPromise)
      return this.refreshPromise;
    const current = this.tokens;
    if (!current) {
      return Promise.reject(new UnifiedAIAuthError("auth_refresh_failed", "no tokens available to refresh"));
    }
    const generationAtStart = this.sessionGeneration;
    this.emitAuthEvent({ type: "refresh_start" });
    const p = refreshTokens({
      tokenUrl: this.tokenUrl,
      clientId: current.client_id,
      refreshToken: current.refresh_token,
      fetch: this.options.fetch
    }).catch((err) => {
      this.emitAuthEvent({
        type: "refresh_failure",
        code: err instanceof UnifiedError ? err.code : undefined
      });
      this.session.emitError(err);
      throw err;
    }).then(async (next) => {
      this.emitAuthEvent({ type: "refresh_success" });
      if (this.sessionGeneration !== generationAtStart) {
        throw new UnifiedAIAuthError("auth_refresh_failed", "session was cleared while refresh was in flight");
      }
      await this.persist(next.client_id, next, generationAtStart);
      if (this.sessionGeneration === generationAtStart) {
        this.session.markRefreshed({
          expiresAt: next.expires_at * 1000,
          identity: this.identityFromTokens(next)
        });
        this.scheduleProactiveRefresh();
      }
      return next;
    }).finally(() => {
      if (this.refreshPromise === p)
        this.refreshPromise = undefined;
    });
    this.refreshPromise = p;
    return p;
  }
  async clearLocalSession(clientId, opts = {}) {
    this.sessionGeneration++;
    this.tokens = undefined;
    this.lastClientId = undefined;
    this.bootstrapPromise = undefined;
    this.refreshPromise = undefined;
    this.cancelProactiveRefresh();
    if (!clientId)
      return;
    try {
      await this.keychain.clear(clientId);
    } catch (err) {
      if (!opts.throwOnKeychain)
        return;
      if (err instanceof UnifiedError && err.code === "keychain_unavailable")
        return;
      throw err;
    }
  }
  async doBootstrap(generationAtStart) {
    const clientId = this.resolveClientId();
    let cached = null;
    let lookup;
    try {
      cached = await this.keychain.get(clientId);
      lookup = cached ? "hit" : "miss";
    } catch (err) {
      if (err instanceof UnifiedError && err.code === "keychain_unavailable") {
        lookup = "unavailable";
      } else {
        throw err;
      }
    }
    this.emitAuthEvent({ type: "keychain_lookup", result: lookup });
    if (cached) {
      if (this.sessionGeneration !== generationAtStart) {
        throw abortedSignInError();
      }
      this.tokens = cached;
      this.lastClientId = clientId;
      return;
    }
    const envSnapshot = this.env.read();
    const handoffToken = envSnapshot.handoffToken;
    if (envSnapshot.handoffPort !== undefined) {
      const tokens3 = await this.tryHandoff(envSnapshot.handoffPort, clientId, "env", handoffToken);
      if (tokens3) {
        await this.persistBootstrapTokens(clientId, tokens3, generationAtStart);
        return;
      }
    }
    const disc = await this.discovery.read();
    if (disc) {
      const tokens3 = await this.tryHandoff(disc.port, clientId, "discovery", handoffToken);
      if (tokens3) {
        await this.persistBootstrapTokens(clientId, tokens3, generationAtStart);
        return;
      }
    }
    this.emitAuthEvent({ type: "browser_pkce_start" });
    const tokens2 = await runBrowserPkce({
      clientId,
      authorizeUrl: this.authorizeUrl,
      tokenUrl: this.tokenUrl,
      fetch: this.options.fetch,
      openUrl: this.openUrl,
      loopback: this.loopback
    });
    await this.persistBootstrapTokens(clientId, tokens2, generationAtStart);
  }
  async persistBootstrapTokens(clientId, tokens2, generationAtStart) {
    try {
      await this.persist(clientId, tokens2, generationAtStart);
    } catch (err) {
      if (this.sessionGeneration !== generationAtStart) {
        this.tokens = undefined;
        this.lastClientId = undefined;
        await this.revokeAbandonedTokens(tokens2);
        throw abortedSignInError(err);
      }
      throw err;
    }
    if (this.sessionGeneration !== generationAtStart) {
      await this.revokeAbandonedTokens(tokens2);
      throw abortedSignInError();
    }
  }
  async revokeAbandonedTokens(tokens2) {
    try {
      await revokeToken({
        revokeUrl: this.revokeUrl,
        clientId: tokens2.client_id,
        token: tokens2.refresh_token,
        tokenTypeHint: "refresh_token",
        fetch: this.options.fetch,
        ...this.revokeTimeoutMs !== undefined ? { timeoutMs: this.revokeTimeoutMs } : {}
      });
    } catch {}
  }
  resolveClientId() {
    const configured = this.options.appId;
    if (configured)
      return configured;
    const fromEnv = this.env.read().clientId;
    if (fromEnv)
      return fromEnv;
    throw new UnifiedError("not_bootstrapped", "appId is required (set it in UnifiedAIOptions or via UNIFIEDAI_CLIENT_ID)");
  }
  async tryHandoff(port, clientId, source, handoffToken) {
    this.emitAuthEvent({ type: "handoff_attempt", source, port });
    try {
      const tokens2 = await requestHandoff({
        port,
        clientId,
        fetch: this.options.fetch,
        ...handoffToken !== undefined ? { handoffToken } : {}
      });
      this.emitAuthEvent({ type: "handoff_result", source, result: "success" });
      return tokens2;
    } catch (err) {
      if (err instanceof UnifiedError && err.code === "handoff_unreachable") {
        this.emitAuthEvent({ type: "handoff_result", source, result: "unreachable" });
        return null;
      }
      if (err instanceof UnifiedError && err.code === "app_not_installed") {
        this.emitAuthEvent({ type: "handoff_result", source, result: "not_installed" });
        if (source === "discovery")
          return null;
        throw err;
      }
      this.emitAuthEvent({ type: "handoff_result", source, result: "error" });
      throw err;
    }
  }
  async persist(clientId, tokens2, generationAtStart) {
    this.tokens = tokens2;
    this.lastClientId = clientId;
    let wroteKeychain = true;
    try {
      await this.keychain.set(clientId, tokens2);
    } catch (err) {
      if (err instanceof UnifiedError && err.code === "keychain_unavailable") {
        wroteKeychain = false;
      } else {
        throw err;
      }
    }
    if (this.sessionGeneration !== generationAtStart) {
      this.tokens = undefined;
      this.lastClientId = undefined;
      if (wroteKeychain) {
        try {
          await this.keychain.clear(clientId);
        } catch {}
      }
    }
  }
  identityFromTokens(tokens2) {
    return { user_id: tokens2.user_id, client_id: tokens2.client_id };
  }
  scheduleProactiveRefresh() {
    this.cancelProactiveRefresh();
    if (this.options.token !== undefined)
      return;
    if (this.refreshSkewSeconds <= 0)
      return;
    const tokens2 = this.tokens;
    if (!tokens2)
      return;
    const skewMs = this.refreshSkewSeconds * 1000;
    const fireAt = tokens2.expires_at * 1000 - skewMs;
    const delay2 = fireAt - Date.now();
    if (delay2 <= 0)
      return;
    const generationAtSchedule = this.sessionGeneration;
    const timer = setTimeout(() => {
      this.proactiveTimer = undefined;
      if (this.sessionGeneration !== generationAtSchedule)
        return;
      const current = this.tokens;
      if (!current)
        return;
      if (current.expires_at * 1000 - skewMs > Date.now()) {
        this.scheduleProactiveRefresh();
        return;
      }
      this.proactiveRefresh();
    }, Math.min(delay2, MAX_TIMER_DELAY_MS));
    timer.unref?.();
    this.proactiveTimer = timer;
  }
  cancelProactiveRefresh() {
    if (this.proactiveTimer !== undefined) {
      clearTimeout(this.proactiveTimer);
      this.proactiveTimer = undefined;
    }
  }
  async proactiveRefresh() {
    try {
      await this.ensureFreshToken();
    } catch {
      await this.onAuthFailure();
    }
  }
}
// src/node/_internal/ecosystem-discovery.ts
import { join as join3 } from "node:path";
function defaultEcosystemDiscoveryPath() {
  return join3(defaultDiscoveryDir(), "ecosystem.json");
}
function readRecord(path) {
  return readDiscoveryJson(path, (parsed) => {
    const p = parsed;
    return typeof p?.url === "string" && typeof p?.token === "string";
  });
}
async function enrollLocal(baseUrl, oauthToken, timeoutMs) {
  try {
    return await withTimeoutSignal(timeoutMs, async (signal) => {
      const res = await fetch(`${baseUrl}/enroll`, {
        method: "POST",
        headers: { authorization: `Bearer ${oauthToken}` },
        signal
      });
      if (!res.ok)
        return null;
      const body = await res.json();
      return typeof body.token === "string" ? body.token : null;
    });
  } catch {
    return null;
  }
}
async function discoverLocalEcosystem(opts = {}) {
  const envUrl = process.env.UNIFIEDAI_ECOSYSTEM_URL;
  const envToken = process.env.UNIFIEDAI_ECOSYSTEM_TOKEN;
  if (envUrl && envToken) {
    return { baseUrl: envUrl, token: envToken };
  }
  const record = await readRecord(opts.path ?? defaultEcosystemDiscoveryPath());
  if (!record)
    return null;
  try {
    return await withTimeoutSignal(opts.timeoutMs ?? 500, async (signal) => {
      const res = await fetch(`${record.url}/health`, { signal });
      if (!res.ok)
        return null;
      const body = await res.json();
      if (body?.service !== "ecosystem")
        return null;
      if (opts.oauthToken) {
        const scoped = await enrollLocal(record.url, opts.oauthToken, opts.timeoutMs ?? 500);
        if (scoped)
          return { baseUrl: record.url, token: scoped };
      }
      return { baseUrl: record.url, token: record.token };
    });
  } catch {
    return null;
  }
}
export {
  Actions,
  Agent,
  Artifacts,
  Audio,
  AuthenticationError,
  BRIDGE_PORTS,
  BadRequestError,
  CALENDARS_COLLECTION,
  CALENDAR_NS,
  CLAUDE_CODE_MODEL_PREFIX,
  CURSOR_MODEL_PREFIX,
  Calendar,
  Chat,
  ChatCompletions,
  CloudFsBackend,
  CloudStorageBackend,
  Core,
  Decisions,
  DeprecatedModelError,
  Embeddings,
  Files,
  ForbiddenError,
  Fs,
  Helpers,
  ITEMS_COLLECTION,
  Images,
  Memory,
  MemoryBackend,
  MemoryGrantStore,
  MessageStream,
  Messages,
  Models,
  NamespaceSharing,
  NotFoundError,
  OPEN_ARTIFACT_ACTION,
  OPEN_ARTIFACT_PARAMS_SCHEMA,
  OPEN_ARTIFACT_SPEC,
  PLAN_FREE_ID,
  PlanRequiredError,
  Projects,
  RateLimitError,
  References,
  Responses,
  ServerError,
  Session,
  Storage,
  StreamInterruptedError,
  Sync,
  UnifiedAI2 as UnifiedAI,
  UnifiedAIAuthError,
  UnifiedAIError,
  UnifiedError,
  UnifiedStream,
  Usage,
  UsageLimitError,
  Users,
  Videos,
  WorkspaceSync,
  _resetLocalAgentState,
  addDaysInZone,
  addExdateOp,
  addMonthsInZone,
  artifactRefFromHit,
  artifactRefFromLink,
  bearerSubprotocol,
  bridgeCursorModels,
  bridgeDetect,
  bridgeHealth,
  bridgeListDir,
  bridgeMcpResult,
  bridgeOrigin,
  bridgePickFolder,
  bridgeStartRun,
  bridgeStopRun,
  bridgeToken,
  buildHttpError,
  calendarToMetadata,
  checkDesktopAvailable,
  claudeCodeModelName,
  clearBridgeToken,
  clientDeviceId,
  clientDeviceName,
  closeAllRelayHosts,
  closeRelayHost,
  confident,
  configureLocalAgents,
  connectDesktop,
  connectRelayHost,
  costsMore,
  createCalendarOp,
  createItemOp,
  dayRange,
  decodeSnapshot,
  defaultConfig,
  defaultEcosystemDiscoveryPath,
  defaultPairName,
  defaultTiming,
  deleteCalendarOp,
  deleteItemOp,
  detectAgents,
  disconnectDesktop,
  discoverBridge,
  discoverLocalEcosystem,
  dispatchFrame,
  dispatchPrompt,
  encodeSnapshot2 as encodeSnapshot,
  expandOccurrences,
  extractServerMessage,
  fallbackDispatch,
  firstByHint,
  formatBody,
  formatTimeUntil,
  formatTokenCount,
  formatUsd,
  fsError,
  fsTools,
  gate,
  getLocalAgentStatus,
  getTimeZoneOffsetMs,
  hasBridgeToken,
  httpErrorCodeFromStatus,
  httpErrorMessage,
  invalidateBridgePort,
  invalidateCursorModels,
  isCloudPlan,
  isDesktopConnected,
  isEpochMismatch,
  isLocalAgentModel,
  isPlanRequiredBody,
  isResolvableArtifactRef,
  isSameDayInZone,
  itemToMetadata,
  laneForModel,
  listLocalAgentDevices,
  listLocalAgentDir,
  listLocalModels,
  listRelayHosts,
  localAgentsConfig,
  monthGrid,
  namespaceAccess,
  newId,
  normalizeDirListing,
  normalizeNs,
  normalizePrefix,
  normalizeRelPath,
  notGrantedError,
  onLocalAgentStatusChange,
  openRunEvents,
  pairBridge,
  parseCalendar,
  parseCalendarItem,
  parseDispatch,
  parsePlan,
  parseSSE,
  parseTestReport,
  pickWorker,
  pickWorkspaceFolder,
  placeholderLocalModel,
  planPrompt,
  planRequiredError,
  profileById,
  refreshLocalAgentDevices,
  refreshLocalAgents,
  refreshRelayHosts,
  relayWsUrl,
  resolveLocalAgentSource,
  resolveSourceFor,
  roleFor,
  runBrowserPkce,
  runLocalAgent,
  sequenceById,
  setLocalAgentSource,
  setOverrideOp,
  signInWithBrowser,
  startOfDayInZone,
  startOfMonthInZone,
  startOfWeekInZone,
  stepPrompt,
  storageAbortError,
  storageError,
  storageTools,
  summarizeUsage,
  syncError,
  syncTools,
  testPrompt,
  toChatAudioPart,
  toChatFilePart,
  toChatImagePart,
  toChatVideoPart,
  toMessagesDocumentPart,
  toMessagesImagePart,
  toOpenArtifactParams,
  toResponsesAudioPart,
  toResponsesFilePart,
  toResponsesImagePart,
  toResponsesVideoPart,
  updateCalendarOp,
  updateItemOp,
  utcToZonedFields,
  webTools,
  weekRange,
  zonedFieldsToUtc
};

//# debugId=575A0218F9A7020464756E2164756E21
//# sourceMappingURL=index.js.map
