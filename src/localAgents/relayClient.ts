// Client side of the cross-device **agent relay**.
//
// Wire contract: UnifiedApp `apps/desktop/docs/agent-relay.md`. Peers are
// unified-api `modules/relay/` (the server) and the desktop's
// `agentCli/relayHost.ts` (the machine that actually runs the CLIs). This is a
// port of the desktop frontend's `src/agentCli/relayClient.ts` with Vue's `ref`
// replaced by the SDK's own `Observable` — the frames are byte-identical.
//
// A "client" here is any signed-in surface that wants to drive ANOTHER
// machine's Claude Code / Cursor. It lists the account's online hosts over
// plain HTTP, then opens one WebSocket per host it uses. Run-level frames are
// deliberately identical to the loopback bridge's, so `transport.ts` maps both
// backends onto the same lane surface and the CLIs' raw NDJSON lines reach the
// unchanged translators either way.
//
// Nothing here connects on import: `listRelayHosts()` is a GET, and
// `connectRelayHost()` is only called once a source has actually been chosen.
import { Observable } from "../core/_internal/observable";
import { localAgentsConfig, relayWsBase, unifiedApiUrl, unifiedToken } from "./config";
import { type LocalAgentDirListing, normalizeDirListing } from "./dirListing";

export interface RelayCapabilities {
  claudeCode: { found: boolean };
  cursor: { found: boolean };
}

export interface RelayHost {
  deviceId: string;
  deviceName: string;
  capabilities: RelayCapabilities;
  connectedAt?: string;
}

export type ApprovalState = "unknown" | "pending" | "approved" | "denied";

export interface RelayDetectResult {
  claudeCode: { found: boolean; path: string | null };
  cursor: { found: boolean; path: string | null };
}

export interface RelayRunHandlers {
  onLine(line: string): void;
  onExit(exit: { code: number | null; canceled: boolean; stderr: string }): void;
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

/** Request/response frames time out; a run's stream does not (it can think for minutes). */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * A polling host opens its socket on its next poll after a knock, so a 4404
 * right after one means "not yet". Longer than one poll, shorter than ready().
 */
const WAKE_TIMEOUT_MS = 10_000;
const WAKE_RETRY_MS = 500;
/** Reconnect backoff, doubling to the ceiling. */
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;

// ── Host listing ────────────────────────────────────────────────────────────

/**
 * The account's currently online hosts. A plain authenticated GET — listing is
 * NOT a connection, so it is safe to call while merely deciding which compute
 * source to offer, and it raises no consent anywhere.
 *
 * Goes through the ordinary `/api/v1/*` path the rest of the SDK uses (a dev
 * proxy handles it in standalone dev); only the WebSockets below need an
 * absolute base.
 */
export async function listRelayHosts(): Promise<RelayHost[]> {
  const token = await unifiedToken();
  if (!token) return [];
  const base = unifiedApiUrl().replace(/\/+$/, "");
  const res = await fetch(`${base}/api/v1/relay/hosts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Relay host listing failed (HTTP ${res.status}).`);
  const data = (await res.json()) as unknown;
  const rows = Array.isArray(data) ? data : ((data as { hosts?: unknown })?.hosts ?? []);
  if (!Array.isArray(rows)) return [];
  return rows.filter(isRelayHost);
}

function isRelayHost(value: unknown): value is RelayHost {
  const v = value as RelayHost | null;
  return !!v && typeof v.deviceId === "string" && typeof v.deviceName === "string";
}

// ── Presence, status, knock ─────────────────────────────────────────────────
//
// A sharing desktop holds no socket until someone needs one: it polls `/presence`,
// clients poll `/status` and `/knock` a host to bring its socket up
// (agent-relay.md § On-demand sockets). All plain HTTP, like the listing above.

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

async function relayFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  const token = await unifiedToken();
  if (!token) return null;
  const base = unifiedApiUrl().replace(/\/+$/, "");
  return fetch(`${base}/api/v1/relay${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
}

/** Who is online and what they run. Null when signed out or the server didn't answer. */
export async function relayStatus(): Promise<RelayStatus | null> {
  const res = await relayFetch("/status").catch(() => null);
  return res?.ok ? ((await res.json()) as RelayStatus) : null;
}

/**
 * Ask a polling host to open its socket. Null when the server didn't answer, in
 * which case the connect attempt still tells the caller where things stand.
 */
export async function knockRelayHost(
  deviceId: string,
): Promise<{ online: boolean; socket: boolean } | null> {
  const res = await relayFetch(`/knock/${encodeURIComponent(deviceId)}`, { method: "POST" }).catch(
    () => null,
  );
  return res?.ok ? ((await res.json()) as { online: boolean; socket: boolean }) : null;
}

/**
 * A host's poll. `status` lets it tell "this device isn't yours" (403, stop
 * polling) from a passing failure (try again next poll); 0 means signed out.
 */
export async function postRelayPresence(
  presence: RelayPresence,
): Promise<{ status: number; answer: RelayPresenceAnswer | null }> {
  const res = await relayFetch("/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(presence),
  });
  if (!res) return { status: 0, answer: null };
  return { status: res.status, answer: res.ok ? ((await res.json()) as RelayPresenceAnswer) : null };
}

// ── WebSocket URL ───────────────────────────────────────────────────────────

/**
 * Relay WebSockets connect to unified-api DIRECTLY rather than through the
 * local proxies the HTTP calls use: dev proxies do not handle upgrades
 * reliably. `relayWsBase()` resolves the absolute unified-api base (see
 * config.ts), so `/relay/*` hangs off it directly.
 */
export function relayWsUrl(path: string): string {
  const url = new URL(`${relayWsBase()}/relay${path}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Browsers cannot set headers on a WebSocket handshake, so the token rides the
 * subprotocol (agent-relay.md § WS auth). The server echoes the selected
 * subprotocol back.
 */
export async function bearerSubprotocol(): Promise<string | null> {
  const token = await unifiedToken();
  return token ? `unified-bearer.${token}` : null;
}

/**
 * This surface's own identity, for the host's client list and block list.
 * Deliberately
 * client-local and not an auth input: a browser tab has no registered device id,
 * and inventing one the server trusted would be a hole — the contract has the
 * server report `deviceVerified: false` for exactly this case. Stable across
 * reloads so a block the user set stays set across them.
 */
const CLIENT_ID_KEY = "unified.agentRelay.clientId";

export function clientDeviceId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    globalThis.localStorage?.setItem(CLIENT_ID_KEY, fresh);
    return fresh;
  } catch {
    return "browser";
  }
}

export function clientDeviceName(): string {
  const name = localAgentsConfig().clientName?.trim() || "UnifiedAI app";
  if (typeof location === "undefined") return name;
  return `${name} (${location.host})`;
}

// ── Connection ──────────────────────────────────────────────────────────────

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

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

/**
 * Open (or reuse) the connection to one host. Connections are cached per
 * deviceId for the app session — a second caller gets the live socket rather
 * than a second `client-open` on the host.
 */
const connections = new Map<string, RelayConnection>();

export function connectRelayHost(deviceId: string): RelayConnection {
  const existing = connections.get(deviceId);
  if (existing) return existing;
  const conn = createConnection(deviceId);
  connections.set(deviceId, conn);
  return conn;
}

/** Drop a cached connection ("disconnect", source switch). */
export function closeRelayHost(deviceId: string): void {
  connections.get(deviceId)?.close();
  connections.delete(deviceId);
}

export function closeAllRelayHosts(): void {
  for (const id of [...connections.keys()]) closeRelayHost(id);
}

function createConnection(deviceId: string): RelayConnection {
  const approval = new Observable<ApprovalState>("unknown");
  const connected = new Observable(false);
  const host = new Observable<RelayHost | null>(null);
  const lastError = new Observable<string | null>(null);

  const pending = new Map<string, Pending>();
  const runs = new Map<string, RelayRunHandlers>();
  const readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  let socket: WebSocket | null = null;
  let backoff = BACKOFF_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closedByUs = false;
  let opening = false;
  /** While set and in the future, a 4404 means the knocked host hasn't opened yet. */
  let wakeUntil = 0;

  function settleReady(): void {
    if (approval.get() !== "approved" || !connected.get()) return;
    while (readyWaiters.length) readyWaiters.shift()?.resolve();
  }

  function failReady(message: string): void {
    while (readyWaiters.length) readyWaiters.shift()?.reject(new Error(message));
  }

  /**
   * Why a `ready()` wait ran out. A socket that never opened is a CONNECTION
   * failure — reporting it as "not approved" invents a refusal the host never
   * made and sends the user hunting for an approval prompt that isn't there.
   */
  function notReadyReason(): string {
    if (!connected.get()) return lastError.get() ?? "Couldn't reach that computer.";
    if (approval.get() === "denied") return "That computer declined this device.";
    return "That computer didn't answer in time.";
  }

  function send(frame: Record<string, unknown>): void {
    if (socket?.readyState !== 1 /* OPEN */) {
      throw new Error("Not connected to that computer.");
    }
    socket.send(JSON.stringify(frame));
  }

  function request(frame: Record<string, unknown>, timeoutMs: number | null = REQUEST_TIMEOUT_MS) {
    const id = crypto.randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (timeoutMs !== null) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("The other computer didn't answer in time."));
        }, timeoutMs);
      }
      pending.set(id, entry);
      try {
        send({ ...frame, id });
      } catch (err) {
        pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function resolvePending(id: string, frame: Record<string, unknown>): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(frame);
  }

  function rejectPending(id: string, message: string): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }

  /** One inbound frame → local state / handlers. Exported behavior under test. */
  function handleFrame(frame: Record<string, unknown>): void {
    switch (frame.type) {
      case "attached": {
        const h = frame.host as RelayHost | undefined;
        if (h && typeof h.deviceId === "string") host.set(h);
        // The host answers with `approval`; ask explicitly so a host that only
        // pushes on change still tells us where we stand.
        try {
          send({ type: "approve?" });
        } catch {
          /* the socket just opened; a throw here is not actionable */
        }
        break;
      }
      case "approval": {
        const state = frame.state;
        approval.set(
          state === "approved" || state === "pending" || state === "denied" ? state : "unknown",
        );
        if (approval.get() === "approved") settleReady();
        if (approval.get() === "denied") {
          failReady("That computer declined this device.");
          lastError.set("That computer declined this device.");
        }
        break;
      }
      case "host-closed":
        // A host with nothing to do closes its socket. Only a run it took with it is news.
        if (runs.size) lastError.set("That computer went offline.");
        endAllRuns("the host went offline");
        break;
      // ALLOWLIST, not a formality: a reply whose type is missing here is
      // silently dropped and its caller waits out the full timeout instead of
      // failing. Adding a request verb means adding its result here too.
      case "detect-result":
      case "cursor-models-result":
      case "pick-folder-result":
      case "list-dir-result":
      case "repo-root-result":
        if (typeof frame.id === "string") resolvePending(frame.id, frame);
        break;
      case "line": {
        const run = typeof frame.runId === "string" ? runs.get(frame.runId) : undefined;
        if (run && typeof frame.line === "string") run.onLine(frame.line);
        break;
      }
      case "exit": {
        const runId = typeof frame.runId === "string" ? frame.runId : "";
        const run = runs.get(runId);
        if (!run) break;
        runs.delete(runId);
        run.onExit({
          code: typeof frame.code === "number" ? frame.code : null,
          canceled: frame.canceled === true,
          stderr: typeof frame.stderr === "string" ? frame.stderr : "",
        });
        break;
      }
      case "mcp-list": {
        const run = typeof frame.runId === "string" ? runs.get(frame.runId) : undefined;
        if (run && typeof frame.id === "string") run.onMcpList?.(frame.id);
        break;
      }
      case "mcp-call": {
        const run = typeof frame.runId === "string" ? runs.get(frame.runId) : undefined;
        if (run && typeof frame.id === "string" && typeof frame.name === "string") {
          run.onMcpCall?.(frame.id, frame.name, frame.arguments);
        }
        break;
      }
      case "error": {
        const message = typeof frame.message === "string" ? frame.message : "Relay error";
        lastError.set(message);
        if (typeof frame.id === "string") rejectPending(frame.id, message);
        if (typeof frame.runId === "string") {
          const run = runs.get(frame.runId);
          if (run) {
            runs.delete(frame.runId);
            run.onExit({ code: null, canceled: false, stderr: message });
          }
        }
        break;
      }
    }
  }

  /**
   * Every in-flight run dies with the socket. Surfacing it as a normal `exit`
   * (rather than leaving the turn hanging forever) lets the lane's existing
   * failure path render it — the CLI on the far side is genuinely gone.
   */
  function endAllRuns(reason: string): void {
    for (const [runId, handlers] of [...runs]) {
      runs.delete(runId);
      handlers.onExit({ code: null, canceled: false, stderr: `Relay connection lost: ${reason}` });
    }
    for (const id of [...pending.keys()]) rejectPending(id, `Relay connection lost: ${reason}`);
  }

  function reportOffline(): void {
    wakeUntil = 0;
    lastError.set("That computer is offline.");
    failReady("That computer is offline.");
  }

  async function open(): Promise<void> {
    if (closedByUs || opening || socket) return;
    opening = true;
    try {
      await connect();
    } finally {
      opening = false;
    }
  }

  async function connect(): Promise<void> {
    if (!wakeUntil) wakeUntil = Date.now() + WAKE_TIMEOUT_MS;
    const knock = await knockRelayHost(deviceId);
    if (closedByUs) return;
    if (knock && !knock.online) return reportOffline();
    // The unified-api bearer may be short-lived, so it is fetched per
    // connection attempt rather than captured once.
    const proto = await bearerSubprotocol();
    if (closedByUs) return;
    if (!proto) {
      lastError.set("Not signed in.");
      failReady("Not signed in.");
      return;
    }
    let ws: WebSocket;
    try {
      // Display hints only — the trust anchor is the credential on the upgrade.
      // Without them the host's approval card can only show an opaque id, and a
      // consent prompt the user cannot recognize is one they will click through.
      const hints = new URLSearchParams({
        deviceId: clientDeviceId(),
        deviceName: clientDeviceName(),
      });
      ws = new WebSocket(`${relayWsUrl(`/connect/${encodeURIComponent(deviceId)}`)}?${hints}`, [
        proto,
      ]);
    } catch (err) {
      lastError.set(err instanceof Error ? err.message : String(err));
      scheduleRetry();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      connected.set(true);
      backoff = BACKOFF_MIN_MS;
      lastError.set(null);
    };
    // A socket that opens is not attached yet: 4404 arrives after the upgrade.
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      handleFrame(frame);
    };
    ws.onclose = (event: CloseEvent) => {
      connected.set(false);
      if (socket === ws) socket = null;
      endAllRuns("socket closed");
      // 4403 (not your device) is a terminal answer, not a transient failure.
      if (event.code === 4403) {
        wakeUntil = 0;
        approval.set("denied");
        lastError.set("That computer isn't yours to use.");
        failReady("That computer isn't yours to use.");
        return;
      }
      // 4404 means no socket yet. Right after a knock that is the host on its way.
      if (event.code === 4404) {
        if (Date.now() >= wakeUntil) return reportOffline();
        if (!retryTimer && !closedByUs) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void open();
          }, WAKE_RETRY_MS);
        }
        return;
      }
      wakeUntil = 0;
      // A host with nothing to do closes its socket, and waking it again costs the
      // user money, so only reconnect for a caller who is waiting. ready() reopens.
      if (readyWaiters.length) scheduleRetry();
    };
    ws.onerror = () => {
      lastError.set("Relay connection error.");
    };
  }

  function scheduleRetry(): void {
    if (closedByUs || retryTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void open();
    }, delay);
  }

  void open();

  const conn: RelayConnection = {
    deviceId,
    approval,
    connected,
    host,
    lastError,

    ready(timeoutMs = REQUEST_TIMEOUT_MS) {
      if (connected.get() && approval.get() === "approved") return Promise.resolve();
      if (approval.get() === "denied") {
        return Promise.reject(new Error("That computer declined this device."));
      }
      if (!retryTimer) void open();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(notReadyReason())), timeoutMs);
        readyWaiters.push({
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        settleReady();
      });
    },

    async detect() {
      await conn.ready();
      const frame = await request({ type: "detect" });
      return {
        claudeCode: normalizeDetect(frame.claudeCode),
        cursor: normalizeDetect(frame.cursor),
      };
    },

    async cursorModels(json: boolean) {
      await conn.ready();
      const frame = await request({ type: "cursor-models", format: json ? "json" : "text" });
      return typeof frame.output === "string" ? frame.output : "";
    },

    async pickFolder() {
      await conn.ready();
      // No timeout: this blocks on a native dialog on the other machine.
      const frame = await request({ type: "pick-folder" }, null);
      return typeof frame.path === "string" ? frame.path : null;
    },

    async listDir(path?: string) {
      await conn.ready();
      // Default timeout: unlike `pick-folder` this never waits on a human.
      const frame = await request({
        type: "list-dir",
        ...(path !== undefined ? { path } : {}),
      });
      return normalizeDirListing(frame);
    },

    async repoRoots(paths: string[]) {
      if (!paths.length) return [];
      await conn.ready();
      const frame = await request({ type: "repo-root", paths });
      const roots = Array.isArray(frame.roots) ? frame.roots : [];
      // Never trust the host to have kept the shape: callers index this against
      // their own array, so pad/trim to the length they asked about.
      return paths.map((_, i) => {
        const r = roots[i];
        return typeof r === "string" && r ? r : null;
      });
    },

    async startRun(args, handlers) {
      await conn.ready();
      // Register BEFORE sending, so a host that answers instantly can't beat us.
      runs.set(args.runId, handlers);
      try {
        send({ type: "start", ...args });
      } catch (err) {
        runs.delete(args.runId);
        throw err;
      }
    },

    stopRun(runId: string) {
      try {
        send({ type: "stop", runId });
      } catch {
        // socket already gone — the run died with it
      }
    },

    mcpResult(id: string, result: unknown) {
      try {
        send({ type: "mcp-result", id, result });
      } catch {
        // the run is over; the far side has nothing to answer
      }
    },

    close() {
      closedByUs = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      endAllRuns("disconnected");
      socket?.close();
      socket = null;
      connected.set(false);
    },
  };
  return conn;
}

function normalizeDetect(value: unknown): { found: boolean; path: string | null } {
  const v = value as { found?: unknown; path?: unknown } | null;
  return {
    found: v?.found === true,
    path: typeof v?.path === "string" ? v.path : null,
  };
}
