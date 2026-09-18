// Ambient declaration for the `@unified/host-api` bare specifier every
// embedded marketplace app imports its host bridge from. Reference it from an
// app's tsconfig:
//
//     { "compilerOptions": { "types": ["@unifiedai/sdk/host-api/ambient"] } }
//
// or from any .d.ts in the app:
//
//     /// <reference types="@unifiedai/sdk/host-api/ambient" />
//
// KEPT IN SYNC BY HAND with ./index.ts, which exports this exact surface as
// ordinary named types. An ambient `declare module` must stay self-contained —
// importing the sibling from in here would turn this file into a module and
// stop the declaration applying globally under some consumer tsconfigs — so
// the surface is restated verbatim. Change the two files together.

declare module "@unified/host-api" {
  /**
   * The host's authenticated SDK instance — a full `UnifiedAI`, attributed to
   * this app by the host (each remote gets its own scoped instance).
   */
  export function getSdk(): import("@unifiedai/sdk").UnifiedAI;
  /**
   * Build the agent loop's file tools (write/read/edit/list) bound to an
   * `sdk.fs` namespace — the SDK's canonical tool spec, reached through the
   * host so the app never bundles its own SDK copy.
   */
  export function fsTools(
    ns: import("@unifiedai/sdk").FsNamespace,
  ): import("@unifiedai/sdk").ToolSpec[];
  /**
   * A self-contained data-URI for a provider/author's brand logo. `input` is the
   * author/provider name (or a `{ author }` object); `theme` is POSITIONAL (not
   * an options object) — the host forwards it straight to the SDK, whose dark
   * variants need `"dark"` as the 2nd arg. Unknown names resolve to an empty
   * string (compare against `getProviderLogo("")` to detect it).
   */
  export function getProviderLogo(
    input: string | { author?: string | null } | null | undefined,
    theme?: "light" | "dark",
  ): string;
  /**
   * The host's resolved color scheme ("light" | "dark"). The host collapses the
   * user's light/dark/system preference; the app's chrome also follows it via
   * CSS keyed off `[data-theme="dark"]` on the shared <html>.
   */
  export function getTheme(): "light" | "dark";
  /**
   * Subscribe to host color-scheme changes. Fires once immediately, then on
   * every change. Returns an unsubscribe function.
   */
  export function onThemeChange(cb: (theme: "light" | "dark") => void): () => void;

  /** Runtime context the host binds for each action invocation. */
  export interface ActionContext {
    /** Active project id, bound from the host (not from caller params). */
    projectId: string | null;
    /** Aborted when the caller cancels or the deadline passes. */
    signal: AbortSignal;
    /** Streaming actions emit progress here. */
    progress: (data: unknown) => void;
    /** Who is driving the action. */
    caller: { kind: "host" | "app" | "mcp-external"; tier: "first-party" | "untrusted" };
  }

  /**
   * An action handler. Return a plain JSON-serializable value; the host adapts it
   * per caller. May be an async generator (yield progress, return the result).
   */
  export type ActionHandler<P = Record<string, unknown>, R = unknown> = (
    params: P,
    ctx: ActionContext,
  ) => Promise<R> | AsyncGenerator<unknown, R>;

  /**
   * Register this app's action handlers with the host — the reverse of the
   * getters above (the host invokes INTO the app through these). The app supplies
   * no id: the host attributes it from the app being loaded. Register at module
   * scope so handlers stay live for the session. Returns an unregister function.
   */
  export function registerActions(handlers: Record<string, ActionHandler>): () => void;

  // ── Local agent providers (Cursor, Claude Code) ──────────────────────────
  /**
   * Which machine a local-agent call should run on. `auto` is the host's own
   * selection (and the default). An embedded app has exactly ONE device — the
   * machine its host runs on — so passing this only matters on hosts that can
   * reach more than one; older hosts ignore the argument and answer for the
   * machine they run on, which is the correct answer there.
   */
  export type HostDevicePref =
    | { kind: "auto" }
    | { kind: "bridge" }
    | { kind: "relay"; deviceId: string };

  /**
   * Run one agent turn through the host, which picks the lane from the model:
   * gateway models go through the SDK's agent loop, while models served by a
   * locally installed agent CLI (Cursor, Claude Code) go through the host's
   * child-process bridge — an app cannot reach that itself, since remotes do
   * not bundle @tauri-apps. Options and result mirror `sdk.agent.run`.
   *
   * `sessionKey` is the only addition: pass a stable key for a conversation
   * that should keep the CLI's own thread context across turns, and OMIT it
   * for fan-out workers so each gets a fresh, throwaway session.
   *
   * `device` pins the turn to one machine — omit it to run on whatever the host
   * has selected. Older hosts ignore it and run on the machine they run on.
   *
   * Throws when the host is too old to provide the bridge — feature-detect with
   * `hasRunAgent()` and fall back to `getSdk().agent.run` to degrade gracefully
   * (e.g. in standalone dev, outside the desktop shell).
   */
  export function runAgent(
    options: import("@unifiedai/sdk").RunAgentOptions & {
      sessionKey?: string;
      device?: HostDevicePref;
    },
  ): Promise<import("@unifiedai/sdk").RunAgentResult>;

  /** Whether the host provides the agent-run bridge (false standalone / old host). */
  export function hasRunAgent(): boolean;

  /**
   * The host's merged model catalog: gateway models plus whichever local agent
   * CLIs are actually installed. Prefer this over `getSdk().models.list()`,
   * which only ever sees the gateway half. Null when the host is too old.
   *
   * `device` asks for a specific machine's local half; older hosts ignore the
   * argument and answer for the machine they run on.
   */
  export function listModels(options?: { device?: HostDevicePref }): Promise<Array<{
    id: string;
    "model-id": string;
    name: string;
    author: string;
    type?: string;
    owned_by?: string;
    logo?: string | null;
    model_author?: { name?: string; color?: string | null };
    context_size?: number | null;
  }> | null>;

  // ── Directory browsing ───────────────────────────────────────────────────

  /** One entry of a `listHostDir` listing. */
  export interface HostDirEntry {
    name: string;
    path: string;
    git: boolean;
  }

  /**
   * A directory listing on a host machine — the browse verb behind attaching
   * a remote workspace to `runAgent({ workspace })`.
   */
  export interface DirListing {
    path: string | null;
    parent: string | null;
    home: string;
    sep: string;
    entries: HostDirEntry[];
    suggested?: string[];
    truncated?: boolean;
    restricted?: boolean;
  }

  export interface HostListDirOptions {
    /** Directory to list. Omit for the host's landing view (home / suggested roots). */
    path?: string;
    /** Which machine to browse. Omit / "auto" follows the host's own resolution. */
    device?: HostDevicePref;
  }

  /**
   * Browse a host machine's folders on behalf of an embedded app — the listing
   * behind attaching a remote workspace to `runAgent({ workspace })`. Routes
   * exactly like a run: local when there's no `device`, else bridge/relay.
   * Omit on hosts that can't browse the local disk.
   */
  export function listHostDir(options?: HostListDirOptions): Promise<DirListing>;

  /**
   * Whether a model is served by a local agent CLI rather than the gateway.
   * Local lanes cannot honor `response_format`/`json_schema`, `maxSteps` or
   * `maxTokens`, and report failures without the SDK's typed `errorCode` — so
   * any call depending on those must stay on the gateway even when the user has
   * picked a local model. False when the host is too old.
   */
  export function isLocalAgentModel(modelId: string | null | undefined): boolean;

  // ── Usage ─────────────────────────────────────────────────────────────────
  /**
   * The host's authoritative usage summary — the same numbers the profile card
   * shows. Every field is optional: the host derives what it can from
   * unified-api's usage response.
   */
  export interface HostUsageSummary {
    plan?: string;
    totalCost?: number;
    limit?: number;
    percentUsed?: number;
    windowStart?: string;
    windowEnd?: string;
    credits?: number | null;
  }

  /**
   * The host's authoritative usage summary (same source as the profile card).
   * Resolves to null when the host is too old to provide it, so callers can
   * fall back to `getSdk().usage`.
   */
  export function getUsage(): Promise<HostUsageSummary | null>;

  // ── Projects ──────────────────────────────────────────────────────────────
  /** The project the user is currently working in. */
  export interface ProjectContext {
    id: string;
    name: string;
  }

  /**
   * The project the user is currently working in (or null). Apps file new work
   * into it and scope their @-mention picker to it; cross-app content is read
   * back via `sdk.references`. Null when standalone or the host is too old.
   */
  export function getCurrentProject(): ProjectContext | null;

  /**
   * Subscribe to current-project changes. Fires once immediately with the
   * current context, then on every change. Returns an unsubscribe function
   * (a no-op when the host is too old to provide it).
   */
  export function onProjectChange(cb: (project: ProjectContext | null) => void): () => void;

  // ── Cross-app open ────────────────────────────────────────────────────────
  /**
   * Put one artifact on screen, in whatever app owns it — the single cross-app
   * open path (@-mention chips, reference cards, project links). Build the ref
   * with `artifactRefFromLink` from @unifiedai/sdk when you hold a ProjectLink.
   *
   * Resolves to null when there is no host bridge (standalone dev), so an app
   * can tell "the shell handled this" from "there is no shell" and fall back
   * to its own UI. Otherwise the outcome says what was actually achieved: only
   * `kind: "item"` means the artifact is on screen — `"app"` and
   * `"unavailable"` both carry a `reason` fit to show the user. Never report
   * those as success.
   */
  export function openArtifact(
    ref: import("@unifiedai/sdk").ArtifactRef,
  ): Promise<import("@unifiedai/sdk").OpenArtifactOutcome | null>;

  // ── Local folder pick ────────────────────────────────────────────────────

  /** One entry of a `pickLocalFolder` listing. */
  export interface LocalFolderEntry {
    path: string;
    size: number;
  }

  /** Result of `pickLocalFolder` — a native folder pick plus an ignore-aware walk. */
  export interface LocalFolderListing {
    token: string;
    folderName: string;
    entries: LocalFolderEntry[];
    skippedDirCount: number;
    truncated: boolean;
  }

  /** One file read back by `readLocalFolderFiles`. */
  export interface LocalFolderFile {
    path: string;
    bytes: Uint8Array;
  }

  /**
   * Native folder pick + ignore-aware listing for embedded apps. `null` when
   * cancelled. Omit on hosts that can't walk the local disk.
   */
  export function pickLocalFolder(): Promise<LocalFolderListing | null>;

  /** Bounded read of relative paths from a folder picked this session. */
  export function readLocalFolderFiles(
    token: string,
    paths: string[],
  ): Promise<LocalFolderFile[]>;
}
