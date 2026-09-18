export type Theme = "light" | "dark";
export interface EmbedInit {
    /** This app's own payload, forwarded verbatim by the host. */
    payload: unknown;
    theme: Theme;
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
/** Ask the host to run one of THIS app's declared, non-mutating actions. */
export declare function call<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>;
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
export declare function onTheme(cb: (theme: Theme) => void): void;
/** The host toggled one of this app's `preview.tools` buttons; set that tool's state. */
export declare function onTool(cb: (id: string, active: boolean) => void): void;
/** Report a state change this embed made to itself (e.g. it disarmed after use)
 *  for one of its declared `preview.tools`, so the host's button stays in sync. */
export declare function toolState(id: string, active: boolean): void;
/** Announce readiness. The host replies with `init`; call this last. */
export declare function ready(): void;
//# sourceMappingURL=embed.d.ts.map