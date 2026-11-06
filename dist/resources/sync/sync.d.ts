import type { Core } from "../../core/core.js";
import { NamespaceSharing } from "../_kv/grants.js";
import type { SyncDeltaOptions, SyncDeltaPage, WorkspaceSummary, WorkspaceSyncOptions } from "./types.js";
import { WorkspaceSync } from "./workspace.js";
export declare class Sync {
    #private;
    private readonly client;
    private readonly workspaces;
    constructor(client: Core);
    /**
     * Grant CRUD for this app's sync namespace. Grants are namespace-scoped
     * (not workspace-scoped): the owning app publishes access to its `ns`.
     * With `grantStore` injected (local UnifiedApp), CRUD stays in-process.
     * Otherwise HTTP to unified-api / FakeSyncServer.
     */
    get grants(): NamespaceSharing;
    /**
     * List the workspaces the authenticated caller belongs to (id, name, kind,
     * role) via unified-api's `GET /sync/workspaces`. An app uses this to discover
     * its personal workspace id without a round-trip to base-api.
     */
    listWorkspaces(): Promise<WorkspaceSummary[]>;
    /**
     * A delta cursor at the workspace's newest write. Read it before a first full
     * read to follow changes from that moment, without the engine or a bootstrap.
     */
    head(workspaceId: string): Promise<string>;
    /**
     * One page of changes since `cursor`, including tombstones. `ns` narrows to one
     * namespace; `thin` drops the payload, keeping each row's identity and
     * `metadata.conversationId`. A 409 means the epoch moved: read `head()` again.
     */
    delta(workspaceId: string, opts: SyncDeltaOptions): Promise<SyncDeltaPage>;
    /**
     * Open (or reuse) the sync engine for `workspaceId`. `opts` is honored only on
     * the first call for a given id — later calls return the cached handle.
     */
    workspace(workspaceId: string, opts?: WorkspaceSyncOptions): WorkspaceSync;
    private resolveBackend;
}
//# sourceMappingURL=sync.d.ts.map