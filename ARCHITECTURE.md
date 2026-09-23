# Architecture

How the source is organised, and where new code goes.

## Entry-point layout

The SDK ships two runtime client entries plus optional logos/testing subpaths,
so the same package works in browsers, Workers, edge runtimes, and Node —
without forcing any consumer to bundle Node-only or test-only modules.

```
@unifiedai/sdk           → browser-safe (default; zero `node:*` deps; minified)
@unifiedai/sdk/node      → strict superset; adds OAuth/PKCE/keychain/loopback
@unifiedai/sdk/logos     → brand-logo helpers (~58 KB data-URI table, kept out of the core bundle)
@unifiedai/sdk/testing   → test doubles (FakeSyncServer, createLocalSharingRuntime)
```

Bundlers auto-resolve via the `browser` / `node` export conditions in
`package.json`. Same class name (`UnifiedAI`) in both entries — call sites
read identically regardless of which target you build for.

## Source layout

```
src/
├── index.ts                  # browser entry — exports the browser-safe surface
├── logos/
│   └── index.ts              # @unifiedai/sdk/logos entry — brand-logo helpers (~58 KB data-URIs)
├── testing/
│   └── index.ts              # @unifiedai/sdk/testing entry — FakeSyncServer + local sharing runtime
├── auth/
│   └── browser-sign-in.ts    # browser sign-in helper
├── assets/
│   └── logos/                # SVG sources compiled into resources/logos.generated.ts
├── core/                     # shared base, both entries depend on this
│   ├── client.ts             # UnifiedAI base class (trusted-token mode; memoized lazy resource getters)
│   ├── core.ts               # transport types (Core, RequestOptions, TokenProvider)
│   ├── errors.ts             # UnifiedError + subclasses + the UnifiedErrorCode registry
│   ├── identity.ts           # Identity public type
│   └── _internal/
│       ├── base64.ts         # chunked base64 ↔ bytes (shared; RangeError-safe)
│       ├── cache.ts          # small TTL cache
│       ├── http-errors.ts    # error-body extraction helpers
│       ├── pkce.ts           # crypto-based code challenge/verifier (WebCrypto; runtime-agnostic)
│       ├── progress.ts       # progress-event types
│       ├── retry.ts          # 401-retry + network-retry classifier, ms-based Retry-After parser
│       ├── sse.ts            # SSE frame parser
│       ├── sse-stream.ts     # shared SSE stream factory (chat / messages / responses)
│       ├── stream.ts         # UnifiedStream async-iterable
│       ├── token-endpoint.ts # postTokenGrant helper
│       ├── tokens.ts         # TokenSet type
│       └── upload-progress.ts# upload progress tracking
├── resources/                # one file (or dir) per resource; browser-safe
│   ├── _internal/            # chunkedUpload, contentDisposition, mime, poll
│   ├── _kv/                  # shared keys, records, queries, namespace/backend resolution, grants
│   ├── agent/                # tool-loop scaffolding (agent, fs-tools, storage-tools, sync-tools, web-tools)
│   ├── sharing.ts            # public namespace-grant types (sdk.storage.grants / sdk.sync.grants)
│   ├── calendar/             # date math, recurrence, sync-adapter (curated barrel)
│   ├── fs/                   # jailed file workspace (cloud backend, path jail, errors)
│   ├── storage/              # typed collections (cloud + in-memory backends)
│   ├── sync/                 # workspace sync engine (+ fake-server, exported via /testing)
│   ├── actions.ts            # ─┐
│   ├── artifacts.ts          #  │
│   ├── audio.ts              #  │
│   ├── chat.ts               #  │
│   ├── embeddings.ts         #  │
│   ├── files.ts              #  │
│   ├── helpers.ts            #  │ flat single-file resources
│   ├── images.ts             #  │
│   ├── memory.ts             #  │
│   ├── messages.ts           #  │
│   ├── models.ts             #  │
│   ├── projects.ts           #  │
│   ├── references.ts         #  │
│   ├── responses.ts          #  │
│   ├── usage.ts              #  │
│   ├── users.ts              #  │
│   ├── videos.ts             # ─┘
│   ├── logos.ts              # logo helpers (exported via @unifiedai/sdk/logos)
│   └── logos.generated.ts    # generated logo table — do not edit
└── node/                     # OAuth/CLI extension; pulls Node-only deps
    ├── index.ts              # node entry — re-exports browser surface + adds OAuth UnifiedAI
    ├── client.ts             # UnifiedAI subclass: bootstrap (lazy auto-bootstrap), signOut,
    │                         #   identity, refresh, onAuthEvent
    └── _internal/
        ├── discovery.ts           # desktop.json handoff discovery
        ├── discovery-file.ts      # shared platform config-dir + discovery-file read/parse
        ├── ecosystem-discovery.ts # ecosystem.json discovery (local ecosystem hosting)
        ├── env.ts                 # UNIFIEDAI_* env reader
        ├── fetch-timeout.ts       # fetch bounded by a deadline
        ├── handoff.ts             # desktop handoff endpoint probe (3 s timeout)
        ├── keychain.ts            # @napi-rs/keyring (lazy, optional dependency)
        ├── loopback.ts            # node:http OAuth redirect callback (state-hardened, signInTimeoutMs)
        ├── open-url.ts            # opens the system browser (Windows: rundll32 url.dll,FileProtocolHandler)
        ├── refresh.ts             # refresh-token grant
        └── revoke.ts              # token revocation (best-effort, bounded)

tests/
├── core/                     # browser-safe behavior; imports from src/index.ts
├── node/                     # OAuth behavior; imports from src/node/index.ts
├── bundle/                   # asserts dist/index.browser.js is node-free
├── browser/                  # Playwright tests against the built browser bundle
└── integration/              # recorded-cassette tests against the live API
    ├── cassettes/            # one dir per surface (chat, messages, files, …)
    ├── helpers/
    └── setup/

scripts/
└── verify-browser-bundle.ts  # bundle-content gate; runs on every build
```

## Class hierarchy

```
Core (core/core.ts)
   ↑
UnifiedAI (core/client.ts)        ← browser entry
   ↑                                exports this as `UnifiedAI`
UnifiedAI (node/client.ts)        ← node entry
                                    re-exports as `UnifiedAI` (subclass)
```

`request()` and `stream()` live on the base. They go through three protected
hooks that the subclass overrides:

- `getInitialAccessToken()` — base returns from the trusted-token provider;
  subclass returns from the OAuth tokens it owns
- `refreshAccessToken()` — base re-invokes the provider with single-flight
  coalescing; subclass runs the refresh-token grant
- `onAuthFailure()` — base marks the trusted-token session `expired`; the
  subclass additionally clears SDK-owned tokens and keychain state

All four code paths (browser+trusted, node+trusted, node+OAuth, future
node+OAuth-with-token) share one 401-retry implementation.

## Conventions

- **One module per resource** in `src/resources/`. Simple resources use one
  file; complex resources use a curated directory barrel. Colocate each
  resource's public types with its module rather than creating a shared type
  dump.
- **Cross-cutting universal types** live at the top of `src/core/` as their
  own file.
- **Internal-only helpers** colocate with their caller. If you need to share
  one, lift it to the nearest `_internal/` (underscore marks it private —
  never re-exported from any `index.ts`).
- **New file: where does it go?**
  - Static `node:*` import? → `src/node/_internal/`
  - Uses `fetch`/`ReadableStream`/`crypto.subtle`/runtime-agnostic only?
    → `src/core/_internal/` if shared, else colocate with caller
- **`tsconfig` lint rule** (eslint `no-restricted-paths`, planned) forbids
  imports from `src/node/` inside `src/core/` or `src/resources/` so the
  boundary can't silently regress.

## Adding a resource

1. Create `src/resources/<name>.ts`:

   ```ts
   import { Core } from "../core/core";

   export interface MyResource { /* ... */ }
   export interface MyResourceCreateParams { /* ... */ }

   export class MyResources {
     constructor(private readonly client: Core) {}
     async create(params: MyResourceCreateParams): Promise<MyResource> {
       return this.client.request("/v1/my-resource", { method: "POST", body: params });
     }
   }
   ```

2. Attach it to the base `UnifiedAI` in `src/core/client.ts` as a memoized
   lazy getter (resources are constructed on first access so an unused
   resource costs nothing at construction). The node subclass inherits it
   automatically:

   ```ts
   #myResources?: MyResources;
   get myResources(): MyResources {
     return (this.#myResources ??= new MyResources(this));
   }
   ```

3. Re-export public types from BOTH `src/index.ts` and `src/node/index.ts`
   (or via the `export * from "../resources/<name>"` line that already
   bridges them).

4. Add a test in `tests/core/<name>.test.ts` using a fake fetch.

5. Record the change with `bun run changeset`.

## Auth & bootstrap

`UnifiedAI.bootstrap()` is idempotent. In trusted-token mode it's a no-op.
In OAuth mode (node entry only) it resolves the user identity via:

1. cached keychain tokens for the client_id (an unavailable keychain falls
   through rather than failing)
2. env-var-supplied handoff port (`UNIFIEDAI_HANDOFF_PORT`; a 404 here is
   authoritative and surfaces as `app_not_installed`)
3. discovery-file handoff (`~/.woluai/desktop.json`, or
   `%APPDATA%\WoluAI\desktop.json` on Windows; `~/.woluai-<env>` when
   `WOLUAI_ENV=dev|local`; a 404 here falls through —
   the file may be stale)
4. fresh browser PKCE (loopback receives the redirect; bounded by
   `signInTimeoutMs`, default 5 minutes)

In OAuth mode `bootstrap()` also runs lazily on the first request when no
`token` was configured. Failed attempts remain eligible for a later request;
success or `signOut()` disarms implicit bootstrap so a signed-out client never
silently reopens a browser. Auth-flow progress is observable via the
`onAuthEvent` hook.

Tokens are private instance state on the subclass. Refresh is single-flighted
across the proactive pre-expiry timer and reactive 401 retry, and rotated token
sets replace keychain state atomically. Session-generation guards prevent an
in-flight bootstrap or refresh from restoring tokens after `signOut()`.
`sdk.identity()` returns `{ user_id, client_id }`.

The wire protocol (endpoints, discovery file format, keychain entry name,
env vars, PKCE params) is documented in [PROTOCOL.md](PROTOCOL.md) so future
Rust/Go/Python SDKs can interop with the same keychain entries and
desktop endpoint.

## Errors

Errors constructed by the SDK use `UnifiedError` or one of its subclasses
(`UnifiedAIError` for HTTP failures, `UnifiedAIAuthError` for auth failures).
Caller `AbortError`s, exhausted raw transport failures, and a few polling
timeouts may propagate as native errors. Map HTTP failures inside the base
`request()`/`stream()`; resources should not catch and re-wrap them.

`UnifiedAIError.message` includes a server-extracted snippet when the body
matches a known shape (`{message}`, `{error}`, `{error: {message}}`, FastAPI
`{detail}`, `{errors[]}`). The full body is on `err.body`.

## Public surface = the entry `index.ts` files

If a name isn't exported from `src/index.ts` (browser surface),
`src/node/index.ts` (node surface), `src/logos/index.ts`
(`@unifiedai/sdk/logos`), or `src/testing/index.ts`
(`@unifiedai/sdk/testing`), it isn't part of the SDK and can be
renamed/removed without a major bump. Treat all four as the contract.

The bundle-content test (`tests/bundle/browser-bundle.test.ts`) plus the
`scripts/verify-browser-bundle.ts` step enforce the **structural invariant**
that the browser bundle contains no `node:*` specifier and no
`@napi-rs/keyring` reference.
