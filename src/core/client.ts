import { Actions } from "../resources/actions";
import { Agent } from "../resources/agent";
import { Artifacts } from "../resources/artifacts";
import { Audio } from "../resources/audio";
import { Calendar } from "../resources/calendar";
import { Chat } from "../resources/chat";
import { Decisions } from "../resources/decisions";
import { Embeddings } from "../resources/embeddings";
import { Files } from "../resources/files";
import { Fs } from "../resources/fs";
import { Helpers } from "../resources/helpers";
import { Images } from "../resources/images";
import { Memory } from "../resources/memory";
import { Messages } from "../resources/messages";
import { Models } from "../resources/models";
import { Projects } from "../resources/projects";
import { References } from "../resources/references";
import { Responses } from "../resources/responses";
import { Storage } from "../resources/storage";
import { Sync } from "../resources/sync";
import { Usage } from "../resources/usage";
import { Users } from "../resources/users";
import { Videos } from "../resources/videos";
import { LruCache, cacheKey, resolveCacheConfig } from "./_internal/cache";
import {
  drainResponse,
  formatBody,
  httpErrorMessage,
  readErrorBody,
} from "./_internal/http-errors";
import {
  type RetryAttempt,
  type RetryConfig,
  type RetryListener,
  isIdempotent,
  isNetworkErrorRetryable,
  isRetryableStatus,
  nextDelay,
  resolveRetryConfig,
  delay as retryDelay,
} from "./_internal/retry";
import { prepareUploadProgress } from "./_internal/upload-progress";
import { Core, type CoreOptions, type RequestOptions } from "./core";
import {
  UnifiedAIAuthError,
  UnifiedAIError,
  UnifiedError,
  buildHttpError,
  headersToRecord,
  isUsageLimitBody,
} from "./errors";
import type { Identity } from "./identity";
import { Session } from "./session";

const DEFAULT_API_URL = "https://api.unifiedai.app";

// Browser bundles don't have `process`. Read env vars defensively so importing
// the SDK in a Vite/Workers/edge runtime doesn't throw at construction time.
function envVar(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env[name];
}

/**
 * Options for the browser-safe UnifiedAI client.
 *
 * To use OAuth (PKCE bootstrap, keychain storage, handoff discovery), import
 * from "@unifiedai/sdk/node" instead — that entry exposes a UnifiedAI subclass
 * with the additional `authorizeUrl`, `tokenUrl`, `discovery`, `keychain`,
 * `openUrl`, and `loopback` options.
 */
/**
 * The browser/core entry has no OAuth machinery. Every "you need the node
 * entry" site shares this factory so consumers can branch on a single
 * `not_implemented` code and get consistent guidance.
 */
function oauthUnavailable(reason: string): UnifiedError {
  return new UnifiedError(
    "not_implemented",
    `${reason}. Pass \`token\` for trusted-token mode, or import UnifiedAI from '@unifiedai/sdk/node' for OAuth.`,
  );
}

export interface UnifiedAIOptions extends CoreOptions {}

/**
 * Browser-safe UnifiedAI client. Requires trusted-token mode (a string or
 * async callback supplied via the `token` option). For OAuth flows, see
 * `@unifiedai/sdk/node`.
 *
 * Subclasses extend this base to add bootstrap strategies. The HTTP request
 * and stream paths live here so all auth modes share a single 401-retry flow;
 * mode-specific behavior is reached through `protected` hooks.
 */
export class UnifiedAI extends Core {
  // Resources are memoized lazy getters rather than eager fields: a client
  // that only ever calls `sdk.chat` shouldn't pay ~22 allocations at
  // construction. Every resource constructor is a pure field assignment (no
  // listeners, timers, or I/O), so deferring construction is observably
  // identical. Note this is an allocation win only — the static imports
  // remain, so all resource classes still ship in the bundle.
  #models?: Models;
  #usage?: Usage;
  #users?: Users;
  #chat?: Chat;
  #responses?: Responses;
  #messages?: Messages;
  #images?: Images;
  #files?: Files;
  #audio?: Audio;
  #videos?: Videos;
  #embeddings?: Embeddings;
  #decisions?: Decisions;
  #helpers?: Helpers;
  #calendar?: Calendar;
  #projects?: Projects;
  #references?: References;
  #artifacts?: Artifacts;
  #memory?: Memory;
  #actions?: Actions;
  #storage?: Storage;
  #fs?: Fs;
  #sync?: Sync;
  #agent?: Agent;

  get models(): Models {
    return (this.#models ??= new Models(this));
  }
  get usage(): Usage {
    return (this.#usage ??= new Usage(this));
  }
  get users(): Users {
    return (this.#users ??= new Users(this));
  }
  get chat(): Chat {
    return (this.#chat ??= new Chat(this));
  }
  get responses(): Responses {
    return (this.#responses ??= new Responses(this));
  }
  get messages(): Messages {
    return (this.#messages ??= new Messages(this));
  }
  get images(): Images {
    return (this.#images ??= new Images(this));
  }
  get files(): Files {
    return (this.#files ??= new Files(this));
  }
  get audio(): Audio {
    return (this.#audio ??= new Audio(this));
  }
  get videos(): Videos {
    return (this.#videos ??= new Videos(this));
  }
  get embeddings(): Embeddings {
    return (this.#embeddings ??= new Embeddings(this));
  }
  get decisions(): Decisions {
    return (this.#decisions ??= new Decisions(this));
  }
  get helpers(): Helpers {
    return (this.#helpers ??= new Helpers());
  }
  get calendar(): Calendar {
    return (this.#calendar ??= new Calendar());
  }

  /**
   * Cross-app projects (`sdk.projects`). A Project gathers artifacts from
   * different apps into one user-owned workspace; `addLink` attaches an artifact
   * or a portion of one. Requires auth (writes to unified-api).
   */
  get projects(): Projects {
    return (this.#projects ??= new Projects(this));
  }

  /**
   * Reference resolution (`sdk.references`). Reads a project link back into
   * content — including across apps — authorized by project membership. Resolves
   * a `uniref://` handle (or linkId) to a portion snapshot or a live artifact.
   */
  get references(): References {
    return (this.#references ??= new References(this));
  }

  /**
   * Artifacts (`sdk.artifacts`). The cross-app export contract — publish a
   * canonical, self-contained snapshot of an app's work (design/doc/sheet) that
   * chat, other apps, and external agents can consume. Versions are whole
   * snapshots; `resolveRef` reads an `artifact://<id>@<v>` reference.
   */
  get artifacts(): Artifacts {
    return (this.#artifacts ??= new Artifacts(this));
  }

  /**
   * Agent memory (`sdk.memory`). The server-side append-only ledger — append
   * events (the server stamps taint origin + applied/proposed status from the
   * credential), sync since a cursor, and lexically query. Standalone-app parity
   * with the desktop shell's memory.
   */
  get memory(): Memory {
    return (this.#memory ??= new Memory(this));
  }

  /**
   * Cross-app actions (`sdk.actions`). Declare this app's ActionSpecs and SERVE
   * invocations over a pull channel (`serve(handlers)` polls, runs, responds) — or
   * INVOKE another app's action (`invoke` + `awaitResult`). Offline apps report as
   * unavailable so callers can fall back to artifacts.
   */
  get actions(): Actions {
    return (this.#actions ??= new Actions(this));
  }

  /**
   * App-namespaced storage (`STORAGE-SPEC.md`). Typed collections over a
   * swappable backend — the server-backed Cloud store (unified-api → Supabase)
   * when a token is configured, or a host-injected backend. Requires a token (or
   * an injected backend): there is no local browser fallback. Cross-app and
   * agent access go through {@link Storage.grants}. Cloud paths are Pro-gated
   * (`PlanRequiredError`).
   */
  get storage(): Storage {
    return (this.#storage ??= new Storage(this));
  }

  /**
   * App-namespaced file workspace (`docs/capability-platform.md`). A jailed
   * directory tree the app — and the agent loop running on its behalf — reads,
   * writes, and edits. The server-backed Cloud workspace (unified-api → Supabase)
   * when a token is configured, or a host-injected backend. Requires a token (or
   * an injected backend): there is no local browser fallback.
   */
  get fs(): Fs {
    return (this.#fs ??= new Fs(this));
  }

  /**
   * Per-workspace sync engine (`sdk.sync`, PROTOCOL.md "Sync"). `sync.workspace(id)`
   * returns a live-first `WorkspaceSync` that hydrates from an optional injected
   * `SnapshotBackend`, catches up (bootstrap → delta) against unified-api, polls
   * deltas, and applies optimistic writes. One cached engine per workspace id.
   * `sync.grants` publishes a namespace to other apps and authenticated agents.
   * Cloud bootstrap/delta/apply are Pro-gated.
   */
  get sync(): Sync {
    return (this.#sync ??= new Sync(this));
  }

  /**
   * Unopinionated tool-loop scaffolding (`docs/capability-platform.md`).
   * `sdk.agent.run({ system, prompt, tools, … })` runs the model with the app's
   * OWN prompt and tools (compose `fsTools(sdk.fs.namespace())` /
   * `storageTools(sdk.storage.namespace())` / `syncTools(ws, ns)` / `webTools()`
   * with your own), dispatching tool-calls until the model stops. No prompt or
   * tool policy is baked in — the app orchestrates.
   */
  get agent(): Agent {
    return (this.#agent ??= new Agent(this));
  }

  /**
   * Observable auth-session surface: `isAuthenticated()`, `expiresAt`,
   * `identity`, and `onChange(listener)`. In trusted-token mode it reflects
   * the configured token (active while one is set); the node OAuth subclass
   * additionally tracks expiry, caches identity, and drives proactive refresh.
   */
  readonly session: Session;

  private trustedRefreshPromise: Promise<string> | undefined;
  private readonly responseCache: LruCache | undefined;

  constructor(options: UnifiedAIOptions = {}) {
    super({
      ...options,
      apiUrl: options.apiUrl ?? envVar("UNIFIEDAI_API_URL") ?? DEFAULT_API_URL,
    });
    const cacheCfg = resolveCacheConfig(this.options.cache);
    this.responseCache = cacheCfg ? new LruCache(cacheCfg) : undefined;
    // Trusted-token mode is "authenticated" the moment a token is configured —
    // the host owns the lifecycle so the SDK can't see expiry, but it can
    // truthfully report that a session exists. OAuth mode starts signed-out
    // until bootstrap() establishes tokens.
    this.session = new Session(this.options.token !== undefined ? "active" : "signed_out");
  }

  /**
   * In trusted-token mode, bootstrap is a no-op (the host owns the lifecycle).
   * Subclasses override this to run OAuth bootstrap. Calling bootstrap on the
   * base class without a `token` configured throws — those callers should
   * import the node subclass instead.
   */
  bootstrap(): Promise<void> {
    if (this.options.token !== undefined) return Promise.resolve();
    return Promise.reject(oauthUnavailable("OAuth bootstrap is unavailable in the browser entry"));
  }

  identity(): Identity {
    throw new UnifiedError(
      "not_bootstrapped",
      "identity() requires the node entry or a subclass that owns user-session state.",
    );
  }

  /**
   * The bearer this client would send on a request made right now — the
   * configured trusted token, or (node OAuth subclass) the current access
   * token, acquiring one if needed.
   *
   * Public because a handful of surfaces authenticate OUTSIDE `request()` and
   * must reuse the client's own credential rather than re-deriving one: the
   * local-agent relay's WebSocket (which carries its bearer in the
   * `Sec-WebSocket-Protocol` value, since browsers cannot set headers on an
   * upgrade) is the motivating case. Rejects with the same
   * `not_bootstrapped` / OAuth-unavailable errors `request()` would.
   */
  accessToken(): Promise<string> {
    return this.getInitialAccessToken();
  }

  /**
   * No-op in trusted-token mode — the host owns the token lifecycle, so there
   * is no SDK-side session to clear. Subclasses that own session state (the
   * node OAuth subclass) override this to revoke and wipe the keychain.
   * Resolves successfully so callers can wire it into UI flows uniformly.
   */
  async signOut(): Promise<void> {
    // Trusted-token mode has no SDK-owned session to clear, but the host can
    // still observe the lifecycle — emit so listeners see a uniform signedOut.
    this.session.markSignedOut();
  }

  /** Map a non-ok response to the thrown typed HTTP error (shared by request/requestBinary/stream). */
  private async throwHttpError(op: string, path: string, res: Response): Promise<never> {
    const status = res.status;
    const body = await readErrorBody(res);
    throw buildHttpError(
      httpErrorMessage(op, path, status, body),
      status,
      body,
      headersToRecord(res.headers),
    );
  }

  override async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    // Opt-in cache: lookup before any network work. Cache only applies to
    // JSON `request()` — binary and stream responses aren't worth storing.
    // The key is computed once and reused for the post-response store below.
    let key: string | undefined;
    if (options.cache && this.responseCache) {
      key = cacheKey(method, path, options.body, options.query);
      const hit = this.responseCache.get(key);
      if (hit !== undefined) return hit as T;
    }
    const url = this.buildUrl(path, options.query);
    const isMultipart = typeof FormData !== "undefined" && options.body instanceof FormData;
    const isBinaryBody =
      options.body instanceof ArrayBuffer ||
      options.body instanceof Uint8Array ||
      (typeof Blob !== "undefined" && options.body instanceof Blob);
    // Progress-tracked multipart uploads: the encode-vs-estimate strategy,
    // the 100 MB wrap cap, and the bookend semantics all live in
    // _internal/upload-progress.ts. `upload` is undefined when no listener
    // was supplied (or the body isn't FormData) — the request then sends the
    // FormData untouched.
    const upload = isMultipart
      ? await prepareUploadProgress(options.body as FormData, options.onUploadProgress)
      : undefined;
    const bodyInit: BodyInit | undefined = isMultipart
      ? (options.body as FormData)
      : isBinaryBody
        ? (options.body as BodyInit)
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined;
    const send = (accessToken: string) => {
      // 0/total bookend, once per send attempt (see UploadProgress.beginAttempt
      // for why per-attempt matters on the 401-retry path).
      upload?.beginAttempt();
      const init: RequestInit & { duplex?: "half" } = {
        method: options.method ?? "GET",
        // For multipart, let fetch set the Content-Type (with boundary). For
        // binary bodies the caller supplies `contentType` (or we default to
        // application/octet-stream below). Only JSON gets the auto-applied
        // application/json header from buildHeaders.
        headers: this.buildHeaders(
          accessToken,
          bodyInit !== undefined && !isMultipart && !isBinaryBody,
        ),
      };
      const wrapped = upload?.body();
      if (wrapped) {
        init.body = wrapped.stream;
        // Required by the WHATWG fetch spec when body is a stream; Node 20+
        // and Bun reject the call without it.
        init.duplex = "half";
        // Pre-encoded multipart bytes need the Content-Type (with boundary)
        // set explicitly — fetch only does that for a real FormData body.
        (init.headers as Record<string, string>)["content-type"] = wrapped.contentType;
      } else if (bodyInit !== undefined) {
        init.body = bodyInit;
        if (isBinaryBody) {
          (init.headers as Record<string, string>)["content-type"] =
            options.contentType ?? "application/octet-stream";
        }
      }
      if (options.signal) init.signal = options.signal;
      return this.options.fetch(url, init);
    };

    const res = await this.executeWithRetry(send, method, options);
    // Final synthetic bookend — only fires on the above-cap (unwrapped) path;
    // see UploadProgress.finish.
    if (res.ok) upload?.finish();
    if (!res.ok) {
      await this.throwHttpError("request", path, res);
    }
    if (res.status === 204) return undefined as T;
    const parsed = (await res.json()) as T;
    if (key !== undefined && this.responseCache) {
      this.responseCache.set(key, parsed);
    }
    return parsed;
  }

  /**
   * Issue a request and return the raw response bytes plus selected metadata.
   * Used for binary endpoints — audio TTS bytes, video content downloads —
   * where the response is not JSON. Shares the same 401-refresh and typed-
   * error mapping as {@link request}.
   */
  override async requestBinary(
    path: string,
    options: RequestOptions = {},
  ): Promise<{
    bytes: ArrayBuffer;
    contentType: string;
    headers: Readonly<Record<string, string>>;
  }> {
    const url = this.buildUrl(path, options.query);
    const isMultipart = typeof FormData !== "undefined" && options.body instanceof FormData;
    const bodyInit: BodyInit | undefined = isMultipart
      ? (options.body as FormData)
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined;
    const send = (accessToken: string) => {
      const init: RequestInit = {
        method: options.method ?? "GET",
        headers: this.buildHeaders(accessToken, bodyInit !== undefined && !isMultipart),
      };
      if (bodyInit !== undefined) init.body = bodyInit;
      if (options.signal) init.signal = options.signal;
      return this.options.fetch(url, init);
    };

    const res = await this.executeWithRetry(send, options.method ?? "GET", options);
    if (!res.ok) {
      await this.throwHttpError("requestBinary", path, res);
    }
    const rawCt = res.headers.get("content-type") ?? "";
    const headers = headersToRecord(res.headers);
    // 204 No Content has no body by definition. Mirror request()'s
    // short-circuit so callers don't receive a 0-byte buffer that looks
    // like a successful download. Drain first — a misbehaving gateway can
    // attach a body to a 204 and leaving it un-read prevents keep-alive
    // socket reuse on undici/Bun.
    if (res.status === 204) {
      await drainResponse(res);
      throw new UnifiedAIError(
        "request_failed",
        `requestBinary to ${path} returned 204 No Content (no bytes to return)`,
        204,
        undefined,
        headers,
      );
    }
    // Defense against gateway error pages and provider misconfiguration: a
    // 200 with an unexpected Content-Type (HTML error page, JSON envelope)
    // would otherwise be silently returned as `audio` or `video` bytes.
    // Mirrors the analogous guard in stream() at the SSE content-type check.
    if (options.acceptedContentTypes && options.acceptedContentTypes.length > 0) {
      const ct = (rawCt.split(";")[0] ?? "").trim().toLowerCase();
      const ok = options.acceptedContentTypes.some((accepted) => {
        const a = accepted.toLowerCase();
        return a.endsWith("/") ? ct.startsWith(a) : ct === a;
      });
      if (!ok) {
        // Drain the body so the connection can be reused; cap the peek to
        // avoid swallowing megabytes of HTML into Error.message.
        const peek = (await readErrorBody(res)) ?? "";
        throw new UnifiedAIError(
          "request_failed",
          `requestBinary to ${path} expected one of [${options.acceptedContentTypes.join(", ")}], got ${rawCt || "<none>"}`,
          res.status,
          peek,
          headers,
        );
      }
    }
    const bytes = await res.arrayBuffer();
    return { bytes, contentType: rawCt, headers };
  }

  override async stream(
    path: string,
    options: RequestOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const url = this.buildUrl(path, options.query);
    const bodyText = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const send = (accessToken: string) => {
      const headers = this.buildHeaders(accessToken, bodyText !== undefined);
      headers.accept = "text/event-stream";
      const init: RequestInit = {
        method: options.method ?? "GET",
        headers,
      };
      if (bodyText !== undefined) init.body = bodyText;
      if (options.signal) init.signal = options.signal;
      return this.options.fetch(url, init);
    };

    const res = await this.executeWithRetry(send, options.method ?? "GET", options);
    if (!res.ok) {
      await this.throwHttpError("stream", path, res);
    }
    if (!res.body) {
      throw new UnifiedAIError(
        "request_failed",
        `stream to ${path} returned no body`,
        res.status,
        undefined,
        headersToRecord(res.headers),
      );
    }
    // Defence in depth: a 2xx with a non-SSE content-type (e.g. an endpoint that
    // ignored `stream: true` and returned JSON) would otherwise silently yield
    // zero events. Fail loudly so callers don't see a phantom empty stream.
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("text/event-stream")) {
      const body = await readErrorBody(res);
      throw new UnifiedAIError(
        "request_failed",
        `stream to ${path} expected text/event-stream, got ${ct || "<none>"}`,
        res.status,
        body,
        headersToRecord(res.headers),
      );
    }
    return res.body;
  }

  // ─── Retry orchestration ──────────────────────────────────────────────

  /**
   * Run `send(token)` with the 401-refresh path and outer retry/backoff
   * applied. Returns the final Response (which the caller is expected to
   * inspect for non-retryable 4xx and parse the body). The 401 path is
   * handled internally and never surfaces to the retry classifier — it's
   * an auth concern, not a transient one.
   *
   * `method` and `options` are used to decide idempotency and to read the
   * caller-level retry override.
   */
  protected async executeWithRetry(
    send: (accessToken: string) => Promise<Response>,
    method: string,
    options: RequestOptions,
  ): Promise<Response> {
    const cfg = resolveRetryConfig(options.retry ?? this.options.retry);
    const idempotent = isIdempotent(method, options.idempotent);
    const listeners: RetryListener[] = [];
    if (this.options.onRetry) listeners.push(this.options.onRetry);
    if (options.onRetry) listeners.push(options.onRetry);
    const startedAt = Date.now();
    let attempt = 0;
    // Token is resolved once before the retry loop so a sign-out / refresh
    // racing the loop doesn't turn a retried 5xx into a not_bootstrapped error.
    // We track it as `currentToken` so a successful 401-refresh inside one
    // attempt rolls forward into the next attempt — without this, every
    // retry following a refresh would re-send the stale original token and
    // force another 401 + refresh round-trip.
    let currentToken = await this.getInitialAccessToken();

    const runOnce = async (): Promise<Response> => {
      let res = await send(currentToken);
      if (res.status === 401) {
        // drainResponse swallows body-read errors internally, but a body
        // stream that throws synchronously on read (rare; some
        // gateway/proxy combinations) could still propagate. If it does,
        // we must NOT let it escape as a generic Error — the outer retry
        // classifier would treat it as a retryable network blip and the
        // 401 path would silently restart. Wrap defensively so the
        // auth-failure contract stays terminal.
        try {
          await drainResponse(res);
        } catch {
          // Body drain failure on a 401 is non-fatal here: we already know
          // the request failed auth, the socket may or may not be reusable,
          // and the subsequent refresh+retry will open a fresh connection.
        }
        let freshToken: string;
        try {
          freshToken = await this.refreshAccessToken();
        } catch (err) {
          await this.onAuthFailure();
          // Surface as a typed auth error so the outer retry classifier
          // recognizes this as a terminal failure. Without this, a host
          // token provider that throws a plain Error would be misread by
          // isNetworkErrorRetryable as a transient blip and trigger
          // duplicate onAuthFailure() / markExpired() on every retry.
          if (err instanceof UnifiedError) throw err;
          throw new UnifiedAIAuthError(
            "auth_refresh_failed",
            err instanceof Error ? err.message : "refresh failed",
            undefined,
            undefined,
            undefined,
            err,
          );
        }
        currentToken = freshToken;
        res = await send(freshToken);
        if (res.status === 401) {
          const body = await readErrorBody(res);
          await this.onAuthFailure();
          throw new UnifiedAIAuthError(
            "auth_retry_still_unauthorized",
            `request still 401 after refresh: ${formatBody(body)}`,
            401,
            body,
            headersToRecord(res.headers),
          );
        }
      }
      return res;
    };

    while (true) {
      let res: Response | undefined;
      let err: unknown;
      try {
        res = await runOnce();
      } catch (e) {
        err = e;
      }

      // Decide whether to retry. `cfg` undefined means retry disabled.
      // Idempotency policy:
      //   - 429 is always safe (server told us to back off; the request
      //     didn't take effect — RFC 6585).
      //   - 408 (request timeout) and 5xx COULD have side-effected on a
      //     non-idempotent call (e.g. a 502 after the origin already
      //     processed the POST). Gate on idempotent for those.
      //   - Network errors: gate on idempotent. We don't know if the
      //     server saw the request.
      // A 429 from billing-window exhaustion (UsageLimitError) is terminal
      // within the window — retrying just amplifies load and log noise, and
      // the usage read is the call most likely to trip it. A transient
      // rate-limit 429 IS worth retrying, so tell them apart by the body code
      // before deciding. Only peek when we'd otherwise retry (cfg + 429).
      const usageLimited429 = !!cfg && res?.status === 429 && (await this.is429UsageLimit(res));

      const retryable = cfg
        ? res
          ? res.status === 429
            ? !usageLimited429
            : isRetryableStatus(res.status) && idempotent
          : isNetworkErrorRetryable(err) && idempotent
        : false;

      if (!retryable || !cfg) {
        if (err !== undefined) throw err;
        // biome-ignore lint/style/noNonNullAssertion: branch guards res defined
        return res!;
      }

      if (attempt >= cfg.maxRetries) {
        if (err !== undefined) throw err;
        // biome-ignore lint/style/noNonNullAssertion: branch guards res defined
        return res!;
      }
      const reason: Response | Error = res ?? (err as Error);
      const wait = nextDelay(attempt, cfg, reason);
      const elapsed = Date.now() - startedAt;
      if (elapsed + wait > cfg.maxElapsedMs) {
        if (err !== undefined) throw err;
        // biome-ignore lint/style/noNonNullAssertion: branch guards res defined
        return res!;
      }
      const event: RetryAttempt = {
        attempt: attempt + 1,
        delayMs: wait,
        status: res?.status,
        reason,
      };
      for (const l of listeners) {
        try {
          l(event);
        } catch {
          // Host telemetry listeners must not break the retry loop.
        }
      }
      // Drain the failing response so the underlying socket can be reused.
      if (res) await drainResponse(res);
      await retryDelay(wait, options.signal);
      if (options.signal?.aborted) {
        // Always surface the abort, never the prior attempt's error. If
        // user code cancelled mid-backoff, that's the load-bearing signal —
        // burying it under a TypeError('fetch failed') from the previous
        // attempt confuses every abort handler downstream.
        // Preserve `signal.reason` (web platform spec: callers can pass a
        // typed reason via `controller.abort(reason)`) as the `.cause` of
        // the surfaced AbortError so error-classification chains that
        // branch on `err.cause` still see the original intent.
        const reason = options.signal.reason;
        const abortError =
          typeof DOMException !== "undefined"
            ? new DOMException("Aborted", "AbortError")
            : Object.assign(new Error("Aborted"), { name: "AbortError" });
        if (reason !== undefined) {
          // DOMException allows arbitrary property assignment in V8/Bun.
          (abortError as { cause?: unknown }).cause = reason;
        }
        throw abortError;
      }
      attempt += 1;
    }
  }

  /**
   * Peek a 429 body to tell a terminal usage-limit (quota exhausted; won't
   * clear by waiting) from a transient rate-limit (worth retrying). Reads a
   * `clone()` so the original response stays intact for the caller's error
   * path and the retry-drain. Any read/parse failure falls back to `false`
   * (treat-as-retryable) so a malformed body keeps the prior behavior.
   */
  private async is429UsageLimit(res: Response): Promise<boolean> {
    try {
      return isUsageLimitBody(await readErrorBody(res.clone()));
    } catch {
      return false;
    }
  }

  // ─── Hooks for subclasses ──────────────────────────────────────────────

  /** Returns the access token used on the initial request. */
  protected async getInitialAccessToken(): Promise<string> {
    if (this.options.token !== undefined) return this.resolveTrustedToken();
    // Same code as bootstrap() throws so consumers can branch on a single
    // condition to detect "browser entry imported but OAuth needed".
    throw oauthUnavailable("no token configured");
  }

  /**
   * Returns a fresh access token after a 401. The base implementation
   * coalesces concurrent calls when in trusted-token mode so a host whose
   * provider does real I/O (HTTP, IPC, keychain) only sees one refresh per
   * burst of 401s.
   */
  protected async refreshAccessToken(): Promise<string> {
    if (this.options.token !== undefined) {
      if (this.trustedRefreshPromise) return this.trustedRefreshPromise;
      const p = this.resolveTrustedToken().finally(() => {
        if (this.trustedRefreshPromise === p) this.trustedRefreshPromise = undefined;
      });
      this.trustedRefreshPromise = p;
      // Emit `refreshed` once per coalesced burst, not once per awaiting
      // caller. Attach to `p` (shared by all callers) rather than awaiting
      // here so the single-flight contract is preserved. The rejection
      // branch is a no-op — the real failure propagates via the returned `p`.
      p.then(
        () => this.session.markRefreshed(),
        () => {},
      );
      return p;
    }
    throw oauthUnavailable("no refresh strategy available");
  }

  /** Cleanup hook fired when refresh fails or a retry still 401s. */
  protected async onAuthFailure(): Promise<void> {
    // Base: no local state to clear (the host owns the trusted-token
    // lifecycle) — but the observable session must still learn that auth is
    // dead, or a host subscribed to session.onChange would keep seeing
    // "active" after a terminal failure. markExpired() only transitions
    // `active` → `expired` (idempotent, never overrides signed_out), so a
    // burst of concurrent failures collapses to one `expired` event and a
    // subclass that also marks expired won't double-emit.
    this.session.markExpired();
  }

  protected async resolveTrustedToken(): Promise<string> {
    const t = this.options.token;
    if (t === undefined) {
      throw new UnifiedError("not_bootstrapped", "trusted token provider not set");
    }
    return typeof t === "function" ? await t() : t;
  }

  // ─── URL/header helpers (protected so subclasses can compose) ─────────

  protected buildUrl(path: string, query: RequestOptions["query"]): string {
    const base = this.options.apiUrl;
    const full = base
      ? `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`
      : path;
    if (!query) return full;
    // `full` may be relative (apiUrl === "" → the host serves /api/* via a dev
    // proxy or a custom protocol). `new URL(relative)` throws without a base,
    // so append the query string manually instead of constructing a URL.
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (!qs) return full;
    return `${full}${full.includes("?") ? "&" : "?"}${qs}`;
  }

  protected buildHeaders(accessToken: string, hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    // In trusted-token mode, an empty token means "let the fetch layer carry
    // auth" (e.g. cookies via credentials: include). Sending `Bearer ` with no
    // token would be rejected by most backends.
    if (accessToken) h.authorization = `Bearer ${accessToken}`;
    if (hasBody) h["content-type"] = "application/json";
    // Per-app attribution for shared uapi_ testing keys. unified-api honors
    // this only on own-credential API keys; JWT `app` claims and OAuth
    // client_id ignore it. Empty appId (unscoped client) omits the header.
    const appId = this.appId.trim();
    if (appId) h["x-unified-app"] = appId;
    if (this.callerKind === "agent") h["x-unified-caller"] = "agent";
    return h;
  }
}
