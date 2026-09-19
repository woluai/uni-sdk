import { Actions } from "../resources/actions.js";
import { Agent } from "../resources/agent.js";
import { Artifacts } from "../resources/artifacts.js";
import { Audio } from "../resources/audio.js";
import { Calendar } from "../resources/calendar.js";
import { Chat } from "../resources/chat.js";
import { Decisions } from "../resources/decisions.js";
import { Embeddings } from "../resources/embeddings.js";
import { Files } from "../resources/files.js";
import { Fs } from "../resources/fs.js";
import { Helpers } from "../resources/helpers.js";
import { Images } from "../resources/images.js";
import { Memory } from "../resources/memory.js";
import { Messages } from "../resources/messages.js";
import { Models } from "../resources/models.js";
import { Projects } from "../resources/projects.js";
import { References } from "../resources/references.js";
import { Responses } from "../resources/responses.js";
import { Storage } from "../resources/storage.js";
import { Sync } from "../resources/sync.js";
import { Usage } from "../resources/usage.js";
import { Users } from "../resources/users.js";
import { Videos } from "../resources/videos.js";
import { Core, type CoreOptions, type RequestOptions } from "./core.js";
import type { Identity } from "./identity.js";
import { Session } from "./session.js";
export interface UnifiedAIOptions extends CoreOptions {
}
/**
 * Browser-safe UnifiedAI client. Requires trusted-token mode (a string or
 * async callback supplied via the `token` option). For OAuth flows, see
 * `@unifiedai/sdk/node`.
 *
 * Subclasses extend this base to add bootstrap strategies. The HTTP request
 * and stream paths live here so all auth modes share a single 401-retry flow;
 * mode-specific behavior is reached through `protected` hooks.
 */
export declare class UnifiedAI extends Core {
    #private;
    get models(): Models;
    get usage(): Usage;
    get users(): Users;
    get chat(): Chat;
    get responses(): Responses;
    get messages(): Messages;
    get images(): Images;
    get files(): Files;
    get audio(): Audio;
    get videos(): Videos;
    get embeddings(): Embeddings;
    get decisions(): Decisions;
    get helpers(): Helpers;
    get calendar(): Calendar;
    /**
     * Cross-app projects (`sdk.projects`). A Project gathers artifacts from
     * different apps into one user-owned workspace; `addLink` attaches an artifact
     * or a portion of one. Requires auth (writes to unified-api).
     */
    get projects(): Projects;
    /**
     * Reference resolution (`sdk.references`). Reads a project link back into
     * content — including across apps — authorized by project membership. Resolves
     * a `uniref://` handle (or linkId) to a portion snapshot or a live artifact.
     */
    get references(): References;
    /**
     * Artifacts (`sdk.artifacts`). The cross-app export contract — publish a
     * canonical, self-contained snapshot of an app's work (design/doc/sheet) that
     * chat, other apps, and external agents can consume. Versions are whole
     * snapshots; `resolveRef` reads an `artifact://<id>@<v>` reference.
     */
    get artifacts(): Artifacts;
    /**
     * Agent memory (`sdk.memory`). The server-side append-only ledger — append
     * events (the server stamps taint origin + applied/proposed status from the
     * credential), sync since a cursor, and lexically query. Standalone-app parity
     * with the desktop shell's memory.
     */
    get memory(): Memory;
    /**
     * Cross-app actions (`sdk.actions`). Declare this app's ActionSpecs and SERVE
     * invocations over a pull channel (`serve(handlers)` polls, runs, responds) — or
     * INVOKE another app's action (`invoke` + `awaitResult`). Offline apps report as
     * unavailable so callers can fall back to artifacts.
     */
    get actions(): Actions;
    /**
     * App-namespaced storage (`STORAGE-SPEC.md`). Typed collections over a
     * swappable backend — the server-backed Cloud store (unified-api → Supabase)
     * when a token is configured, or a host-injected backend. Requires a token (or
     * an injected backend): there is no local browser fallback. Cross-app and
     * agent access go through {@link Storage.grants}. Cloud paths are Pro-gated
     * (`PlanRequiredError`).
     */
    get storage(): Storage;
    /**
     * App-namespaced file workspace (`docs/capability-platform.md`). A jailed
     * directory tree the app — and the agent loop running on its behalf — reads,
     * writes, and edits. The server-backed Cloud workspace (unified-api → Supabase)
     * when a token is configured, or a host-injected backend. Requires a token (or
     * an injected backend): there is no local browser fallback.
     */
    get fs(): Fs;
    /**
     * Per-workspace sync engine (`sdk.sync`, PROTOCOL.md "Sync"). `sync.workspace(id)`
     * returns a live-first `WorkspaceSync` that hydrates from an optional injected
     * `SnapshotBackend`, catches up (bootstrap → delta) against unified-api, polls
     * deltas, and applies optimistic writes. One cached engine per workspace id.
     * `sync.grants` publishes a namespace to other apps and authenticated agents.
     * Cloud bootstrap/delta/apply are Pro-gated.
     */
    get sync(): Sync;
    /**
     * Unopinionated tool-loop scaffolding (`docs/capability-platform.md`).
     * `sdk.agent.run({ system, prompt, tools, … })` runs the model with the app's
     * OWN prompt and tools (compose `fsTools(sdk.fs.namespace())` /
     * `storageTools(sdk.storage.namespace())` / `syncTools(ws, ns)` / `webTools()`
     * with your own), dispatching tool-calls until the model stops. No prompt or
     * tool policy is baked in — the app orchestrates.
     */
    get agent(): Agent;
    /**
     * Observable auth-session surface: `isAuthenticated()`, `expiresAt`,
     * `identity`, and `onChange(listener)`. In trusted-token mode it reflects
     * the configured token (active while one is set); the node OAuth subclass
     * additionally tracks expiry, caches identity, and drives proactive refresh.
     */
    readonly session: Session;
    private trustedRefreshPromise;
    private readonly responseCache;
    constructor(options?: UnifiedAIOptions);
    /**
     * In trusted-token mode, bootstrap is a no-op (the host owns the lifecycle).
     * Subclasses override this to run OAuth bootstrap. Calling bootstrap on the
     * base class without a `token` configured throws — those callers should
     * import the node subclass instead.
     */
    bootstrap(): Promise<void>;
    identity(): Identity;
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
    accessToken(): Promise<string>;
    /**
     * No-op in trusted-token mode — the host owns the token lifecycle, so there
     * is no SDK-side session to clear. Subclasses that own session state (the
     * node OAuth subclass) override this to revoke and wipe the keychain.
     * Resolves successfully so callers can wire it into UI flows uniformly.
     */
    signOut(): Promise<void>;
    /** Map a non-ok response to the thrown typed HTTP error (shared by request/requestBinary/stream). */
    private throwHttpError;
    request<T>(path: string, options?: RequestOptions): Promise<T>;
    /**
     * Issue a request and return the raw response bytes plus selected metadata.
     * Used for binary endpoints — audio TTS bytes, video content downloads —
     * where the response is not JSON. Shares the same 401-refresh and typed-
     * error mapping as {@link request}.
     */
    requestBinary(path: string, options?: RequestOptions): Promise<{
        bytes: ArrayBuffer;
        contentType: string;
        headers: Readonly<Record<string, string>>;
    }>;
    stream(path: string, options?: RequestOptions): Promise<ReadableStream<Uint8Array>>;
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
    protected executeWithRetry(send: (accessToken: string) => Promise<Response>, method: string, options: RequestOptions): Promise<Response>;
    /**
     * Peek a 429 body to tell a terminal usage-limit (quota exhausted; won't
     * clear by waiting) from a transient rate-limit (worth retrying). Reads a
     * `clone()` so the original response stays intact for the caller's error
     * path and the retry-drain. Any read/parse failure falls back to `false`
     * (treat-as-retryable) so a malformed body keeps the prior behavior.
     */
    private is429UsageLimit;
    /** Returns the access token used on the initial request. */
    protected getInitialAccessToken(): Promise<string>;
    /**
     * Returns a fresh access token after a 401. The base implementation
     * coalesces concurrent calls when in trusted-token mode so a host whose
     * provider does real I/O (HTTP, IPC, keychain) only sees one refresh per
     * burst of 401s.
     */
    protected refreshAccessToken(): Promise<string>;
    /** Cleanup hook fired when refresh fails or a retry still 401s. */
    protected onAuthFailure(): Promise<void>;
    protected resolveTrustedToken(): Promise<string>;
    protected buildUrl(path: string, query: RequestOptions["query"]): string;
    protected buildHeaders(accessToken: string, hasBody: boolean): Record<string, string>;
}
//# sourceMappingURL=client.d.ts.map