import { parseRetryAfterValue } from "./_internal/retry";

export type UnifiedErrorCode =
  // Core / client lifecycle
  | "not_implemented"
  | "not_bootstrapped"
  // Client-side input validation (raised across resources and sync)
  | "invalid_input"
  // Caller abort observed before/between requests (files upload, chunked upload)
  | "aborted"
  // Auth & token acquisition (node OAuth flow, desktop handoff, keychain)
  | "app_not_installed"
  | "handoff_unreachable"
  | "auth_user_cancelled"
  | "auth_timeout"
  | "auth_state_mismatch"
  | "auth_token_exchange_failed"
  | "auth_refresh_failed"
  | "auth_retry_still_unauthorized"
  | "browser_open_failed"
  | "keychain_unavailable"
  // HTTP errors from unified-api (defined below; includes "not_found", which
  // the storage/fs subsystems also raise for local lookups)
  | UnifiedAIHttpErrorCode
  // Streaming
  | "stream_interrupted"
  // Storage subsystem (also raises "not_found" / "invalid_input")
  | "storage_unavailable"
  | "storage_read_only"
  | "storage_not_granted"
  // Sync subsystem (also raises "invalid_input")
  | "sync_not_granted"
  // Fs subsystem (also raises "not_found" / "invalid_input")
  | "fs_unavailable"
  | "fs_read_only"
  | "fs_not_granted"
  | "invalid_path"
  | "edit_not_found"
  | "edit_not_unique"
  // Forward-compat escape hatch: codes not yet registered here still compile,
  // while the literals above keep autocomplete and exhaustiveness hints.
  | (string & {});

export class UnifiedError extends Error {
  /**
   * Structural marker present on every SDK-typed error. The retry classifier
   * (`_internal/retry.ts` → `isNetworkErrorRetryable`) checks this property —
   * not `instanceof`, which fails when two copies of the SDK are bundled, and
   * not an error-name allowlist, which silently misses new subclasses — to
   * keep intentional SDK errors out of the network-retry path.
   */
  readonly isUnifiedSdkError = true as const;
  readonly code: UnifiedErrorCode;
  readonly status: number | undefined;

  constructor(code: UnifiedErrorCode, message: string, status?: number, cause?: unknown) {
    // ES2022 `Error.cause` (lib target is ESNext). Only pass the options bag
    // when a cause was supplied so `"cause" in err` stays false otherwise.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "UnifiedError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Construct a plain (non-HTTP) subsystem error. The subsystem error modules
 * (storage/fs/sync) re-export this behind a code type narrowed to the codes
 * that subsystem actually raises, so call sites keep tight typing while the
 * construction logic lives in one place.
 */
export function subsystemError(code: UnifiedErrorCode, message: string): UnifiedError {
  return new UnifiedError(code, message);
}

/**
 * A streaming response ended abnormally: the connection dropped after a 200 but
 * before the stream produced its terminating event (no `[DONE]` / finish). This
 * is distinct from an HTTP error (the request had already succeeded) and from a
 * caller abort (that surfaces as the caller's own AbortError, never this). It
 * typically means the upstream provider or gateway was slow enough to hit an
 * idle timeout, or buffered a long generation and the socket was closed mid-
 * flight. Retrying, or switching to a faster model, usually clears it. The
 * original transport error (e.g. an ECONNRESET) is attached as `cause`.
 */
export class StreamInterruptedError extends UnifiedError {
  constructor(cause?: unknown, message?: string) {
    super(
      "stream_interrupted",
      message ??
        "The model stream ended unexpectedly before completing — the connection dropped mid-response. The model may be slow or the upstream may have timed out; retry, or switch to a different model.",
      undefined,
      cause,
    );
    this.name = "StreamInterruptedError";
  }
}

export type UnifiedAIAuthErrorCode = "auth_refresh_failed" | "auth_retry_still_unauthorized";

export type UnifiedAIHttpErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "model_deprecated"
  | "rate_limited"
  | "usage_limit_exceeded"
  | "plan_required"
  | "storage_not_granted"
  | "sync_not_granted"
  | "fs_not_granted"
  | "server_error"
  | "request_failed";

/**
 * Base class for HTTP errors returned by the unified-api backend. All
 * status-specific subclasses (`AuthenticationError`, `RateLimitError`, etc.)
 * extend this, so consumers can catch broadly with `UnifiedAIError` or
 * narrowly via `instanceof` on a concrete subclass.
 */
export class UnifiedAIError extends UnifiedError {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly requestId: string | undefined;

  constructor(
    code: UnifiedAIHttpErrorCode | UnifiedAIAuthErrorCode,
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
    cause?: unknown,
  ) {
    super(code, message, status, cause);
    this.name = "UnifiedAIError";
    this.body = body;
    this.headers = headers;
    this.requestId = headers?.["x-request-id"] ?? headers?.["request-id"];
  }
}

export class BadRequestError extends UnifiedAIError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("bad_request", message, status, body, headers);
    this.name = "BadRequestError";
  }
}

export class AuthenticationError extends UnifiedAIError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
    code: UnifiedAIHttpErrorCode | UnifiedAIAuthErrorCode = "unauthorized",
    cause?: unknown,
  ) {
    super(code, message, status, body, headers, cause);
    this.name = "AuthenticationError";
  }
}

/**
 * Subclass of `AuthenticationError` used when the SDK's automatic refresh
 * flow fails (refresh-token exchange errored, or a retried request still
 * returned 401). Subclassing `AuthenticationError` means user code that
 * branches on `instanceof AuthenticationError` catches both the initial
 * 401 and the refresh-failure case, and headers/requestId from the failing
 * response are surfaced for support correlation.
 */
export class UnifiedAIAuthError extends AuthenticationError {
  constructor(
    code: UnifiedAIAuthErrorCode,
    message: string,
    status?: number,
    body?: unknown,
    headers?: Readonly<Record<string, string>>,
    cause?: unknown,
  ) {
    super(message, status ?? 401, body, headers, code, cause);
    this.name = "UnifiedAIAuthError";
  }
}

/**
 * The credential was accepted but is not allowed to perform this request
 * (HTTP 403) — e.g. an app-scoped token whose scope doesn't cover the
 * endpoint, or a key disabled by policy. Distinct from
 * `AuthenticationError` (401: credential missing/invalid, where a refresh
 * may help) — a 403 is terminal for the credential: neither retrying nor
 * refreshing will clear it.
 */
export class ForbiddenError extends UnifiedAIError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
    code: UnifiedAIHttpErrorCode = "forbidden",
  ) {
    super(code, message, status, body, headers);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends UnifiedAIError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("not_found", message, status, body, headers);
    this.name = "NotFoundError";
  }
}

/**
 * The requested model still exists in the catalog but has been retired and
 * is no longer callable. unified-api returns HTTP 410 with a body
 * `{code: "model_deprecated"}` from any call-time endpoint (chat, messages,
 * embeddings, images, responses, …) when a deprecated model id is requested;
 * the deprecated model is also absent from `models.list()`.
 *
 * Detected via the body `code` rather than the 410 status alone, because 410
 * is also used for expired upload sessions. Retrying will not help — switch
 * to a current model (see `models.list()`).
 */
export class DeprecatedModelError extends UnifiedAIError {
  readonly isDeprecated = true as const;

  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("model_deprecated", message, status, body, headers);
    this.name = "DeprecatedModelError";
  }
}

/**
 * Derive `RateLimitError.retryAfter` (whole SECONDS) from the shared
 * Retry-After parser in `_internal/retry.ts` (which returns milliseconds and
 * guards against empty/whitespace-only headers — `Number("   ")` is 0, which
 * would otherwise read as "retry immediately"). Kept as a thin wrapper so the
 * retry loop's delay and this public field can never diverge.
 */
function parseRetryAfter(
  headers: Readonly<Record<string, string>> | undefined,
): number | undefined {
  const ms = parseRetryAfterValue(headers?.["retry-after"]);
  return ms === undefined ? undefined : Math.ceil(ms / 1000);
}

/**
 * Generic rate limiting: too many requests in a window. Honor `retryAfter`
 * (seconds) to back off.
 *
 * Sibling — NOT parent — of `UsageLimitError`. A 429 from plan-quota
 * exhaustion throws `UsageLimitError`, not `RateLimitError`, so a generic
 * retry wrapper that only checks `instanceof RateLimitError` will miss
 * quota errors (which is correct: retrying won't help). Catch both
 * explicitly when you want to surface 429s uniformly. Order matters if
 * you use `else if` chains — `UsageLimitError` does NOT pass an
 * `instanceof RateLimitError` check, but check the more specific class
 * first regardless to stay future-proof.
 */
export class RateLimitError extends UnifiedAIError {
  readonly retryAfter: number | undefined;

  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("rate_limited", message, status, body, headers);
    this.name = "RateLimitError";
    this.retryAfter = parseRetryAfter(headers);
  }
}

/**
 * Plan usage limit exhausted for the current billing window. Unlike
 * `RateLimitError`, this won't clear by waiting a few seconds — the user
 * must upgrade or wait until `usagePeriodStart` rolls over.
 *
 * `periodCost` and `limit` are parsed from the server message when present
 * (unified-api currently surfaces them as `"Window cost: $X.XXXX / $Y.YY"`).
 * Both are undefined if the message shape changes.
 */
export class UsageLimitError extends UnifiedAIError {
  readonly periodCost: number | undefined;
  readonly limit: number | undefined;
  readonly resetAt: string | undefined;
  readonly isUsageLimit = true as const;

  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("usage_limit_exceeded", message, status, body, headers);
    this.name = "UsageLimitError";
    const parsed = parseUsageFields(body);
    this.periodCost = parsed.periodCost;
    this.limit = parsed.limit;
    this.resetAt = parsed.resetAt;
  }
}

/**
 * Cloud sync/persistence was refused because the caller's plan is Free.
 * Sibling — NOT child — of {@link ForbiddenError}: a generic 403 handler
 * that only checks `instanceof ForbiddenError` will miss this, which is
 * correct (this is an upgrade CTA, not a permission bug). HTTP 403 with
 * body `{ code: "plan_required", required_plan: "Pro", current_plan_id }`.
 *
 * Local/injected backends never emit this — only cloud paths
 * (`/api/v1/storage/*`, `/api/v1/fs/*`, `/api/v1/sync/:id/{bootstrap,delta,apply}`).
 */
export class PlanRequiredError extends UnifiedAIError {
  readonly isPlanRequired = true as const;
  /** Plan name the caller must have. Currently always `"Pro"`. */
  readonly requiredPlan: string;
  /** `plans.id` / `account_type` of the caller, when the server sent it. */
  readonly currentPlanId: number | undefined;

  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("plan_required", message, status, body, headers);
    this.name = "PlanRequiredError";
    const parsed = parsePlanRequiredFields(body);
    this.requiredPlan = parsed.requiredPlan;
    this.currentPlanId = parsed.currentPlanId;
  }
}

export class ServerError extends UnifiedAIError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("server_error", message, status, body, headers);
    this.name = "ServerError";
  }
}

function parsePlanRequiredFields(body: unknown): {
  requiredPlan: string;
  currentPlanId: number | undefined;
} {
  let requiredPlan = "Pro";
  let currentPlanId: number | undefined;
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.required_plan === "string" && obj.required_plan) {
      requiredPlan = obj.required_plan;
    }
    if (typeof obj.current_plan_id === "number" && Number.isFinite(obj.current_plan_id)) {
      currentPlanId = obj.current_plan_id;
    }
  }
  return { requiredPlan, currentPlanId };
}

/** Body `{ code: "plan_required" }` — keyed on the code, not the 403 status. */
export function isPlanRequiredBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return (body as Record<string, unknown>).code === "plan_required";
}

const NOT_GRANTED_CODES = new Set(["storage_not_granted", "sync_not_granted", "fs_not_granted"]);

function notGrantedCodeFromBody(body: unknown): UnifiedAIHttpErrorCode | undefined {
  if (!body || typeof body !== "object") return undefined;
  const code = (body as Record<string, unknown>).code;
  if (typeof code === "string" && NOT_GRANTED_CODES.has(code)) {
    return code as UnifiedAIHttpErrorCode;
  }
  return undefined;
}

function parseUsageFields(body: unknown): {
  periodCost: number | undefined;
  limit: number | undefined;
  resetAt: string | undefined;
} {
  let periodCost: number | undefined;
  let limit: number | undefined;
  let resetAt: string | undefined;
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.period_cost === "number") periodCost = obj.period_cost;
    if (typeof obj.limit === "number") limit = obj.limit;
    if (typeof obj.reset_at === "string") resetAt = obj.reset_at;
    const msg = typeof obj.message === "string" ? obj.message : undefined;
    if (msg && (periodCost === undefined || limit === undefined)) {
      // Anchored to the "Window cost: $X / $Y" phrasing that unified-api
      // emits today (src/lib/auth.ts → enforceUsageLimit). Unanchored
      // matching would mis-extract from any prior "$X / $Y" substring in
      // a future message wording.
      const m = msg.match(
        /Window\s+cost:\s*\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$([0-9]+(?:\.[0-9]+)?)/i,
      );
      if (m) {
        if (periodCost === undefined) periodCost = Number(m[1]);
        if (limit === undefined) limit = Number(m[2]);
      }
    }
  }
  return { periodCost, limit, resetAt };
}

/**
 * Distinguish quota exhaustion from generic throttling. unified-api's
 * `apiKeyAuthPlugin` emits `{message: "Usage limit exceeded..."}` for
 * billing-window exhaustion; its in-memory rate limiter emits
 * `{error: "rate_limited"}` for transient throttling.
 *
 * Match conditions are intentionally narrow to avoid false positives:
 *   - explicit `code: "usage_limit_exceeded"`, OR
 *   - `period_cost` AND `limit` both present (the structured shape we'd
 *     prefer unified-api to migrate to), OR
 *   - `message` starting with "Usage limit exceeded" (current shape).
 *
 * NB: a single `limit` field alone is NOT enough — a future rate-limit
 * response may include `{error: "rate_limited", limit: 60}` (requests
 * per window), and that should stay a `RateLimitError`.
 */
export function isUsageLimitBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  if (obj.code === "usage_limit_exceeded") return true;
  if (typeof obj.period_cost === "number" && typeof obj.limit === "number") return true;
  if (typeof obj.message === "string" && /^\s*usage limit exceeded\b/i.test(obj.message)) {
    return true;
  }
  return false;
}

/**
 * A retired model. unified-api emits `{code: "model_deprecated"}` (HTTP 410)
 * for call-time requests against a deprecated model id. Keyed on the explicit
 * `code` rather than the status, because 410 is also used for expired upload
 * sessions — those must stay generic, not surface as a DeprecatedModelError.
 */
function isDeprecatedModelBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return (body as Record<string, unknown>).code === "model_deprecated";
}

export function httpErrorCodeFromStatus(status: number): UnifiedAIHttpErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "request_failed";
}

/**
 * Client-side constructor for a Pro-gate refusal (no HTTP round-trip). The
 * body shape matches what unified-api emits so `instanceof PlanRequiredError`
 * and `err.code === "plan_required"` work the same as the mapped HTTP error.
 */
export function planRequiredError(currentPlanId = 0, requiredPlan = "Pro"): PlanRequiredError {
  const body = {
    code: "plan_required" as const,
    required_plan: requiredPlan,
    current_plan_id: currentPlanId,
    message: `Cloud sync and persistence require a ${requiredPlan} plan.`,
  };
  return new PlanRequiredError(body.message, 403, body);
}

/**
 * Build the right typed error subclass for an HTTP failure. Falls back to
 * `UnifiedAIError` for statuses without a dedicated class (generic 4xx).
 */
export function buildHttpError(
  message: string,
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): UnifiedAIError {
  // Checked before the status branches: a deprecated-model error is identified
  // by its body code (it arrives as 410, which otherwise has no dedicated class
  // and is shared with expired upload sessions).
  if (isDeprecatedModelBody(body)) {
    return new DeprecatedModelError(message, status, body, headers);
  }
  // Upgrade-shaped 403: Free caller hit a Pro-gated cloud path. Sibling of
  // ForbiddenError so upgrade UI can catch this without treating it as a
  // permission bug.
  if (isPlanRequiredBody(body)) {
    return new PlanRequiredError(message, status, body, headers);
  }
  const notGranted = notGrantedCodeFromBody(body);
  if (notGranted) {
    return new ForbiddenError(message, status, body, headers, notGranted);
  }
  if (status === 400) return new BadRequestError(message, status, body, headers);
  if (status === 401) return new AuthenticationError(message, status, body, headers);
  if (status === 403) return new ForbiddenError(message, status, body, headers);
  if (status === 404) return new NotFoundError(message, status, body, headers);
  if (status === 429) {
    return isUsageLimitBody(body)
      ? new UsageLimitError(message, status, body, headers)
      : new RateLimitError(message, status, body, headers);
  }
  if (status >= 500) return new ServerError(message, status, body, headers);
  return new UnifiedAIError(httpErrorCodeFromStatus(status), message, status, body, headers);
}

export function headersToRecord(h: Headers): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return Object.freeze(out);
}
