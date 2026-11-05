// Public types + the swappable snapshot-backend contract for `sdk.sync` — the
// live-first, per-workspace sync engine over unified-api's `/api/v1/sync/*`.
// See PROTOCOL.md ("Sync") for the wire contract this mirrors.
//
// The engine keeps an in-memory materialized view of a workspace's records and
// keeps it fresh against the server (bootstrap → delta → poll). A host MAY
// inject a `SnapshotBackend` so the last-known view survives a reload
// (stale-while-revalidate); with no backend the engine is memory-only and
// online-first. There is deliberately NO browser persistence fallback.

/**
 * Host-injected local persistence for a workspace snapshot. The desktop shell
 * injects a Tauri-native one; tests inject an in-memory double. The engine only
 * ever partitions by `workspaceId` — it hands the backend an opaque byte blob
 * and asks for it back, so the backend needs no knowledge of the record model.
 */
export interface SnapshotBackend {
  /** The most recently saved snapshot for `workspaceId`, or `null` if none. */
  load(workspaceId: string): Promise<Uint8Array | null>;
  /** Persist the latest snapshot bytes for `workspaceId` (replacing any prior). */
  save(workspaceId: string, bytes: Uint8Array): Promise<void>;
  /** Drop any snapshot for `workspaceId` (used on an epoch reset). */
  clear(workspaceId: string): Promise<void>;
}

/**
 * A materialized record in a workspace. `metadata` is a JSON-ish bag; `syncId`
 * is the server's monotonic per-workspace change counter (used for ordering and
 * dedupe); `version` bumps on every write. Tombstones never surface here — a
 * deleted record is removed from the local view.
 */
export interface SyncRecord {
  ns: string;
  collection: string;
  id: string;
  metadata: Record<string, unknown>;
  version: number;
  /** Always `false` for records returned by `get()`/`list()` (tombstones are removed). */
  deleted: boolean;
  syncId: number;
  createdAt: number;
  updatedAt: number;
  hasBlob: boolean;
  blobEncoding?: string;
}

/**
 * One mutation in an `apply()` batch. Exactly one of `patch` / `replace` /
 * `delete` is the intent:
 * - `patch` — shallow-merge over the record's `metadata`; a `null` value removes
 *   that key.
 * - `replace` — swap `metadata` wholesale.
 * - `delete` — tombstone (clears metadata, removes the local record).
 * Blob fields are pass-through metadata for the server's content-addressed store
 * and are rejected in shared workspaces.
 */
export interface SyncOp {
  ns: string;
  collection: string;
  id: string;
  patch?: Record<string, unknown>;
  replace?: Record<string, unknown>;
  delete?: boolean;
  blobHash?: string;
  blobEncoding?: string;
  bytes?: Uint8Array;
}

/** Per-op result of an `apply()` — the server-stamped `syncId` and `version`. */
export interface SyncApplyResult {
  ns: string;
  collection: string;
  id: string;
  syncId: number;
  version: number;
}

/**
 * Engine lifecycle state.
 * - `idle` — constructed, not started.
 * - `hydrating` — loading/serving a local snapshot while revalidating.
 * - `bootstrapping` — paging the full LIVE set (no usable snapshot cursor).
 * - `live` — caught up; polling deltas.
 * - `offline` — two-or-more consecutive poll failures; backing off.
 * - `error` — an unrecoverable engine error.
 */
export type SyncState = "idle" | "hydrating" | "bootstrapping" | "live" | "offline" | "error";

/** Immutable snapshot of the engine's status at the moment it changed. */
export interface SyncStatus {
  readonly state: SyncState;
  /** Epoch ms of the last successful sync, if any. */
  readonly lastSyncAt?: number;
  /** The failure behind an `offline`/`error` state, if any. */
  readonly error?: unknown;
}

/**
 * The `status` observable on a `WorkspaceSync`. Mirrors the `session`-style
 * surface: read the current value with {@link get}, and {@link subscribe} for
 * changes (the returned function unsubscribes). Subscribing does NOT replay the
 * current value — read it with `get()` first if you need it.
 */
export interface SyncStatusObservable {
  get(): SyncStatus;
  subscribe(listener: (status: SyncStatus) => void): () => void;
}

/** A filter over a collection scan. `where` is JS strict-equality over metadata. */
export interface SyncListFilter {
  where?: Record<string, unknown>;
}

/** A read handle to one `(ns, collection)` within a workspace's local view. */
export interface SyncCollection {
  /** The live record for `id`, or `null`. Returns a copy — mutating it is safe. */
  get(id: string): SyncRecord | null;
  /** All live records, optionally filtered by `where`. Returns copies. */
  list(filter?: SyncListFilter): SyncRecord[];
  /**
   * Fire `listener` once per batch of changes to THIS collection (post-batch,
   * not per record). Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
}

/**
 * A workspace the caller is a member of, as returned by
 * `sdk.sync.listWorkspaces()` (unified-api `GET /sync/workspaces`). Lets an app
 * discover its personal (or shared) workspace id without talking to base-api.
 */
export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: "personal" | "team";
  role: "owner" | "member";
}

/** Options for `sdk.sync.workspace(id, opts)`. */
export interface WorkspaceSyncOptions {
  /**
   * Delta poll cadence in ms. Default 5000; clamped up to a 1000 ms floor.
   * On repeated failure the engine backs off exponentially (up to 60s) from
   * this base and returns to it on recovery.
   */
  pollIntervalMs?: number;
}

export interface SyncDeltaOptions {
  cursor: string;
  /** Only this namespace. */
  ns?: string;
  /** No payload: each row's identity and `metadata.conversationId`. */
  thin?: boolean;
  limit?: number;
}

/** One record of a `sdk.sync.delta()` page; tombstones have `deleted: true` and empty metadata. */
export interface SyncDeltaRecord {
  ns: string;
  collection: string;
  id: string;
  metadata: Record<string, unknown>;
  version: number;
  deleted: boolean;
  syncId: number;
  createdAt: number;
  updatedAt: number;
  hasBlob: boolean;
}

export interface SyncDeltaPage {
  records: SyncDeltaRecord[];
  cursor: string;
  hasMore: boolean;
}
