/**
 * Client half of the host's inline-preview protocol — import from
 * "@unifiedai/sdk/app/embed".
 *
 * This is a BYTE-COMPATIBLE DUPLICATE of
 * apps/desktop/shared/host-embed/index.ts in the UnifiedApp repo. The wire
 * format must stay identical between the two copies (same duplicated-codec
 * convention as elementRefToken) — an app cannot import the desktop file
 * directly (its embed bundle is a self-contained IIFE with no host globals),
 * so this SDK copy exists so third-party apps get the same protocol without
 * pulling in the desktop repo. Change both files together.
 *
 * The frame runs in an opaque origin (sandbox without allow-same-origin), so
 * it cannot reach the host's globals, its SDK, or any other app's frame.
 * Everything it needs arrives over postMessage, and the only actions it may
 * ask the host to run are its OWN app's declared, non-mutating ones.
 */
const MSG = "__unifiedEmbed";

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

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** Cleared on response so a resolved call stops holding a live timer. */
  timer: ReturnType<typeof setTimeout>;
}

let seq = 0;
const pending = new Map<string, Pending>();
let onInitCb: ((init: EmbedInit) => void) | null = null;
let onThemeCb: ((theme: Theme) => void) | null = null;
let onToolCb: ((id: string, active: boolean) => void) | null = null;

function post(payload: Record<string, unknown>): void {
  parent.postMessage({ [MSG]: true, ...payload }, "*");
}

window.addEventListener("message", (e: MessageEvent) => {
  // Only the host (our parent) drives this frame.
  if (e.source !== parent) return;
  const msg = e.data as
    | {
        [key: string]: unknown;
        t?: string;
        id?: string;
        ok?: boolean;
        value?: unknown;
        error?: { code?: string; message?: string };
      }
    | undefined;
  if (!msg || msg[MSG] !== true) return;

  if (msg.t === "init") {
    onInitCb?.({
      payload: msg.payload ?? null,
      theme: msg.theme === "dark" ? "dark" : "light",
      fill: msg.fill === true,
    });
  } else if (msg.t === "theme") {
    onThemeCb?.(msg.theme === "dark" ? "dark" : "light");
  } else if (msg.t === "tool" && typeof msg.id === "string" && typeof msg.active === "boolean") {
    onToolCb?.(msg.id, msg.active);
  } else if (msg.t === "res" && msg.id) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error?.message || "Host action failed"));
  }
});

/** Ask the host to run one of THIS app's declared, non-mutating actions. */
export function call<T = unknown>(
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const id = `c${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`Host action "${action}" timed out`));
    }, 20_000);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    post({ t: "call", id, action, params });
  });
}

/** Tell the host how tall this preview wants to be. Host clamps to its own max. */
/**
 * Ask the host to size the frame to `height`. Ignored when `EmbedInit.fill` is
 * true — the host owns the box there.
 */
export function resize(height: number): void {
  post({ t: "resize", height });
}

/** Ask the host to open this item full-size. The host relays it to whichever
 *  action the app's own manifest declares as `preview.open`. */
export function openFull(): void {
  post({ t: "open" });
}

/** Surface a failure as the host's error state instead of a blank frame. */
export function fail(message: string): void {
  post({ t: "error", message });
}

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
export function reference(ref: EmbedReference): void {
  post({ t: "reference", ref });
}

export function onInit(cb: (init: EmbedInit) => void): void {
  onInitCb = cb;
}
export function onTheme(cb: (theme: Theme) => void): void {
  onThemeCb = cb;
}

/** The host toggled one of this app's `preview.tools` buttons; set that tool's state. */
export function onTool(cb: (id: string, active: boolean) => void): void {
  onToolCb = cb;
}

/** Report a state change this embed made to itself (e.g. it disarmed after use)
 *  for one of its declared `preview.tools`, so the host's button stays in sync. */
export function toolState(id: string, active: boolean): void {
  post({ t: "tool", id, active });
}

/** Announce readiness. The host replies with `init`; call this last. */
export function ready(): void {
  post({ t: "ready" });
}
