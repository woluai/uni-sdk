export type Theme = "light" | "dark";
export interface EmbedInit {
    /** This app's own payload, forwarded verbatim by the host. */
    payload: unknown;
    theme: Theme;
    /**
     * Computed host CSS variables (`--text`, `--bg-glass`, …). Optional: a plugin
     * that wants its own look can ignore them. Posted so a sandboxed page can
     * match the shell without running in the host origin.
     */
    tokens?: Record<string, string> | undefined;
    /**
     * The host has given this frame a FIXED box (it is docked in the artifact
     * side panel) rather than sizing the frame to whatever height the embed asks
     * for. Two consequences for the embed:
     *
     *  - size to the viewport — `document.documentElement.clientHeight` is real
     *    available space, not a value the embed itself caused;
     *  - `resize()` is ignored, so don't derive layout from a height the host
     *    will never grant.
     *
     * False for an inline card, where the embed's own `resize()` drives the
     * frame's height and reading the viewport height would feed back on itself.
     */
    fill: boolean;
}
/** A host refusal or timeout, with the protocol error code intact. */
export declare class EmbedError extends Error {
    readonly code?: string;
    constructor(message: string, code?: string);
}
/** Ask the host to run one of THIS app's declared, non-mutating actions. */
export declare function call<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>;
export interface EmbedFetchOptions {
    method?: "GET" | "POST" | "HEAD";
    headers?: Record<string, string>;
    body?: string | null;
    /** Host cache lifetime in seconds, capped at one hour. Omit to disable caching. */
    maxAge?: number;
}
export interface EmbedFetchResponse {
    status: number;
    body: string;
    /** Seconds since the host fetched this response; zero for a fresh response. */
    age: number;
}
/** Fetch through the desktop host's declared-origin allowlist and user consent.
 *  HTTP errors resolve with their status; host refusals reject with EmbedError. */
export declare function hostFetch(url: string, options?: EmbedFetchOptions): Promise<EmbedFetchResponse>;
/** Set the header badge. The host trims to 8 characters; an empty string clears it. */
export declare function badge(text: string): void;
export interface EmbedWidgetValue {
    /** Text drawn by the host, capped at 6 characters. */
    text: string;
    level?: "calm" | "warn" | "alarm";
    /** Hover text, capped at 80 characters. */
    title?: string;
}
export interface EmbedWidgetItem {
    /** Key from surfaces.header.icons; unknown keys use the app's own icon. */
    icon?: string;
    /** Accessible label, capped at 40 characters. */
    label?: string;
    /** The host displays at most two values per item. */
    values: EmbedWidgetValue[];
}
/** Describe up to four header items for the host to draw. An empty array clears them. */
export declare function widget(items: EmbedWidgetItem[]): void;
/** Tell the host how tall this preview wants to be. Host clamps to its own max. */
/**
 * Ask the host to size the frame to `height`. Ignored when `EmbedInit.fill` is
 * true — the host owns the box there.
 */
export declare function resize(height: number): void;
/** Ask the host to open this item full-size. The host relays it to whichever
 *  action the app's own manifest declares as `preview.open`. */
export declare function openFull(): void;
/** Surface a failure as the host's error state instead of a blank frame. */
export declare function fail(message: string): void;
/**
 * One item inside this embed that the user picked to talk about. The host turns
 * it into a composer mention chip and, at send time, hands it back to whichever
 * action this app's manifest declares as `preview.resolveReference` — so the
 * app resolves its own reference into prompt text and the host stays ignorant
 * of what it means.
 */
export interface EmbedReference {
    /** App-scoped stable id, e.g. `<designId>#oid=<oid>`. Capped at 512 chars. */
    id: string;
    /** Chip label. The host truncates to 80 chars. */
    label: string;
    /** What it is, e.g. "design-element". `[a-z0-9-]+`, up to 40 chars. */
    artifactType: string;
    /** Small `data:image/*` URL. Dropped by the host if it exceeds its cap. */
    thumbnail?: string;
    /** Opaque to the host; echoed back verbatim to `resolveReference`. Rejected
     *  if its JSON exceeds 8 KB. */
    data?: Record<string, unknown>;
}
/** Push one of this embed's items at the chat composer as a mention chip. The
 *  frame never names its app — the host stamps that from the frame's identity. */
export declare function reference(ref: EmbedReference): void;
export declare function onInit(cb: (init: EmbedInit) => void): void;
export declare function onTheme(cb: (theme: Theme, tokens?: Record<string, string>) => void): void;
/** The host toggled one of this app's `preview.tools` buttons; set that tool's state. */
export declare function onTool(cb: (id: string, active: boolean) => void): void;
/** Report a state change this embed made to itself (e.g. it disarmed after use)
 *  for one of its declared `preview.tools`, so the host's button stays in sync. */
export declare function toolState(id: string, active: boolean): void;
/** Announce readiness. The host replies with `init`; call this last. */
export declare function ready(): void;
//# sourceMappingURL=embed.d.ts.map