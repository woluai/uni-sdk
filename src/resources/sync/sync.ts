// `sdk.sync` — the entry point to the per-workspace sync engine. It caches ONE
// `WorkspaceSync` per workspace id (so `.workspace(id)` twice returns the same
// handle) and threads through the host-injected `SnapshotBackend` (if any). The
// engine itself works online-only when no backend is present — there is no
// browser persistence fallback. See PROTOCOL.md ("Sync").
//
// `sdk.sync.grants` is the namespace-sharing surface: any marketplace app can
// expose its `ns` (e.g. `"planner"`) to other apps and authenticated agents.
import type { Core } from "../../core/core";
import { NamespaceSharing } from "../_kv/grants";
import type {
  SnapshotBackend,
  SyncDeltaOptions,
  SyncDeltaPage,
  WorkspaceSummary,
  WorkspaceSyncOptions,
} from "./types";
import { WorkspaceSync } from "./workspace";

interface WorkspaceListResponse {
  workspaces: WorkspaceSummary[];
}

export class Sync {
  private readonly workspaces = new Map<string, WorkspaceSync>();
  #sharing?: NamespaceSharing;

  constructor(private readonly client: Core) {}

  /**
   * Grant CRUD for this app's sync namespace. Grants are namespace-scoped
   * (not workspace-scoped): the owning app publishes access to its `ns`.
   * With `grantStore` injected (local UnifiedApp), CRUD stays in-process.
   * Otherwise HTTP to unified-api / FakeSyncServer.
   */
  get grants(): NamespaceSharing {
    if (!this.#sharing) {
      this.#sharing = new NamespaceSharing({
        resource: "sync",
        client: this.client,
        local: this.client.grantStore ?? null,
        ownNs: () => this.client.appId,
      });
    }
    return this.#sharing;
  }

  /**
   * List the workspaces the authenticated caller belongs to (id, name, kind,
   * role) via unified-api's `GET /sync/workspaces`. An app uses this to discover
   * its personal workspace id without a round-trip to base-api.
   */
  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const res = await this.client.request<WorkspaceListResponse>("/api/v1/sync/workspaces", {
      method: "GET",
      retry: false,
    });
    return res.workspaces;
  }

  /**
   * A delta cursor at the workspace's newest write. Read it before a first full
   * read to follow changes from that moment, without the engine or a bootstrap.
   */
  async head(workspaceId: string): Promise<string> {
    const res = await this.client.request<{ cursor: string }>(
      `/api/v1/sync/${encodeURIComponent(workspaceId)}/head`,
      { method: "GET", retry: false },
    );
    return res.cursor;
  }

  /**
   * One page of changes since `cursor`, including tombstones. `ns` narrows to one
   * namespace; `thin` drops the payload, keeping each row's identity and
   * `metadata.conversationId`. A 409 means the epoch moved: read `head()` again.
   */
  async delta(workspaceId: string, opts: SyncDeltaOptions): Promise<SyncDeltaPage> {
    return this.client.request<SyncDeltaPage>(`/api/v1/sync/${encodeURIComponent(workspaceId)}/delta`, {
      method: "GET",
      query: {
        cursor: opts.cursor,
        ...(opts.ns ? { ns: opts.ns } : {}),
        ...(opts.thin ? { thin: "1" } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
      },
      retry: false,
    });
  }

  /**
   * Open (or reuse) the sync engine for `workspaceId`. `opts` is honored only on
   * the first call for a given id — later calls return the cached handle.
   */
  workspace(workspaceId: string, opts: WorkspaceSyncOptions = {}): WorkspaceSync {
    let ws = this.workspaces.get(workspaceId);
    if (!ws) {
      ws = new WorkspaceSync(this.client, workspaceId, this.resolveBackend(), opts);
      this.workspaces.set(workspaceId, ws);
    }
    return ws;
  }

  private resolveBackend(): SnapshotBackend | null {
    return this.client.snapshotBackend ?? null;
  }
}
