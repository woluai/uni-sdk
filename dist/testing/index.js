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

// src/resources/usage.ts
var PLAN_FREE_ID = 0;
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

// src/resources/sync/fake-server.ts
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
function errorResponse(status, code) {
  return jsonResponse(status, { code, message: code });
}
function encodeCursor(c) {
  return btoa(JSON.stringify(c));
}
function decodeCursor(raw) {
  try {
    const c = JSON.parse(atob(raw));
    if (typeof c.e !== "number" || typeof c.a !== "number")
      return null;
    return { e: c.e, a: c.a };
  } catch {
    return null;
  }
}

class FakeSyncServer {
  baseUrl;
  grants;
  shared;
  workspaces = new Map;
  meta = new Map;
  failApply = false;
  offline = false;
  cloudPlanId;
  requestCount = 0;
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl ?? "https://fake-sync.test";
    this.shared = new Set(opts.sharedWorkspaces ?? []);
    this.cloudPlanId = opts.cloudPlanId;
    this.grants = opts.grants ?? new MemoryGrantStore;
  }
  setCloudPlanId(id) {
    this.cloudPlanId = id;
  }
  bumpEpoch(workspaceId) {
    this.ws(workspaceId).epoch += 1;
  }
  registerWorkspace(workspaceId, meta = {}) {
    this.ws(workspaceId);
    this.meta.set(workspaceId, {
      name: meta.name ?? workspaceId,
      kind: meta.kind ?? "team",
      role: meta.role ?? "owner"
    });
  }
  seed(workspaceId, records) {
    this.applyOps(workspaceId, records.map((r) => ({ ns: r.ns, collection: r.collection, id: r.id, replace: r.metadata })));
  }
  applyOps(workspaceId, ops) {
    const ws = this.ws(workspaceId);
    for (const op of ops)
      this.applyOne(ws, op);
  }
  remove(workspaceId, ns, collection, id) {
    this.applyOne(this.ws(workspaceId), { ns, collection, id, delete: true });
  }
  setApplyFailing(on) {
    this.failApply = on;
  }
  setOffline(on) {
    this.offline = on;
  }
  fetch = async (input, init) => {
    this.requestCount += 1;
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, this.baseUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const si = parts.indexOf("sync");
    if (si < 0)
      return errorResponse(404, "route_not_found");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headerMap(input, init);
    const caller = callerFromHeaders(headers);
    if (parts.length === si + 2 && parts[si + 1] === "workspaces" && method === "GET") {
      return this.listWorkspaces();
    }
    if (parts.length >= si + 2 && parts[si + 1] === "grants") {
      return this.handleGrants(method, parts.slice(si + 2), init, caller, url);
    }
    if (parts.length < si + 3)
      return errorResponse(404, "route_not_found");
    const workspaceId = decodeURIComponent(parts[si + 1] ?? "");
    const action = parts[si + 2];
    const gated = this.planGate();
    if (gated)
      return gated;
    if (action === "bootstrap" && method === "GET") {
      return this.bootstrap(workspaceId, url, caller);
    }
    if (action === "delta" && method === "GET") {
      return this.delta(workspaceId, url, caller);
    }
    if (action === "apply" && method === "POST") {
      return this.apply(workspaceId, init, caller);
    }
    return errorResponse(404, "route_not_found");
  };
  listWorkspaces() {
    const ids = new Set([...this.meta.keys(), ...this.workspaces.keys()]);
    const workspaces = [...ids].map((id) => {
      const m = this.meta.get(id);
      return { id, name: m?.name ?? id, kind: m?.kind ?? "personal", role: m?.role ?? "owner" };
    });
    return jsonResponse(200, { workspaces });
  }
  bootstrap(workspaceId, url, caller) {
    if (this.offline)
      return errorResponse(503, "unavailable");
    const ws = this.ws(workspaceId);
    const limit = this.limit(url);
    const cursorRaw = url.searchParams.get("cursor");
    let after = 0;
    if (cursorRaw !== null) {
      const c = decodeCursor(cursorRaw);
      if (!c)
        return errorResponse(400, "invalid_cursor");
      if (c.e !== ws.epoch)
        return errorResponse(409, "cursor_epoch_mismatch");
      after = c.a;
    }
    const live = [...ws.records.values()].filter((r) => !r.deleted && r.syncId > after && this.nsVisible(caller, r.ns, "read")).sort((a, b) => a.syncId - b.syncId);
    const page = live.slice(0, limit);
    const complete = live.length <= limit;
    const lastInPage = page[page.length - 1];
    const newAfter = complete ? this.maxSyncId(ws) : lastInPage?.syncId ?? after;
    return jsonResponse(200, {
      records: page.map(toWire),
      cursor: encodeCursor({ e: ws.epoch, a: newAfter }),
      complete
    });
  }
  delta(workspaceId, url, caller) {
    if (this.offline)
      return errorResponse(503, "unavailable");
    const ws = this.ws(workspaceId);
    const limit = this.limit(url);
    const cursorRaw = url.searchParams.get("cursor");
    let after = 0;
    if (cursorRaw !== null) {
      const c = decodeCursor(cursorRaw);
      if (!c)
        return errorResponse(400, "invalid_cursor");
      if (c.e !== ws.epoch)
        return errorResponse(409, "cursor_epoch_mismatch");
      after = c.a;
    }
    const changed = [...ws.records.values()].filter((r) => r.syncId > after && this.nsVisible(caller, r.ns, "read")).sort((a, b) => a.syncId - b.syncId);
    const page = changed.slice(0, limit);
    const hasMore = changed.length > limit;
    const lastInPage = page[page.length - 1];
    const newAfter = lastInPage?.syncId ?? after;
    return jsonResponse(200, {
      records: page.map((r) => r.deleted ? toTombstone(r) : toWire(r)),
      cursor: encodeCursor({ e: ws.epoch, a: newAfter }),
      hasMore
    });
  }
  apply(workspaceId, init, caller) {
    if (this.failApply)
      return errorResponse(500, "internal");
    const ws = this.ws(workspaceId);
    let body;
    try {
      body = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      return errorResponse(400, "bad_request");
    }
    const ops = body.ops;
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 200) {
      return errorResponse(400, "bad_request");
    }
    const isShared = this.shared.has(workspaceId);
    const results = [];
    for (const op of ops) {
      const ns = String(op.ns ?? "");
      if (!this.nsVisible(caller, ns, "readwrite")) {
        return jsonResponse(403, {
          code: "sync_not_granted",
          message: `no grant to access namespace "${ns}"`
        });
      }
      if (isShared && (op.blob_hash !== undefined || op.bytes !== undefined)) {
        return errorResponse(400, "blobs_not_supported_in_shared_workspaces");
      }
      if (op.replace !== undefined && typeof op.replace !== "boolean") {
        return errorResponse(400, "invalid_op_replace_must_be_boolean");
      }
      const normalized = typeof op.replace === "boolean" ? op.replace ? { ...op, replace: op.patch ?? {}, patch: undefined } : { ...op, replace: undefined } : op;
      results.push(this.applyOne(ws, normalized));
    }
    return jsonResponse(200, { results });
  }
  applyOne(ws, op) {
    const ns = String(op.ns);
    const collection = String(op.collection);
    const id = String(op.id);
    const key = pkOf(ns, collection, id);
    const existing = ws.records.get(key);
    const now = Date.now();
    ws.seq += 1;
    const syncId = ws.seq;
    const version = (existing?.version ?? 0) + 1;
    let rec;
    if (op.delete === true) {
      rec = {
        ns,
        collection,
        id,
        metadata: {},
        version,
        deleted: true,
        syncId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        hasBlob: false
      };
    } else {
      let metadata;
      if (op.replace !== undefined)
        metadata = { ...op.replace };
      else if (op.patch !== undefined)
        metadata = mergePatch(existing?.metadata ?? {}, op.patch);
      else
        metadata = existing ? { ...existing.metadata } : {};
      const hasBlob = op.blob_hash !== undefined || op.bytes !== undefined ? true : existing?.hasBlob ?? false;
      const blobEncoding = op.blob_encoding ?? existing?.blobEncoding;
      rec = {
        ns,
        collection,
        id,
        metadata,
        version,
        deleted: false,
        syncId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        hasBlob,
        ...blobEncoding !== undefined ? { blobEncoding } : {}
      };
    }
    ws.records.set(key, rec);
    return { ns, collection, id, syncId, version };
  }
  ws(workspaceId) {
    let s = this.workspaces.get(workspaceId);
    if (!s) {
      s = { epoch: 1, seq: 0, records: new Map };
      this.workspaces.set(workspaceId, s);
    }
    return s;
  }
  limit(url) {
    const raw = Number(url.searchParams.get("limit"));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
  }
  maxSyncId(ws) {
    let max = 0;
    for (const r of ws.records.values())
      if (r.syncId > max)
        max = r.syncId;
    return max;
  }
  planGate() {
    if (this.cloudPlanId === undefined)
      return null;
    if (this.cloudPlanId > PLAN_FREE_ID)
      return null;
    return jsonResponse(403, {
      code: "plan_required",
      required_plan: "Pro",
      current_plan_id: this.cloudPlanId,
      message: "Cloud sync and persistence require a Pro plan."
    });
  }
  nsVisible(caller, ns, mode) {
    if (!caller.appId.trim())
      return true;
    return namespaceAccess(this.grants, caller, ns, mode);
  }
  handleGrants(method, rest, init, caller, url) {
    const own = caller.appId.trim();
    if (!own)
      return errorResponse(400, "invalid_input");
    if (rest.length === 0 && method === "GET") {
      const ns = (url.searchParams.get("ns") ?? "").trim() || own;
      if (ns !== own)
        return errorResponse(400, "invalid_input");
      return jsonResponse(200, { grants: this.grants.list(ns) });
    }
    if (rest.length === 0 && method === "POST") {
      let body;
      try {
        body = JSON.parse(String(init?.body ?? "{}"));
      } catch {
        return errorResponse(400, "bad_request");
      }
      const ns = typeof body.ns === "string" && body.ns.trim() ? body.ns.trim() : own;
      if (ns !== own)
        return errorResponse(400, "invalid_input");
      if (!body.grantee)
        return errorResponse(400, "invalid_input");
      const mode = body.mode === "readwrite" ? "readwrite" : "read";
      try {
        const grant = this.grants.upsert(ns, body.grantee, mode);
        return jsonResponse(200, grant);
      } catch {
        return errorResponse(400, "invalid_input");
      }
    }
    if (rest.length === 1 && method === "DELETE") {
      const id = decodeURIComponent(rest[0] ?? "");
      const g = this.grants.get(id);
      if (g && g.ns !== own)
        return errorResponse(403, "forbidden");
      return jsonResponse(200, { revoked: this.grants.delete(id) });
    }
    return errorResponse(404, "route_not_found");
  }
}
function toWire(r) {
  return {
    ns: r.ns,
    collection: r.collection,
    id: r.id,
    metadata: r.metadata,
    version: r.version,
    deleted: r.deleted,
    syncId: r.syncId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    hasBlob: r.hasBlob,
    ...r.blobEncoding !== undefined ? { blobEncoding: r.blobEncoding } : {}
  };
}
function toTombstone(r) {
  return { ...toWire(r), deleted: true, metadata: {} };
}
function headerMap(input, init) {
  if (typeof input !== "string" && !(input instanceof URL))
    return input.headers;
  return new Headers(init?.headers);
}
function callerFromHeaders(headers) {
  const appId = headers.get("x-unified-app") ?? "";
  const kind = headers.get("x-unified-caller") === "agent" ? "agent" : "app";
  return { appId, kind };
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
  const location = asString(metadata.location);
  if (location !== undefined)
    base.location = location;
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
function encodeCursor2(cursor) {
  return bytesToBase64Url(utf8Encoder3.encode(JSON.stringify(cursor)));
}
function decodeCursor2(token) {
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
  return encodeCursor2(o === undefined ? { v: 1, i: id } : { v: 1, o, i: id });
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
      const cursor = decodeCursor2(q.after);
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

// src/testing/local-sharing.ts
function createLocalSharingRuntime(opts = {}) {
  const grantStore = new MemoryGrantStore;
  const storage = new MemoryBackend({ grants: grantStore });
  const server = new FakeSyncServer({
    grants: grantStore,
    ...opts.cloudPlanId !== undefined ? { cloudPlanId: opts.cloudPlanId } : {}
  });
  return {
    grantStore,
    storage,
    server,
    client({ appId, callerKind }) {
      return new UnifiedAI({
        appId,
        token: "local",
        storage,
        grantStore,
        apiUrl: server.baseUrl,
        fetch: server.fetch,
        ...callerKind ? { callerKind } : {}
      });
    }
  };
}
export {
  createLocalSharingRuntime,
  FakeSyncServer
};

//# debugId=9D5CBD22C16D9A2664756E2164756E21
//# sourceMappingURL=index.js.map
