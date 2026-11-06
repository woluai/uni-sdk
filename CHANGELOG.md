# Changelog

## Unreleased

### Breaking

- **Logo helpers moved to `@unifiedai/sdk/logos`.** `getProviderLogo`,
  `getModelLogo`, `listProviderLogos` (and the `LogoTheme` /
  `ProviderLogoInput` / `ModelLogoInput` types) are no longer exported from
  the root or `/node` entries. The ~58 KB generated logo table now stays out
  of the core bundle. Update imports to `@unifiedai/sdk/logos`.
- **`FakeSyncServer` and `FakeSyncServerOptions` moved to
  `@unifiedai/sdk/testing`.** Test doubles no longer ship in production
  bundles. Update imports to
  `@unifiedai/sdk/testing`.
- **Calendar removed.** `sdk.calendar` and calendar-specific date, recurrence,
  and sync-adapter exports are no longer available.

### Added

- **Namespace sharing** (`sdk.storage.grants` / `sdk.sync.grants`) — any
  marketplace app can expose a namespaced storage/sync resource to other apps
  (`{ type: "app", appId }`) and authenticated agents (`{ type: "agent" }`)
  without baking domain types into the SDK. Local backends enforce grants;
  cloud backends map `403 storage_not_granted` / `sync_not_granted`.
  Opt-in agent packs: `storageTools(ns)` and `syncTools(ws, ns)`. Local
  UnifiedApp/desktop path: inject a shared `grantStore` (or use
  `createLocalSharingRuntime()` from `@unifiedai/sdk/testing`). Production
  unified-api deploy is out of scope.
- **Pro-gated cloud persistence.** Free (`plans.id = 0`) hitting cloud
  storage/fs/sync paths gets `PlanRequiredError` (`code: "plan_required"`,
  HTTP 403, `requiredPlan` / `currentPlanId`). Injected local backends are
  not gated. Local-dev models the gate via `FakeSyncServer({ cloudPlanId: 0 })`.
  Helper: `isCloudPlan` / `PLAN_FREE_ID`. `x-unified-caller: agent`
  when `callerKind: "agent"`.
- `X-Unified-App` request header from the client's `appId`, so a shared
  `uapi_` testing key can still attribute usage per app (honored by
  unified-api on own-credential API keys only).
- `ForbiddenError` (403) — credential accepted but not permitted (app-scoped
  token, disabled key). Terminal: refreshing won't help.
- `isUnifiedSdkError: true` marker on every SDK error, so SDK errors stay
  recognizable when a bundler duplicates class identities and `instanceof`
  breaks. `UnifiedError`, `UnifiedAIError`, `AuthenticationError`,
  `UnifiedAIAuthError`, and `StreamInterruptedError` preserve the standard
  ES2022 `cause` value.
- All subsystem error codes (storage, fs, sync, auth/bootstrap, streaming,
  client-side) are now registered in the `UnifiedErrorCode` union, built via
  a shared `subsystemError()` factory. Unregistered strings still compile.
- New subpath exports: `@unifiedai/sdk/logos` and `@unifiedai/sdk/testing`
  (see Breaking above).
- TypeDoc now generates API reference pages for all four public entry points.
- Client/per-request context compression for chat, messages, and responses,
  plus usage-display helpers `summarizeUsage`, `formatTokenCount`, `formatUsd`,
  and `formatTimeUntil`.
- Public node `Env`/`EnvReader` types for injected environment configuration.
- Public `SSEMessage` and node `DiscoveryRecord` types, completing the
  exported signatures of `parseSSE` and `DiscoveryReader`.
- **OAuth auto-bootstrap.** With no `token` configured, the first request on
  a node client bootstraps lazily. Failed attempts remain retryable; success
  or sign-out disarms implicit bootstrap so a signed-out client never silently
  reopens a browser.
- `onAuthEvent` hook: observability into the auth flow via an `AuthEvent`
  union (`keychain_lookup`, `handoff_attempt`, `handoff_result`,
  `browser_pkce_start`, `refresh_start`, `refresh_success`,
  `refresh_failure`, `sign_out`). Listeners run synchronously and thrown
  listener errors are isolated from auth.
- `signInTimeoutMs` option: bounds the browser sign-in wait (default 5
  minutes); expiry rejects with the new `auth_timeout` code and closes the
  loopback listener.
- Proactive OAuth refresh: access tokens refresh 60 seconds before expiry by
  default. `refreshSkewSeconds` configures the lead time (`0` disables it);
  proactive and reactive 401 refreshes share one single-flight operation.
- New `browser_open_failed` error code when the system browser can't be
  launched; the error identifies the failed opener and underlying process
  failure.
- `UNIFIEDAI_HANDOFF_TOKEN` env var: forwarded verbatim as an
  `x-handoff-token` header on desktop handoff requests (absent → header
  omitted).
- Trusted-token refresh failure now transitions `sdk.session` to `expired`
  and emits one `expired` event instead of leaving observable state stale.
- JSDoc on `appId` / `token` options documenting how the two auth modes
  coexist.
- Runnable source examples for browser trusted-token auth, Node OAuth
  streaming chat, and file upload progress.
- **`webTools()`** opt-in agent tool pack (`web_search` + `web_fetch`) —
  DuckDuckGo HTML search (no API key) plus SSRF-hardened page fetch. Compose
  with `fsTools()` into `sdk.agent.run({ tools })`. Pluggable `SearchBackend`
  for SearXNG later. Intended for Node/CLI/node-service (browser CORS blocks
  DuckDuckGo unless you inject a custom backend).

### Fixed

- GitHub installs (`github:greedyafinc/uni-sdk#…`) resolve `.`, `./app`,
  `./logos`, and the other documented subpaths on a default `bun install`.
  `dist/` JS and `.d.ts` are committed; `prepare` skips the rebuild inside
  `node_modules` so `trustedDependencies` is no longer required (and no
  longer fails `bun install` when set).

### Changed

- **Shared SSE stream factory.** `messages` and `responses` streams now throw
  `StreamInterruptedError` when reading an established SSE response fails,
  matching `chat` — previously only `chat` surfaced read failures as typed
  errors.
- **Lazy resource getters.** All 22 resources are memoized lazy getters —
  constructed on first access instead of ~22 allocations at client
  construction.
- **Minified browser build** (~98 KB) and a `sideEffects` glob in
  `package.json` for better tree-shaking by consumers.
- `@napi-rs/keyring` is now an **optionalDependency** — install failures no
  longer break the SDK; the keychain is treated as unavailable.
- Internal consolidation: shared `sleep`/`poll`, MIME lookup,
  `fetchWithTimeout`, discovery-file, chunked-base64, and upload-progress
  helpers; shared KV keys/records/query and namespace/backend machinery for
  storage/fs/sync; a single ms-based `Retry-After` parser; dead node-only
  shims (`browser-auth.ts`, node `pkce.ts`, node `token-endpoint.ts`) deleted
  in favor of the shared core implementations.

### Fixed

- **Windows browser opener** now uses `rundll32 url.dll,FileProtocolHandler`
  instead of `cmd /c start`: cmd.exe re-parses its command line, so unquoted
  `&` separators in OAuth query strings truncated the URL and executed the
  remainder as shell commands.
- **Keychain unavailability no longer aborts bootstrap** — a locked or
  missing OS keychain falls through to the next token source.
- **Discovery-file handoff 404 falls through to browser PKCE** — a stale
  discovery file is not authoritative (env-injected handoff 404s still
  surface as `app_not_installed`, since the desktop set the port for this
  exact process).
- **Desktop handoff requests are bounded at 3 s** — a hung desktop no longer
  stalls bootstrap.
- **Loopback callback hardened against state races** — a callback with a
  mismatched `state` is answered with a 400 and the listener keeps waiting
  for the genuine redirect instead of consuming the pending flow.
- **`signOut()` race** — tokens are snapshotted, local state is cleared
  first, then the snapshot is revoked (best-effort, bounded), so a concurrent
  `bootstrap()` can no longer have its fresh session destroyed by a trailing
  clear.
- **Bootstrap/sign-out race** — if sign-out lands during an in-flight auth
  ladder, bootstrap now rejects with `code: "aborted"`, cannot resurrect the
  session or emit a late `signedIn`, and revokes any token family minted by
  the cancelled flow.
- **`references.resync` RangeError** on large payloads, fixed by the shared
  chunked base64 codec in `core/_internal/base64.ts`.

## 0.2.0

### Added

- Typed HTTP error hierarchy (UNI-84). Every resource (`chat`, `messages`,
  `responses`, `embeddings`, `images`, `models`, `usage`) now throws a
  status-specific subclass of `UnifiedAIError`:
  - `BadRequestError` (400)
  - `AuthenticationError` (401)
  - `NotFoundError` (404)
  - `RateLimitError` (429, generic throttling — exposes `retryAfter`)
  - `UsageLimitError` (429, plan quota exhausted — exposes `periodCost`,
    `limit`, `resetAt`, `isUsageLimit: true`)
  - `ServerError` (5xx)
- `UnifiedAIError` base now carries `headers` and `requestId` (read from
  `x-request-id` / `request-id`).
- `buildHttpError(message, status, body, headers?)` factory exported for
  consumers building custom transports on top of `Core`.

### Changed

- **Breaking-ish — `err.code` values changed for 400 and 429.** Previously
  any non-`{401,403,404,5xx}` failure surfaced as `code: "request_failed"`.
  Now: 400 → `"bad_request"`, 429 throttling → `"rate_limited"`, 429 quota
  exhausted → `"usage_limit_exceeded"`. Consumers branching on
  `err.code === "request_failed"` for those statuses must update. Prefer
  `instanceof` against the new subclasses going forward.
- **Breaking-ish — `UnifiedAIHttpErrorCode` union widened.** Added members
  `"bad_request"`, `"rate_limited"`, `"usage_limit_exceeded"`. Exhaustive
  `switch (err.code)` statements typed against this union will now fail
  to compile until the new cases are added.
- **`UnifiedAIAuthError` now extends `AuthenticationError`** (which extends
  `UnifiedAIError`). Existing `instanceof UnifiedAIAuthError` and
  `instanceof UnifiedError` checks keep working, and 401 refresh-failure
  errors now surface response headers and `requestId`. Previously
  `UnifiedAIAuthError` extended `UnifiedError` directly and dropped both.
- Consumers checking `error.message` strings for 401/429/etc. should
  switch to `instanceof`. All thrown values still subclass `Error`, so
  generic catch-all handlers keep working.

### Notes

- `RateLimitError` and `UsageLimitError` are **siblings**, not
  parent/child. A generic retry wrapper that only catches `RateLimitError`
  will *not* intercept `UsageLimitError` — which is the intended design,
  since retrying a quota-exhausted request will keep failing. Code that
  wants to log all 429s uniformly should catch both explicitly.
