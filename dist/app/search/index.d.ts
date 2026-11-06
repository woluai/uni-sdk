export type MatchKind = "boundary" | "mid" | "none";
/**
 * Whether `term` appears in `haystackLower` at a word boundary (start of
 * string or preceded by whitespace/punctuation), only mid-word, or not at all.
 * Scans every occurrence so a later boundary hit still counts as "boundary"
 * even if an earlier mid-word occurrence exists.
 *
 * Both arguments must already be case-folded — callers lower-case once per
 * field rather than once per (field, term) pair.
 *
 * The empty term is "none". `"".indexOf("")` is 0, so without this guard an
 * empty term would score as a boundary hit against every field and would also
 * keep `allInTitle` alive for free.
 */
export declare function matchKind(haystackLower: string, term: string): MatchKind;
/**
 * The three text fields every provider scores against, generalized over what
 * each app happens to call them:
 *
 *  - `title`     — sheet/doc `title`, design/project `name`, note `name`
 *  - `secondary` — the cheap human-visible line: sheets/docs `preview`, a
 *                  design's enclosing project name
 *  - `body`      — the write-time `searchText` content projection, where the
 *                  app has one
 *
 * Omitted fields simply contribute nothing, which is how a provider with only
 * two fields uses the same scorer as one with three.
 */
export interface ScoreFields {
    title: string;
    secondary?: string;
    body?: string;
}
/**
 * Per-term relevance of one candidate. The weight table, unchanged from the
 * per-app copies this replaces:
 *  - term at a word boundary in `title` (start of string, or preceded by
 *    whitespace/punctuation) — or as a `title` prefix — → +3 (full value)
 *  - term as a mid-word substring in `title` (not at a boundary) → +1.5 (half)
 *  - term at a word boundary in `secondary` → +1 (full value)
 *  - term as a mid-word substring in `secondary` → +0.5 (half value)
 *  - term at a word boundary in `body` → +0.75 (full value)
 *  - term as a mid-word substring in `body` → +0.25 (third value)
 *  - ALL terms present somewhere in `title` (boundary or substring) → +2 bonus
 *  - case-folded `title === query` (exact match) → +5 bonus
 *
 * `body` sits below `secondary`, which sits below `title`, on purpose: a word
 * buried in a projected body is weaker evidence of relevance than the same
 * word in the visible snippet, and much weaker than one in the name.
 *
 * The +2 and +5 bonuses are title-only and are unaffected by the other fields.
 * The weakest real match this can produce is +0.25 — which is the invariant
 * `HINTS_FLOOR` below is defined against.
 */
export declare function scoreFields(fields: ScoreFields, terms: string[], query: string): number;
/**
 * ONE floor score for an item pulled in purely via `hints.ids`, with zero (or
 * negative-filtered) text match.
 *
 * INVARIANT: strictly below the weakest real match, and strictly above 0 — so
 * a hinted-only item always surfaces, and always ranks last. The weakest real
 * match `scoreFields` can return is +0.25 (a mid-word `body` hit); the
 * ordinal scores the delegating providers (notes, planner) hand out are ≥1.
 * 0.1 clears both with room to spare.
 *
 * This used to be three numbers — 0.1, 0.2 and 0.25 — for the one invariant,
 * because each copy was re-derived by hand as the weight table grew. 0.25 was
 * in fact already wrong for the apps that score `searchText`: it TIED with the
 * weakest real match instead of sitting below it.
 */
export declare const HINTS_FLOOR = 0.1;
/**
 * True when `id` appears in `hintIds`, matching either a bare id ("abc123") or
 * a namespaced handle ("sheets:abc123"). The host forms handles as
 * `${appId}:${id}` (apps/desktop src/apps/search/rank.ts), so `appId` must be
 * the id the provider is registered under, not a display name.
 */
export declare function isHinted(id: string, hintIds: string[] | undefined, appId: string): boolean;
/**
 * The one method of the SDK's `Collection<T>` this module needs, matched
 * STRUCTURALLY so nothing here has to import the SDK's runtime (see the module
 * header). The query argument is `unknown` on purpose: `Query<T>` is generic
 * over the row type and cannot be named without the SDK, and TypeScript's
 * bivariant checking of method parameters makes every real collection
 * assignable to this shape anyway. It also removes design-app's
 * `as unknown as Partial<DesignRow>` cast — that cast only existed because the
 * SDK types `match` as `V extends string ? string : never`, which collapses to
 * `never` for an OPTIONAL `searchText`.
 */
export interface SearchTextCollection<Row> {
    query(q?: unknown): Promise<Row[]>;
}
/**
 * Rows whose `searchText` projection matches `text` server-side, newest-edited
 * first, capped at `limit`. Returns [] when there is no collection at all.
 *
 * This pushes content matching into Postgres: `searchText` is backed by a
 * generated `search_text` tsvector column, and the SDK's `match` operator
 * compiles to a `websearch`/`simple` full-text predicate against it. That lets
 * search find body matches WITHOUT dragging every row to the client.
 *
 * Two things to know before using it:
 *
 * 1. There is NO relevance order — `match` deliberately has no `ts_rank`
 *    support, so ranking stays a client-side job. The `updatedAt desc` order
 *    here is only so that a store with more than `limit` matches yields the
 *    most recently edited ones rather than an arbitrary slice.
 * 2. Unlike the fail-soft reads it sits next to, it THROWS on failure instead
 *    of returning []. That is deliberate and load-bearing: the caller has to
 *    be able to distinguish "nothing matched" from "this server does not
 *    support the op" so `createLatchedFallback` below can latch the capability
 *    off, and a swallowed error is indistinguishable from an empty result set.
 *    The one exception is "no storage backend at all" (a null collection),
 *    which is not a capability signal — the host may still be booting — so it
 *    returns [] like its fail-soft neighbours.
 */
export declare function queryBySearchText<Row>(collection: SearchTextCollection<Row> | null | undefined, text: string, limit: number): Promise<Row[]>;
/** A wrapped optional capability plus the latch state its caller needs to read
    (to widen its client-side window once the pushdown is gone). */
export interface LatchedFallback<Row> {
    /** Never rejects. [] both when the capability is latched off and when the
        call was already aborted. */
    run(query: string, limit: number, signal?: AbortSignal): Promise<Row[]>;
    /** True once the capability has failed at least once this module lifetime. */
    readonly disabled: boolean;
    /** Test-only: forget that the capability has been latched off. */
    resetForTests(): void;
}
/**
 * Wrap an optional server-side capability in a one-way latch: has it failed us
 * yet? The state lives for the lifetime of the module that calls this — a
 * provider may be rebuilt, but the server's capabilities don't change under us
 * mid-session.
 *
 * This exists because the failure is a per-keystroke cost. `match` is not
 * deployed to production yet, so against prod EVERY search would otherwise pay
 * a doomed round trip and log a fresh warning. One attempt is enough to learn
 * the answer, so the answer is remembered.
 *
 * It deliberately over-latches: a transient network blip disables the pushdown
 * for the session even though the op is fine. That trade is correct here — the
 * cost of being wrong is degrading to the widened client-side scan (what these
 * providers did before the pushdown existed), while the cost of NOT latching
 * is a guaranteed failed request on every keystroke forever against a server
 * that lacks the op. Discriminating on error code would be a cross-repo change
 * spanning the SDK's error hierarchy and unified-api; it is not this seam's
 * job to guess.
 *
 * `run` never rejects, which is what makes it safe to `Promise.all` alongside
 * the recent-window listing without a failing match taking the whole search
 * down with it. The first failure latches and logs ONCE; every later call
 * skips the attempt entirely rather than re-paying it.
 *
 * Pass `fn` as a thunk that re-reads its dependency at call time (e.g.
 * `(q, n) => searchDeps.queryBySearchText(q, n)`), never a direct reference —
 * the apps' `searchDeps` seams are mutable so tests can stub them.
 */
export declare function createLatchedFallback<Row>(label: string, fn: (query: string, limit: number) => Promise<Row[]>): LatchedFallback<Row>;
/**
 * The SDK's `SearchOpenRef` / `SearchPreview` / `SearchHit`
 * (src/resources/search/types.ts), matched STRUCTURALLY so this module stays
 * import-free (see the module header). Each provider still annotates its own
 * `search()` with the real SDK `SearchHit`; what `toSearchHit` returns is
 * assignable to it.
 */
export interface HitOpenRef {
    objectId: string;
    collection?: string;
    projectId?: string | null;
    /** Must name a declared, NON-MUTATING action of the same app, or the host's
        sanitizeOpenRef silently drops it (apps/desktop src/apps/search/fanout.ts;
        `mutates` defaults to TRUE). None of these five providers sets it — they
        all rely on the app's standard `openArtifact` verb instead. */
    action?: string;
    params?: Record<string, unknown>;
}
export interface HitPreview {
    kind: string;
    data?: unknown;
    ref?: string;
}
export interface AppSearchHit {
    id: string;
    kind: string;
    title: string;
    snippet?: string;
    score: number;
    updatedAt?: number;
    projectId?: string | null;
    containerTitle?: string;
    preview?: HitPreview;
    openRef?: HitOpenRef;
}
export interface SearchHitInput {
    id: string;
    kind: string;
    title: string;
    score: number;
    updatedAt: number;
    /** The human-visible excerpt. Becomes `snippet` (empty → omitted) and, when
        `textPreview` is set, the `preview.data` payload as well. */
    text?: string;
    containerTitle?: string;
    projectId?: string | null;
    openRef: HitOpenRef;
    /** Emit `preview: { kind: "text", data: text }` alongside the snippet.
        Opt-IN: docs, sheets and notes have a cheap text excerpt to show, while
        design has nothing under the host's 2 KB preview cap (a design's `thumb`
        is a 20-50 KB data URL that `sanitizeHit` provably always discarded) and
        planner has no preview surface at all. */
    textPreview?: boolean;
}
/**
 * One provider's candidate → one `SearchHit`.
 *
 * The five app providers were each building this object literal by hand, three
 * of them (docs, sheets, notes) byte-identical in shape and carrying the same
 * near-verbatim eight-line comment about why `openRef.action` is omitted. The
 * shape is a host contract, not an app decision, so it lives here; what stays
 * per-provider is which fields it can fill.
 *
 * ── Why no `openRef.action` ──
 * The host invokes the app's standard `openArtifact` verb, which adapts
 * `objectId` (plus `kind`/`fragment` where the app needs them) onto that app's
 * own open action. Naming an `action` here would duplicate that mapping in a
 * second place — and in a `search.js` chunk that deliberately stays free of the
 * app-side module graph. `objectId`/`collection`/`projectId` still travel: the
 * host uses them for its fallback navigation path and for ranking.
 *
 * ── Key omission ──
 * Fields left undefined are OMITTED rather than emitted as `undefined` keys, so
 * the hit JSON-serializes to exactly what the provider meant. `snippet` follows
 * `text || undefined` — an empty excerpt is not a snippet — while `preview.data`
 * carries `text` verbatim, which is what the three preview-bearing providers
 * already did.
 */
export declare function toSearchHit(input: SearchHitInput): AppSearchHit;
/**
 * The tie-break every scoring provider ends on: score DESC, then `updatedAt`
 * DESC. Four copies of `(a, b) => b.score - a.score || b.<row>.updatedAt -
 * a.<row>.updatedAt` differed only in what the candidate wrapper called its row,
 * which is what `updatedAtOf` abstracts.
 *
 * The recency half is not decoration. Scores here are coarse (a small weighted
 * integer-ish sum), so ties are common — two documents whose titles both match
 * one term score identically. Without the second key the winner is whatever
 * order the store happened to return, which is unstable across a hybrid
 * recent+matched merge; with it, the more recently edited item wins, matching
 * what every one of these apps shows at the top of its own home grid.
 *
 * Not used by planner, which sorts on score alone: its scores are ORDINALS
 * handed out by a delegating matcher that has already applied its own ordering,
 * so a recency tie-break there would fight the ranking it is given.
 */
export declare function compareHits<C extends {
    score: number;
}>(updatedAtOf: (c: C) => number): (a: C, b: C) => number;
//# sourceMappingURL=index.d.ts.map