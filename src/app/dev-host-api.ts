// Standalone-dev implementation of `@unified/host-api`, used only when an
// embedded app runs on its own via `vite dev` (outside the UnifiedApp shell).
// The `unifiedApp` Vite plugin ("@unifiedai/sdk/app/vite") aliases the
// `@unified/host-api` specifier here in serve; in a production build the
// specifier is externalized to /host-api.js instead, so none of this ships in
// the bundle.
//
// Generic — no app-specific behavior. It mirrors the host's own bridge so the
// app exercises a REAL uni-sdk instance against unified-api through the app's
// dev proxy, not a mock:
//  - `getSdk()` builds a `UnifiedAI` with relative URLs (`/api/v1/*`) and the
//    dev `uapi_` key from VITE_DEV_API_KEY in the app's .env. The app id comes
//    from VITE_UNIFIED_APP_ID, which the `unifiedApp` plugin defines from its
//    `appId` option.
//  - Theme resolves from the OS preference (there is no host shell setting
//    <html data-theme> — though data-theme is still honored if a dev tool sets
//    it).
//  - `registerActions` is a no-op (there is no host shell to invoke actions).
//  - The local-agent lane is REAL: a running UnifiedApp desktop is reached over
//    the loopback agent bridge (or the account's other machines over the relay),
//    so `runAgent` on a `claude-code/*` / `cursor/*` model behaves as it does
//    when embedded. See the section at the bottom for the consent rules.

import { UnifiedAI } from "../core/client";
import type { HostModelEntry, ProjectContext } from "../host-api";
import {
  type LocalAgentDevice,
  type LocalAgentSource,
  type LocalAgentSourcePref,
  type LocalAgentStatus,
  checkDesktopAvailable as checkDesktopAvailableSource,
  configureLocalAgents,
  connectDesktop as connectDesktopSource,
  disconnectDesktop as disconnectDesktopSource,
  getLocalAgentStatus,
  hasBridgeToken,
  isDesktopConnected,
  isLocalAgentModel as isLocalAgentModelId,
  listLocalAgentDevices,
  listLocalModels,
  onLocalAgentStatusChange,
  pickWorkspaceFolder as pickDesktopFolder,
  refreshLocalAgentDevices,
  refreshLocalAgents,
  resolveLocalAgentSource,
  resolveSourceFor,
  runLocalAgent,
} from "../localAgents/index";
import { fsTools } from "../resources/agent/fs-tools";
import type { RunAgentOptions, RunAgentResult } from "../resources/agent/types";
import { getProviderLogo } from "../resources/logos";

/** Vite-injected env, read defensively so this module also loads (for its
    no-ops) under plain bundler-less tooling where import.meta.env is absent. */
const env: Record<string, string | undefined> =
  (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

let sdk: UnifiedAI | null = null;

export function getSdk(): UnifiedAI {
  if (!sdk) {
    const devApiKey = env.VITE_DEV_API_KEY;
    if (!devApiKey) {
      throw new Error(
        "VITE_DEV_API_KEY is not set. Copy .env.example to .env and add your dev uapi_ key.",
      );
    }
    sdk = new UnifiedAI({
      // Empty apiUrl keeps requests relative (`/api/v1/*`) so the Vite dev
      // proxy routes them to unified-api.
      apiUrl: "",
      token: () => devApiKey,
      appId: env.VITE_UNIFIED_APP_ID || "dev-app",
      fetch: ((input, init) => fetch(input, { ...init, credentials: "include" })) as typeof fetch,
    });
  }
  return sdk;
}

// The real fsTools — the host bridge delegates to this same SDK function, so
// standalone dev exercises the canonical tool spec rather than a stub.
export { getProviderLogo, fsTools };

function readTheme(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getTheme(): "light" | "dark" {
  return readTheme();
}

export function onThemeChange(cb: (theme: "light" | "dark") => void): () => void {
  cb(readTheme());
  const media = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  const onMedia = () => cb(readTheme());
  media?.addEventListener("change", onMedia);
  const observer = new MutationObserver(() => cb(readTheme()));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => {
    media?.removeEventListener("change", onMedia);
    observer.disconnect();
  };
}

// Standalone dev has no host shell to invoke actions, so registration is a
// no-op. The real bridge (public/host-api.js → window.__UNIFIED_HOST__)
// replaces this module when the app runs inside UnifiedApp.
export function registerActions(
  _handlers: Record<string, (params: Record<string, unknown>, ctx: unknown) => unknown>,
): () => void {
  return () => {};
}

// ── Local agent providers (Cursor, Claude Code) ────────────────────────────
//
// Standalone dev used to report the local-agent bridge as absent outright. It
// no longer has to: a page served from `localhost:5173` can reach a RUNNING
// UnifiedApp desktop over the loopback agent bridge, and a signed-in one can
// reach the account's other machines over the relay — the same two transports
// the desktop frontend uses in a browser. `../localAgents` is the shared
// implementation of both.
//
// The consent rule is the reason this is not simply "connect on load":
//
//   * Auto-connect is attempted once, lazily, and only over paths that raise
//     NOTHING on anyone's screen — the bridge only when a pairing token for
//     this origin already exists (the contract's silent re-pair), and the relay
//     only through the ordinary `GET /hosts` listing under the app's own
//     credentials.
//   * First-time bridge pairing opens a consent modal on the desktop, so it is
//     never reached from page load. It lives behind `connectDesktop()`, which
//     the app must call from an explicit user action.
//
// A not-yet-paired (or no-desktop) state is reported cleanly: `hasRunAgent()`
// is false, `listModels()` returns the gateway catalog alone, and `runAgent`
// stays on the gateway lane. Nothing throws.

/** Started once, lazily. Resolving is prompt-free by construction (see above). */
let autoConnect: Promise<LocalAgentSource | null> | null = null;

// Give the relay the app's own credential + base URL rather than re-reading
// env: `getSdk()` is already configured with the dev `uapi_` key, which
// unified-api's auth accepts on `/v1/relay` like any other credential.
//
// `getSdk()` throws when VITE_DEV_API_KEY is unset. That must not abort the
// caller: the loopback bridge authenticates with its own pairing token and
// works signed-out, so a missing dev key disables only the relay half.
function configureFromSdk(): void {
  try {
    configureLocalAgents({
      client: getSdk(),
      ...(env.VITE_UNIFIED_API_URL
        ? { wsBaseUrl: `${env.VITE_UNIFIED_API_URL.replace(/\/+$/, "")}/api/v1` }
        : {}),
    });
  } catch {
    // No dev key — bridge-only mode.
  }
}

function ensureLocalAgents(): Promise<LocalAgentSource | null> {
  if (!autoConnect) {
    configureFromSdk();
    autoConnect = resolveLocalAgentSource().catch(() => null);
  }
  return autoConnect;
}

/**
 * Whether a desktop source is connected. Synchronous (the host-api contract),
 * so it answers false until the lazy resolve above settles — kick that off here
 * too, so a caller that polls or re-renders converges without extra API.
 */
export function hasRunAgent(): boolean {
  void ensureLocalAgents();
  return isDesktopConnected();
}

/** Delegates to the shared prefix check — `claude-code/*` and `cursor/*`. */
export function isLocalAgentModel(modelId: string | null | undefined): boolean {
  return isLocalAgentModelId(modelId);
}

/**
 * The merged catalog: gateway models plus whichever local agent CLIs are
 * actually installed on the connected desktop — the same shape the embedded
 * host's `hostListModels` returns, so an app renders one picker either way.
 *
 * Returns the gateway half alone when no desktop is connected (rather than
 * `null`, which the contract reserves for "the host is too old to answer").
 *
 * `device` asks for a SPECIFIC machine's local half (from `listLocalDevices()`)
 * instead of the active source; the gateway half is the same either way.
 */
export async function listModels(options?: {
  device?: LocalAgentSourcePref;
}): Promise<HostModelEntry[]> {
  await ensureLocalAgents();
  const [gateway, local] = await Promise.all([
    getSdk()
      .models.list()
      .then((res) => res.data)
      .catch(() => []),
    listLocalModels(options?.device).catch(() => []),
  ]);
  const rows: HostModelEntry[] = gateway.map((m) => ({
    id: m.id,
    "model-id": m.id,
    name: m.name,
    author: m.model_author?.name ?? m.owned_by,
    type: m.type,
    owned_by: m.owned_by,
    logo: m.logo,
    model_author: m.model_author,
    context_size: m.context_size ?? null,
  }));
  return [...rows, ...local];
}

/**
 * One agent turn. Local-CLI models take the desktop lane (the app's own tools
 * are served to the CLI and execute here, in this page); everything else runs
 * the SDK's in-process agent loop exactly as before.
 */
export async function runAgent(
  options: RunAgentOptions & {
    sessionKey?: string;
    device?: LocalAgentSourcePref;
    /**
     * Run the local CLI FROM this host folder instead of the app's scratch
     * workspace. Meaningless to the gateway lane below (it has no filesystem),
     * so it is dropped there — see `workspace` on `runLocalAgent`.
     */
    workspace?: string;
  },
): Promise<RunAgentResult> {
  const { sessionKey, device, workspace, ...runOpts } = options;
  const model = runOpts.model;
  if (!model || !isLocalAgentModelId(model)) {
    return await getSdk().agent.run(runOpts);
  }
  await ensureLocalAgents();
  // `isDesktopConnected()` describes the ACTIVE source, which says nothing about
  // a device the caller picked explicitly — resolve that one instead.
  const reachable = device ? (await resolveSourceFor(device)) !== null : isDesktopConnected();
  if (!reachable) {
    return {
      ok: false,
      error:
        "No desktop app is connected, so local coding agents can't run. Open UnifiedApp on this machine and connect it.",
      model,
      producedOutput: false,
      messages: runOpts.messages ?? [],
    };
  }
  return await runLocalAgent({
    model,
    ...(runOpts.messages ? { messages: runOpts.messages } : {}),
    ...(runOpts.prompt !== undefined ? { prompt: runOpts.prompt } : {}),
    ...(runOpts.tools ? { tools: runOpts.tools } : {}),
    ...(runOpts.signal ? { signal: runOpts.signal } : {}),
    ...(runOpts.onEvent ? { onEvent: runOpts.onEvent } : {}),
    ...(sessionKey ? { conversationId: sessionKey } : {}),
    ...(device ? { source: device } : {}),
    // Read-only: write access is `trustWorkspace`, which only the HOST may set
    // (it grants it for folders its own user picked), never a browsing client.
    ...(workspace ? { workspace } : {}),
  });
}

// ── Desktop connection controls (standalone-dev only) ──────────────────────
// Not part of the `@unified/host-api` contract — inside the shell the desktop
// IS the host. Standalone dev needs them because pairing is a user action.

/**
 * Pair this origin with a running desktop app. PARKS on a consent modal on the
 * desktop, so call it only from an explicit user gesture. Resolves to the
 * connected source, or rejects with a readable error (no desktop running, the
 * user declined, the request timed out).
 */
export async function connectDesktop(): Promise<LocalAgentSource | null> {
  configureFromSdk();
  autoConnect = null;
  const source = await connectDesktopSource();
  autoConnect = Promise.resolve(source);
  return source;
}

/** Forget this origin's pairing token and fall back to the gateway lane. */
export async function disconnectDesktop(): Promise<void> {
  await disconnectDesktopSource();
  autoConnect = Promise.resolve(null);
}

/**
 * Whether a desktop is reachable on the loopback range. Probes `/health` only,
 * so it never prompts and needs no credential — safe to call on page load to
 * decide whether to offer a "Connect" affordance.
 */
export function checkDesktopAvailable(): Promise<boolean> {
  return checkDesktopAvailableSource();
}

/** Whether a pairing token for this origin exists — i.e. `connectDesktop` is not needed. */
export function isDesktopPaired(): boolean {
  return hasBridgeToken();
}

/** Live connection state (source, bridge availability, relay hosts, errors). */
export function getDesktopStatus(): LocalAgentStatus {
  void ensureLocalAgents();
  return getLocalAgentStatus();
}

export function onDesktopStatusChange(cb: (status: LocalAgentStatus) => void): () => void {
  void ensureLocalAgents();
  return onLocalAgentStatusChange(cb);
}

/** Re-probe the loopback range and re-list relay hosts. */
export async function refreshDesktop(): Promise<LocalAgentSource | null> {
  configureFromSdk();
  const source = await refreshLocalAgents();
  autoConnect = Promise.resolve(source);
  return source;
}

/**
 * Every device the user can run local agents on, for a compute picker. Derived
 * from the last probe/listing, so it is synchronous and never throws; the first
 * entry is what `auto` would resolve to. Empty until the lazy resolve below has
 * settled — subscribe with `onDesktopStatusChange` to re-read it.
 */
export function listLocalDevices(): LocalAgentDevice[] {
  void ensureLocalAgents();
  try {
    return listLocalAgentDevices();
  } catch {
    return [];
  }
}

/**
 * Re-probe the loopback bridge and re-list the relay hosts, then return the
 * devices. Prompt-free, and it leaves the active source alone.
 */
export async function refreshLocalDevices(): Promise<LocalAgentDevice[]> {
  configureFromSdk();
  try {
    return await refreshLocalAgentDevices();
  } catch {
    return [];
  }
}

/**
 * Open the folder picker on the DESKTOP (which is also the host-side read
 * consent for the folder chosen). Null when cancelled or not connected. Pass a
 * `device` to open it on that machine rather than the active source.
 */
export function pickWorkspaceFolder(device?: LocalAgentSourcePref): Promise<string | null> {
  return pickDesktopFolder(device);
}

export type { LocalAgentDevice, LocalAgentSourcePref };

// ── Host conveniences without a host ────────────────────────────────────────
// These mirror the bridge's documented "host too old / no host" fallbacks, so
// standalone dev behaves exactly like an old host and callers take the same
// degradation paths they would ship with.

/** No host usage source in standalone dev — callers fall back to `getSdk().usage`. */
export function getUsage(): Promise<null> {
  return Promise.resolve(null);
}

/** No project context in standalone dev. */
export function getCurrentProject(): ProjectContext | null {
  return null;
}

/**
 * Fires once with `null` (the bridge fires immediately with the current
 * context, which standalone dev never has) and never again; the unsubscribe
 * is a no-op.
 */
export function onProjectChange(cb: (project: ProjectContext | null) => void): () => void {
  cb(null);
  return () => {};
}

/**
 * Resolves to null — the bridge's "there is no shell" outcome — so apps take
 * their documented fallback and surface the artifact in their own UI.
 */
export function openArtifact(): Promise<null> {
  return Promise.resolve(null);
}

/** No local-disk browsing in standalone dev — same "host too old" rejection
    a real bridge gives when it lacks the verb. */
export function listHostDir(): Promise<never> {
  return Promise.reject(new Error("@unified/host-api: listHostDir unavailable in standalone dev"));
}

/** No native folder picker in standalone dev. */
export function pickLocalFolder(): Promise<null> {
  return Promise.resolve(null);
}

/** No local-disk browsing in standalone dev — same "host too old" rejection
    a real bridge gives when it lacks the verb. */
export function readLocalFolderFiles(): Promise<never> {
  return Promise.reject(
    new Error("@unified/host-api: readLocalFolderFiles unavailable in standalone dev"),
  );
}
