import { Observable } from "../core/_internal/observable.js";
import { type LocalAgentDirListing } from "./dirListing.js";
export interface RelayCapabilities {
    claudeCode: {
        found: boolean;
    };
    cursor: {
        found: boolean;
    };
}
export interface RelayHost {
    deviceId: string;
    deviceName: string;
    capabilities: RelayCapabilities;
    connectedAt?: string;
}
export type ApprovalState = "unknown" | "pending" | "approved" | "denied";
export interface RelayDetectResult {
    claudeCode: {
        found: boolean;
        path: string | null;
    };
    cursor: {
        found: boolean;
        path: string | null;
    };
}
export interface RelayRunHandlers {
    onLine(line: string): void;
    onExit(exit: {
        code: number | null;
        canceled: boolean;
        stderr: string;
    }): void;
    onMcpList?(id: string): void;
    onMcpCall?(id: string, name: string, args: unknown): void;
}
export interface RelayStartArgs {
    runId: string;
    lane: "claude-code" | "cursor";
    prompt: string;
    model: string | null;
    effort?: string | null;
    /** Claude Code only; the caller's system instructions. */
    systemPrompt?: string | null;
    resume?: string | null;
    workspace?: string | null;
    trustWorkspace?: boolean;
    extraDirs?: string[];
    mcp: boolean;
}
/**
 * The account's currently online hosts. A plain authenticated GET — listing is
 * NOT a connection, so it is safe to call while merely deciding which compute
 * source to offer, and it raises no consent anywhere.
 *
 * Goes through the ordinary `/api/v1/*` path the rest of the SDK uses (a dev
 * proxy handles it in standalone dev); only the WebSockets below need an
 * absolute base.
 */
export declare function listRelayHosts(): Promise<RelayHost[]>;
export interface RelayHostStatus {
    deviceId: string;
    /** A host socket is up, so connecting needs no knock. */
    socket: boolean;
    /** Conversations with a turn running on that host. */
    working: string[];
    /** Conversations waiting on the user there → what they wait for. */
    awaiting: Record<string, string>;
}
export interface RelayStatus {
    hosts: RelayHostStatus[];
    /** Moves on every chat write; null when the server has seen none since it started. */
    chatSync: number | null;
}
export interface RelayPresence {
    deviceId: string;
    deviceName?: string;
    working?: string[];
    awaiting?: Record<string, string>;
    capabilities?: Record<string, unknown>;
}
export interface RelayPresenceAnswer {
    /** A client wants this host's socket. */
    wake: boolean;
    chatSync: number | null;
    /** The server has no capabilities for this host, as after a restart. */
    sendCapabilities: boolean;
}
/** Who is online and what they run. Null when signed out or the server didn't answer. */
export declare function relayStatus(): Promise<RelayStatus | null>;
/**
 * Ask a polling host to open its socket. Null when the server didn't answer, in
 * which case the connect attempt still tells the caller where things stand.
 */
export declare function knockRelayHost(deviceId: string): Promise<{
    online: boolean;
    socket: boolean;
} | null>;
/**
 * A host's poll. `status` lets it tell "this device isn't yours" (403, stop
 * polling) from a passing failure (try again next poll); 0 means signed out.
 */
export declare function postRelayPresence(presence: RelayPresence): Promise<{
    status: number;
    answer: RelayPresenceAnswer | null;
}>;
/**
 * Relay WebSockets connect to unified-api DIRECTLY rather than through the
 * local proxies the HTTP calls use: dev proxies do not handle upgrades
 * reliably. `relayWsBase()` resolves the absolute unified-api base (see
 * config.ts), so `/relay/*` hangs off it directly.
 */
export declare function relayWsUrl(path: string): string;
/**
 * Browsers cannot set headers on a WebSocket handshake, so the token rides the
 * subprotocol (agent-relay.md § WS auth). The server echoes the selected
 * subprotocol back.
 */
export declare function bearerSubprotocol(): Promise<string | null>;
export declare function clientDeviceId(): string;
export declare function clientDeviceName(): string;
export interface RelayConnection {
    readonly deviceId: string;
    /** Observable so a UI can render live state without polling. */
    readonly approval: Observable<ApprovalState>;
    readonly connected: Observable<boolean>;
    readonly host: Observable<RelayHost | null>;
    readonly lastError: Observable<string | null>;
    /** Resolves once the socket is attached AND the host has approved this device. */
    ready(timeoutMs?: number): Promise<void>;
    detect(): Promise<RelayDetectResult>;
    cursorModels(json: boolean): Promise<string>;
    pickFolder(): Promise<string | null>;
    listDir(path?: string): Promise<LocalAgentDirListing>;
    /**
     * The repository each path belongs to, index-for-index, `null` where there is
     * none. Batched because a caller learns a run's paths together and the host
     * answers with filesystem stats — one round trip rather than a walk over the
     * wire. A host that restricts remote access answers `null` for anything
     * outside the grant, indistinguishable from "not in a repo".
     */
    repoRoots(paths: string[]): Promise<Array<string | null>>;
    startRun(args: RelayStartArgs, handlers: RelayRunHandlers): Promise<void>;
    stopRun(runId: string): void;
    mcpResult(id: string, result: unknown): void;
    close(): void;
}
export declare function connectRelayHost(deviceId: string): RelayConnection;
/** Drop a cached connection ("disconnect", source switch). */
export declare function closeRelayHost(deviceId: string): void;
export declare function closeAllRelayHosts(): void;
//# sourceMappingURL=relayClient.d.ts.map