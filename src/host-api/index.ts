// The `@unified/host-api` surface, as ordinary named types — import from
// "@unifiedai/sdk/host-api".
//
// `@unified/host-api` is the bare specifier every embedded marketplace app
// imports its host bridge from. It is EXTERNALIZED in every app's remote build
// (the host maps it to /host-api.js, which forwards window.__UNIFIED_HOST__),
// so the module itself never resolves at compile time — apps get its types
// from the self-contained ambient declaration next door (./ambient.d.ts),
// which every app used to copy-paste as its own src/host-api.d.ts.
//
// This file is the SINGLE editable source of that surface: real, importable
// interfaces the ambient declaration restates verbatim. Change the two files
// together — ambient.d.ts cannot import from here (an ambient `declare module`
// must stay self-contained to work under every consumer tsconfig), so the sync
// is by hand, guarded by the comment at the top of ambient.d.ts.
//
// Types only — no runtime code lives here. The dev-time IMPLEMENTATION of this
// surface is src/app/dev-host-api.ts.

import type { UnifiedAI } from "../core/client";
import type { RunAgentOptions, RunAgentResult, ToolSpec } from "../resources/agent/types";
import type { FsNamespace } from "../resources/fs/types";
import type { ArtifactRef, OpenArtifactOutcome } from "../resources/openArtifact";

// ─── getSdk ──────────────────────────────────────────────────────────────────

/** One catalog row of `HostSdk.models.list`. Only the fields the embedded
    editors read are typed; `type` gates which models are offered for text
    interactions, `model_author` groups the picker. */
export interface HostSdkModel {
  id: string;
  name: string;
  type: "text" | "image" | "video" | "audio" | "embedding";
  owned_by?: string;
  logo?: string | null;
  model_author?: { name: string; color?: string | null };
  is_custom?: boolean;
}

export interface HostSdkChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface HostSdkChatParams {
  model: string;
  messages: HostSdkChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stop?: string | string[];
}

export interface HostSdkChatChoice {
  message: { content: string | null };
  /** "stop" | "length" | … — "length" means the output was truncated. */
  finish_reason?: string | null;
}

/**
 * LEGACY structural slice of the host's SDK instance — the shape this module
 * typed `getSdk()` as before it was widened to the real `UnifiedAI` class
 * (which the host has always actually returned). Kept exported for apps that
 * still reference it; new code should use `UnifiedAI` directly.
 */
export interface HostSdk {
  models: {
    /** The model catalog, as returned by unified-api (`{ object, data }`). */
    list: (options?: {
      signal?: AbortSignal;
      include?: Array<"author">;
    }) => Promise<{ object?: "list"; data: HostSdkModel[] }>;
  };
  chat: {
    completions: {
      create: (
        params: HostSdkChatParams,
        options?: { signal?: AbortSignal },
      ) => Promise<{ choices: HostSdkChatChoice[] }>;
    };
  };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

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

// ─── Models (merged catalog) ─────────────────────────────────────────────────

/** One row of `listModels` — the host's merged catalog of gateway models plus
    whichever local agent CLIs are actually installed. */
export interface HostModelEntry {
  id: string;
  "model-id": string;
  name: string;
  author: string;
  type?: string;
  owned_by?: string;
  logo?: string | null;
  model_author?: { name?: string; color?: string | null };
  context_size?: number | null;
}

// ─── Compute devices ─────────────────────────────────────────────────────────

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

// ─── Directory browsing ───────────────────────────────────────────────────────

/** One entry of a `listHostDir` listing. */
export interface HostDirEntry {
  name: string;
  path: string;
  git: boolean;
}

/**
 * A directory listing on a host machine — the browse verb behind attaching a
 * remote workspace to `runAgent({ workspace })`.
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

// ─── Local folder pick ─────────────────────────────────────────────────────────

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

// ─── Projects ────────────────────────────────────────────────────────────────

/** The project the user is currently working in (host `stores/projects.ts`). */
export interface ProjectContext {
  id: string;
  name: string;
}

// ─── Usage ───────────────────────────────────────────────────────────────────

/**
 * The host's authoritative usage summary — the same numbers the profile card
 * shows (host `stores/auth.ts` `UsageSummary`). Every field is optional: the
 * host derives what it can from unified-api's usage response.
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

// ─── The module surface ──────────────────────────────────────────────────────

/**
 * Everything `@unified/host-api` exports, as one interface — useful for typing
 * a dev shim or a host bridge implementation as a whole. The per-function
 * documentation lives on ./ambient.d.ts (the copy consumers actually see).
 */
export interface HostApi {
  /**
   * The host's authenticated SDK instance — a full `UnifiedAI`, attributed to
   * this app by the host (each remote gets its own scoped instance).
   */
  getSdk(): UnifiedAI;
  /**
   * Build the agent loop's file tools (write/read/edit/list) bound to an
   * `sdk.fs` namespace — the SDK's canonical tool spec, reached through the
   * host so the app never bundles its own SDK copy.
   */
  fsTools(ns: FsNamespace): ToolSpec[];
  /**
   * A self-contained data-URI for a provider/author's brand logo. `input` is
   * the author/provider name (or a `{ author }` object); `theme` is POSITIONAL
   * (not an options object) — the host forwards it straight to the SDK, whose
   * dark variants need `"dark"` as the 2nd arg. Unknown names resolve to a
   * brand logo, or an empty string when there is no mark (compare against
   * `getProviderLogo("")` to detect it).
   */
  getProviderLogo(
    input: string | { author?: string | null } | null | undefined,
    theme?: "light" | "dark",
  ): string;
  /**
   * The host's resolved color scheme ("light" | "dark"). The host collapses
   * the user's light/dark/system preference; the app's chrome also follows it
   * via CSS keyed off `[data-theme="dark"]` on the shared <html>.
   */
  getTheme(): "light" | "dark";
  /**
   * Subscribe to host color-scheme changes. Fires once immediately, then on
   * every change. Returns an unsubscribe function.
   */
  onThemeChange(cb: (theme: "light" | "dark") => void): () => void;
  /**
   * Register this app's action handlers with the host — the reverse of the
   * getters above (the host invokes INTO the app through these). The app
   * supplies no id: the host attributes it from the app being loaded. Register
   * at module scope so handlers stay live for the session. Returns an
   * unregister function.
   */
  registerActions(handlers: Record<string, ActionHandler>): () => void;
  /**
   * Run one agent turn through the host, which picks the lane from the model:
   * gateway models go through the SDK's agent loop, while models served by a
   * locally installed agent CLI (Cursor, Claude Code) go through the host's
   * child-process bridge. `sessionKey` keeps a conversation's CLI thread
   * context across turns; omit it for fan-out workers. `device` pins the turn
   * to one machine (older hosts ignore it and run on the machine they run on,
   * which is correct — an embedded app has exactly one device). Throws when the
   * host is too old to provide the bridge — feature-detect with `hasRunAgent()`.
   */
  runAgent(
    options: RunAgentOptions & { sessionKey?: string; device?: HostDevicePref },
  ): Promise<RunAgentResult>;
  /** Whether the host provides the agent-run bridge (false standalone / old host). */
  hasRunAgent(): boolean;
  /**
   * The host's merged model catalog: gateway models plus whichever local agent
   * CLIs are actually installed. Prefer this over `getSdk().models.list()`,
   * which only ever sees the gateway half. Null when the host is too old.
   *
   * `device` asks for a specific machine's local half; older hosts ignore the
   * argument and answer for the machine they run on.
   */
  listModels(options?: { device?: HostDevicePref }): Promise<HostModelEntry[] | null>;
  /**
   * Browse a host machine's folders on behalf of an embedded app — the listing
   * behind attaching a remote workspace to `runAgent({ workspace })`. Routes
   * exactly like a run: local when there's no `device`, else bridge/relay.
   * Omit on hosts that can't browse the local disk.
   */
  listHostDir?(options?: HostListDirOptions): Promise<DirListing>;
  /**
   * Whether a model is served by a local agent CLI rather than the gateway.
   * Local lanes cannot honor `response_format`/`json_schema`, `maxSteps` or
   * `maxTokens`, and report failures without the SDK's typed `errorCode` — so
   * any call depending on those must stay on the gateway even when the user
   * has picked a local model. False when the host is too old.
   */
  isLocalAgentModel(modelId: string | null | undefined): boolean;
  /**
   * The host's authoritative usage summary (same source as the profile card).
   * Resolves to null when the host is too old to provide it, so callers can
   * fall back to `getSdk().usage`.
   */
  getUsage(): Promise<HostUsageSummary | null>;
  /**
   * The project the user is currently working in (or null). Apps file new work
   * into it and scope their @-mention picker to it; cross-app content is read
   * back via `sdk.references`. Null when standalone or the host is too old.
   */
  getCurrentProject(): ProjectContext | null;
  /**
   * Subscribe to current-project changes. Fires once immediately with the
   * current context, then on every change. Returns an unsubscribe function
   * (a no-op when the host is too old to provide it).
   */
  onProjectChange(cb: (project: ProjectContext | null) => void): () => void;
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
  openArtifact(ref: ArtifactRef): Promise<OpenArtifactOutcome | null>;
  /**
   * Native folder pick + ignore-aware listing for embedded apps. `null` when
   * cancelled. Omit on hosts that can't walk the local disk.
   */
  pickLocalFolder?(): Promise<LocalFolderListing | null>;
  /** Bounded read of relative paths from a folder picked this session. */
  readLocalFolderFiles?(token: string, paths: string[]): Promise<LocalFolderFile[]>;
}

export type {
  RunAgentOptions,
  RunAgentResult,
  ToolSpec,
  FsNamespace,
  ArtifactRef,
  OpenArtifactOutcome,
  UnifiedAI,
};
