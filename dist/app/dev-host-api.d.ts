import { UnifiedAI } from "../core/client.js";
import type { HostModelEntry, ProjectContext } from "../host-api.js";
import { type LocalAgentDevice, type LocalAgentSource, type LocalAgentSourcePref, type LocalAgentStatus } from "../localAgents/index.js";
import { fsTools } from "../resources/agent/fs-tools.js";
import type { RunAgentOptions, RunAgentResult } from "../resources/agent/types.js";
import { getProviderLogo } from "../resources/logos.js";
export declare function getSdk(): UnifiedAI;
export { getProviderLogo, fsTools };
export declare function getTheme(): "light" | "dark";
export declare function onThemeChange(cb: (theme: "light" | "dark") => void): () => void;
export declare function registerActions(_handlers: Record<string, (params: Record<string, unknown>, ctx: unknown) => unknown>): () => void;
/**
 * Whether a desktop source is connected. Synchronous (the host-api contract),
 * so it answers false until the lazy resolve above settles — kick that off here
 * too, so a caller that polls or re-renders converges without extra API.
 */
export declare function hasRunAgent(): boolean;
/** Delegates to the shared prefix check — `claude-code/*` and `cursor/*`. */
export declare function isLocalAgentModel(modelId: string | null | undefined): boolean;
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
export declare function listModels(options?: {
    device?: LocalAgentSourcePref;
}): Promise<HostModelEntry[]>;
/**
 * One agent turn. Local-CLI models take the desktop lane (the app's own tools
 * are served to the CLI and execute here, in this page); everything else runs
 * the SDK's in-process agent loop exactly as before.
 */
export declare function runAgent(options: RunAgentOptions & {
    sessionKey?: string;
    device?: LocalAgentSourcePref;
    /**
     * Run the local CLI FROM this host folder instead of the app's scratch
     * workspace. Meaningless to the gateway lane below (it has no filesystem),
     * so it is dropped there — see `workspace` on `runLocalAgent`.
     */
    workspace?: string;
}): Promise<RunAgentResult>;
/**
 * Pair this origin with a running desktop app. PARKS on a consent modal on the
 * desktop, so call it only from an explicit user gesture. Resolves to the
 * connected source, or rejects with a readable error (no desktop running, the
 * user declined, the request timed out).
 */
export declare function connectDesktop(): Promise<LocalAgentSource | null>;
/** Forget this origin's pairing token and fall back to the gateway lane. */
export declare function disconnectDesktop(): Promise<void>;
/**
 * Whether a desktop is reachable on the loopback range. Probes `/health` only,
 * so it never prompts and needs no credential — safe to call on page load to
 * decide whether to offer a "Connect" affordance.
 */
export declare function checkDesktopAvailable(): Promise<boolean>;
/** Whether a pairing token for this origin exists — i.e. `connectDesktop` is not needed. */
export declare function isDesktopPaired(): boolean;
/** Live connection state (source, bridge availability, relay hosts, errors). */
export declare function getDesktopStatus(): LocalAgentStatus;
export declare function onDesktopStatusChange(cb: (status: LocalAgentStatus) => void): () => void;
/** Re-probe the loopback range and re-list relay hosts. */
export declare function refreshDesktop(): Promise<LocalAgentSource | null>;
/**
 * Every device the user can run local agents on, for a compute picker. Derived
 * from the last probe/listing, so it is synchronous and never throws; the first
 * entry is what `auto` would resolve to. Empty until the lazy resolve below has
 * settled — subscribe with `onDesktopStatusChange` to re-read it.
 */
export declare function listLocalDevices(): LocalAgentDevice[];
/**
 * Re-probe the loopback bridge and re-list the relay hosts, then return the
 * devices. Prompt-free, and it leaves the active source alone.
 */
export declare function refreshLocalDevices(): Promise<LocalAgentDevice[]>;
/**
 * Open the folder picker on the DESKTOP (which is also the host-side read
 * consent for the folder chosen). Null when cancelled or not connected. Pass a
 * `device` to open it on that machine rather than the active source.
 */
export declare function pickWorkspaceFolder(device?: LocalAgentSourcePref): Promise<string | null>;
export type { LocalAgentDevice, LocalAgentSourcePref };
/** No host usage source in standalone dev — callers fall back to `getSdk().usage`. */
export declare function getUsage(): Promise<null>;
/** No project context in standalone dev. */
export declare function getCurrentProject(): ProjectContext | null;
/**
 * Fires once with `null` (the bridge fires immediately with the current
 * context, which standalone dev never has) and never again; the unsubscribe
 * is a no-op.
 */
export declare function onProjectChange(cb: (project: ProjectContext | null) => void): () => void;
/**
 * Resolves to null — the bridge's "there is no shell" outcome — so apps take
 * their documented fallback and surface the artifact in their own UI.
 */
export declare function openArtifact(): Promise<null>;
/** No local-disk browsing in standalone dev — same "host too old" rejection
    a real bridge gives when it lacks the verb. */
export declare function listHostDir(): Promise<never>;
/** No native folder picker in standalone dev. */
export declare function pickLocalFolder(): Promise<null>;
/** No local-disk browsing in standalone dev — same "host too old" rejection
    a real bridge gives when it lacks the verb. */
export declare function readLocalFolderFiles(): Promise<never>;
//# sourceMappingURL=dev-host-api.d.ts.map