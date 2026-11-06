// In-memory implementation of unified-api's `/api/v1/sync/*` endpoints, wired in
// via the SDK's existing transport seam: it exposes a `fetch` implementation you
// pass as `new UnifiedAI({ fetch: server.fetch, token, apiUrl })`. No parallel
// HTTP-mocking mechanism — the same `fetch` option the rest of the test suite
// uses. Used by tests and for host-app local development.
//
// It faithfully models the server's counter semantics: a monotonic per-workspace
// `sync_id`, tombstones in the delta stream, epoch bumping (`bumpEpoch()` makes
// the next bootstrap/delta with an older cursor return 409), and the SAME
// merge/replace/null-strips-key logic as the real server (shared `mergePatch`).
import { pkOf } from "../_kv/keys";
import type { SyncedRecordFields } from "../_kv/records";
import {
  MemoryGrantStore,
  type NamespaceGrantee,
  type SharingCaller,
  namespaceAccess,
} from "../_kv/sharing";
import { PLAN_FREE_ID } from "../usage";
import { mergePatch } from "./merge";

// A record as the fake server stores it — the shared sync record field set,
// verbatim (tombstones stay in the map with `deleted: true`).
type ServerRecord = SyncedRecordFields;

interface WorkspaceState {
  epoch: number;
  seq: number;
  records: Map<string, ServerRecord>;
}

interface Cursor {
  e: number;
  a: number;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(status, { code, message: code });
}

function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c));
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(atob(raw)) as Partial<Cursor>;
    if (typeof c.e !== "number" || typeof c.a !== "number") return null;
    return { e: c.e, a: c.a };
  } catch {
    return null;
  }
}

export interface FakeSyncServerOptions {
  /** Workspace ids that reject blob ops with 400 `blobs_not_supported_in_shared_workspaces`. */
  sharedWorkspaces?: string[];
  /** Base url the SDK is pointed at (cosmetic; routing is by path). */
  baseUrl?: string;
  /**
   * Caller's `plans.id`. `PLAN_FREE_ID` (0) makes bootstrap/delta/apply
   * return 403 `plan_required`. Omit (default) to leave the caller entitled
   * — existing tests keep working. Local UnifiedApp sets this from the
   * desktop session; it does not call production billing.
   */
  cloudPlanId?: number;
  /**
   * Share this grant table with `MemoryBackend` / `UnifiedAI({ grantStore })`
   * in the same local host process. Omit to create a private table.
   */
  grants?: MemoryGrantStore;
}

/** An in-memory `/api/v1/sync/*` server exposed as a `fetch` implementation. */
export class FakeSyncServer {
  readonly baseUrl: string;
  /** Inspectable grant table (same contract as MemoryBackend.grants). */
  readonly grants: MemoryGrantStore;
  private readonly shared: Set<string>;
  private readonly workspaces = new Map<string, WorkspaceState>();
  // Membership metadata for GET /sync/workspaces (id → {name, kind, role}).
  private readonly meta = new Map<
    string,
    { name: string; kind: "personal" | "team"; role: "owner" | "member" }
  >();
  private failApply = false;
  private offline = false;
  private cloudPlanId: number | undefined;
  /** Number of requests served — for asserting no redundant round-trips. */
  requestCount = 0;

  constructor(opts: FakeSyncServerOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://fake-sync.test";
    this.shared = new Set(opts.sharedWorkspaces ?? []);
    this.cloudPlanId = opts.cloudPlanId;
    this.grants = opts.grants ?? new MemoryGrantStore();
  }

  /** Override the caller's plan for the Pro gate (`0` = Free). */
  setCloudPlanId(id: number | undefined): void {
    this.cloudPlanId = id;
  }

  /** Bump the epoch so the next bootstrap/delta with an older cursor → 409. */
  bumpEpoch(workspaceId: string): void {
    this.ws(workspaceId).epoch += 1;
  }

  /**
   * Register a workspace's membership metadata so it surfaces from
   * `GET /sync/workspaces`. Also materializes the workspace state (so its
   * bootstrap/delta endpoints answer even before any write).
   */
  registerWorkspace(
    workspaceId: string,
    meta: { name?: string; kind?: "personal" | "team"; role?: "owner" | "member" } = {},
  ): void {
    this.ws(workspaceId);
    this.meta.set(workspaceId, {
      name: meta.name ?? workspaceId,
      kind: meta.kind ?? "team",
      role: meta.role ?? "owner",
    });
  }

  /** Directly seed records (bypassing HTTP) for test setup. Advances `sync_id`. */
  seed(
    workspaceId: string,
    records: Array<{
      ns: string;
      collection: string;
      id: string;
      metadata: Record<string, unknown>;
    }>,
  ): void {
    this.applyOps(
      workspaceId,
      records.map((r) => ({ ns: r.ns, collection: r.collection, id: r.id, replace: r.metadata })),
    );
  }

  /** Apply arbitrary wire-shaped ops server-side (bypassing HTTP), advancing `sync_id`. */
  applyOps(workspaceId: string, ops: Array<Record<string, unknown>>): void {
    const ws = this.ws(workspaceId);
    for (const op of ops) this.applyOne(ws, op);
  }

  /** Server-side delete (tombstone) of a record. */
  remove(workspaceId: string, ns: string, collection: string, id: string): void {
    this.applyOne(this.ws(workspaceId), { ns, collection, id, delete: true });
  }

  /** When on, `/apply` returns 500. */
  setApplyFailing(on: boolean): void {
    this.failApply = on;
  }

  /** When on, `/bootstrap` and `/delta` return 503 (simulating a network outage). */
  setOffline(on: boolean): void {
    this.offline = on;
  }

  /** The `fetch` implementation to pass as `new UnifiedAI({ fetch: server.fetch })`. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.requestCount += 1;
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, this.baseUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const si = parts.indexOf("sync");
    if (si < 0) return errorResponse(404, "route_not_found");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headerMap(input, init);
    const caller = callerFromHeaders(headers);

    // Discovery: GET /sync/workspaces (no :workspaceId). Checked before the
    // per-workspace routes so the static path wins, matching the real server.
    if (parts.length === si + 2 && parts[si + 1] === "workspaces" && method === "GET") {
      return this.listWorkspaces();
    }

    // Namespace grants (also static — not scoped to a workspace id).
    if (parts.length >= si + 2 && parts[si + 1] === "grants") {
      return this.handleGrants(method, parts.slice(si + 2), init, caller, url);
    }

    if (parts.length < si + 3) return errorResponse(404, "route_not_found");
    const workspaceId = decodeURIComponent(parts[si + 1] ?? "");
    const action = parts[si + 2];

    const gated = this.planGate();
    if (gated) return gated;

    if (action === "bootstrap" && method === "GET") {
      return this.bootstrap(workspaceId, url, caller);
    }
    if (action === "head" && method === "GET") {
      if (this.offline) return errorResponse(503, "unavailable");
      const ws = this.ws(workspaceId);
      return jsonResponse(200, { cursor: encodeCursor({ e: ws.epoch, a: this.maxSyncId(ws) }) });
    }
    if (action === "delta" && method === "GET") {
      return this.delta(workspaceId, url, caller);
    }
    if (action === "apply" && method === "POST") {
      return this.apply(workspaceId, init, caller);
    }
    return errorResponse(404, "route_not_found");
  };

  // ─── Routes ──────────────────────────────────────────────────────────────────

  private listWorkspaces(): Response {
    // Every workspace known to the fake (explicitly registered, or materialized
    // via seed/applyOps) surfaces; registered metadata wins, else sane defaults.
    const ids = new Set<string>([...this.meta.keys(), ...this.workspaces.keys()]);
    const workspaces = [...ids].map((id) => {
      const m = this.meta.get(id);
      return { id, name: m?.name ?? id, kind: m?.kind ?? "personal", role: m?.role ?? "owner" };
    });
    return jsonResponse(200, { workspaces });
  }

  private bootstrap(workspaceId: string, url: URL, caller: SharingCaller): Response {
    if (this.offline) return errorResponse(503, "unavailable");
    const ws = this.ws(workspaceId);
    const limit = this.limit(url);
    const cursorRaw = url.searchParams.get("cursor");
    let after = 0;
    if (cursorRaw !== null) {
      const c = decodeCursor(cursorRaw);
      if (!c) return errorResponse(400, "invalid_cursor");
      if (c.e !== ws.epoch) return errorResponse(409, "cursor_epoch_mismatch");
      after = c.a;
    }
    const live = [...ws.records.values()]
      .filter((r) => !r.deleted && r.syncId > after && this.nsVisible(caller, r.ns, "read"))
      .sort((a, b) => a.syncId - b.syncId);
    const page = live.slice(0, limit);
    const complete = live.length <= limit;
    const lastInPage = page[page.length - 1];
    const newAfter = complete ? this.maxSyncId(ws) : (lastInPage?.syncId ?? after);
    return jsonResponse(200, {
      records: page.map(toWire),
      cursor: encodeCursor({ e: ws.epoch, a: newAfter }),
      complete,
    });
  }

  private delta(workspaceId: string, url: URL, caller: SharingCaller): Response {
    if (this.offline) return errorResponse(503, "unavailable");
    const ws = this.ws(workspaceId);
    const limit = this.limit(url);
    const cursorRaw = url.searchParams.get("cursor");
    let after = 0;
    if (cursorRaw !== null) {
      const c = decodeCursor(cursorRaw);
      if (!c) return errorResponse(400, "invalid_cursor");
      if (c.e !== ws.epoch) return errorResponse(409, "cursor_epoch_mismatch");
      after = c.a;
    }
    const ns = url.searchParams.get("ns");
    const thin = url.searchParams.get("thin") === "1";
    const changed = [...ws.records.values()]
      .filter((r) => r.syncId > after && (!ns || r.ns === ns) && this.nsVisible(caller, r.ns, "read"))
      .sort((a, b) => a.syncId - b.syncId);
    const page = changed.slice(0, limit);
    const hasMore = changed.length > limit;
    const lastInPage = page[page.length - 1];
    const newAfter = lastInPage?.syncId ?? after;
    return jsonResponse(200, {
      records: page.map((r) => {
        if (r.deleted) return toTombstone(r);
        const wire = toWire(r);
        if (!thin) return wire;
        const conversationId = (r.metadata as Record<string, unknown>).conversationId;
        return { ...wire, metadata: typeof conversationId === "string" ? { conversationId } : {}, hasBlob: false };
      }),
      cursor: encodeCursor({ e: ws.epoch, a: newAfter }),
      hasMore,
    });
  }

  private apply(
    workspaceId: string,
    init: RequestInit | undefined,
    caller: SharingCaller,
  ): Response {
    if (this.failApply) return errorResponse(500, "internal");
    const ws = this.ws(workspaceId);
    let body: { ops?: unknown };
    try {
      body = JSON.parse(String(init?.body ?? "{}")) as { ops?: unknown };
    } catch {
      return errorResponse(400, "bad_request");
    }
    const ops = body.ops;
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 200) {
      return errorResponse(400, "bad_request");
    }
    const isShared = this.shared.has(workspaceId);
    const results: Array<{
      ns: string;
      collection: string;
      id: string;
      syncId: number;
      version: number;
    }> = [];
    for (const op of ops as Array<Record<string, unknown>>) {
      const ns = String(op.ns ?? "");
      if (!this.nsVisible(caller, ns, "readwrite")) {
        return jsonResponse(403, {
          code: "sync_not_granted",
          message: `no grant to access namespace "${ns}"`,
        });
      }
      if (isShared && (op.blob_hash !== undefined || op.bytes !== undefined)) {
        return errorResponse(400, "blobs_not_supported_in_shared_workspaces");
      }
      // Model the REAL wire faithfully: `replace` is a BOOLEAN flag and the
      // replacement metadata rides in `patch` (app_objects_apply casts
      // `op->>'replace'` to boolean). A non-boolean `replace` is what the real
      // server rejects — mirror that so a client that mis-serializes it (sending
      // the object) is caught here instead of silently "working".
      if (op.replace !== undefined && typeof op.replace !== "boolean") {
        return errorResponse(400, "invalid_op_replace_must_be_boolean");
      }
      const normalized =
        typeof op.replace === "boolean"
          ? op.replace
            ? { ...op, replace: (op.patch ?? {}) as Record<string, unknown>, patch: undefined }
            : { ...op, replace: undefined }
          : op;
      results.push(this.applyOne(ws, normalized));
    }
    return jsonResponse(200, { results });
  }

  // ─── Mutation ────────────────────────────────────────────────────────────────

  private applyOne(
    ws: WorkspaceState,
    op: Record<string, unknown>,
  ): { ns: string; collection: string; id: string; syncId: number; version: number } {
    const ns = String(op.ns);
    const collection = String(op.collection);
    const id = String(op.id);
    const key = pkOf(ns, collection, id);
    const existing = ws.records.get(key);
    const now = Date.now();
    ws.seq += 1;
    const syncId = ws.seq;
    const version = (existing?.version ?? 0) + 1;

    let rec: ServerRecord;
    if (op.delete === true) {
      rec = {
        ns,
        collection,
        id,
        metadata: {},
        version,
        deleted: true,
        syncId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        hasBlob: false,
      };
    } else {
      let metadata: Record<string, unknown>;
      if (op.replace !== undefined) metadata = { ...(op.replace as Record<string, unknown>) };
      else if (op.patch !== undefined)
        metadata = mergePatch(existing?.metadata ?? {}, op.patch as Record<string, unknown>);
      else metadata = existing ? { ...existing.metadata } : {};
      const hasBlob =
        op.blob_hash !== undefined || op.bytes !== undefined ? true : (existing?.hasBlob ?? false);
      const blobEncoding = (op.blob_encoding as string | undefined) ?? existing?.blobEncoding;
      rec = {
        ns,
        collection,
        id,
        metadata,
        version,
        deleted: false,
        syncId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        hasBlob,
        ...(blobEncoding !== undefined ? { blobEncoding } : {}),
      };
    }
    ws.records.set(key, rec);
    return { ns, collection, id, syncId, version };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private ws(workspaceId: string): WorkspaceState {
    let s = this.workspaces.get(workspaceId);
    if (!s) {
      s = { epoch: 1, seq: 0, records: new Map() };
      this.workspaces.set(workspaceId, s);
    }
    return s;
  }

  private limit(url: URL): number {
    const raw = Number(url.searchParams.get("limit"));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
  }

  private maxSyncId(ws: WorkspaceState): number {
    let max = 0;
    for (const r of ws.records.values()) if (r.syncId > max) max = r.syncId;
    return max;
  }

  private planGate(): Response | null {
    if (this.cloudPlanId === undefined) return null;
    if (this.cloudPlanId > PLAN_FREE_ID) return null;
    return jsonResponse(403, {
      code: "plan_required",
      required_plan: "Pro",
      current_plan_id: this.cloudPlanId,
      message: "Cloud sync and persistence require a Pro plan.",
    });
  }

  /**
   * Unscoped callers (no `x-unified-app`) are treated as first-party and see
   * every namespace — matching existing tests and the desktop host. A stamped
   * app identity is grant-filtered.
   */
  private nsVisible(caller: SharingCaller, ns: string, mode: "read" | "readwrite"): boolean {
    if (!caller.appId.trim()) return true;
    return namespaceAccess(this.grants, caller, ns, mode);
  }

  private handleGrants(
    method: string,
    rest: string[],
    init: RequestInit | undefined,
    caller: SharingCaller,
    url: URL,
  ): Response {
    const own = caller.appId.trim();
    if (!own) return errorResponse(400, "invalid_input");
    if (rest.length === 0 && method === "GET") {
      const ns = (url.searchParams.get("ns") ?? "").trim() || own;
      if (ns !== own) return errorResponse(400, "invalid_input");
      return jsonResponse(200, { grants: this.grants.list(ns) });
    }
    if (rest.length === 0 && method === "POST") {
      let body: { ns?: unknown; grantee?: NamespaceGrantee; mode?: unknown };
      try {
        body = JSON.parse(String(init?.body ?? "{}")) as {
          ns?: unknown;
          grantee?: NamespaceGrantee;
          mode?: unknown;
        };
      } catch {
        return errorResponse(400, "bad_request");
      }
      const ns = typeof body.ns === "string" && body.ns.trim() ? body.ns.trim() : own;
      if (ns !== own) return errorResponse(400, "invalid_input");
      if (!body.grantee) return errorResponse(400, "invalid_input");
      const mode = body.mode === "readwrite" ? "readwrite" : "read";
      try {
        const grant = this.grants.upsert(ns, body.grantee, mode);
        return jsonResponse(200, grant);
      } catch {
        return errorResponse(400, "invalid_input");
      }
    }
    if (rest.length === 1 && method === "DELETE") {
      const id = decodeURIComponent(rest[0] ?? "");
      const g = this.grants.get(id);
      if (g && g.ns !== own) return errorResponse(403, "forbidden");
      return jsonResponse(200, { revoked: this.grants.delete(id) });
    }
    return errorResponse(404, "route_not_found");
  }
}

function toWire(r: ServerRecord): Record<string, unknown> {
  return {
    ns: r.ns,
    collection: r.collection,
    id: r.id,
    metadata: r.metadata,
    version: r.version,
    deleted: r.deleted,
    syncId: r.syncId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    hasBlob: r.hasBlob,
    ...(r.blobEncoding !== undefined ? { blobEncoding: r.blobEncoding } : {}),
  };
}

function toTombstone(r: ServerRecord): Record<string, unknown> {
  return { ...toWire(r), deleted: true, metadata: {} };
}

function headerMap(input: string | URL | Request, init?: RequestInit): Headers {
  if (typeof input !== "string" && !(input instanceof URL)) return input.headers;
  return new Headers(init?.headers);
}

function callerFromHeaders(headers: Headers): SharingCaller {
  const appId = headers.get("x-unified-app") ?? "";
  const kind = headers.get("x-unified-caller") === "agent" ? "agent" : "app";
  return { appId, kind };
}
