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
function stableStringify(value) {
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
  const canonical = `${method.toUpperCase()}|${path}|${stableStringify(query ?? null)}|${stableStringify(body ?? null)}`;
  return `${fnv1a(canonical)}|${canonical.length}`;
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
    const status = res.status;
    const body = await readErrorBody(res);
    throw buildHttpError(httpErrorMessage(op, path, status, body), status, body, headersToRecord(res.headers));
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
    const send = (accessToken) => {
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
    const res = await this.executeWithRetry(send, method, options);
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
    const send = (accessToken) => {
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
    const res = await this.executeWithRetry(send, options.method ?? "GET", options);
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
    const send = (accessToken) => {
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
    const res = await this.executeWithRetry(send, options.method ?? "GET", options);
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
  async executeWithRetry(send, method, options) {
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
      let res = await send(currentToken);
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
        res = await send(freshToken);
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
function stableStringify2(value) {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(stableStringify2).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify2(value[k])}`).join(",")}}`;
}
function inflightKey(name, args) {
  return `${name} ${stableStringify2(args)}`;
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
// src/resources/logos.generated.ts
var LOGO_DATA_URIS = {
  amazon: "data:image/svg+xml;utf8,%3C%3Fxml%20version%3D%221.0%22%20encoding%3D%22utf-8%22%3F%3E%3Csvg%20version%3D%221.1%22%20id%3D%22Layer_1%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20x%3D%220px%22%20y%3D%220px%22%20viewBox%3D%220%200%20122.879%20111.709%22%20enable-background%3D%22new%200%200%20122.879%20111.709%22%20xml%3Aspace%3D%22preserve%22%3E%3Cg%3E%3Cpath%20d%3D%22M33.848%2C54.85c0-5.139%2C1.266-9.533%2C3.798-13.182c2.532-3.649%2C5.995-6.404%2C10.389-8.266%20c4.021-1.713%2C8.974-2.941%2C14.858-3.687c2.01-0.223%2C5.287-0.521%2C9.83-0.894v-1.899c0-4.766-0.521-7.968-1.564-9.607%20c-1.564-2.235-4.021-3.351-7.373-3.351h-0.893c-2.458%2C0.223-4.581%2C1.005-6.368%2C2.345c-1.787%2C1.341-2.942%2C3.202-3.463%2C5.586%20c-0.298%2C1.489-1.042%2C2.345-2.234%2C2.569l-12.847-1.564c-1.266-0.298-1.899-0.968-1.899-2.011c0-0.223%2C0.037-0.484%2C0.111-0.781%20c1.266-6.628%2C4.375-11.543%2C9.328-14.746C50.473%2C2.161%2C56.264%2C0.373%2C62.893%2C0h2.793c8.488%2C0%2C15.117%2C2.197%2C19.885%2C6.591%20c0.746%2C0.748%2C1.438%2C1.55%2C2.066%2C2.401c0.631%2C0.856%2C1.135%2C1.62%2C1.506%2C2.29c0.373%2C0.67%2C0.709%2C1.639%2C1.006%2C2.904%20c0.299%2C1.267%2C0.521%2C2.142%2C0.672%2C2.625c0.148%2C0.484%2C0.26%2C1.527%2C0.334%2C3.129c0.074%2C1.601%2C0.111%2C2.55%2C0.111%2C2.848v27.034%20c0%2C1.936%2C0.279%2C3.705%2C0.838%2C5.306c0.559%2C1.602%2C1.1%2C2.756%2C1.619%2C3.463c0.521%2C0.707%2C1.379%2C1.844%2C2.57%2C3.406%20c0.447%2C0.672%2C0.67%2C1.268%2C0.67%2C1.789c0%2C0.596-0.297%2C1.115-0.895%2C1.563c-6.18%2C5.363-9.531%2C8.268-10.053%2C8.715%20c-0.893%2C0.67-1.973%2C0.744-3.24%2C0.223c-1.041-0.895-1.953-1.75-2.736-2.57c-0.781-0.818-1.34-1.414-1.676-1.787%20c-0.334-0.371-0.875-1.098-1.619-2.178s-1.268-1.807-1.564-2.178c-4.17%2C4.543-8.266%2C7.373-12.287%2C8.49%20c-2.533%2C0.744-5.661%2C1.117-9.384%2C1.117c-5.735%2C0-10.445-1.77-14.131-5.307C35.691%2C66.336%2C33.848%2C61.328%2C33.848%2C54.85L33.848%2C54.85z%20M53.062%2C52.615c0%2C2.905%2C0.727%2C5.232%2C2.178%2C6.982c1.453%2C1.75%2C3.407%2C2.625%2C5.865%2C2.625c0.224%2C0%2C0.54-0.037%2C0.95-0.111%20c0.408-0.076%2C0.688-0.113%2C0.838-0.113c3.127-0.818%2C5.547-2.828%2C7.26-6.031c0.82-1.415%2C1.434-2.96%2C1.844-4.636%20c0.41-1.675%2C0.633-3.035%2C0.67-4.078c0.037-1.042%2C0.057-2.755%2C0.057-5.138v-2.793c-4.32%2C0-7.596%2C0.298-9.83%2C0.894%20C56.338%2C42.077%2C53.062%2C46.21%2C53.062%2C52.615L53.062%2C52.615z%22%2F%3E%3Cpath%20fill%3D%22%23FF9900%22%20d%3D%22M99.979%2C88.586c0.15-0.299%2C0.373-0.596%2C0.672-0.895c1.861-1.266%2C3.648-2.121%2C5.361-2.568%20c2.83-0.744%2C5.586-1.154%2C8.266-1.229c0.746-0.076%2C1.453-0.037%2C2.123%2C0.111c3.352%2C0.297%2C5.361%2C0.857%2C6.033%2C1.676%20c0.297%2C0.447%2C0.445%2C1.117%2C0.445%2C2.01v0.783c0%2C2.605-0.707%2C5.678-2.121%2C9.215c-1.416%2C3.537-3.389%2C6.387-5.922%2C8.547%20c-0.371%2C0.297-0.707%2C0.445-1.004%2C0.445c-0.15%2C0-0.299-0.037-0.447-0.111c-0.447-0.223-0.559-0.633-0.336-1.229%20c2.756-6.479%2C4.133-10.984%2C4.133-13.518c0-0.818-0.148-1.414-0.445-1.787c-0.746-0.893-2.83-1.34-6.256-1.34%20c-1.268%2C0-2.756%2C0.074-4.469%2C0.223c-1.861%2C0.225-3.574%2C0.447-5.139%2C0.672c-0.447%2C0-0.744-0.076-0.895-0.225%20c-0.148-0.148-0.186-0.297-0.111-0.447C99.867%2C88.846%2C99.904%2C88.734%2C99.979%2C88.586L99.979%2C88.586z%20M0.223%2C86.688%20c0.373-0.596%2C0.968-0.633%2C1.788-0.113c18.618%2C10.799%2C38.875%2C16.199%2C60.769%2C16.199c14.598%2C0%2C29.008-2.719%2C43.232-8.156%20c0.371-0.148%2C0.912-0.371%2C1.619-0.67c0.709-0.297%2C1.211-0.521%2C1.508-0.67c1.117-0.447%2C1.992-0.223%2C2.625%2C0.67%20c0.635%2C0.895%2C0.43%2C1.713-0.613%2C2.457c-1.342%2C0.969-3.055%2C2.086-5.139%2C3.352c-6.404%2C3.799-13.555%2C6.74-21.449%2C8.826%20c-7.893%2C2.086-15.602%2C3.127-23.123%2C3.127c-11.618%2C0-22.603-2.029-32.954-6.088C18.134%2C101.563%2C8.862%2C95.846%2C0.67%2C88.475%20C0.223%2C88.102%2C0%2C87.729%2C0%2C87.357C0%2C87.133%2C0.074%2C86.91%2C0.223%2C86.688L0.223%2C86.688z%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E",
  anthropic: "data:image/svg+xml;utf8,%3Csvg%20version%3D%221.1%22%20id%3D%22Layer_1%22%20xmlns%3Ax%3D%22ns_extend%3B%22%20xmlns%3Ai%3D%22ns_ai%3B%22%20xmlns%3Agraph%3D%22ns_graphs%3B%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20x%3D%220px%22%20y%3D%220px%22%20viewBox%3D%220%200%2092.2%2065%22%20style%3D%22enable-background%3Anew%200%200%2092.2%2065%3B%22%20xml%3Aspace%3D%22preserve%22%3E%0A%20%3Cstyle%20type%3D%22text%2Fcss%22%3E%0A%20%20.st0%7Bfill%3A%23181818%3B%7D%0A%20%3C%2Fstyle%3E%0A%20%3Cmetadata%3E%0A%20%20%3Csfw%20xmlns%3D%22ns_sfw%3B%22%3E%0A%20%20%20%3Cslices%3E%0A%20%20%20%3C%2Fslices%3E%0A%20%20%20%3CsliceSourceBounds%20bottomLeftOrigin%3D%22true%22%20height%3D%2265%22%20width%3D%2292.2%22%20x%3D%22-43.7%22%20y%3D%22-98%22%3E%0A%20%20%20%3C%2FsliceSourceBounds%3E%0A%20%20%3C%2Fsfw%3E%0A%20%3C%2Fmetadata%3E%0A%20%3Cpath%20class%3D%22st0%22%20d%3D%22M66.5%2C0H52.4l25.7%2C65h14.1L66.5%2C0z%20M25.7%2C0L0%2C65h14.4l5.3-13.6h26.9L51.8%2C65h14.4L40.5%2C0C40.5%2C0%2C25.7%2C0%2C25.7%2C0z%0A%09%20M24.3%2C39.3l8.8-22.8l8.8%2C22.8H24.3z%22%3E%0A%20%3C%2Fpath%3E%0A%3C%2Fsvg%3E",
  "anthropic-dark": "data:image/svg+xml;utf8,%3Csvg%20version%3D%221.1%22%20id%3D%22Layer_1%22%20xmlns%3Ax%3D%22ns_extend%3B%22%20xmlns%3Ai%3D%22ns_ai%3B%22%20xmlns%3Agraph%3D%22ns_graphs%3B%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20x%3D%220px%22%20y%3D%220px%22%20viewBox%3D%220%200%2092.2%2065%22%20style%3D%22enable-background%3Anew%200%200%2092.2%2065%3B%22%20xml%3Aspace%3D%22preserve%22%3E%0A%20%3Cstyle%20type%3D%22text%2Fcss%22%3E%0A%20%20.st0%7Bfill%3A%23ffffff%3B%7D%0A%20%3C%2Fstyle%3E%0A%20%3Cmetadata%3E%0A%20%20%3Csfw%20xmlns%3D%22ns_sfw%3B%22%3E%0A%20%20%20%3Cslices%3E%0A%20%20%20%3C%2Fslices%3E%0A%20%20%20%3CsliceSourceBounds%20bottomLeftOrigin%3D%22true%22%20height%3D%2265%22%20width%3D%2292.2%22%20x%3D%22-43.7%22%20y%3D%22-98%22%3E%0A%20%20%20%3C%2FsliceSourceBounds%3E%0A%20%20%3C%2Fsfw%3E%0A%20%3C%2Fmetadata%3E%0A%20%3Cpath%20class%3D%22st0%22%20d%3D%22M66.5%2C0H52.4l25.7%2C65h14.1L66.5%2C0z%20M25.7%2C0L0%2C65h14.4l5.3-13.6h26.9L51.8%2C65h14.4L40.5%2C0C40.5%2C0%2C25.7%2C0%2C25.7%2C0z%0A%09%20M24.3%2C39.3l8.8-22.8l8.8%2C22.8H24.3z%22%3E%0A%20%3C%2Fpath%3E%0A%3C%2Fsvg%3E",
  bytedance: "data:image/svg+xml;utf8,%3Csvg%20fill%3D%22%233C8CFF%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EByteDance%3C%2Ftitle%3E%3Cpath%20d%3D%22M19.8772%201.4685L24%202.5326v18.9426l-4.1228%201.0563V1.4685zm-13.3481%209.428l4.115%201.0641v8.9786l-4.115%201.0642v-11.107zM0%202.572l4.115%201.0642v16.7354L0%2021.428V2.572zm17.4553%205.6205v11.107l-4.1228-1.0642V9.2568l4.1228-1.0642z%22%2F%3E%3C%2Fsvg%3E",
  claude: "data:image/svg+xml;utf8,%3Csvg%20height%3D%221em%22%20style%3D%22flex%3Anone%3Bline-height%3A1%22%20viewBox%3D%220%200%2024%2024%22%20width%3D%221em%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EClaude%3C%2Ftitle%3E%3Cpath%20d%3D%22M4.709%2015.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0%2011.784l.055-.352.48-.321.686.06%201.52.103%202.278.158%201.652.097%202.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686%201.908%201.476%202.491%201.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97%202.97%200%2001-.104-.729L6.283.134%206.696%200l.996.134.42.364.62%201.414%201.002%202.229%201.555%203.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286%201.851-.559%202.903-.364%201.942h.212l.243-.242.985-1.306%201.652-2.064.73-.82.85-.904.547-.431h1.033l.76%201.129-.34%201.166-1.064%201.347-.881%201.142-1.264%201.7-.79%201.36.073.11.188-.02%202.856-.606%201.543-.28%201.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061%201.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093%201.068%202.006%201.81%202.509%202.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649%202.345%203.521.122%201.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674%207.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434%201.967-2.18%202.945-1.726%201.845-.414.164-.717-.37.067-.662.401-.589%202.388-3.036%201.44-1.882.93-1.086-.006-.158h-.055L4.132%2018.56l-1.13.146-.487-.456.061-.746.231-.243%201.908-1.312-.006.006z%22%20fill%3D%22%23D97757%22%20fill-rule%3D%22nonzero%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E",
  codex: "data:image/svg+xml;utf8,%3Csvg%20version%3D%221.2%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20250%20250%22%20width%3D%22250%22%20height%3D%22250%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22P%22%20gradientUnits%3D%22userSpaceOnUse%22%2F%3E%3ClinearGradient%20id%3D%22g1%22%20x2%3D%221%22%20href%3D%22%23P%22%20gradientTransform%3D%22matrix(0%2C249.335%2C-249.128%2C0%2C125%2C.332)%22%3E%3Cstop%20stop-color%3D%22%23b1a7ff%22%2F%3E%3Cstop%20offset%3D%22.5%22%20stop-color%3D%22%237a9dff%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%233941ff%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Cstyle%3E.a%7Bfill%3Aurl(%23g1)%7D%3C%2Fstyle%3E%3Cpath%20class%3D%22a%22%20d%3D%22m84.3%205.1q3.7-1.5%207.7-2.6%203.9-1%207.9-1.6%204-0.5%208.1-0.6%204%200%208%200.5%2020.7%202.4%2037.1%2017.7%200.1%200.1%200.4%200.3%200.1%200%200.2%200%200%200%200.2%200%200%200%200.1%200%200%200%200.1%200%205.2-1.4%2010.7-1.9%205.4-0.4%2010.7%200.1%205.5%200.4%2010.7%201.9%205.2%201.3%2010.1%203.6l0.6%200.4%201.6%200.8q5.2%202.5%209.7%206.1%204.7%203.4%208.6%207.7%203.8%204.3%206.9%209.2%203%204.8%205.2%2010.2%204.3%2010.5%204.3%2022.1%200.2%202.1%200%204.2-0.1%202.2-0.2%204.3-0.3%202.1-0.7%204.3-0.4%202.1-0.9%204.1%200%200.2%200%200.4%200%200.2%200%200.5%200%200.1%200.1%200.4%200.1%200.1%200.3%200.3%2012.3%2012.6%2016.3%2030%206%2029.7-12.2%2053.5l-1.9%202.2q-3%203.5-6.5%206.4-3.4%203.1-7.3%205.5-3.8%202.4-8.1%204.2-4.1%201.9-8.5%203.2-0.3%200-0.4%200.2-0.3%200-0.4%200.1-0.1%200.1-0.3%200.4%200%200.1-0.1%200.3c-2.7%207.7-5.3%2014.2-10.2%2020.7-12.5%2016.5-30.8%2025.5-51.5%2025.5q-24.6-0.1-43.6-18.1-0.2-0.1-0.4-0.2-0.2-0.1-0.4-0.1-0.2%200-0.3%200-0.3%200-0.4%200c-5.4%201.7-10.9%201.9-16.7%201.9q-3.5%200-7-0.5-3.4-0.4-6.9-1.2-3.3-0.8-6.6-2-3.3-1.2-6.4-2.8-3.3-1.6-6.4-3.6-3-2-5.8-4.3-3-2.3-5.5-5-2.5-2.6-4.6-5.6c-2.2-2.7-4.3-5.4-5.8-8.5q-0.8-1.6-1.6-3.2-0.6-1.7-1.3-3.3-0.7-1.7-1.2-3.4-0.5-1.6-1-3.4-1.1-4-1.6-7.9-0.6-4-0.6-8%200-4%200.6-8%200.4-4%201.4-8%200%200%200-0.1%200-0.1%200-0.1%200.2-0.2%200.2-0.3%200-0.1-0.2-0.1%200-0.2%200-0.3%200-0.1-0.1-0.1%200-0.2%200-0.2-0.1-0.1-0.1-0.1-2.4-2.5-4.6-5.2-2.1-2.7-4-5.4-1.7-3-3.2-6-1.5-3.1-2.6-6.3-0.8-2-1.3-4.1-0.7-2-1.1-4-0.4-2.1-0.7-4.2-0.2-2.2-0.4-4.3-0.2-2.8-0.1-5.6%200-2.8%200.3-5.4%200.1-2.8%200.6-5.6%200.4-2.8%201.1-5.5%207-23.1%2026.9-36.3%204.3-2.9%208.2-4.5%204.5-1.9%209-3.2%200.2%200%200.3-0.1%200.1-0.2%200.3-0.3%200.1%200%200.1-0.3%200.1-0.1%200.1-0.2%201-3.1%202.2-6%201-2.9%202.5-5.7%201.5-3%203.2-5.6%201.7-2.7%203.7-5.1%202.5-3.2%205.3-5.9%203-2.8%206.1-5.4%203.2-2.4%206.8-4.4%203.5-2%207.2-3.5zm48.3%20146.4c-2.3%200.1-4.4%201-6%202.8-1.5%201.6-2.4%203.7-2.4%205.9%200%202.3%200.9%204.4%202.4%206.2%201.6%201.6%203.7%202.5%206%202.6h50.4c2.4%200.1%204.8-0.6%206.5-2.4%201.7-1.6%202.8-4%202.8-6.4%200-2.4-1.1-4.7-2.8-6.3-1.7-1.8-4.1-2.6-6.5-2.4zm-56.7-64.9c-1.2-1.9-3-3.4-5.3-3.9-2.2-0.5-4.5-0.3-6.5%200.9-2%201.1-3.5%203-4.1%205.2-0.7%202.2-0.4%204.6%200.6%206.5l17.7%2030.9-17.5%2029.5c-1.2%202-1.6%204.5-1.1%206.8%200.7%202.3%202.1%204.1%204.1%205.3%202%201.2%204.4%201.6%206.7%200.9%202.2-0.5%204.2-1.9%205.4-3.9l20.1-34.1q0.7-0.9%200.9-2.1%200.3-1.1%200.3-2.3%200-1.2-0.3-2.2-0.2-1.2-0.8-2.2z%22%2F%3E%3C%2Fsvg%3E",
  cohere: "data:image/svg+xml;utf8,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%3Cpath%20d%3D%22M9.14882%2013.5552C9.58082%2013.5552%2010.4448%2013.5336%2011.6544%2013.0368C13.0584%2012.4536%2015.8232%2011.4168%2017.832%2010.3368C19.236%209.5808%2019.8408%208.5872%2019.8408%207.248C19.8408%205.412%2018.3504%203.9%2016.4928%203.9H8.71682C6.06002%203.9%203.90002%206.06%203.90002%208.7168C3.90002%2011.3736%205.93042%2013.5552%209.14882%2013.5552Z%22%20fill%3D%22currentColor%22%2F%3E%0A%3Cpath%20d%3D%22M10.4664%2016.86C10.4664%2015.564%2011.244%2014.376%2012.4536%2013.8792L14.8944%2012.864C17.3784%2011.8488%2020.1%2013.6632%2020.1%2016.3416C20.1%2018.4152%2018.4152%2020.1%2016.3416%2020.1H13.6848C11.9136%2020.1%2010.4664%2018.6528%2010.4664%2016.86Z%22%20fill%3D%22currentColor%22%2F%3E%0A%3Cpath%20d%3D%22M6.68642%2014.1816C5.15282%2014.1816%203.90002%2015.4344%203.90002%2016.968V17.3352C3.90002%2018.8472%205.15282%2020.1%206.68642%2020.1C8.22003%2020.1%209.47283%2018.8472%209.47283%2017.3136V16.9464C9.45123%2015.4344%208.22003%2014.1816%206.68642%2014.1816Z%22%20fill%3D%22currentColor%22%2F%3E%0A%3C%2Fsvg%3E",
  cursor: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20%20viewBox%3D%220%200%2048%2048%22%20width%3D%22480px%22%20height%3D%22480px%22%20fill-rule%3D%22evenodd%22%20clip-rule%3D%22evenodd%22%20baseProfile%3D%22basic%22%3E%3Cpolygon%20fill%3D%22%23bcbcbc%22%20points%3D%2223.974%2C4%206.97%2C14%206.97%2C34%2023.998%2C44%2040.97%2C34%2040.97%2C14%22%2F%3E%3Cline%20x1%3D%227.97%22%20x2%3D%2223.579%22%20y1%3D%2233%22%20y2%3D%2224.454%22%20fill%3D%22none%22%20stroke%3D%22%23bcbcbc%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-miterlimit%3D%2210%22%20stroke-width%3D%222%22%2F%3E%3Cline%20x1%3D%2223.972%22%20x2%3D%2223.966%22%20y1%3D%225.903%22%20y2%3D%2215.864%22%20fill%3D%22none%22%20stroke%3D%22%23bcbcbc%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-miterlimit%3D%2210%22%20stroke-width%3D%222%22%2F%3E%3Cline%20x1%3D%2239.97%22%20x2%3D%2232.97%22%20y1%3D%2233%22%20y2%3D%2229%22%20fill%3D%22none%22%20stroke%3D%22%23bcbcbc%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-miterlimit%3D%2210%22%20stroke-width%3D%222%22%2F%3E%3Cpolygon%20fill%3D%22%23757575%22%20points%3D%2223.974%2C4%206.97%2C14%206.97%2C34%2023.97%2C24%22%2F%3E%3Cpolygon%20fill%3D%22%23424242%22%20points%3D%2223.981%2C14%2040.97%2C14%2040.97%2C34%2023.971%2C24%22%2F%3E%3Cpolygon%20fill%3D%22%23616161%22%20fill-rule%3D%22evenodd%22%20points%3D%2240.97%2C14%2023.966%2C17%2023.974%2C4%22%20clip-rule%3D%22evenodd%22%2F%3E%3Cpolygon%20fill%3D%22%23616161%22%20fill-rule%3D%22evenodd%22%20points%3D%226.97%2C14%2023.981%2C16.881%2023.966%2C24%206.97%2C34%22%20clip-rule%3D%22evenodd%22%2F%3E%3Cpolygon%20fill%3D%22%23ededed%22%20points%3D%226.97%2C14%2023.97%2C24%2023.998%2C44%2040.97%2C14%22%2F%3E%3C%2Fsvg%3E",
  deepseekai: "data:image/svg+xml;utf8,%3Csvg%20height%3D%221em%22%20style%3D%22flex%3Anone%3Bline-height%3A1%22%20viewBox%3D%220%200%2024%2024%22%20width%3D%221em%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EDeepSeek%3C%2Ftitle%3E%3Cpath%20d%3D%22M23.748%204.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434%201.202-.422%201.84.027%201.436.633%202.58%201.838%203.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526%205.526%200%2001-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365%2011.365%200%2000-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055%203.055%200%2001-.465.137%209.597%209.597%200%2000-2.883-.102c-1.885.21-3.39%201.102-4.497%202.623C.082%208.606-.231%2010.684.152%2012.85c.403%202.284%201.569%204.175%203.36%205.653%201.858%201.533%203.997%202.284%206.438%202.14%201.482-.085%203.133-.284%204.994-1.86.47.234.962.327%201.78.397.63.059%201.236-.03%201.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926%201.096-1.296%202.746-2.642%203.392-7.003.05-.347.007-.565%200-.845-.004-.17.035-.237.23-.256a4.173%204.173%200%20001.545-.475c1.396-.763%201.96-2.015%202.093-3.517.02-.23-.004-.467-.247-.588zM11.581%2018c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696%204.696%200%20011.529-.039c2.132.312%203.946%201.265%205.468%202.774.868.86%201.525%201.887%202.202%202.891.72%201.066%201.494%202.082%202.48%202.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306%200%2001.415-.287.302.302%200%2001.2.288.306.306%200%2001-.31.307.303.303%200%2001-.304-.308zm3.11%201.596c-.2.081-.399.151-.59.16a1.245%201.245%200%2001-.798-.254c-.274-.23-.47-.358-.552-.758a1.73%201.73%200%2001.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559%200%2001-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136%201.146.016.352.144.618.408%201.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z%22%20fill%3D%22%234D6BFE%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E",
  fishaudio: "data:image/svg+xml;utf8,%3Csvg%20fill%3D%22%239B90E8%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EFish%20Audio%3C%2Ftitle%3E%3Cpath%20d%3D%22M23.12%2012.13v.62c0%20.24.19.44.44.44.24%200%20.44-.2.44-.44v-.62c0-.24-.2-.44-.44-.44-.25%200-.44.2-.44.44m-1.77.37v1.74c0%20.24.2.44.44.44.25%200%20.44-.2.44-.44V12.5c0-.24-.19-.44-.44-.44-.24%200-.44.2-.44.44m-1.76.43v1.99q0%20.09.03.17.04.08.1.14.07.07.15.1t.17.03c.24%200%20.44-.19.44-.44v-1.99c0-.25-.2-.44-.44-.44q-.09%200-.17.03t-.15.1q-.06.06-.1.14-.03.08-.03.17m-1.76.35v1.97c0%20.24.19.44.44.44.24%200%20.44-.2.44-.44v-1.97c0-.24-.2-.44-.44-.44-.25%200-.44.2-.44.44m-1.77.32v1.65c0%20.25.2.45.44.45s.44-.2.44-.45V13.6c0-.25-.2-.45-.44-.45s-.44.2-.44.45m-1.76%201.26v.3q.01.17.14.3.13.11.3.12.18-.01.31-.12.13-.13.14-.3v-.3q-.01-.17-.14-.3-.13-.11-.31-.12-.17.01-.3.12-.13.13-.14.3M0%209.38v.19c0%20.24.2.44.44.44.25%200%20.44-.2.44-.44v-.19c0-.25-.19-.44-.44-.44-.24%200-.44.19-.44.44m1.82.15v.81c0%20.24.19.44.44.44.24%200%20.44-.2.44-.44v-.81q0-.18-.13-.31t-.31-.13-.31.13-.13.31m1.81-.24v3.39q.01.17.14.3.13.11.3.12.18-.01.31-.12.13-.13.14-.3V9.29q-.01-.17-.14-.3-.13-.11-.31-.12-.17.01-.3.12-.13.13-.14.3m1.83-.35v.22c0%20.24.19.44.44.44.24%200%20.44-.2.44-.44v-.22q0-.18-.13-.31T5.9%208.5t-.31.13-.13.31m0%202.94v2.34c0%20.25.19.44.44.44.24%200%20.44-.19.44-.44v-2.34c0-.24-.2-.44-.44-.44-.25%200-.44.2-.44.44m15.89-3.32V11c0%20.25.2.44.44.44.25%200%20.44-.19.44-.44V8.56c0-.24-.19-.44-.44-.44-.24%200-.44.2-.44.44m-1.76-.39v3.28q.01.17.14.3.13.11.3.12.18-.01.31-.12.13-.13.14-.3V8.17c0-.25-.2-.44-.44-.44q-.09%200-.17.03t-.15.1q-.06.06-.1.14-.03.08-.03.17M17.83%208v3.9c0%20.24.19.44.44.44.24%200%20.44-.2.44-.44V8c0-.25-.2-.44-.44-.44-.25%200-.44.19-.44.44m-1.77.11v3.96c0%20.25.2.44.44.44s.44-.19.44-.44V8.11c0-.25-.2-.44-.44-.44s-.44.19-.44.44m-1.76.27v5.03q.01.17.14.3.13.11.3.12.18-.01.31-.12.13-.13.14-.3V8.38c0-.25-.2-.44-.45-.44-.24%200-.44.19-.44.44m-1.8.46v5.75q.01.17.14.3.13.11.3.12.18-.01.31-.12.13-.13.14-.3V8.84c0-.25-.2-.44-.45-.44-.24%200-.44.19-.44.44m-1.76.76v5.52c0%20.24.2.44.44.44.25%200%20.44-.2.44-.44V9.6c0-.24-.19-.44-.44-.44-.24%200-.44.2-.44.44m-1.77%201.01v4.77q.01.17.14.3.13.11.3.12.18-.01.31-.12.13-.13.14-.3v-4.77q-.01-.17-.14-.3-.13-.11-.31-.12-.17.01-.3.12-.13.13-.14.3M23.12%209.6v1.22c0%20.24.19.44.44.44.24%200%20.44-.2.44-.44V9.6c0-.24-.2-.44-.44-.44-.25%200-.44.2-.44.44M7.21%2011.32V16c0%20.24.19.44.44.44.24%200%20.44-.2.44-.44v-4.68q0-.18-.13-.31t-.31-.13-.31.13-.13.31%22%2F%3E%3C%2Fsvg%3E",
  gemini: "data:image/svg+xml;utf8,%3Csvg%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2065%2065%22%3E%3Cmask%20id%3D%22maskme%22%20style%3D%22mask-type%3Aalpha%22%20maskUnits%3D%22userSpaceOnUse%22%20x%3D%220%22%20y%3D%220%22%20width%3D%2265%22%20height%3D%2265%22%3E%3Cpath%20d%3D%22M32.447%200c.68%200%201.273.465%201.439%201.125a38.904%2038.904%200%20001.999%205.905c2.152%205%205.105%209.376%208.854%2013.125%203.751%203.75%208.126%206.703%2013.125%208.855a38.98%2038.98%200%20005.906%201.999c.66.166%201.124.758%201.124%201.438%200%20.68-.464%201.273-1.125%201.439a38.902%2038.902%200%2000-5.905%201.999c-5%202.152-9.375%205.105-13.125%208.854-3.749%203.751-6.702%208.126-8.854%2013.125a38.973%2038.973%200%2000-2%205.906%201.485%201.485%200%2001-1.438%201.124c-.68%200-1.272-.464-1.438-1.125a38.913%2038.913%200%2000-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973%2038.973%200%2000-5.905-2A1.485%201.485%200%20010%2032.448c0-.68.465-1.272%201.125-1.438a38.903%2038.903%200%20005.905-2c5-2.151%209.376-5.104%2013.125-8.854%203.75-3.749%206.703-8.125%208.855-13.125a38.972%2038.972%200%20001.999-5.905A1.485%201.485%200%200132.447%200z%22%20fill%3D%22%23000%22%2F%3E%3Cpath%20d%3D%22M32.447%200c.68%200%201.273.465%201.439%201.125a38.904%2038.904%200%20001.999%205.905c2.152%205%205.105%209.376%208.854%2013.125%203.751%203.75%208.126%206.703%2013.125%208.855a38.98%2038.98%200%20005.906%201.999c.66.166%201.124.758%201.124%201.438%200%20.68-.464%201.273-1.125%201.439a38.902%2038.902%200%2000-5.905%201.999c-5%202.152-9.375%205.105-13.125%208.854-3.749%203.751-6.702%208.126-8.854%2013.125a38.973%2038.973%200%2000-2%205.906%201.485%201.485%200%2001-1.438%201.124c-.68%200-1.272-.464-1.438-1.125a38.913%2038.913%200%2000-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973%2038.973%200%2000-5.905-2A1.485%201.485%200%20010%2032.448c0-.68.465-1.272%201.125-1.438a38.903%2038.903%200%20005.905-2c5-2.151%209.376-5.104%2013.125-8.854%203.75-3.749%206.703-8.125%208.855-13.125a38.972%2038.972%200%20001.999-5.905A1.485%201.485%200%200132.447%200z%22%20fill%3D%22url(%23prefix__paint0_linear_2001_67)%22%2F%3E%3C%2Fmask%3E%3Cg%20mask%3D%22url(%23maskme)%22%3E%3Cg%20filter%3D%22url(%23prefix__filter0_f_2001_67)%22%3E%3Cpath%20d%3D%22M-5.859%2050.734c7.498%202.663%2016.116-2.33%2019.249-11.152%203.133-8.821-.406-18.131-7.904-20.794-7.498-2.663-16.116%202.33-19.25%2011.151-3.132%208.822.407%2018.132%207.905%2020.795z%22%20fill%3D%22%23FFE432%22%2F%3E%3C%2Fg%3E%3Cg%20filter%3D%22url(%23prefix__filter1_f_2001_67)%22%3E%3Cpath%20d%3D%22M27.433%2021.649c10.3%200%2018.651-8.535%2018.651-19.062%200-10.528-8.35-19.062-18.651-19.062S8.78-7.94%208.78%202.587c0%2010.527%208.35%2019.062%2018.652%2019.062z%22%20fill%3D%22%23FC413D%22%2F%3E%3C%2Fg%3E%3Cg%20filter%3D%22url(%23prefix__filter2_f_2001_67)%22%3E%3Cpath%20d%3D%22M20.184%2082.608c10.753-.525%2018.918-12.244%2018.237-26.174-.68-13.93-9.95-24.797-20.703-24.271C6.965%2032.689-1.2%2044.407-.519%2058.337c.681%2013.93%209.95%2024.797%2020.703%2024.271z%22%20fill%3D%22%2300B95C%22%2F%3E%3C%2Fg%3E%3Cg%20filter%3D%22url(%23prefix__filter3_f_2001_67)%22%3E%3Cpath%20d%3D%22M20.184%2082.608c10.753-.525%2018.918-12.244%2018.237-26.174-.68-13.93-9.95-24.797-20.703-24.271C6.965%2032.689-1.2%2044.407-.519%2058.337c.681%2013.93%209.95%2024.797%2020.703%2024.271z%22%20fill%3D%22%2300B95C%22%2F%3E%3C%2Fg%3E%3Cg%20filter%3D%22url(%23prefix__filter4_f_2001_67)%22%3E%3Cpath%20d%3D%22M30.954%2074.181c9.014-5.485%2011.427-17.976%205.389-27.9-6.038-9.925-18.241-13.524-27.256-8.04-9.015%205.486-11.428%2017.977-5.39%2027.902%206.04%209.924%2018.242%2013.523%2027.257%208.038z%22%20fill%3D%22%2300B95C%22%2F%3E%3C%2Fg%3E%3Cg%20filter%3D%22url(%23prefix__filter5_f_2001_67)%22%3E%3Cpath%20d%3D%22M67.391%2042.993c10.132%200%2018.346-7.91%2018.346-17.666%200-9.757-8.214-17.667-18.346-17.667s-18.346%207.91-18.346%2017.667c0%209.757%208.214%2017.666%2018.346%2017.666z%22%20fill%3D%22%233186FF%22%2F%3E%3C%2Fg%3E%3Cg%20filter%3D%22url(%23prefix__filter6_f_2001_67)%22%3E%3Cpath%20d%3D%22M-13.065%2040.944c9.33%207.094%2022.959%204.869%2030.442-4.972%207.483-9.84%205.987-23.569-3.343-30.663C4.704-1.786-8.924.439-16.408%2010.28c-7.483%209.84-5.986%2023.57%203.343%2030.664z%22%20fill%3D%22%23FBBC04%22%2F%3E%3C%2Fg%3E%3Cg%20filter%3D%22url(%23prefix__filter7_f_2001_67)%22%3E%3Cpath%20d%3D%22M34.74%2051.43c11.135%207.656%2025.896%205.524%2032.968-4.764%207.073-10.287%203.779-24.832-7.357-32.488C49.215%206.52%2034.455%208.654%2027.382%2018.94c-7.072%2010.288-3.779%2024.833%207.357%2032.49z%22%20fill%3D%22%233186FF%22%2F%3E%3C%2Fg%3E%3Cg%20filter%3D%22url(%23prefix__filter8_f_2001_67)%22%3E%3Cpath%20d%3D%22M54.984-2.336c2.833%203.852-.808%2011.34-8.131%2016.727-7.324%205.387-15.557%206.631-18.39%202.78-2.833-3.853.807-11.342%208.13-16.728%207.324-5.387%2015.558-6.631%2018.39-2.78z%22%20fill%3D%22%23749BFF%22%2F%3E%3C%2Fg%3E%3Cg%20filter%3D%22url(%23prefix__filter9_f_2001_67)%22%3E%3Cpath%20d%3D%22M31.727%2016.104C43.053%205.598%2046.94-8.626%2040.41-15.666c-6.53-7.04-21.006-4.232-32.332%206.274s-15.214%2024.73-8.683%2031.77c6.53%207.04%2021.006%204.232%2032.332-6.274z%22%20fill%3D%22%23FC413D%22%2F%3E%3C%2Fg%3E%3Cg%20filter%3D%22url(%23prefix__filter10_f_2001_67)%22%3E%3Cpath%20d%3D%22M8.51%2053.838c6.732%204.818%2014.46%205.55%2017.262%201.636%202.802-3.915-.384-10.994-7.116-15.812-6.731-4.818-14.46-5.55-17.261-1.636-2.802%203.915.383%2010.994%207.115%2015.812z%22%20fill%3D%22%23FFEE48%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3Cdefs%3E%3Cfilter%20id%3D%22prefix__filter0_f_2001_67%22%20x%3D%22-19.824%22%20y%3D%2213.152%22%20width%3D%2239.274%22%20height%3D%2243.217%22%20filterUnits%3D%22userSpaceOnUse%22%20color-interpolation-filters%3D%22sRGB%22%3E%3CfeFlood%20flood-opacity%3D%220%22%20result%3D%22BackgroundImageFix%22%2F%3E%3CfeBlend%20in%3D%22SourceGraphic%22%20in2%3D%22BackgroundImageFix%22%20result%3D%22shape%22%2F%3E%3CfeGaussianBlur%20stdDeviation%3D%222.46%22%20result%3D%22effect1_foregroundBlur_2001_67%22%2F%3E%3C%2Ffilter%3E%3Cfilter%20id%3D%22prefix__filter1_f_2001_67%22%20x%3D%22-15.001%22%20y%3D%22-40.257%22%20width%3D%2284.868%22%20height%3D%2285.688%22%20filterUnits%3D%22userSpaceOnUse%22%20color-interpolation-filters%3D%22sRGB%22%3E%3CfeFlood%20flood-opacity%3D%220%22%20result%3D%22BackgroundImageFix%22%2F%3E%3CfeBlend%20in%3D%22SourceGraphic%22%20in2%3D%22BackgroundImageFix%22%20result%3D%22shape%22%2F%3E%3CfeGaussianBlur%20stdDeviation%3D%2211.891%22%20result%3D%22effect1_foregroundBlur_2001_67%22%2F%3E%3C%2Ffilter%3E%3Cfilter%20id%3D%22prefix__filter2_f_2001_67%22%20x%3D%22-20.776%22%20y%3D%2211.927%22%20width%3D%2279.454%22%20height%3D%2290.916%22%20filterUnits%3D%22userSpaceOnUse%22%20color-interpolation-filters%3D%22sRGB%22%3E%3CfeFlood%20flood-opacity%3D%220%22%20result%3D%22BackgroundImageFix%22%2F%3E%3CfeBlend%20in%3D%22SourceGraphic%22%20in2%3D%22BackgroundImageFix%22%20result%3D%22shape%22%2F%3E%3CfeGaussianBlur%20stdDeviation%3D%2210.109%22%20result%3D%22effect1_foregroundBlur_2001_67%22%2F%3E%3C%2Ffilter%3E%3Cfilter%20id%3D%22prefix__filter3_f_2001_67%22%20x%3D%22-20.776%22%20y%3D%2211.927%22%20width%3D%2279.454%22%20height%3D%2290.916%22%20filterUnits%3D%22userSpaceOnUse%22%20color-interpolation-filters%3D%22sRGB%22%3E%3CfeFlood%20flood-opacity%3D%220%22%20result%3D%22BackgroundImageFix%22%2F%3E%3CfeBlend%20in%3D%22SourceGraphic%22%20in2%3D%22BackgroundImageFix%22%20result%3D%22shape%22%2F%3E%3CfeGaussianBlur%20stdDeviation%3D%2210.109%22%20result%3D%22effect1_foregroundBlur_2001_67%22%2F%3E%3C%2Ffilter%3E%3Cfilter%20id%3D%22prefix__filter4_f_2001_67%22%20x%3D%22-19.845%22%20y%3D%2215.459%22%20width%3D%2279.731%22%20height%3D%2281.505%22%20filterUnits%3D%22userSpaceOnUse%22%20color-interpolation-filters%3D%22sRGB%22%3E%3CfeFlood%20flood-opacity%3D%220%22%20result%3D%22BackgroundImageFix%22%2F%3E%3CfeBlend%20in%3D%22SourceGraphic%22%20in2%3D%22BackgroundImageFix%22%20result%3D%22shape%22%2F%3E%3CfeGaussianBlur%20stdDeviation%3D%2210.109%22%20result%3D%22effect1_foregroundBlur_2001_67%22%2F%3E%3C%2Ffilter%3E%3Cfilter%20id%3D%22prefix__filter5_f_2001_67%22%20x%3D%2229.832%22%20y%3D%22-11.552%22%20width%3D%2275.117%22%20height%3D%2273.758%22%20filterUnits%3D%22userSpaceOnUse%22%20color-interpolation-filters%3D%22sRGB%22%3E%3CfeFlood%20flood-opacity%3D%220%22%20result%3D%22BackgroundImageFix%22%2F%3E%3CfeBlend%20in%3D%22SourceGraphic%22%20in2%3D%22BackgroundImageFix%22%20result%3D%22shape%22%2F%3E%3CfeGaussianBlur%20stdDeviation%3D%229.606%22%20result%3D%22effect1_foregroundBlur_2001_67%22%2F%3E%3C%2Ffilter%3E%3Cfilter%20id%3D%22prefix__filter6_f_2001_67%22%20x%3D%22-38.583%22%20y%3D%22-16.253%22%20width%3D%2278.135%22%20height%3D%2278.758%22%20filterUnits%3D%22userSpaceOnUse%22%20color-interpolation-filters%3D%22sRGB%22%3E%3CfeFlood%20flood-opacity%3D%220%22%20result%3D%22BackgroundImageFix%22%2F%3E%3CfeBlend%20in%3D%22SourceGraphic%22%20in2%3D%22BackgroundImageFix%22%20result%3D%22shape%22%2F%3E%3CfeGaussianBlur%20stdDeviation%3D%228.706%22%20result%3D%22effect1_foregroundBlur_2001_67%22%2F%3E%3C%2Ffilter%3E%3Cfilter%20id%3D%22prefix__filter7_f_2001_67%22%20x%3D%228.107%22%20y%3D%22-5.966%22%20width%3D%2278.877%22%20height%3D%2277.539%22%20filterUnits%3D%22userSpaceOnUse%22%20color-interpolation-filters%3D%22sRGB%22%3E%3CfeFlood%20flood-opacity%3D%220%22%20result%3D%22BackgroundImageFix%22%2F%3E%3CfeBlend%20in%3D%22SourceGraphic%22%20in2%3D%22BackgroundImageFix%22%20result%3D%22shape%22%2F%3E%3CfeGaussianBlur%20stdDeviation%3D%227.775%22%20result%3D%22effect1_foregroundBlur_2001_67%22%2F%3E%3C%2Ffilter%3E%3Cfilter%20id%3D%22prefix__filter8_f_2001_67%22%20x%3D%2213.587%22%20y%3D%22-18.488%22%20width%3D%2256.272%22%20height%3D%2251.81%22%20filterUnits%3D%22userSpaceOnUse%22%20color-interpolation-filters%3D%22sRGB%22%3E%3CfeFlood%20flood-opacity%3D%220%22%20result%3D%22BackgroundImageFix%22%2F%3E%3CfeBlend%20in%3D%22SourceGraphic%22%20in2%3D%22BackgroundImageFix%22%20result%3D%22shape%22%2F%3E%3CfeGaussianBlur%20stdDeviation%3D%226.957%22%20result%3D%22effect1_foregroundBlur_2001_67%22%2F%3E%3C%2Ffilter%3E%3Cfilter%20id%3D%22prefix__filter9_f_2001_67%22%20x%3D%22-15.526%22%20y%3D%22-31.297%22%20width%3D%2270.856%22%20height%3D%2269.306%22%20filterUnits%3D%22userSpaceOnUse%22%20color-interpolation-filters%3D%22sRGB%22%3E%3CfeFlood%20flood-opacity%3D%220%22%20result%3D%22BackgroundImageFix%22%2F%3E%3CfeBlend%20in%3D%22SourceGraphic%22%20in2%3D%22BackgroundImageFix%22%20result%3D%22shape%22%2F%3E%3CfeGaussianBlur%20stdDeviation%3D%225.876%22%20result%3D%22effect1_foregroundBlur_2001_67%22%2F%3E%3C%2Ffilter%3E%3Cfilter%20id%3D%22prefix__filter10_f_2001_67%22%20x%3D%22-14.168%22%20y%3D%2220.964%22%20width%3D%2255.501%22%20height%3D%2251.571%22%20filterUnits%3D%22userSpaceOnUse%22%20color-interpolation-filters%3D%22sRGB%22%3E%3CfeFlood%20flood-opacity%3D%220%22%20result%3D%22BackgroundImageFix%22%2F%3E%3CfeBlend%20in%3D%22SourceGraphic%22%20in2%3D%22BackgroundImageFix%22%20result%3D%22shape%22%2F%3E%3CfeGaussianBlur%20stdDeviation%3D%227.273%22%20result%3D%22effect1_foregroundBlur_2001_67%22%2F%3E%3C%2Ffilter%3E%3ClinearGradient%20id%3D%22prefix__paint0_linear_2001_67%22%20x1%3D%2218.447%22%20y1%3D%2243.42%22%20x2%3D%2252.153%22%20y2%3D%2215.004%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%234893FC%22%2F%3E%3Cstop%20offset%3D%22.27%22%20stop-color%3D%22%234893FC%22%2F%3E%3Cstop%20offset%3D%22.777%22%20stop-color%3D%22%23969DFF%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23BD99FE%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3C%2Fsvg%3E",
  google: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20width%3D%2224%22%3E%3Cpath%20d%3D%22M22.56%2012.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26%201.37-1.04%202.53-2.21%203.31v2.77h3.57c2.08-1.92%203.28-4.74%203.28-8.09z%22%20fill%3D%22%234285F4%22%2F%3E%3Cpath%20d%3D%22M12%2023c2.97%200%205.46-.98%207.28-2.66l-3.57-2.77c-.98.66-2.23%201.06-3.71%201.06-2.86%200-5.29-1.93-6.16-4.53H2.18v2.84C3.99%2020.53%207.7%2023%2012%2023z%22%20fill%3D%22%2334A853%22%2F%3E%3Cpath%20d%3D%22M5.84%2014.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43%208.55%201%2010.22%201%2012s.43%203.45%201.18%204.93l2.85-2.22.81-.62z%22%20fill%3D%22%23FBBC05%22%2F%3E%3Cpath%20d%3D%22M12%205.38c1.62%200%203.06.56%204.21%201.64l3.15-3.15C17.45%202.09%2014.97%201%2012%201%207.7%201%203.99%203.47%202.18%207.07l3.66%202.84c.87-2.6%203.3-4.53%206.16-4.53z%22%20fill%3D%22%23EA4335%22%2F%3E%3Cpath%20d%3D%22M1%201h22v22H1z%22%20fill%3D%22none%22%2F%3E%3C%2Fsvg%3E",
  inception: "data:image/svg+xml;utf8,%3Csvg%20viewBox%3D%220%200%20322%20329%22%20fill%3D%22currentColor%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%3Cpath%20d%3D%22M66.6056%2012.2522C78.2802%2010.9725%2090.1467%209.81141%20102.205%208.76904C101.283%2018.7387%20100.344%2029.0241%2099.3908%2039.6253C86.7998%2040.7234%2074.4657%2041.933%2062.3887%2043.254C63.8026%2032.6301%2065.2082%2022.2961%2066.6056%2012.2522Z%22%2F%3E%0A%3Cpath%20d%3D%22M190.537%200.314209C209.075%201.76321%20227.197%203.48983%20244.902%205.49407C247.173%2020.8365%20249.457%2036.8426%20251.754%2053.5123C233.188%2051.4234%20213.965%2049.5885%20194.085%2048.0074C192.87%2031.3521%20191.687%2015.4544%20190.537%200.314209Z%22%2F%3E%0A%3Cpath%20d%3D%22M3.32567%2083.1635C10.678%2082.1789%2018.1872%2081.1902%2025.8533%2080.1974C24.9079%2088.9946%2024.0245%2097.9239%2023.203%20106.985C15.5534%20107.735%208.07104%20108.476%200.755859%20109.208C1.55054%20100.419%202.40714%2091.7378%203.32567%2083.1635Z%22%2F%3E%0A%3Cpath%20d%3D%22M125.097%2061.4632C142.838%2061.1247%20160.579%2061.1247%20178.32%2061.4632C178.987%2077.2949%20179.652%2093.8005%20180.314%20110.98C161.244%20110.635%20142.174%20110.635%20123.104%20110.98C123.766%2093.8005%20124.431%2077.2949%20125.097%2061.4632Z%22%2F%3E%0A%3Cpath%20d%3D%22M257.047%2058.7478C276.794%2061.4951%20295.649%2064.229%20313.611%2066.9495C315.968%2087.5947%20317.949%20108.787%20319.555%20130.526C301.897%20129.345%20283.187%20128.121%20263.425%20126.854C261.637%20103.218%20259.511%2080.5158%20257.047%2058.7478Z%22%2F%3E%0A%3Cpath%20d%3D%22M53.7907%20142.982C66.3384%20142.561%2079.3041%20142.139%2092.6877%20141.716C92.4689%20156.637%2092.4689%20171.559%2092.6877%20186.48C79.3041%20186.057%2066.3384%20185.635%2053.7907%20185.214C53.5802%20171.137%2053.5802%20157.059%2053.7907%20142.982Z%22%2F%3E%0A%3Cpath%20d%3D%22M198.812%20129.277C219.842%20130.206%20239.886%20131.151%20258.946%20132.113C259.435%20153.437%20259.435%20174.762%20258.946%20196.086C239.886%20197.048%20219.842%20197.993%20198.812%20198.922C199.298%20175.707%20199.298%20152.492%20198.812%20129.277Z%22%2F%3E%0A%3Cpath%20d%3D%22M0.755859%20218.987C8.07104%20219.72%2015.5534%20220.461%2023.203%20221.21C24.0245%20230.271%2024.9079%20239.201%2025.8533%20247.998C18.1872%20247.005%2010.678%20246.016%203.32567%20245.032C2.40714%20236.457%201.55054%20227.776%200.755859%20218.987Z%22%2F%3E%0A%3Cpath%20d%3D%22M123.104%20217.221C142.174%20217.566%20161.244%20217.566%20180.314%20217.221C179.652%20234.4%20178.987%20250.906%20178.32%20266.738C160.579%20267.076%20142.838%20267.076%20125.097%20266.738C124.431%20250.906%20123.766%20234.4%20123.104%20217.221Z%22%2F%3E%0A%3Cpath%20d%3D%22M263.425%20201.342C283.187%20200.075%20301.897%20198.851%20319.555%20197.67C317.949%20219.409%20315.968%20240.602%20313.611%20261.247C295.649%20263.967%20276.794%20266.701%20257.047%20269.448C259.511%20247.68%20261.637%20224.978%20263.425%20201.342Z%22%2F%3E%0A%3Cpath%20d%3D%22M62.3887%20284.943C74.4657%20286.264%2086.7998%20287.473%2099.3908%20288.571C100.344%20299.173%20101.283%20309.458%20102.205%20319.428C90.1467%20318.385%2078.2802%20317.224%2066.6056%20315.944C65.2082%20305.9%2063.8026%20295.567%2062.3887%20284.943Z%22%2F%3E%0A%3Cpath%20d%3D%22M194.085%20280.187C213.965%20278.606%20233.188%20276.771%20251.754%20274.682C249.457%20291.351%20247.173%20307.358%20244.902%20322.7C227.197%20324.704%20209.075%20326.431%20190.537%20327.88C191.687%20312.74%20192.87%20296.842%20194.085%20280.187Z%22%2F%3E%0A%3C%2Fsvg%3E",
  meta: "data:image/svg+xml;utf8,%3C%3Fxml%20version%3D%221.0%22%20encoding%3D%22UTF-8%22%3F%3E%3Csvg%20width%3D%22290%22%20height%3D%22191%22%20viewBox%3D%220%200%20290%20191%22%20xmlns%3Ardf%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2F02%2F22-rdf-syntax-ns%23%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20xmlns%3Acc%3D%22http%3A%2F%2Fcreativecommons.org%2Fns%23%22%3E%0A%3Cdesc%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3ELogo%20of%20Meta%20Platforms%20--%20Graphic%20created%20by%20Detmar%20Owen%3C%2Fdesc%3E%0A%3Cdefs%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%3ClinearGradient%20id%3D%22Grad_Logo1%22%20x1%3D%2261%22%20y1%3D%22117%22%20x2%3D%22259%22%20y2%3D%22127%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%0A%3Cstop%20style%3D%22stop-color%3A%230064e1%22%20offset%3D%220%22%2F%3E%0A%3Cstop%20style%3D%22stop-color%3A%230064e1%22%20offset%3D%220.4%22%2F%3E%0A%3Cstop%20style%3D%22stop-color%3A%230073ee%22%20offset%3D%220.83%22%2F%3E%0A%3Cstop%20style%3D%22stop-color%3A%230082fb%22%20offset%3D%221%22%2F%3E%0A%3C%2FlinearGradient%3E%0A%3ClinearGradient%20id%3D%22Grad_Logo2%22%20x1%3D%2245%22%20y1%3D%22139%22%20x2%3D%2245%22%20y2%3D%2266%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%0A%3Cstop%20style%3D%22stop-color%3A%230082fb%22%20offset%3D%220%22%2F%3E%0A%3Cstop%20style%3D%22stop-color%3A%230064e0%22%20offset%3D%221%22%2F%3E%0A%3C%2FlinearGradient%3E%0A%3C%2Fdefs%3E%0A%3Cpath%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22Logo0%22%20style%3D%22fill%3A%230081fb%22%20d%3D%22m31.06%2C125.96c0%2C10.98%202.41%2C19.41%205.56%2C24.51%204.13%2C6.68%2010.29%2C9.51%2016.57%2C9.51%208.1%2C0%2015.51-2.01%2029.79-21.76%2011.44-15.83%2024.92-38.05%2033.99-51.98l15.36-23.6c10.67-16.39%2023.02-34.61%2037.18-46.96%2011.56-10.08%2024.03-15.68%2036.58-15.68%2021.07%2C0%2041.14%2C12.21%2056.5%2C35.11%2016.81%2C25.08%2024.97%2C56.67%2024.97%2C89.27%200%2C19.38-3.82%2C33.62-10.32%2C44.87-6.28%2C10.88-18.52%2C21.75-39.11%2C21.75l0-31.02c17.63%2C0%2022.03-16.2%2022.03-34.74%200-26.42-6.16-55.74-19.73-76.69-9.63-14.86-22.11-23.94-35.84-23.94-14.85%2C0-26.8%2C11.2-40.23%2C31.17-7.14%2C10.61-14.47%2C23.54-22.7%2C38.13l-9.06%2C16.05c-18.2%2C32.27-22.81%2C39.62-31.91%2C51.75-15.95%2C21.24-29.57%2C29.29-47.5%2C29.29-21.27%2C0-34.72-9.21-43.05-23.09-6.8-11.31-10.14-26.15-10.14-43.06z%22%2F%3E%0A%3Cpath%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22Logo1%22%20style%3D%22fill%3Aurl(%23Grad_Logo1)%22%20d%3D%22m24.49%2C37.3c14.24-21.95%2034.79-37.3%2058.36-37.3%2013.65%2C0%2027.22%2C4.04%2041.39%2C15.61%2015.5%2C12.65%2032.02%2C33.48%2052.63%2C67.81l7.39%2C12.32c17.84%2C29.72%2027.99%2C45.01%2033.93%2C52.22%207.64%2C9.26%2012.99%2C12.02%2019.94%2C12.02%2017.63%2C0%2022.03-16.2%2022.03-34.74l27.4-.86c0%2C19.38-3.82%2C33.62-10.32%2C44.87-6.28%2C10.88-18.52%2C21.75-39.11%2C21.75-12.8%2C0-24.14-2.78-36.68-14.61-9.64-9.08-20.91-25.21-29.58-39.71l-25.79-43.08c-12.94-21.62-24.81-37.74-31.68-45.04-7.39-7.85-16.89-17.33-32.05-17.33-12.27%2C0-22.69%2C8.61-31.41%2C21.78z%22%2F%3E%0A%3Cpath%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22Logo2%22%20style%3D%22fill%3Aurl(%23Grad_Logo2)%22%20d%3D%22m82.35%2C31.23c-12.27%2C0-22.69%2C8.61-31.41%2C21.78-12.33%2C18.61-19.88%2C46.33-19.88%2C72.95%200%2C10.98%202.41%2C19.41%205.56%2C24.51l-26.48%2C17.44c-6.8-11.31-10.14-26.15-10.14-43.06%200-30.75%208.44-62.8%2024.49-87.55%2014.24-21.95%2034.79-37.3%2058.36-37.3z%22%2F%3E%0A%3Cpath%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22Text%22%20style%3D%22fill%3A%23192830%22%20d%3D%22m347.94%2C6.04h35.93l61.09%2C110.52%2061.1-110.52h35.15v181.6h-29.31v-139.18l-53.58%2C96.38h-27.5l-53.57-96.38v139.18h-29.31z%20m285.11%2C67.71c-21.02%2C0-33.68%2C15.82-36.71%2C35.41h71.34c-1.47-20.18-13.11-35.41-34.63-35.41z%20m-65.77%2C46.57c0-41.22%2026.64-71.22%2066.28-71.22%2038.99%2C0%2062.27%2C29.62%2062.27%2C73.42v8.05h-99.49c3.53%2C21.31%2017.67%2C35.67%2040.47%2C35.67%2018.19%2C0%2029.56-5.55%2040.34-15.7l15.57%2C19.07c-14.67%2C13.49-33.33%2C21.27-56.95%2C21.27-42.91%2C0-68.49-31.29-68.49-70.56z%20m164.09-43.97h-26.98v-24h26.98v-39.69h28.28v39.69h40.99v24h-40.99v60.83c0%2C20.77%206.64%2C28.15%2022.96%2C28.15%207.45%2C0%2011.72-.64%2018.03-1.69v23.74c-7.86%2C2.22-15.36%2C3.24-23.48%2C3.24-30.53%2C0-45.79-16.68-45.79-50.07z%20m188.35%2C23.34c-5.68-14.34-18.35-24.9-36.97-24.9-24.2%2C0-39.69%2C17.17-39.69%2C45.14%200%2C27.27%2014.26%2C45.27%2038.53%2C45.27%2019.08%2C0%2032.7-11.1%2038.13-24.91z%20m28.28%2C87.95h-27.76v-18.94c-7.76%2C11.15-21.88%2C22.18-44.75%2C22.18-36.78%2C0-61.36-30.79-61.36-70.95%200-40.54%2025.17-70.83%2062.92-70.83%2018.66%2C0%2033.3%2C7.46%2043.19%2C20.63v-17.38h27.76z%22%2F%3E%0A%3C%2Fsvg%3E",
  minimaxai: "data:image/svg+xml;utf8,%3Csvg%20height%3D%221em%22%20style%3D%22flex%3Anone%3Bline-height%3A1%22%20viewBox%3D%220%200%2024%2024%22%20width%3D%221em%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EMinimax%3C%2Ftitle%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22lobe-icons-minimax-_R_0_%22%20x1%3D%220%25%22%20x2%3D%22100.182%25%22%20y1%3D%2250.057%25%22%20y2%3D%2250.057%25%22%3E%3Cstop%20offset%3D%220%25%22%20stop-color%3D%22%23E2167E%22%3E%3C%2Fstop%3E%3Cstop%20offset%3D%22100%25%22%20stop-color%3D%22%23FE603C%22%3E%3C%2Fstop%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Cpath%20d%3D%22M16.278%202c1.156%200%202.093.927%202.093%202.07v12.501a.74.74%200%2000.744.709.74.74%200%2000.743-.709V9.099a2.06%202.06%200%20012.071-2.049A2.06%202.06%200%200124%209.1v6.561a.649.649%200%2001-.652.645.649.649%200%2001-.653-.645V9.1a.762.762%200%2000-.766-.758.762.762%200%2000-.766.758v7.472a2.037%202.037%200%2001-2.048%202.026%202.037%202.037%200%2001-2.048-2.026v-12.5a.785.785%200%2000-.788-.753.785.785%200%2000-.789.752l-.001%2015.904A2.037%202.037%200%200113.441%2022a2.037%202.037%200%2001-2.048-2.026V18.04c0-.356.292-.645.652-.645.36%200%20.652.289.652.645v1.934c0%20.263.142.506.372.638.23.131.514.131.744%200a.734.734%200%2000.372-.638V4.07c0-1.143.937-2.07%202.093-2.07zm-5.674%200c1.156%200%202.093.927%202.093%202.07v11.523a.648.648%200%2001-.652.645.648.648%200%2001-.652-.645V4.07a.785.785%200%2000-.789-.78.785.785%200%2000-.789.78v14.013a2.06%202.06%200%2001-2.07%202.048%202.06%202.06%200%2001-2.071-2.048V9.1a.762.762%200%2000-.766-.758.762.762%200%2000-.766.758v3.8a2.06%202.06%200%2001-2.071%202.049A2.06%202.06%200%20010%2012.9v-1.378c0-.357.292-.646.652-.646.36%200%20.653.29.653.646V12.9c0%20.418.343.757.766.757s.766-.339.766-.757V9.099a2.06%202.06%200%20012.07-2.048%202.06%202.06%200%20012.071%202.048v8.984c0%20.419.343.758.767.758.423%200%20.766-.339.766-.758V4.07c0-1.143.937-2.07%202.093-2.07z%22%20fill%3D%22url(%23lobe-icons-minimax-_R_0_)%22%20fill-rule%3D%22nonzero%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E",
  mistral: "data:image/svg+xml;utf8,%3C%3Fxml%20version%3D%221.0%22%20encoding%3D%22UTF-8%22%20standalone%3D%22no%22%3F%3E%3C!DOCTYPE%20svg%20PUBLIC%20%22-%2F%2FW3C%2F%2FDTD%20SVG%201.1%2F%2FEN%22%20%22http%3A%2F%2Fwww.w3.org%2FGraphics%2FSVG%2F1.1%2FDTD%2Fsvg11.dtd%22%3E%3Csvg%20width%3D%22100%25%22%20height%3D%22100%25%22%20viewBox%3D%220%200%20129%2091%22%20version%3D%221.1%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20xml%3Aspace%3D%22preserve%22%20xmlns%3Aserif%3D%22http%3A%2F%2Fwww.serif.com%2F%22%20style%3D%22fill-rule%3Aevenodd%3Bclip-rule%3Aevenodd%3Bstroke-linejoin%3Around%3Bstroke-miterlimit%3A2%3B%22%3E%3Cg%3E%3Crect%20x%3D%2218.292%22%20y%3D%220%22%20width%3D%2218.293%22%20height%3D%2218.123%22%20style%3D%22fill%3A%23ffd800%3Bfill-rule%3Anonzero%3B%22%2F%3E%3Crect%20x%3D%2291.473%22%20y%3D%220%22%20width%3D%2218.293%22%20height%3D%2218.123%22%20style%3D%22fill%3A%23ffd800%3Bfill-rule%3Anonzero%3B%22%2F%3E%3Crect%20x%3D%2218.292%22%20y%3D%2218.121%22%20width%3D%2236.586%22%20height%3D%2218.123%22%20style%3D%22fill%3A%23ffaf00%3Bfill-rule%3Anonzero%3B%22%2F%3E%3Crect%20x%3D%2273.181%22%20y%3D%2218.121%22%20width%3D%2236.586%22%20height%3D%2218.123%22%20style%3D%22fill%3A%23ffaf00%3Bfill-rule%3Anonzero%3B%22%2F%3E%3Crect%20x%3D%2218.292%22%20y%3D%2236.243%22%20width%3D%2291.476%22%20height%3D%2218.122%22%20style%3D%22fill%3A%23ff8205%3Bfill-rule%3Anonzero%3B%22%2F%3E%3Crect%20x%3D%2218.292%22%20y%3D%2254.37%22%20width%3D%2218.293%22%20height%3D%2218.123%22%20style%3D%22fill%3A%23fa500f%3Bfill-rule%3Anonzero%3B%22%2F%3E%3Crect%20x%3D%2254.883%22%20y%3D%2254.37%22%20width%3D%2218.293%22%20height%3D%2218.123%22%20style%3D%22fill%3A%23fa500f%3Bfill-rule%3Anonzero%3B%22%2F%3E%3Crect%20x%3D%2291.473%22%20y%3D%2254.37%22%20width%3D%2218.293%22%20height%3D%2218.123%22%20style%3D%22fill%3A%23fa500f%3Bfill-rule%3Anonzero%3B%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%2272.504%22%20width%3D%2254.89%22%20height%3D%2218.123%22%20style%3D%22fill%3A%23e10500%3Bfill-rule%3Anonzero%3B%22%2F%3E%3Crect%20x%3D%2273.181%22%20y%3D%2272.504%22%20width%3D%2254.89%22%20height%3D%2218.123%22%20style%3D%22fill%3A%23e10500%3Bfill-rule%3Anonzero%3B%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E",
  moonshotai: "data:image/svg+xml;utf8,%3Csvg%20fill%3D%22currentColor%22%20fill-rule%3D%22evenodd%22%20height%3D%221em%22%20style%3D%22flex%3Anone%3Bline-height%3A1%22%20viewBox%3D%220%200%2024%2024%22%20width%3D%221em%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EMoonshotAI%3C%2Ftitle%3E%3Cpath%20d%3D%22M1.052%2016.916l9.539%202.552a21.007%2021.007%200%2000.06%202.033l5.956%201.593a11.997%2011.997%200%2001-5.586.865l-.18-.016-.044-.004-.084-.009-.094-.01a11.605%2011.605%200%2001-.157-.02l-.107-.014-.11-.016a11.962%2011.962%200%2001-.32-.051l-.042-.008-.075-.013-.107-.02-.07-.015-.093-.019-.075-.016-.095-.02-.097-.023-.094-.022-.068-.017-.088-.022-.09-.024-.095-.025-.082-.023-.109-.03-.062-.02-.084-.025-.093-.028-.105-.034-.058-.019-.08-.026-.09-.031-.066-.024a6.293%206.293%200%2001-.044-.015l-.068-.025-.101-.037-.057-.022-.08-.03-.087-.035-.088-.035-.079-.032-.095-.04-.063-.028-.063-.027a5.655%205.655%200%2001-.041-.018l-.066-.03-.103-.047-.052-.024-.096-.046-.062-.03-.084-.04-.086-.044-.093-.047-.052-.027-.103-.055-.057-.03-.058-.032a6.49%206.49%200%2001-.046-.026l-.094-.053-.06-.034-.051-.03-.072-.041-.082-.05-.093-.056-.052-.032-.084-.053-.061-.039-.079-.05-.07-.047-.053-.035a7.785%207.785%200%2001-.054-.036l-.044-.03-.044-.03a6.066%206.066%200%2001-.04-.028l-.057-.04-.076-.054-.069-.05-.074-.054-.056-.042-.076-.057-.076-.059-.086-.067-.045-.035-.064-.052-.074-.06-.089-.073-.046-.039-.046-.039a7.516%207.516%200%2001-.043-.037l-.045-.04-.061-.053-.07-.062-.068-.06-.062-.058-.067-.062-.053-.05-.088-.084a13.28%2013.28%200%2001-.099-.097l-.029-.028-.041-.042-.069-.07-.05-.051-.05-.053a6.457%206.457%200%2001-.168-.179l-.08-.088-.062-.07-.071-.08-.042-.049-.053-.062-.058-.068-.046-.056a7.175%207.175%200%2001-.027-.033l-.045-.055-.066-.082-.041-.052-.05-.064-.02-.025a11.99%2011.99%200%2001-1.44-2.402zm-1.02-5.794l11.353%203.037a20.468%2020.468%200%2000-.469%202.011l10.817%202.894a12.076%2012.076%200%2001-1.845%202.005L.657%2015.923l-.016-.046-.035-.104a11.965%2011.965%200%2001-.05-.153l-.007-.023a11.896%2011.896%200%2001-.207-.741l-.03-.126-.018-.08-.021-.097-.018-.081-.018-.09-.017-.084-.018-.094c-.026-.141-.05-.283-.071-.426l-.017-.118-.011-.083-.013-.102a12.01%2012.01%200%2001-.019-.161l-.005-.047a12.12%2012.12%200%2001-.034-2.145zm1.593-5.15l11.948%203.196c-.368.605-.705%201.231-1.01%201.875l11.295%203.022c-.142.82-.368%201.612-.668%202.365l-11.55-3.09L.124%2010.26l.015-.1.008-.049.01-.067.015-.087.018-.098c.026-.148.056-.295.088-.442l.028-.124.02-.085.024-.097c.022-.09.045-.18.07-.268l.028-.102.023-.083.03-.1.025-.082.03-.096.026-.082.031-.095a11.896%2011.896%200%20011.01-2.232zm4.442-4.4L17.352%204.59a20.77%2020.77%200%2000-1.688%201.721l7.823%202.093c.267.852.442%201.744.513%202.665L2.106%205.213l.045-.065.027-.04.04-.055.046-.065.055-.076.054-.072.064-.086.05-.065.057-.073.055-.07.06-.074.055-.069.065-.077.054-.066.066-.077.053-.06.072-.082.053-.06.067-.074.054-.058.073-.078.058-.06.063-.067.168-.17.1-.098.059-.056.076-.071a12.084%2012.084%200%20012.272-1.677zM12.017%200h.097l.082.001.069.001.054.002.068.002.046.001.076.003.047.002.06.003.054.002.087.005.105.007.144.011.088.007.044.004.077.008.082.008.047.005.102.012.05.006.108.014.081.01.042.006.065.01.207.032.07.012.065.011.14.026.092.018.11.022.046.01.075.016.041.01L14.7.3l.042.01.065.015.049.012.071.017.096.024.112.03.113.03.113.032.05.015.07.02.078.024.073.023.05.016.05.016.076.025.099.033.102.036.048.017.064.023.093.034.11.041.116.045.1.04.047.02.06.024.041.018.063.026.04.018.057.025.11.048.1.046.074.035.075.036.06.028.092.046.091.045.102.052.053.028.049.026.046.024.06.033.041.022.052.029.088.05.106.06.087.051.057.034.053.032.096.059.088.055.098.062.036.024.064.041.084.056.04.027.062.042.062.043.023.017c.054.037.108.075.161.114l.083.06.065.048.056.043.086.065.082.064.04.03.05.041.086.069.079.065.085.071c.712.6%201.353%201.283%201.909%202.031L7.222.994l.062-.027.065-.028.081-.034.086-.035c.113-.045.227-.09.341-.131l.096-.035.093-.033.084-.03.096-.031c.087-.03.176-.058.264-.085l.091-.027.086-.025.102-.03.085-.023.1-.026L9.04.37l.09-.023.091-.022.095-.022.09-.02.098-.021.091-.02.095-.018.092-.018.1-.018.091-.016.098-.017.092-.014.097-.015.092-.013.102-.013.091-.012.105-.012.09-.01.105-.01c.093-.01.186-.018.28-.024l.106-.008.09-.005.11-.006.093-.004.1-.004.097-.002.099-.002.197-.002z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E",
  "moonshotai-dark": "data:image/svg+xml;utf8,%3Csvg%20fill%3D%22%23ffffff%22%20fill-rule%3D%22evenodd%22%20height%3D%221em%22%20style%3D%22flex%3Anone%3Bline-height%3A1%22%20viewBox%3D%220%200%2024%2024%22%20width%3D%221em%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EMoonshotAI%3C%2Ftitle%3E%3Cpath%20d%3D%22M1.052%2016.916l9.539%202.552a21.007%2021.007%200%2000.06%202.033l5.956%201.593a11.997%2011.997%200%2001-5.586.865l-.18-.016-.044-.004-.084-.009-.094-.01a11.605%2011.605%200%2001-.157-.02l-.107-.014-.11-.016a11.962%2011.962%200%2001-.32-.051l-.042-.008-.075-.013-.107-.02-.07-.015-.093-.019-.075-.016-.095-.02-.097-.023-.094-.022-.068-.017-.088-.022-.09-.024-.095-.025-.082-.023-.109-.03-.062-.02-.084-.025-.093-.028-.105-.034-.058-.019-.08-.026-.09-.031-.066-.024a6.293%206.293%200%2001-.044-.015l-.068-.025-.101-.037-.057-.022-.08-.03-.087-.035-.088-.035-.079-.032-.095-.04-.063-.028-.063-.027a5.655%205.655%200%2001-.041-.018l-.066-.03-.103-.047-.052-.024-.096-.046-.062-.03-.084-.04-.086-.044-.093-.047-.052-.027-.103-.055-.057-.03-.058-.032a6.49%206.49%200%2001-.046-.026l-.094-.053-.06-.034-.051-.03-.072-.041-.082-.05-.093-.056-.052-.032-.084-.053-.061-.039-.079-.05-.07-.047-.053-.035a7.785%207.785%200%2001-.054-.036l-.044-.03-.044-.03a6.066%206.066%200%2001-.04-.028l-.057-.04-.076-.054-.069-.05-.074-.054-.056-.042-.076-.057-.076-.059-.086-.067-.045-.035-.064-.052-.074-.06-.089-.073-.046-.039-.046-.039a7.516%207.516%200%2001-.043-.037l-.045-.04-.061-.053-.07-.062-.068-.06-.062-.058-.067-.062-.053-.05-.088-.084a13.28%2013.28%200%2001-.099-.097l-.029-.028-.041-.042-.069-.07-.05-.051-.05-.053a6.457%206.457%200%2001-.168-.179l-.08-.088-.062-.07-.071-.08-.042-.049-.053-.062-.058-.068-.046-.056a7.175%207.175%200%2001-.027-.033l-.045-.055-.066-.082-.041-.052-.05-.064-.02-.025a11.99%2011.99%200%2001-1.44-2.402zm-1.02-5.794l11.353%203.037a20.468%2020.468%200%2000-.469%202.011l10.817%202.894a12.076%2012.076%200%2001-1.845%202.005L.657%2015.923l-.016-.046-.035-.104a11.965%2011.965%200%2001-.05-.153l-.007-.023a11.896%2011.896%200%2001-.207-.741l-.03-.126-.018-.08-.021-.097-.018-.081-.018-.09-.017-.084-.018-.094c-.026-.141-.05-.283-.071-.426l-.017-.118-.011-.083-.013-.102a12.01%2012.01%200%2001-.019-.161l-.005-.047a12.12%2012.12%200%2001-.034-2.145zm1.593-5.15l11.948%203.196c-.368.605-.705%201.231-1.01%201.875l11.295%203.022c-.142.82-.368%201.612-.668%202.365l-11.55-3.09L.124%2010.26l.015-.1.008-.049.01-.067.015-.087.018-.098c.026-.148.056-.295.088-.442l.028-.124.02-.085.024-.097c.022-.09.045-.18.07-.268l.028-.102.023-.083.03-.1.025-.082.03-.096.026-.082.031-.095a11.896%2011.896%200%20011.01-2.232zm4.442-4.4L17.352%204.59a20.77%2020.77%200%2000-1.688%201.721l7.823%202.093c.267.852.442%201.744.513%202.665L2.106%205.213l.045-.065.027-.04.04-.055.046-.065.055-.076.054-.072.064-.086.05-.065.057-.073.055-.07.06-.074.055-.069.065-.077.054-.066.066-.077.053-.06.072-.082.053-.06.067-.074.054-.058.073-.078.058-.06.063-.067.168-.17.1-.098.059-.056.076-.071a12.084%2012.084%200%20012.272-1.677zM12.017%200h.097l.082.001.069.001.054.002.068.002.046.001.076.003.047.002.06.003.054.002.087.005.105.007.144.011.088.007.044.004.077.008.082.008.047.005.102.012.05.006.108.014.081.01.042.006.065.01.207.032.07.012.065.011.14.026.092.018.11.022.046.01.075.016.041.01L14.7.3l.042.01.065.015.049.012.071.017.096.024.112.03.113.03.113.032.05.015.07.02.078.024.073.023.05.016.05.016.076.025.099.033.102.036.048.017.064.023.093.034.11.041.116.045.1.04.047.02.06.024.041.018.063.026.04.018.057.025.11.048.1.046.074.035.075.036.06.028.092.046.091.045.102.052.053.028.049.026.046.024.06.033.041.022.052.029.088.05.106.06.087.051.057.034.053.032.096.059.088.055.098.062.036.024.064.041.084.056.04.027.062.042.062.043.023.017c.054.037.108.075.161.114l.083.06.065.048.056.043.086.065.082.064.04.03.05.041.086.069.079.065.085.071c.712.6%201.353%201.283%201.909%202.031L7.222.994l.062-.027.065-.028.081-.034.086-.035c.113-.045.227-.09.341-.131l.096-.035.093-.033.084-.03.096-.031c.087-.03.176-.058.264-.085l.091-.027.086-.025.102-.03.085-.023.1-.026L9.04.37l.09-.023.091-.022.095-.022.09-.02.098-.021.091-.02.095-.018.092-.018.1-.018.091-.016.098-.017.092-.014.097-.015.092-.013.102-.013.091-.012.105-.012.09-.01.105-.01c.093-.01.186-.018.28-.024l.106-.008.09-.005.11-.006.093-.004.1-.004.097-.002.099-.002.197-.002z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E",
  nvidia: "data:image/svg+xml;utf8,%3Csvg%20viewBox%3D%220%200%20271.7%20179.7%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%222500%22%20height%3D%221653%22%3E%3Cpath%20d%3D%22M101.3%2053.6V37.4c1.6-.1%203.2-.2%204.8-.2%2044.4-1.4%2073.5%2038.2%2073.5%2038.2S148.2%20119%20114.5%20119c-4.5%200-8.9-.7-13.1-2.1V67.7c17.3%202.1%2020.8%209.7%2031.1%2027l23.1-19.4s-16.9-22.1-45.3-22.1c-3-.1-6%20.1-9%20.4m0-53.6v24.2l4.8-.3c61.7-2.1%20102%2050.6%20102%2050.6s-46.2%2056.2-94.3%2056.2c-4.2%200-8.3-.4-12.4-1.1v15c3.4.4%206.9.7%2010.3.7%2044.8%200%2077.2-22.9%20108.6-49.9%205.2%204.2%2026.5%2014.3%2030.9%2018.7-29.8%2025-99.3%2045.1-138.7%2045.1-3.8%200-7.4-.2-11-.6v21.1h170.2V0H101.3zm0%20116.9v12.8c-41.4-7.4-52.9-50.5-52.9-50.5s19.9-22%2052.9-25.6v14h-.1c-17.3-2.1-30.9%2014.1-30.9%2014.1s7.7%2027.3%2031%2035.2M27.8%2077.4s24.5-36.2%2073.6-40V24.2C47%2028.6%200%2074.6%200%2074.6s26.6%2077%20101.3%2084v-14c-54.8-6.8-73.5-67.2-73.5-67.2z%22%20fill%3D%22%2376b900%22%2F%3E%3C%2Fsvg%3E",
  openai: "data:image/svg+xml;utf8,%3Csvg%20height%3D%222500%22%20viewBox%3D%22-1%20-.1%20949.1%20959.8%22%20width%3D%222474%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22m925.8%20456.3c10.4%2023.2%2017%2048%2019.7%2073.3%202.6%2025.3%201.3%2050.9-4.1%2075.8-5.3%2024.9-14.5%2048.8-27.3%2070.8-8.4%2014.7-18.3%2028.5-29.7%2041.2-11.3%2012.6-23.9%2024-37.6%2034-13.8%2010-28.5%2018.4-44.1%2025.3-15.5%206.8-31.7%2012-48.3%2015.4-7.8%2024.2-19.4%2047.1-34.4%2067.7-14.9%2020.6-33%2038.7-53.6%2053.6-20.6%2015-43.4%2026.6-67.6%2034.4-24.2%207.9-49.5%2011.8-75%2011.8-16.9.1-33.9-1.7-50.5-5.1-16.5-3.5-32.7-8.8-48.2-15.7s-30.2-15.5-43.9-25.5c-13.6-10-26.2-21.5-37.4-34.2-25%205.4-50.6%206.7-75.9%204.1-25.3-2.7-50.1-9.3-73.4-19.7-23.2-10.3-44.7-24.3-63.6-41.4s-35-37.1-47.7-59.1c-8.5-14.7-15.5-30.2-20.8-46.3s-8.8-32.7-10.6-49.6c-1.8-16.8-1.7-33.8.1-50.7%201.8-16.8%205.5-33.4%2010.8-49.5-17-18.9-31-40.4-41.4-63.6-10.3-23.3-17-48-19.6-73.3-2.7-25.3-1.3-50.9%204-75.8s14.5-48.8%2027.3-70.8c8.4-14.7%2018.3-28.6%2029.6-41.2s24-24%2037.7-34%2028.5-18.5%2044-25.3c15.6-6.9%2031.8-12%2048.4-15.4%207.8-24.3%2019.4-47.1%2034.3-67.7%2015-20.6%2033.1-38.7%2053.7-53.7%2020.6-14.9%2043.4-26.5%2067.6-34.4%2024.2-7.8%2049.5-11.8%2075-11.7%2016.9-.1%2033.9%201.6%2050.5%205.1s32.8%208.7%2048.3%2015.6c15.5%207%2030.2%2015.5%2043.9%2025.5%2013.7%2010.1%2026.3%2021.5%2037.5%2034.2%2024.9-5.3%2050.5-6.6%2075.8-4s50%209.3%2073.3%2019.6c23.2%2010.4%2044.7%2024.3%2063.6%2041.4%2018.9%2017%2035%2036.9%2047.7%2059%208.5%2014.6%2015.5%2030.1%2020.8%2046.3%205.3%2016.1%208.9%2032.7%2010.6%2049.6%201.8%2016.9%201.8%2033.9-.1%2050.8-1.8%2016.9-5.5%2033.5-10.8%2049.6%2017.1%2018.9%2031%2040.3%2041.4%2063.6zm-333.2%20426.9c21.8-9%2041.6-22.3%2058.3-39s30-36.5%2039-58.4c9-21.8%2013.7-45.2%2013.7-68.8v-223q-.1-.3-.2-.7-.1-.3-.3-.6-.2-.3-.5-.5-.3-.3-.6-.4l-80.7-46.6v269.4c0%202.7-.4%205.5-1.1%208.1-.7%202.7-1.7%205.2-3.1%207.6s-3%204.6-5%206.5a32.1%2032.1%200%200%201%20-6.5%205l-191.1%20110.3c-1.6%201-4.3%202.4-5.7%203.2%207.9%206.7%2016.5%2012.6%2025.5%2017.8%209.1%205.2%2018.5%209.6%2028.3%2013.2%209.8%203.5%2019.9%206.2%2030.1%208%2010.3%201.8%2020.7%202.7%2031.1%202.7%2023.6%200%2047-4.7%2068.8-13.8zm-455.1-151.4c11.9%2020.5%2027.6%2038.3%2046.3%2052.7%2018.8%2014.4%2040.1%2024.9%2062.9%2031s46.6%207.7%2070%204.6%2045.9-10.7%2066.4-22.5l193.2-111.5.5-.5q.2-.2.3-.6.2-.3.3-.6v-94l-233.2%20134.9c-2.4%201.4-4.9%202.4-7.5%203.2-2.7.7-5.4%201-8.2%201-2.7%200-5.4-.3-8.1-1-2.6-.8-5.2-1.8-7.6-3.2l-191.1-110.4c-1.7-1-4.2-2.5-5.6-3.4-1.8%2010.3-2.7%2020.7-2.7%2031.1s1%2020.8%202.8%2031.1c1.8%2010.2%204.6%2020.3%208.1%2030.1%203.6%209.8%208%2019.2%2013.2%2028.2zm-50.2-417c-11.8%2020.5-19.4%2043.1-22.5%2066.5s-1.5%2047.1%204.6%2070c6.1%2022.8%2016.6%2044.1%2031%2062.9%2014.4%2018.7%2032.3%2034.4%2052.7%2046.2l193.1%20111.6q.3.1.7.2h.7q.4%200%20.7-.2.3-.1.6-.3l81-46.8-233.2-134.6c-2.3-1.4-4.5-3.1-6.5-5a32.1%2032.1%200%200%201%20-5-6.5c-1.3-2.4-2.4-4.9-3.1-7.6-.7-2.6-1.1-5.3-1-8.1v-227.1c-9.8%203.6-19.3%208-28.3%2013.2-9%205.3-17.5%2011.3-25.5%2018-7.9%206.7-15.3%2014.1-22%2022.1-6.7%207.9-12.6%2016.5-17.8%2025.5zm663.3%20154.4c2.4%201.4%204.6%203%206.6%205%201.9%201.9%203.6%204.1%205%206.5%201.3%202.4%202.4%205%203.1%207.6.6%202.7%201%205.4.9%208.2v227.1c32.1-11.8%2060.1-32.5%2080.8-59.7%2020.8-27.2%2033.3-59.7%2036.2-93.7s-3.9-68.2-19.7-98.5-39.9-55.5-69.5-72.5l-193.1-111.6q-.3-.1-.7-.2h-.7q-.3.1-.7.2-.3.1-.6.3l-80.6%2046.6%20233.2%20134.7zm80.5-121h-.1v.1zm-.1-.1c5.8-33.6%201.9-68.2-11.3-99.7-13.1-31.5-35-58.6-63-78.2-28-19.5-61-30.7-95.1-32.2-34.2-1.4-68%206.9-97.6%2023.9l-193.1%20111.5q-.3.2-.5.5l-.4.6q-.1.3-.2.7-.1.3-.1.7v93.2l233.2-134.7c2.4-1.4%205-2.4%207.6-3.2%202.7-.7%205.4-1%208.1-1%202.8%200%205.5.3%208.2%201%202.6.8%205.1%201.8%207.5%203.2l191.1%20110.4c1.7%201%204.2%202.4%205.6%203.3zm-505.3-103.2c0-2.7.4-5.4%201.1-8.1.7-2.6%201.7-5.2%203.1-7.6%201.4-2.3%203-4.5%205-6.5%201.9-1.9%204.1-3.6%206.5-4.9l191.1-110.3c1.8-1.1%204.3-2.5%205.7-3.2-26.2-21.9-58.2-35.9-92.1-40.2-33.9-4.4-68.3%201-99.2%2015.5-31%2014.5-57.2%2037.6-75.5%2066.4-18.3%2028.9-28%2062.3-28%2096.5v223q.1.4.2.7.1.3.3.6.2.3.5.6.2.2.6.4l80.7%2046.6zm43.8%20294.7%20103.9%2060%20103.9-60v-119.9l-103.8-60-103.9%2060z%22%2F%3E%3C%2Fsvg%3E",
  "openai-dark": "data:image/svg+xml;utf8,%3Csvg%20fill%3D%22%23ffffff%22%20height%3D%222500%22%20viewBox%3D%22-1%20-.1%20949.1%20959.8%22%20width%3D%222474%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22m925.8%20456.3c10.4%2023.2%2017%2048%2019.7%2073.3%202.6%2025.3%201.3%2050.9-4.1%2075.8-5.3%2024.9-14.5%2048.8-27.3%2070.8-8.4%2014.7-18.3%2028.5-29.7%2041.2-11.3%2012.6-23.9%2024-37.6%2034-13.8%2010-28.5%2018.4-44.1%2025.3-15.5%206.8-31.7%2012-48.3%2015.4-7.8%2024.2-19.4%2047.1-34.4%2067.7-14.9%2020.6-33%2038.7-53.6%2053.6-20.6%2015-43.4%2026.6-67.6%2034.4-24.2%207.9-49.5%2011.8-75%2011.8-16.9.1-33.9-1.7-50.5-5.1-16.5-3.5-32.7-8.8-48.2-15.7s-30.2-15.5-43.9-25.5c-13.6-10-26.2-21.5-37.4-34.2-25%205.4-50.6%206.7-75.9%204.1-25.3-2.7-50.1-9.3-73.4-19.7-23.2-10.3-44.7-24.3-63.6-41.4s-35-37.1-47.7-59.1c-8.5-14.7-15.5-30.2-20.8-46.3s-8.8-32.7-10.6-49.6c-1.8-16.8-1.7-33.8.1-50.7%201.8-16.8%205.5-33.4%2010.8-49.5-17-18.9-31-40.4-41.4-63.6-10.3-23.3-17-48-19.6-73.3-2.7-25.3-1.3-50.9%204-75.8s14.5-48.8%2027.3-70.8c8.4-14.7%2018.3-28.6%2029.6-41.2s24-24%2037.7-34%2028.5-18.5%2044-25.3c15.6-6.9%2031.8-12%2048.4-15.4%207.8-24.3%2019.4-47.1%2034.3-67.7%2015-20.6%2033.1-38.7%2053.7-53.7%2020.6-14.9%2043.4-26.5%2067.6-34.4%2024.2-7.8%2049.5-11.8%2075-11.7%2016.9-.1%2033.9%201.6%2050.5%205.1s32.8%208.7%2048.3%2015.6c15.5%207%2030.2%2015.5%2043.9%2025.5%2013.7%2010.1%2026.3%2021.5%2037.5%2034.2%2024.9-5.3%2050.5-6.6%2075.8-4s50%209.3%2073.3%2019.6c23.2%2010.4%2044.7%2024.3%2063.6%2041.4%2018.9%2017%2035%2036.9%2047.7%2059%208.5%2014.6%2015.5%2030.1%2020.8%2046.3%205.3%2016.1%208.9%2032.7%2010.6%2049.6%201.8%2016.9%201.8%2033.9-.1%2050.8-1.8%2016.9-5.5%2033.5-10.8%2049.6%2017.1%2018.9%2031%2040.3%2041.4%2063.6zm-333.2%20426.9c21.8-9%2041.6-22.3%2058.3-39s30-36.5%2039-58.4c9-21.8%2013.7-45.2%2013.7-68.8v-223q-.1-.3-.2-.7-.1-.3-.3-.6-.2-.3-.5-.5-.3-.3-.6-.4l-80.7-46.6v269.4c0%202.7-.4%205.5-1.1%208.1-.7%202.7-1.7%205.2-3.1%207.6s-3%204.6-5%206.5a32.1%2032.1%200%200%201%20-6.5%205l-191.1%20110.3c-1.6%201-4.3%202.4-5.7%203.2%207.9%206.7%2016.5%2012.6%2025.5%2017.8%209.1%205.2%2018.5%209.6%2028.3%2013.2%209.8%203.5%2019.9%206.2%2030.1%208%2010.3%201.8%2020.7%202.7%2031.1%202.7%2023.6%200%2047-4.7%2068.8-13.8zm-455.1-151.4c11.9%2020.5%2027.6%2038.3%2046.3%2052.7%2018.8%2014.4%2040.1%2024.9%2062.9%2031s46.6%207.7%2070%204.6%2045.9-10.7%2066.4-22.5l193.2-111.5.5-.5q.2-.2.3-.6.2-.3.3-.6v-94l-233.2%20134.9c-2.4%201.4-4.9%202.4-7.5%203.2-2.7.7-5.4%201-8.2%201-2.7%200-5.4-.3-8.1-1-2.6-.8-5.2-1.8-7.6-3.2l-191.1-110.4c-1.7-1-4.2-2.5-5.6-3.4-1.8%2010.3-2.7%2020.7-2.7%2031.1s1%2020.8%202.8%2031.1c1.8%2010.2%204.6%2020.3%208.1%2030.1%203.6%209.8%208%2019.2%2013.2%2028.2zm-50.2-417c-11.8%2020.5-19.4%2043.1-22.5%2066.5s-1.5%2047.1%204.6%2070c6.1%2022.8%2016.6%2044.1%2031%2062.9%2014.4%2018.7%2032.3%2034.4%2052.7%2046.2l193.1%20111.6q.3.1.7.2h.7q.4%200%20.7-.2.3-.1.6-.3l81-46.8-233.2-134.6c-2.3-1.4-4.5-3.1-6.5-5a32.1%2032.1%200%200%201%20-5-6.5c-1.3-2.4-2.4-4.9-3.1-7.6-.7-2.6-1.1-5.3-1-8.1v-227.1c-9.8%203.6-19.3%208-28.3%2013.2-9%205.3-17.5%2011.3-25.5%2018-7.9%206.7-15.3%2014.1-22%2022.1-6.7%207.9-12.6%2016.5-17.8%2025.5zm663.3%20154.4c2.4%201.4%204.6%203%206.6%205%201.9%201.9%203.6%204.1%205%206.5%201.3%202.4%202.4%205%203.1%207.6.6%202.7%201%205.4.9%208.2v227.1c32.1-11.8%2060.1-32.5%2080.8-59.7%2020.8-27.2%2033.3-59.7%2036.2-93.7s-3.9-68.2-19.7-98.5-39.9-55.5-69.5-72.5l-193.1-111.6q-.3-.1-.7-.2h-.7q-.3.1-.7.2-.3.1-.6.3l-80.6%2046.6%20233.2%20134.7zm80.5-121h-.1v.1zm-.1-.1c5.8-33.6%201.9-68.2-11.3-99.7-13.1-31.5-35-58.6-63-78.2-28-19.5-61-30.7-95.1-32.2-34.2-1.4-68%206.9-97.6%2023.9l-193.1%20111.5q-.3.2-.5.5l-.4.6q-.1.3-.2.7-.1.3-.1.7v93.2l233.2-134.7c2.4-1.4%205-2.4%207.6-3.2%202.7-.7%205.4-1%208.1-1%202.8%200%205.5.3%208.2%201%202.6.8%205.1%201.8%207.5%203.2l191.1%20110.4c1.7%201%204.2%202.4%205.6%203.3zm-505.3-103.2c0-2.7.4-5.4%201.1-8.1.7-2.6%201.7-5.2%203.1-7.6%201.4-2.3%203-4.5%205-6.5%201.9-1.9%204.1-3.6%206.5-4.9l191.1-110.3c1.8-1.1%204.3-2.5%205.7-3.2-26.2-21.9-58.2-35.9-92.1-40.2-33.9-4.4-68.3%201-99.2%2015.5-31%2014.5-57.2%2037.6-75.5%2066.4-18.3%2028.9-28%2062.3-28%2096.5v223q.1.4.2.7.1.3.3.6.2.3.5.6.2.2.6.4l80.7%2046.6zm43.8%20294.7%20103.9%2060%20103.9-60v-119.9l-103.8-60-103.9%2060z%22%2F%3E%3C%2Fsvg%3E",
  perplexity: "data:image/svg+xml;utf8,%3Csvg%20fill%3D%22%231FB8CD%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EPerplexity%3C%2Ftitle%3E%3Cpath%20d%3D%22M22.3977%207.0896h-2.3106V.0676l-7.5094%206.3542V.1577h-1.1554v6.1966L4.4904%200v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318%206.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676%204.8691%204.4634H5.6458V2.6262zM2.7576%2016.332V8.245h7.8476l-6.1149%206.1147v1.9723H2.7576zm2.8882%205.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764%205.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766%205.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948%208.245h7.8478v8.087z%22%2F%3E%3C%2Fsvg%3E",
  poolside: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20128%20128%22%20fill%3D%22currentColor%22%3E%0A%20%20%3Cpath%20d%3D%22m35.959%20121.526c-11.8772-5.794-21.5249-14.947-27.90834-26.4686-6.23593-11.2582-8.930092-23.9574-7.798832-36.7265.256124-2.8615%202.777032-4.9741%205.639732-4.7214%202.85734.2545%204.97334%202.7778%204.72074%205.641-.94779%2010.6955%201.3128%2021.3362%206.538%2030.7705%204.4985%208.1229%2010.9417%2014.84%2018.8061%2019.656l24.4606-50.1633c-9.5744-3.1888-17.5492-1.8007-18.2669-1.6613-.1053.0243-.2071.0414-.3106.0621-2.3841.3992-4.6901-.9038-5.6184-3.0702-1.2811-2.3919-5.1275-8.2384-9.7828-10.5094-4.6552-2.2711-11.8298-1.5385-14.1394-1.0363-1.9474.4252-3.97402-.3009-5.20405-1.8667-1.23003-1.5659-1.4658-3.7015-.5927-5.492%2015.45775-31.71872%2053.84575-44.93849%2085.55925-29.46724%2031.7136%2015.47124%2044.9196%2053.82984%2029.4886%2085.53934-.016.0323-.032.0647-.049.1006-15.485%2031.6834-53.8429%2044.8774-85.542%2029.4134zm33.8009-57.4544-24.4588%2050.1594c24.6863%209.222%2052.7773-1.024%2065.6229-24.3097-1.806-2.7947-4.974-6.8014-8.641-8.5902-4.7375-2.3114-11.6793-1.5543-14.0641-1.0532-.3926.0933-.7839.1383-1.1773.1422-.7048.0034-1.4199-.1363-2.1061-.4355-.7114-.3114-1.3547-.781-1.874-1.386-.2968-.3495-.5421-.7317-.7393-1.1395-.1533-.3062-3.9466-7.6667-12.5659-13.3893zm-38.7651-29.0902c3.9831%201.9431%207.2244%205.0332%209.6483%207.947%207.496-11.4666%2017.6688-20.1275%2025.527-25.7116%202.9201-2.0736%205.9436-4.0123%208.8552-5.6852-20.4537-4.29467-41.8903%203.8115-54.3197%2020.8782%203.2899.2252%206.9209.9284%2010.2892%202.5716zm67.5712-11.9611c.4747%203.3248.8105%206.8979.9729%2010.4798.4384%209.6049-.1169%2022.9086-4.5038%2035.8475%203.6589.0981%207.9139.7451%2011.8069%202.6443%203.476%201.6959%206.39%204.2614%208.684%206.8223%205.855-20.3405-.95-42.2864-16.9617-55.7903zm-28.7702%2029.1142c7.1932%203.5091%2012.3927%208.1776%2015.9169%2012.2023%205.733-18.6289%203.2338-39.4757%201.1469-47.1965-7.3675%203.1085-25.3335%2013.9715-36.4767%2029.961%205.3459.2981%2012.2232%201.5257%2019.4129%205.0332z%22%2F%3E%0A%3C%2Fsvg%3E",
  qwen: "data:image/svg+xml;utf8,%3Csvg%20height%3D%221em%22%20style%3D%22flex%3Anone%3Bline-height%3A1%22%20viewBox%3D%220%200%2024%2024%22%20width%3D%221em%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EQwen%3C%2Ftitle%3E%3Cpath%20d%3D%22M12.604%201.34c.393.69.784%201.382%201.174%202.075a.18.18%200%2000.157.091h5.552c.174%200%20.322.11.446.327l1.454%202.57c.19.337.24.478.024.837-.26.43-.513.864-.76%201.3l-.367.658c-.106.196-.223.28-.04.512l2.652%204.637c.172.301.111.494-.043.77-.437.785-.882%201.564-1.335%202.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099%200%2000-.081.05%20575.097%20575.097%200%2001-2.705%204.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537%200%2001-.465-.271l-1.335-2.323a.09.09%200%2000-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543%200%2001-.002-.54l1.207-2.12a.198.198%200%20000-.197%20550.951%20550.951%200%2001-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625%201.387-2.436.132-.234.304-.334.584-.335a338.3%20338.3%200%20012.589-.001.124.124%200%2000.107-.063l2.806-4.895a.488.488%200%2001.422-.246c.524-.001%201.053%200%201.583-.006L11.704%201c.341-.003.724.032.9.34zm-3.432.403a.06.06%200%2000-.052.03L6.254%206.788a.157.157%200%2001-.135.078H3.253c-.056%200-.07.025-.041.074l5.81%2010.156c.025.042.013.062-.034.063l-2.795.015a.218.218%200%2000-.2.116l-1.32%202.31c-.044.078-.021.118.068.118l5.716.008c.046%200%20.08.02.104.061l1.403%202.454c.046.081.092.082.139%200l5.006-8.76.783-1.382a.055.055%200%2001.096%200l1.424%202.53a.122.122%200%2000.107.062l2.763-.02a.04.04%200%2000.035-.02.041.041%200%20000-.04l-2.9-5.086a.108.108%200%20010-.113l.293-.507%201.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059%200-.073-.026-.043-.077l1.434-2.505a.107.107%200%20000-.114L9.225%201.774a.06.06%200%2000-.053-.031zm6.29%208.02c.046%200%20.058.02.034.06l-.832%201.465-2.613%204.585a.056.056%200%2001-.05.029.058.058%200%2001-.05-.029L8.498%209.841c-.02-.034-.01-.052.028-.054l.216-.012%206.722-.012z%22%20fill%3D%22url(%23lobe-icons-qwen-fill)%22%20fill-rule%3D%22nonzero%22%3E%3C%2Fpath%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22lobe-icons-qwen-fill%22%20x1%3D%220%25%22%20x2%3D%22100%25%22%20y1%3D%220%25%22%20y2%3D%220%25%22%3E%3Cstop%20offset%3D%220%25%22%20stop-color%3D%22%236336E7%22%20stop-opacity%3D%22.84%22%3E%3C%2Fstop%3E%3Cstop%20offset%3D%22100%25%22%20stop-color%3D%22%236F69F7%22%20stop-opacity%3D%22.84%22%3E%3C%2Fstop%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3C%2Fsvg%3E",
  stepfun: "data:image/svg+xml;utf8,%3Csvg%0A%20%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%0A%20%20viewBox%3D%220%200%2028%2028%22%0A%20%20%20%20%3E%0A%20%20%20%20%20%20%3Cg%20clipPath%3D%22url(%23clip0_9396_9240)%22%3E%0A%20%20%20%20%20%20%20%20%3Cpath%0A%20%20%20%20%20%20%20%20%20%20d%3D%22M14%200C6.272%200%200%206.272%200%2014C0%2021.728%206.272%2028%2014%2028C21.728%2028%2028%2021.728%2028%2014C28%206.272%2021.728%200%2014%200ZM10.22%2022.876H5.11V17.766H10.22V22.876ZM16.548%2022.876H11.438V17.766H16.548V22.876ZM16.548%2016.562H11.438V11.438H16.548V16.562ZM16.548%2010.234H11.438V5.124H16.548V10.234ZM22.876%2010.234H17.766V5.11H22.876V10.234Z%22%0A%20%20%20%20%20%20%20%20%20%20fill%3D%22currentColor%22%0A%20%20%20%20%20%20%20%20%2F%3E%0A%20%20%20%20%20%20%3C%2Fg%3E%0A%20%20%20%20%20%20%3Cdefs%3E%0A%20%20%20%20%20%20%20%20%3CclipPath%20id%3D%22clip0_9396_9240%22%3E%0A%20%20%20%20%20%20%20%20%20%20%3Crect%20width%3D%2228%22%20height%3D%2228%22%20%2F%3E%0A%20%20%20%20%20%20%20%20%3C%2FclipPath%3E%0A%20%20%20%20%20%20%3C%2Fdefs%3E%0A%20%20%20%20%3C%2Fsvg%3E",
  thinkingmachines: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22currentColor%22%3E%0A%20%20%3Cpath%20d%3D%22M3%203h5v2H5v3H3V3zm13%200h5v5h-2V5h-3V3zM3%2016h2v3h3v2H3v-5zm16%200h2v5h-5v-2h3v-3z%22%2F%3E%0A%3C%2Fsvg%3E",
  xai: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%22226.69000244140625%20196.85000610351562%20546.6199951171875%20606.300048828125%22%3E%3Cg%3E%3Cpolygon%20fill%3D%22%23000%22%20points%3D%22226.83%20411.15%20501.31%20803.15%20623.31%20803.15%20348.82%20411.15%20226.83%20411.15%22%3E%3C%2Fpolygon%3E%3Cpolygon%20fill%3D%22%23000%22%20points%3D%22348.72%20628.87%20226.69%20803.15%20348.77%20803.15%20409.76%20716.05%20348.72%20628.87%22%3E%3C%2Fpolygon%3E%3Cpolygon%20fill%3D%22%23000%22%20points%3D%22651.23%20196.85%20440.28%20498.12%20501.32%20585.29%20773.31%20196.85%20651.23%20196.85%22%3E%3C%2Fpolygon%3E%3Cpolygon%20fill%3D%22%23000%22%20points%3D%22673.31%20383.25%20673.31%20803.15%20773.31%20803.15%20773.31%20240.44%20673.31%20383.25%22%3E%3C%2Fpolygon%3E%3C%2Fg%3E%3C%2Fsvg%3E",
  "xai-dark": "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%22226.69000244140625%20196.85000610351562%20546.6199951171875%20606.300048828125%22%3E%3Cg%3E%3Cpolygon%20fill%3D%22%23ffffff%22%20points%3D%22226.83%20411.15%20501.31%20803.15%20623.31%20803.15%20348.82%20411.15%20226.83%20411.15%22%3E%3C%2Fpolygon%3E%3Cpolygon%20fill%3D%22%23ffffff%22%20points%3D%22348.72%20628.87%20226.69%20803.15%20348.77%20803.15%20409.76%20716.05%20348.72%20628.87%22%3E%3C%2Fpolygon%3E%3Cpolygon%20fill%3D%22%23ffffff%22%20points%3D%22651.23%20196.85%20440.28%20498.12%20501.32%20585.29%20773.31%20196.85%20651.23%20196.85%22%3E%3C%2Fpolygon%3E%3Cpolygon%20fill%3D%22%23ffffff%22%20points%3D%22673.31%20383.25%20673.31%20803.15%20773.31%20803.15%20773.31%20240.44%20673.31%20383.25%22%3E%3C%2Fpolygon%3E%3C%2Fg%3E%3C%2Fsvg%3E",
  xiaomi: "data:image/svg+xml;utf8,%3Csvg%20fill%3D%22%23FF6900%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EXiaomi%3C%2Ftitle%3E%3Cpath%20d%3D%22M12%200C8.016%200%204.756.255%202.493%202.516.23%204.776%200%208.033%200%2012.012c0%203.98.23%207.235%202.494%209.497C4.757%2023.77%208.017%2024%2012%2024c3.983%200%207.243-.23%209.506-2.491C23.77%2019.247%2024%2015.99%2024%2012.012c0-3.984-.233-7.243-2.502-9.504C19.234.252%2015.978%200%2012%200zM4.906%207.405h5.624c1.47%200%203.007.068%203.764.827.746.746.827%202.233.83%203.676v4.54a.15.15%200%200%201-.152.147h-1.947a.15.15%200%200%201-.152-.148V11.83c-.002-.806-.048-1.634-.464-2.051-.358-.36-1.026-.441-1.72-.458H7.158a.15.15%200%200%200-.151.147v6.98a.15.15%200%200%201-.152.148H4.906a.15.15%200%200%201-.15-.148V7.554a.15.15%200%200%201%20.15-.149zm12.131%200h1.949a.15.15%200%200%201%20.15.15v8.892a.15.15%200%200%201-.15.148h-1.949a.15.15%200%200%201-.151-.148V7.554a.15.15%200%200%201%20.151-.149zM8.92%2010.948h2.046c.083%200%20.15.066.15.147v5.352a.15.15%200%200%201-.15.148H8.92a.15.15%200%200%201-.152-.148v-5.352a.15.15%200%200%201%20.152-.147Z%22%2F%3E%3C%2Fsvg%3E",
  zai: "data:image/svg+xml;utf8,%3Csvg%20fill%3D%22currentColor%22%20fill-rule%3D%22evenodd%22%20height%3D%221em%22%20style%3D%22flex%3Anone%3Bline-height%3A1%22%20viewBox%3D%220%200%2024%2024%22%20width%3D%221em%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EZ.ai%3C%2Ftitle%3E%3Cpath%20d%3D%22M12.105%202L9.927%204.953H.653L2.83%202h9.276zM23.254%2019.048L21.078%2022h-9.242l2.174-2.952h9.244zM24%202L9.264%2022H0L14.736%202H24z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E",
  "zai-dark": "data:image/svg+xml;utf8,%3Csvg%20fill%3D%22%23ffffff%22%20fill-rule%3D%22evenodd%22%20height%3D%221em%22%20style%3D%22flex%3Anone%3Bline-height%3A1%22%20viewBox%3D%220%200%2024%2024%22%20width%3D%221em%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EZ.ai%3C%2Ftitle%3E%3Cpath%20d%3D%22M12.105%202L9.927%204.953H.653L2.83%202h9.276zM23.254%2019.048L21.078%2022h-9.242l2.174-2.952h9.244zM24%202L9.264%2022H0L14.736%202H24z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E"
};

// src/resources/logos.ts
var NORMALIZE_RE = /[\s.]+/g;
function normalizeKey(input) {
  if (!input)
    return null;
  const raw = typeof input === "string" ? input : input.author ?? input.model_author?.name ?? input.owned_by;
  if (!raw)
    return null;
  return raw.toLowerCase().replace(NORMALIZE_RE, "");
}
function hasSlug(slug) {
  return slug in LOGO_DATA_URIS;
}
var SLUG_ALIASES = {
  claudecode: "claude",
  "claude-code": "claude",
  alibaba: "qwen",
  deepseek: "deepseekai",
  minimax: "minimaxai",
  spacexai: "xai",
  "fish-audio": "fishaudio"
};
function resolveSlug(input, theme) {
  const normalized = normalizeKey(input);
  if (!normalized)
    return null;
  const key = SLUG_ALIASES[normalized] ?? normalized;
  if (theme === "dark") {
    const dark = `${key}-dark`;
    if (hasSlug(dark))
      return dark;
  }
  return hasSlug(key) ? key : null;
}
function getProviderLogo(input, theme = "light") {
  const slug = resolveSlug(input, theme);
  return slug ? LOGO_DATA_URIS[slug] : "";
}

// src/app/dev-host-api.ts
var env = import.meta.env ?? {};
var sdk = null;
function getSdk() {
  if (!sdk) {
    const devApiKey = env.VITE_DEV_API_KEY;
    if (!devApiKey) {
      throw new Error("VITE_DEV_API_KEY is not set. Copy .env.example to .env and add your dev uapi_ key.");
    }
    sdk = new UnifiedAI({
      apiUrl: "",
      token: () => devApiKey,
      appId: env.VITE_UNIFIED_APP_ID || "dev-app",
      fetch: (input, init) => fetch(input, { ...init, credentials: "include" })
    });
  }
  return sdk;
}
function readTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark")
    return attr;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function getTheme() {
  return readTheme();
}
function onThemeChange(cb) {
  cb(readTheme());
  const media = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  const onMedia = () => cb(readTheme());
  media?.addEventListener("change", onMedia);
  const observer = new MutationObserver(() => cb(readTheme()));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"]
  });
  return () => {
    media?.removeEventListener("change", onMedia);
    observer.disconnect();
  };
}
function registerActions(_handlers) {
  return () => {};
}
var autoConnect = null;
function configureFromSdk() {
  try {
    configureLocalAgents({
      client: getSdk(),
      ...env.VITE_UNIFIED_API_URL ? { wsBaseUrl: `${env.VITE_UNIFIED_API_URL.replace(/\/+$/, "")}/api/v1` } : {}
    });
  } catch {}
}
function ensureLocalAgents() {
  if (!autoConnect) {
    configureFromSdk();
    autoConnect = resolveLocalAgentSource().catch(() => null);
  }
  return autoConnect;
}
function hasRunAgent() {
  ensureLocalAgents();
  return isDesktopConnected();
}
function isLocalAgentModel2(modelId) {
  return isLocalAgentModel(modelId);
}
async function listModels(options) {
  await ensureLocalAgents();
  const [gateway, local] = await Promise.all([
    getSdk().models.list().then((res) => res.data).catch(() => []),
    listLocalModels(options?.device).catch(() => [])
  ]);
  const rows = gateway.map((m) => ({
    id: m.id,
    "model-id": m.id,
    name: m.name,
    author: m.model_author?.name ?? m.owned_by,
    type: m.type,
    owned_by: m.owned_by,
    logo: m.logo,
    model_author: m.model_author,
    context_size: m.context_size ?? null
  }));
  return [...rows, ...local];
}
async function runAgent(options) {
  const { sessionKey, device, workspace, ...runOpts } = options;
  const model = runOpts.model;
  if (!model || !isLocalAgentModel(model)) {
    return await getSdk().agent.run(runOpts);
  }
  await ensureLocalAgents();
  const reachable = device ? await resolveSourceFor(device) !== null : isDesktopConnected();
  if (!reachable) {
    return {
      ok: false,
      error: "No desktop app is connected, so local coding agents can't run. Open UnifiedApp on this machine and connect it.",
      model,
      producedOutput: false,
      messages: runOpts.messages ?? []
    };
  }
  return await runLocalAgent({
    model,
    ...runOpts.messages ? { messages: runOpts.messages } : {},
    ...runOpts.prompt !== undefined ? { prompt: runOpts.prompt } : {},
    ...runOpts.tools ? { tools: runOpts.tools } : {},
    ...runOpts.signal ? { signal: runOpts.signal } : {},
    ...runOpts.onEvent ? { onEvent: runOpts.onEvent } : {},
    ...sessionKey ? { conversationId: sessionKey } : {},
    ...device ? { source: device } : {},
    ...workspace ? { workspace } : {}
  });
}
async function connectDesktop2() {
  configureFromSdk();
  autoConnect = null;
  const source = await connectDesktop();
  autoConnect = Promise.resolve(source);
  return source;
}
async function disconnectDesktop2() {
  await disconnectDesktop();
  autoConnect = Promise.resolve(null);
}
function checkDesktopAvailable2() {
  return checkDesktopAvailable();
}
function isDesktopPaired() {
  return hasBridgeToken();
}
function getDesktopStatus() {
  ensureLocalAgents();
  return getLocalAgentStatus();
}
function onDesktopStatusChange(cb) {
  ensureLocalAgents();
  return onLocalAgentStatusChange(cb);
}
async function refreshDesktop() {
  configureFromSdk();
  const source = await refreshLocalAgents();
  autoConnect = Promise.resolve(source);
  return source;
}
function listLocalDevices() {
  ensureLocalAgents();
  try {
    return listLocalAgentDevices();
  } catch {
    return [];
  }
}
async function refreshLocalDevices() {
  configureFromSdk();
  try {
    return await refreshLocalAgentDevices();
  } catch {
    return [];
  }
}
function pickWorkspaceFolder2(device) {
  return pickWorkspaceFolder(device);
}
function getUsage() {
  return Promise.resolve(null);
}
function getCurrentProject() {
  return null;
}
function onProjectChange(cb) {
  cb(null);
  return () => {};
}
function openArtifact() {
  return Promise.resolve(null);
}
function listHostDir() {
  return Promise.reject(new Error("@unified/host-api: listHostDir unavailable in standalone dev"));
}
function pickLocalFolder() {
  return Promise.resolve(null);
}
function readLocalFolderFiles() {
  return Promise.reject(new Error("@unified/host-api: readLocalFolderFiles unavailable in standalone dev"));
}
export {
  runAgent,
  registerActions,
  refreshLocalDevices,
  refreshDesktop,
  readLocalFolderFiles,
  pickWorkspaceFolder2 as pickWorkspaceFolder,
  pickLocalFolder,
  openArtifact,
  onThemeChange,
  onProjectChange,
  onDesktopStatusChange,
  listModels,
  listLocalDevices,
  listHostDir,
  isLocalAgentModel2 as isLocalAgentModel,
  isDesktopPaired,
  hasRunAgent,
  getUsage,
  getTheme,
  getSdk,
  getProviderLogo,
  getDesktopStatus,
  getCurrentProject,
  fsTools,
  disconnectDesktop2 as disconnectDesktop,
  connectDesktop2 as connectDesktop,
  checkDesktopAvailable2 as checkDesktopAvailable
};

//# debugId=E4DBF8AB5DB3768A64756E2164756E21
//# sourceMappingURL=dev-host-api.js.map
