export interface EcosystemDiscoveryRecord {
    readonly url: string;
    readonly token: string;
    readonly pid: number;
    readonly started_at: number;
}
/** The resolved local hosting: base URL + the bearer token to authenticate with. */
export interface LocalEcosystem {
    readonly baseUrl: string;
    readonly token: string;
}
export declare function defaultEcosystemDiscoveryPath(): string;
export interface DiscoverOptions {
    /** Override the discovery-file path (tests). */
    readonly path?: string;
    /** Fail-fast probe deadline; PROTOCOL suggests ~500 ms. */
    readonly timeoutMs?: number;
    /** A standalone (class-4) app's OAuth access token. When set, the anonymous discovery
     *  token is upgraded to a scoped one via POST /enroll (offline → stays anonymous). */
    readonly oauthToken?: string;
}
/**
 * Resolve the local Ecosystem API hosting, or null to fall back to cloud. Resolution
 * order (docs/ecosystem-local-tokens.md §8):
 *   1. **Env handoff** — `UNIFIEDAI_ECOSYSTEM_URL` + `UNIFIEDAI_ECOSYSTEM_TOKEN`. A
 *      BUNDLED app (class 3) receives a pre-scoped token from the shell at launch this
 *      way; trusted without a probe (the shell set it for this exact child process).
 *   2. **Discovery file** — read `~/.woluai/ecosystem.json` (per WOLUAI_ENV) + probe `GET <url>/health`.
 *      The file's token is the powerless anonymous identity; a standalone app (class 4)
 *      enrolls for real scopes (§9), which is a later addition.
 * A stale file (dead port) resolves to null because the probe fails — never throws.
 */
export declare function discoverLocalEcosystem(opts?: DiscoverOptions): Promise<LocalEcosystem | null>;
//# sourceMappingURL=ecosystem-discovery.d.ts.map