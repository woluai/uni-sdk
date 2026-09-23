# Auth Protocol

Language-agnostic wire contract for `@unifiedai/sdk` and any future Rust/Go/Python ports.
Reimplement against this document and a Rust SDK should be able to read tokens
written by the TS SDK (and vice versa) without re-authenticating the user.

## Identifiers

- `client_id` — assigned per marketplace app at registration. Stable string.
- `user_id` — assigned per UnifiedAI user. Returned in token responses; SDKs never
  derive it themselves.

## Token shape

All token endpoints return and all SDKs persist the same JSON object:

```json
{
  "access_token": "string",
  "refresh_token": "string",
  "expires_at": 0,
  "user_id": "string",
  "client_id": "string"
}
```

`expires_at` is a Unix timestamp in seconds.

## Userinfo

`GET /api/v1/me` resolves the authenticated user's profile from the gateway.
Accepts any credential type unified-api honors on the Authorization header —
an OAuth access token, an app token, or a `uapi_` key — so any SDK caller can
hit it without first knowing which kind of token it holds.

```json
{
  "user": {
    "id": "string",
    "email": "string | null",
    "first_name": "string | null",
    "last_name": "string | null",
    "display_name": "string | null",
    "created_at": "string",
    "account_type": 0
  },
  "client": {
    "id": "string | null",
    "app_name": "string"
  }
}
```

`client.id` is the OAuth `client_id` for an OAuth-authenticated call, and
`null` for non-OAuth credentials (app token, `uapi_` key). `user.email` is
`null` when the identity provider didn't supply one.

`GET /api/v1/users/:id` resolves any user id to their public display info —
e.g. rendering project-member names in a shared workspace. Any authenticated
caller (same credential types as `/me`) may look up any id; because the
lookup isn't scoped to the caller's own account, the response is deliberately
narrower than `/me` and by design never includes `email` or `account_type`:

```json
{
  "user": {
    "id": "string",
    "first_name": "string | null",
    "last_name": "string | null",
    "display_name": "string | null",
    "created_at": "string"
  }
}
```

An unknown id returns `404` with body `{ "code": "user_not_found", ... }`,
which SDKs surface through their normal HTTP error mapping (e.g. the TS SDK's
`NotFoundError`) — no special-casing required.

`GET /api/v1/users?ids=<comma-separated>` batch-resolves multiple ids in one
round trip — e.g. rendering a list of project members without N+1 calls to
the by-id route. Same field set as the by-id route (no `email`/`account_type`):

```json
{
  "users": [
    {
      "id": "string",
      "first_name": "string | null",
      "last_name": "string | null",
      "display_name": "string | null",
      "created_at": "string"
    }
  ]
}
```

Found-only semantics: unknown or malformed ids in the list are silently
omitted from `users` rather than erroring — an absent id means "not found,"
not "request failed." Order of the returned `users` is unspecified. The
gateway caps at 100 ids after its own dedupe (`400` `"too_many_ids"` beyond
that) and rejects an empty id list (`400` `"invalid_ids"`); SDKs should dedupe
client-side before sending and reject locally rather than relying on the
server for a request that's already known to be too large — the TS SDK's
`sdk.users.list()` does this: short-circuiting to `{ users: [] }` for an
empty deduped list without a network call, and throwing a client-side
`UnifiedError` (`code: "invalid_input"`) above the 100-id cap instead of
truncating or round-tripping to the gateway's `400`.

## Per-request app attribution

`user_activity.app_name` (the dimension user analytics charts by) is
**server-derived from the credential**:

| Credential | `app_name` |
|---|---|
| Internal app-token JWT | JWT `app` claim |
| OAuth access token | `sessions.client_id` |
| `uapi_` API key | `api_keys.app_name`, unless overridden below |

A `uapi_` key is pinned to one `app_name` at create time, which collapses
attribution when one testing key is shared across apps. SDKs that know
their `appId` MUST send it as:

```
X-Unified-App: <slug>
```

`<slug>` matches `^[a-z0-9][a-z0-9-]{0,63}$` (same as `/auth/app-token`).
unified-api honors the header **only** on own-credential `uapi_` keys (and
auth bypass). Internal JWTs and OAuth tokens ignore it — a client cannot
relabel a server-issued app identity. Malformed values are ignored and the
key's stored `app_name` is kept.

The TypeScript SDK sends this header automatically when `appId` is set on
the client (`new UnifiedAI({ token, appId })`).

## Bootstrap order

An SDK MUST resolve tokens in this order on first call to `bootstrap()`:

1. **Keychain hit.** Read OS keychain entry for `(SERVICE, client_id)`. If a valid
   `TokenSet` is present, use it and stop. If the keychain itself is
   inaccessible (`keychain_unavailable`), fall through to the next step —
   an unusable secret store must not block sign-in.
2. **Env-var handoff.** If `UNIFIEDAI_HANDOFF_PORT` is set, `POST` to the desktop
   handoff endpoint on that port (see below). On `handoff_unreachable`, fall
   through. On 404 (`app_not_installed`), surface the error — do not fall back:
   the desktop injected the port into this exact process, so its answer is
   authoritative.
3. **Discovery-file handoff.** Read the discovery file (see below). If present
   and valid, `POST` to the desktop handoff endpoint on the file's port. Fall
   through on `handoff_unreachable` **and** on 404 (`app_not_installed`) —
   unlike step 2, a discovery file may be stale (a desktop that has since
   uninstalled or re-registered apps), so its 404 is not authoritative and the
   SDK proceeds to browser PKCE.
4. **Browser PKCE.** Open the user's system browser to the authorize URL with
   a loopback `redirect_uri`. Exchange the resulting code for tokens at the
   token URL.

Persist the resulting `TokenSet` to the keychain in steps 2–4.
The TypeScript node SDK invokes the same ladder lazily on the first API request
when no trusted `token` is configured. A failed lazy attempt leaves the ladder
eligible for a later request; success or `signOut()` disarms implicit
bootstrap until the caller explicitly invokes `bootstrap()` again.

## Desktop handoff endpoint

The desktop runs an HTTP server on `127.0.0.1` (loopback only).

```
POST /handoff
Content-Type: application/json
Body: { "client_id": "<string>" }

200 → TokenSet JSON
404 → app_not_installed
```

Any connection failure or non-200/non-404 response → `handoff_unreachable` (SDK
falls through to the next step). SDKs SHOULD bound the handoff request with a
short deadline (recommended: 3 seconds, the TS SDK default) and treat a timeout
as `handoff_unreachable` — a hung desktop must not stall bootstrap.

If `UNIFIEDAI_HANDOFF_TOKEN` is set, SDKs MUST forward it verbatim as an
`x-handoff-token` header so the desktop can bind the handoff to the process it
launched; when unset, the header is omitted (back-compat).

## Desktop discovery file

When the desktop starts, it writes a JSON record describing how to reach its
handoff endpoint. SDKs read this file after the environment handoff is absent
or fails with a fall-through error such as `handoff_unreachable`.

| OS | Path |
| --- | --- |
| macOS, Linux | `~/.woluai/desktop.json` |
| Windows | `%APPDATA%\WoluAI\desktop.json` |

Each desktop environment has its own folder: the paths above are prod's, and a
dev or local build uses `~/.woluai-dev` / `~/.woluai-local` (`WoluAI-dev` /
`WoluAI-local` on Windows). SDKs pick the folder from `WOLUAI_ENV` (`dev`,
`local`; unset or `prod` means prod), which the desktop sets on the processes it
spawns. The same folder holds `ecosystem.json` (below).

```json
{ "port": 0, "pid": 0, "started_at": 0 }
```

`started_at` is a Unix timestamp in seconds. The desktop SHOULD remove this
file on clean shutdown but SDKs MUST tolerate stale files (the handoff probe
will fail and the SDK will fall through).

## Browser PKCE

Standard OAuth2 authorization-code flow with PKCE (RFC 7636, S256).

Authorize URL: `https://web.unifiedai.app/oauth/authorize`

Query params:
- `client_id`
- `redirect_uri` — `http://127.0.0.1:<ephemeral>/callback`
- `response_type=code`
- `code_challenge`
- `code_challenge_method=S256`
- `state` — random per-request token; the loopback listener MUST ignore
  callbacks carrying a code with a mismatched state (answer the HTTP request
  with an error, keep listening) so a local process racing the browser cannot
  consume the pending flow; a mismatched state that reaches the waiter is
  rejected as `auth_state_mismatch`. SDKs SHOULD bound the wait for the
  redirect (recommended: 5 minutes) and reject with `auth_timeout`, closing
  the listener.

Token URL: `https://api.unifiedai.app/oauth/token`

```
POST /oauth/token
Content-Type: application/json
Body: {
  "grant_type": "authorization_code",
  "code": "<from callback>",
  "code_verifier": "<original verifier>",
  "client_id": "<string>",
  "redirect_uri": "<must match authorize>"
}

200 → TokenSet JSON
```

The SDK MUST bind the loopback server before opening the browser and close it
after the callback (or on cancellation).

## Token refresh

OAuth clients refresh through the same token URL:

```
POST /oauth/token
Content-Type: application/json
Body: {
  "grant_type": "refresh_token",
  "refresh_token": "<current refresh_token>",
  "client_id": "<string>"
}

200 → replacement TokenSet JSON
```

The server rotates refresh tokens, so an SDK MUST replace the entire stored
`TokenSet` atomically rather than updating only `access_token`. Concurrent
callers MUST share one refresh operation; a proactive expiry refresh and a
reactive 401 refresh must not spend the same rotating token twice.

SDKs SHOULD refresh shortly before `expires_at` (TS SDK default: 60 seconds)
and MUST retain the reactive 401→refresh→single retry path. A refresh failure
clears the unusable local session and surfaces `auth_refresh_failed`; a
successful refresh that races a sign-out MUST be discarded rather than
re-persisting tokens after the user ended the session.

## Sign-out / token revocation

`signOut()` MUST snapshot the current tokens, then clear local state, then
revoke the snapshot — in that order:

1. **Snapshot** the `TokenSet` to revoke (in-memory first, keychain fallback)
   while it is still intact, so the original `refresh_token` is available to
   send to `/oauth/revoke`.
2. **Clear local state** (in-memory session + keychain entry) BEFORE issuing
   the revoke call. Revocation is a network round-trip; if local state stayed
   live during that window, a concurrent `bootstrap()` could establish a fresh
   session that a trailing clear would then destroy. Clearing first closes the
   race: the snapshot lives in a local variable and any subsequently created
   session is owned by the new bootstrap, untouched by this sign-out.
3. **Revoke the snapshot** server-side, best-effort.

```
POST /oauth/revoke
Content-Type: application/json
Body: {
  "token": "<refresh_token>",
  "token_type_hint": "refresh_token",
  "client_id": "<string>"
}

200 → {} (always, per RFC 7009 §2.2 — even for unknown tokens)
```

Per RFC 7009 the server revokes the entire token family (the supplied token
and any rotated children). SDKs MUST treat the call as best-effort: network
failure, 4xx, or 5xx MUST NOT fail `signOut()` — local state is already
cleared by the time the call is made, and SDKs SHOULD bound it with a short
deadline (TS SDK default: 5 seconds) so a hung server cannot stall sign-out. The
default revoke URL is derived from the token URL by replacing `/oauth/token`
with `/oauth/revoke`; it can be overridden via the `UNIFIEDAI_REVOKE_URL` env
var or an explicit `revokeUrl` option.

## Keychain storage

Tokens persist in the OS-native secret store. SDKs in any language read/write
the same entries by using these locations:

| OS | Service / target | Account |
| --- | --- | --- |
| macOS | Keychain service `com.unifiedai.sdk` | `client_id` |
| Windows | Credential Manager target `com.unifiedai.sdk/<client_id>` | `client_id` |
| Linux | Secret Service collection `default`, attributes `{ service: "com.unifiedai.sdk", account: "<client_id>" }` | — |

Stored value is the `TokenSet` JSON, UTF-8.

## Environment variables

| Name | Purpose |
| --- | --- |
| `UNIFIEDAI_HANDOFF_PORT` | Desktop handoff endpoint port. Set by the desktop when it launches an installed app. |
| `WOLUAI_ENV` | Which desktop environment's discovery folder to read: `dev` → `~/.woluai-dev`, `local` → `~/.woluai-local`; unset or `prod` → `~/.woluai`. Set by the desktop when it launches an installed app. |
| `UNIFIEDAI_HANDOFF_TOKEN` | Optional per-launch shared secret, forwarded verbatim as the `x-handoff-token` header on handoff requests. Absent → header omitted. |
| `UNIFIEDAI_CLIENT_ID` | Optional fallback client_id when the SDK is not configured with one. |
| `UNIFIEDAI_TOKEN_URL` | Override the OAuth token endpoint URL (testing / staging). |
| `UNIFIEDAI_REVOKE_URL` | Override the OAuth revoke endpoint URL. Defaults to `tokenUrl` with `/oauth/token` → `/oauth/revoke`. |
| `UNIFIEDAI_AUTHORIZE_URL` | Override the OAuth authorize endpoint URL (testing / staging). |
| `UNIFIEDAI_API_URL` | Override the base URL for `/api/v1/*` and `/v1/messages` requests. Defaults to `https://api.unifiedai.app`. |
| `UNIFIEDAI_ECOSYSTEM_URL` | Authoritative local Ecosystem API base injected into a desktop-launched child process. Use with `UNIFIEDAI_ECOSYSTEM_TOKEN`. |
| `UNIFIEDAI_ECOSYSTEM_TOKEN` | Bearer token paired with `UNIFIEDAI_ECOSYSTEM_URL` for the local Ecosystem API. |

## Context compression

`POST /api/v1/chat/completions`, `POST /v1/messages`, and
`POST /api/v1/responses` accept an OPTIONAL boolean `compression` field in the
request body. Absent or `false` means off — off is the default.

```
POST /api/v1/chat/completions
Content-Type: application/json
Body: {
  "model": "<string>",
  "messages": [...],
  "compression": true
}
```

When `true`, the gateway deterministically compresses conversation context
server-side before the call reaches the provider: tool outputs and long
assistant text in older turns may be rewritten in place. User messages and the
system prompt are never modified, the last 4 messages are protected, and
messages are never added or removed. Compressed content carries
`"[compressed: <description>]"` markers, which MAY appear in context the model
sees and echoes.

SDKs SHOULD expose both a client-level default and a per-request value; the
per-request value MUST take precedence (an explicit per-request `false`
overrides a client default of `true`). When neither is set, SDKs MUST omit the
`compression` key from the wire body entirely.

Savings are observable through usage telemetry (character counts before/after
compression per call). There are no new error codes: requesting compression
never fails a call — surfaces without support simply ignore the parameter.

## Ecosystem API

The **Ecosystem API** is the server-side surface that gives standalone apps (and
external agents over MCP) the same interconnection services embedded apps get
from the desktop shell: projects, artifacts, memory, and cross-app actions. It
is a **contract, not a place** — it has two hostings that MUST expose identical
routes, shapes, and policy order:

- **Cloud hosting** — unified-api under `UNIFIEDAI_API_URL` at `/api/v1/*`,
  authenticated by any credential unified-api accepts (`uapi_` key, internal
  ES256 JWT, or OAuth access token). The caller's app identity is the resolved
  `oauth_clients.id` for OAuth callers; first-party callers have none.
- **Local hosting** — a loopback listener in the running desktop app serving the
  SAME routes from the data already on the machine (local memory ledger,
  `sdk.storage`, the project cache, artifact snapshots). See *Local ecosystem
  hosting & discovery* below. It works fully offline and is the only home of
  data the user never opted into syncing.

An SDK MUST resolve which hosting to use transparently (local first, cloud
fallback) — apps never choose a hosting explicitly. Every route below is
relative to the resolved hosting's base.

### Attribution & taint (normative)

Every write carries a **taint origin** that the **server assigns from the
resolved credential** — clients MUST NOT self-declare it, and any origin-like
field in a request body MUST be ignored. Origins:

| Caller | Taint origin |
| --- | --- |
| Shell host (internal ES256 JWT) | `host` |
| App via OAuth (`oauth_clients.id = <id>`) | `app:<id>` |
| Standalone app (OAuth, no shell attestation) | `app:<id>` (server also records a `standalone` flag) |
| External agent over MCP | `mcp-external` |

A client authenticated with an app token therefore **cannot** upload a
`host`-origin event; the server re-stamps origin on ingest. This is the wire
form of the memory-system taint rule.

### Project policy

Every project carries a server-enforced policy that gates who may contribute
memory/artifacts to it and whether external agents may read it. It is part of
the `Project` object and patchable like other project fields.

```json
{
  "autoCapture": "off | ask | on",
  "appContrib": "off | embedded-only | all",
  "mcpRead": false,
  "perApp": { "<appId>": { "memory": true, "artifacts": true } }
}
```

- `appContrib = "embedded-only"` excludes standalone (OAuth) callers; `"all"`
  admits them; `"off"` admits none.
- `mcpRead` gates whether an external agent (`mcp-external`) may read the
  project's artifacts/memory.
- `perApp` overrides the coarse toggles for a specific app id.

```
GET    /projects                       → { projects }   // list; each project.policy included
GET    /projects/:id                   → { project }    // project.policy included
PATCH  /projects/:id                   Body: { policy?, name?, metadata?, archived? }
GET    /projects/:id/members           → { members: [{ userId, role }] }   // owner or member may read
POST   /projects/:id/members           Body: { userId, role? }   // owner-only
DELETE /projects/:id/members/:userId   → { removed }              // owner-only
```

Omitting `policy` on PATCH leaves it unchanged; policy fields are merged
shallowly (a partial `policy` patches only the named keys). Member **mutations**
are owner-only; a member gets read-only access to the project's shared reads.

### Artifacts

An **Artifact** is a canonical, self-contained export of an app's work
(a design, doc, sheet) — independent of app-internal state and of whether the
producing app is currently running. It is the representation the main chat, other
apps, and external agents consume.

```json
// Artifact — the record
{
  "id": "string",
  "projectId": "string | null",
  "appId": "string",   // producing app, SERVER-attributed, never self-declared
  "kind": "string",    // open vocab, namespaced: "docs/document", "sheets/spreadsheet", "design/canvas"
  "title": "string",
  "version": 0,          // current version pointer
  "createdAt": 0,        // epoch ms
  "updatedAt": 0
}

// ArtifactVersion — an immutable snapshot
{
  "artifactId": "string",
  "version": 0,          // monotonic, server-assigned
  "content": {},         // canonical machine-readable JSON; per-kind, owned by the producing app; MUST be self-contained (no refs into app-private storage)
  "previewRef": { "bucket": "string", "path": "string", "mime": "string" }, // optional rendered preview; fetch a signed URL via GET .../preview
  "text": "string",      // REQUIRED plain-text projection for search/embedding/LLM context
  "contributedBy": "string", // client attribution, SERVER-stamped
  "createdAt": 0
}
```

- `text` is **required** on every version — it is what makes artifacts uniformly
  queryable (chat search, memory link-events, MCP context) without knowing the
  kind. An app that cannot render text forgoes searchability.
- Versions are **whole snapshots** (no deltas). The append-only version list is
  what lets chat reference an artifact "as of" a prior version.
- `content` schema is owned by the producing app and published via its manifest
  `kinds` field so consumers (including external agents) can interpret it;
  `previewRef` + `text` keep an artifact useful to consumers that cannot.

```
GET  /artifacts?projectId=&kind=          → { artifacts: Artifact[] }   // projectId REQUIRED in v1 (local hosting); kind filter is Phase 2
POST /artifacts                            Body: { projectId?, kind, title, content, text, previewB64?, previewMime? }
                                           → { artifact, version }         // creates the artifact + version 1
GET  /artifacts/:id                        → { artifact, latest }          // latest = newest ArtifactVersion
POST /artifacts/:id/versions               Body: { content, text, previewB64?, previewMime? }
                                           → { artifact, version }         // appends a version, bumps the pointer
GET  /artifacts/:id/versions/:v            → { version }                   // content + text (preview via signed URL)
GET  /artifacts/:id/preview?v=             → { url, mime }                 // signed URL to the version's preview (defaults to latest)
```

A chat reference is `artifact://<id>@<version>`, resolved through these routes.

### Memory

The memory ledger is **append-only events**. A write is a batch append; the
server stamps `id`, `createdAt`, and (per the taint rule above) `taintOrigin`.
Writes from untrusted callers (`app:*`, `mcp-external`) are **proposals**,
surfaced for confirmation in the owning app; first-party (`host`) writes apply
directly.

```json
// MemoryEvent — on read
{
  "id": "string",
  "projectId": "string | null",
  "type": "string",       // append vocabulary: "observation" | "summary" | "tombstone" | ...
  "content": {},          // event payload (ledger-defined)
  "taintOrigin": "string",// SERVER-stamped (host | app:<id> | mcp-external)
  "provenance": {},       // source refs
  "salience": {},         // optional salience inputs
  "status": "applied | proposed",
  "seq": 0,                // monotonic append cursor (the value echoed back as `cursor`)
  "createdAt": 0
}
```

```
POST /memory/events                 Body: { projectId?, events: [{ type, content, provenance?, salience? }] }
                                    → { events: MemoryEvent[] }   // each with server-stamped id/origin/status
GET  /memory/events?since=&projectId=  → { events: MemoryEvent[], cursor }   // append-only sync; `since` is the opaque `seq` cursor
POST /memory/query                  Body: { projectId?, query, k, hybrid? }
                                    → { results }
```

`hybrid: true` requests RRF-fused lexical+vector ranking (the `mcp-external` read
path); omitted/false is lexical-only. Ranking is still caller-class gated server-side —
the flag can only *request* hybrid, never widen what the caller may read.

`results` shape is hosting-dependent: the **cloud** hosting returns `[{ event, score }]`
(RRF-fused for `mcp-external`); the **local** hosting returns the grant-gated,
per-caller-redacted memory items directly (no score — it uses the full client-side
scorer for ordering). Callers MUST treat an item's presence, not a numeric score, as
the contract.

- A **tombstone** is itself an append (`type: "tombstone"`, `content` naming the
  target event id) — deletions never mutate history.
- `POST /memory/query` ranking is caller-class gated: lexical (`tsvector`) for
  shell/standalone callers; RRF-fused lexical+vector for the `mcp-external` read
  path (vector rows populated lazily, so a not-yet-embedded row contributes only
  its lexical score). The local hosting serves this query with the full
  client-side retrieval scorer (MMR/salience/epoch).

### Action registry

Standalone apps participate in cross-app actions by **declaring** the same
`ActionSpec` embedded apps use, then serving invocations over a **pull** channel
(so a CLI behind NAT needs no reachable HTTPS endpoint). An optional push webhook
is available for apps that can host one.

```
# Developer app identity (the platform-first root; appId is developer-chosen + unique)
POST /registry/apps                 Body: { appId, display?, declaredScopes?, oauthClientId? }  → RegisteredApp
GET  /registry/apps                 → { apps: RegisteredApp[] }     // the caller's own registered apps
GET  /registry/whoami               → { appId, scopes }             // resolve the caller's app identity (class-4 enroll)

# Action declaration + discovery
POST /registry/actions              Body: { actions: ActionSpec[] }   // appId is SERVER-derived from the credential
GET  /registry/actions?appId=       → { actions: RegisteredAction[] } // each with a `live` flag; discovery for the chat agent loop

# Pull-based invocation transport
POST /registry/invocations              Body: { appId, actionId, args }  → { id } | { status: "offline" }   // invoker enqueues
GET  /registry/invocations/pending      → { invocations: [{ id, actionId, args }] }   // the app pulls (and clears) its work; marks it live
POST /registry/invocations/:id/respond  Body: { result } | { error }   // only the TARGET app may respond
GET  /registry/invocations/:id          → { status: "pending" } | { status: "done", result?, error? }   // invoker polls the result
POST /registry/webhook                  Body: { url }   // optional: push invocations here instead of pull (https + public host)
```

- Wire action names remain `<appId>__<actionId>` — identical to the in-shell
  path, so the (embedded)/(standalone) surfaces cannot drift. `ActionSpec` is the
  exact shape from the shell (`src/apps/types.ts`); it is not redefined here.
- **Liveness is explicit:** an app is *live* if it pulled its inbox recently or
  registered a webhook. The chat agent loop treats actions of a non-live app as
  unavailable and falls back to that app's artifacts.
- A registered webhook makes delivery **push-only** (not also enqueued), so an app
  that both handles the push and polls can't execute one invocation twice.

### Embedded apps

An **embedded app** is a web bundle the desktop shell loads in-process: a
`manifest.json` next to an ES-module `app.js` (and, optionally, a separate
`search.js`). The SDK-side toolkit for authors is `@unifiedai/sdk/app` (helpers),
`@unifiedai/sdk/app/vite` (build plugin), `@unifiedai/sdk/host-api` +
`/host-api/ambient` (bridge types), and `@unifiedai/sdk/app/testkit` (contract
tests); the practical tutorial is [APP_GUIDE.md](APP_GUIDE.md). This section is
the normative contract between an app bundle and any host that loads it.

#### Manifest

```json
{
  "id": "string",        // app id: developer-chosen, unique, no "__"
  "name": "string",      // display name
  "version": "string",   // bundle version; hosts use it as a cache key
  "icon": "string",      // host icon name
  "kind": "web",         // bundle kind; embedded web remotes are "web"
  "module": "app.js",    // the ES-module entry the host imports to mount the app
  "actions": [ /* ActionSpec[] — see below */ ],
  "search": {            // optional: declares a cross-app search provider
    "entry": "search.js",   // separate ES-module chunk, imported lazily
    "kinds": ["doc"]        // lowercase kinds this provider can return
  }
}
```

Each `actions[]` entry is the same `ActionSpec` the standalone action registry
declares (it is deliberately **one shape**, so the embedded and standalone
surfaces cannot drift):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Bare action id, `/^[a-zA-Z0-9-]+$/` — no `__`. |
| `title` | string | Consent-prompt label / MCP tool title. |
| `description` | string | Model-facing description, written for an LLM caller. |
| `params` | JSON Schema | Param schema. Validated host-side; emitted verbatim as the MCP `inputSchema`. |
| `tier` | `"safe"` \| `"privileged"` | Default `"safe"`. `"privileged"` ⇒ verified apps only. |
| `mutates` | boolean | Whether a successful invocation writes anything. **Defaults to `true` (fail-closed)**: an action that omits it is treated as a write and refused on read-only paths. |
| `surfaces` | boolean | A successful invocation puts something on screen in this app. Default `false`. |
| `exposeToMcp` | boolean | Opt in to the external MCP surface. Default `false`. |

Wire action names are `<appId>__<actionId>` (e.g. `docs__createDocument`) —
identical to the standalone registry above. An app that can surface an artifact
MUST declare the ecosystem-standard `openArtifact` action **verbatim** from
`OPEN_ARTIFACT_SPEC` in `@unifiedai/sdk` (hosts may assert deep equality); at
runtime it registers a handler for it, typically via `makeOpenArtifactAdapter`.
Handlers are registered from the module scope of `module` through the host
bridge's `registerActions` — the host attributes them to the loaded app's id,
never to a self-reported one.

#### Sandboxed panels and header widgets

A desktop plugin may declare a panel without an in-process `module`:

```json
{
  "id": "usage-dashboard",
  "name": "Usage dashboard",
  "version": "1.0.0",
  "kind": "web",
  "surfaces": {
    "header": { "icon": "gauge", "title": "Usage", "opens": "popover", "badge": true },
    "panel": { "embed": "embed/index.html", "title": "Usage" }
  },
  "permissions": { "net": ["https://usage.example.com"] }
}
```

Bundle `@unifiedai/sdk/app/embed` into the panel page. It runs in an
opaque-origin sandbox and talks only to its parent via messages marked
`__unifiedEmbed: true`. Register `onInit` and `onTheme` before calling `ready()`.
Both callbacks receive the host's theme; `onInit` also receives `payload`,
`fill`, and optional CSS `tokens`, while `onTheme` receives tokens as its
optional second argument. `fill` means the host owns the frame size.

The SDK exposes these existing desktop verbs:

| Helper | Request | Result |
| --- | --- | --- |
| `hostFetch(url, options?)` | `t: "fetch"`, `id`, `url`, optional `method`, `headers`, `body`, `maxAge` | `{ status, body, age }` |
| `badge(text)` | `t: "badge"`, `text` | No reply; host trims to 8 characters. |
| `widget(items)` | `t: "widget"`, `items` | No reply; empty array clears the widget. |

`hostFetch` defaults to GET; the host supports GET, POST, and HEAD. The URL's
HTTPS origin must be declared in `permissions.net`, and the user must grant
network access. A hidden `?surface=badge` frame never prompts: the visible
panel obtains consent first. SDK requests time out after 60 seconds to allow
for consent; timeout stops waiting, not an already dispatched HTTP request.
HTTP errors resolve with their status and body. Host failures reject with
`EmbedError`, preserving `code` (for example `E_DENIED`); an SDK timeout uses
`timeout`. Hosts without the network broker report an error.

`maxAge` opts into host caching in **seconds**, capped at one hour. The host
shares cached results and concurrent requests across frames of the same app,
keyed by method, URL, headers, and body. HTTP error responses are cached too;
transport failures are not. `age` is whole seconds since fetching the result.
Caching is off when `maxAge` is omitted; only opt in for requests safe to reuse.

A widget item has optional `icon` and `label`, and a `values` array of
`{ text, level?, title? }`. Levels are `calm`, `warn`, or `alarm`. The host
renders plain text and applies these caps: 4 items, 2 values per item, 6
characters per value, 80 per title, and 40 per label. `icon` names a key in
`surfaces.header.icons` (bundle-relative SVG/PNG assets); an unknown key uses
the app's glyph. A widget takes precedence over the simple badge. Permission
checks, cache isolation, and widget sanitization remain the host's responsibility.

#### Search provider load contract

When `manifest.search.entry` is present, the host dynamically imports that
module (never at app mount — search entries must not pull in the app UI) and
instantiates a provider from it:

- The module MUST export `createSearchProvider` — as a named export or as the
  default export — matching `CreateSearchProvider` from `@unifiedai/sdk`.
- The host calls it with a `SearchProviderContext`:
  `{ sdk, appId, limits?, protocolVersion? }`. `appId` is host-assigned; `sdk`
  is the host's authenticated SDK instance. `limits` and `protocolVersion` are
  OPTIONAL runtime truth a host MAY push where its live values differ from the
  documented defaults; when absent the provider assumes the constants below.
- The factory returns a `SearchProvider` (sync or async): `{ kinds?, search(req) }`.
  The host fans a query out across installed apps' providers, passing each a
  `SearchRequest` (`query`, host-tokenized `terms`, `kinds?`, `limit`, `signal`,
  `hints?`). Providers MUST honor `signal` and return hits in rank order — the
  host fuses results by RANK, not by raw score.

#### Host limits (`SEARCH_PROTOCOL_VERSION` 1)

These are PROTOCOL CONSTANTS (exported as `HOST_LIMITS` from
`@unifiedai/sdk/app`), not host tunables: a provider is written against exactly
these numbers, so a host MUST honor them as stated and MAY only **lower** a cap
alongside a bump of `SEARCH_PROTOCOL_VERSION` — silently tightening one strands
every already-shipped provider on the old contract. (Raising a cap, and pushing
the raised value via `SearchProviderContext.limits`, is compatible.)

| Limit | Value | Host behavior past it |
| --- | --- | --- |
| `PER_PROVIDER_REQUEST_LIMIT` | 10 | The `limit` the host passes each provider; extra hits are truncated. |
| `TITLE_MAX` | 200 chars | `title` silently truncated. |
| `SNIPPET_MAX` | 300 chars | `snippet` silently truncated. |
| `CONTAINER_TITLE_MAX` | 120 chars | `containerTitle` silently truncated. |
| `PREVIEW_MAX_BYTES` | 2048 | JSON-serialized `preview` silently discarded (rest of the hit kept). |
| `PER_PROVIDER_TIMEOUT_MS` | 1500 ms | Per-provider budget, INCLUDING module load; the request `signal` aborts and the provider's hits are dropped. |

A host additionally bounds the whole fan-out with a total budget
(the reference shell uses 2500 ms). The total budget is **host-discretionary**
— it is not part of the provider contract, since each provider already sees it
only as its per-provider `signal`.

#### Hit sanitization

Providers are untrusted app code; a host MUST sanitize every returned hit:

- A hit missing a non-empty string `id`, `title`, or `kind` is **dropped**.
- A non-finite/non-number `score` is coerced to `0`; a non-number `updatedAt`
  is removed.
- Strings are clamped to the caps above; an oversized or unserializable
  `preview` is discarded while the rest of the hit is kept.
- An `openRef` without a non-empty `objectId` is discarded.
- `openRef.action` MUST name a **declared, `mutates: false` action of the same
  app**, or the host silently strips `action` + `params` from the ref (the rest
  survives). Because `mutates` defaults to `true`, an action that does not
  explicitly declare `mutates: false` can never be invoked from a search hit —
  fail-closed.
- The host stamps the owning app id on every hit; a provider never supplies it.

### Local ecosystem hosting & discovery

When the desktop app starts it writes a discovery record next to the auth
discovery file so local clients can reach the loopback ecosystem hosting.

| OS | Path |
| --- | --- |
| macOS, Linux | `~/.woluai/ecosystem.json` |
| Windows | `%APPDATA%\WoluAI\ecosystem.json` |

(`~/.woluai-<env>` for a `WOLUAI_ENV` build, as for `desktop.json`.)

```json
{ "url": "http://127.0.0.1:0", "token": "string", "pid": 0, "started_at": 0 }
```

- `url` is the loopback base (ephemeral port). `token` is a per-launch,
  per-app-mintable local token the caller sends as `Authorization: Bearer
  <token>` (or `X-Ecosystem-Token`). The desktop SHOULD remove the file on clean
  shutdown; clients MUST tolerate a stale file (the probe fails and they fall
  through).
- **Resolution order (SDK):** on first ecosystem call, an SDK MUST (0) if the shell
  injected `UNIFIEDAI_ECOSYSTEM_URL` + `UNIFIEDAI_ECOSYSTEM_TOKEN` (a bundled/class-3
  child launched by the desktop), use them directly — no probe (the shell set them for
  this exact process); (1) else read `ecosystem.json` and probe `GET <url>/health` with
  a short fail-fast deadline (~500 ms) — if it answers, use the local hosting; a
  standalone (class-4) app holding an OAuth token MAY then upgrade the powerless anonymous
  discovery token to a scoped one via `POST <url>/enroll` (`Authorization: Bearer
  <oauth>` → `{ token }`), falling back to the anonymous token when enroll fails;
  (2) otherwise use the cloud hosting (`UNIFIEDAI_API_URL`) with the normal bearer
  credential. This mirrors the keychain → handoff → PKCE bootstrap order: local presence
  is preferred, and its absence degrades to cloud (or, offline, to a
  `handoff_unreachable`-style local-only failure) rather than erroring.

The local hosting runs the SAME policy sequence as the cloud hosting
(authenticate → scope → grant/policy → execute → audit); it is the shell's
broker logic re-fronted as HTTP, not a second policy implementation.

## Sync

A **per-workspace, live-first** materialized-view protocol: a client hydrates a
workspace's records (bootstrap), polls changes (delta), and writes optimistic
updates (apply). The wire counter is a monotonic per-workspace **`syncId`**;
ordering, paging, and dedupe are all keyed off it. All three routes are scoped
by a `workspaceId` path segment.

```json
// SyncRecord — on read (bootstrap + delta)
{
  "ns": "string",
  "collection": "string",
  "id": "string",
  "metadata": {},          // JSON-ish bag; {} on a tombstone
  "version": 0,             // bumps on every write
  "deleted": false,         // true = tombstone (delta only)
  "syncId": 0,              // SERVER monotonic per-workspace change counter
  "createdAt": 0,
  "updatedAt": 0,
  "hasBlob": false,
  "blobEncoding": "string"  // optional
}
```

```
GET  /sync/workspaces                              → { workspaces: [{ id, name, kind, role }] }
GET  /sync/:workspaceId/bootstrap?cursor=&limit=   → { records: SyncRecord[], cursor, complete }
GET  /sync/:workspaceId/delta?cursor=&limit=       → { records: SyncRecord[], cursor, hasMore }
POST /sync/:workspaceId/apply                       Body: { ops: SyncOp[] }   // 1..200
                                                    → { results: [{ ns, collection, id, syncId, version }] }
```

- **workspaces** lists the memberships of the authenticated caller — `id`,
  `name`, `kind` (`personal` | `team`), `role` (`owner` | `member`). It lets an
  app discover its personal workspace id without a round-trip to base-api.
  (SDK: `sdk.sync.listWorkspaces()`.)
- **bootstrap** pages the LIVE rows (no tombstones). Follow `cursor` while
  `complete` is false; when `complete` is true the returned `cursor` **becomes a
  delta cursor** (resume point for the change stream).
- **delta** returns every change after `cursor` — including **tombstones**
  (`deleted: true`, empty `metadata`). Follow `cursor` while `hasMore` is true.
- **The cursor is OPAQUE** — clients MUST NOT parse it; they only echo it back.
- **apply** ops carry exactly one intent: `patch` (shallow-merge over `metadata`;
  a JSON `null` value REMOVES that key), `replace` (swap `metadata` wholesale),
  or `delete` (tombstone: sets `deleted`, clears `metadata`). Blob fields
  (`blob_hash`, `blob_encoding`, `bytes`) are content-addressed and rejected in
  shared workspaces.
- **Epoch reset (409 `cursor_epoch_mismatch`):** the workspace's change log was
  rewound/reset, so an older cursor is no longer valid. From either bootstrap or
  delta, the client MUST **discard ALL local state for that workspace** (and any
  local snapshot) and re-run bootstrap from scratch.
- **Offline is read-only** (platform decision). A failed `apply` is rolled back
  locally and rethrown; the client does **NOT** queue a local write log for
  later replay. Reads continue to serve the last-known view (optionally from a
  host-provided snapshot) while offline.

## Namespace sharing

A generic, domain-agnostic grant layer so **any** marketplace app can expose a
namespaced `sdk.storage` / `sdk.sync` resource to (a) other apps and
(b) authenticated agents. No app-specific types (Issue, Milestone, …) belong
in the SDK — the producing app owns the collection schema; consumers see
opaque JSON records.

Planner (and any future app) stores under its own namespace (e.g. `ns:
"planner"`) and publishes grants. Grok Bot and other UnifiedApp apps consume
those grants through the same SDK methods.

### Isolation & identity

- **Isolation by default.** `sdk.storage.namespace()` and sync records whose
  `ns` equals the caller's `appId` are always readable/writable by that app.
- **Identity is host-stamped.** The SDK sends `x-unified-app: <appId>` on every
  request. A client constructed with `callerKind: "agent"` also sends
  `x-unified-caller: agent`. The server MUST re-derive caller class from the
  credential (OAuth client, MCP, …) and MUST ignore a spoofed header.
- An **unscoped** caller (no `appId`, first-party host / `uapi_` key) is not
  grant-filtered — it sees every namespace. Marketplace apps always have an
  `appId`.

### Grant shape

```json
{
  "id": "string",
  "ns": "string",
  "grantee": { "type": "app", "appId": "string" } | { "type": "agent" },
  "mode": "read | readwrite",
  "createdAt": 0,
  "updatedAt": 0
}
```

- `{ "type": "app", "appId" }` — another marketplace app (the same id the host
  stamps on its SDK).
- `{ "type": "agent" }` — any authenticated agent credential (Grok Bot,
  `mcp-external`, or `callerKind: "agent"`). Agent grants are not app-scoped.
- `mode: "readwrite"` implies `read`. Cross-app writes are allowed but uncommon;
  consumers still have to open the namespace with `{ mode: "readwrite" }`.
- Only the **owning app** (`ns === caller.appId`) may list/create/revoke grants
  for that namespace. Re-granting the same grantee upserts `mode`.

```
GET    /storage/grants?ns=                 → { grants: NamespaceGrant[] }
POST   /storage/grants                     Body: { ns?, grantee, mode? }  → NamespaceGrant
DELETE /storage/grants/:id                 → { revoked: boolean }

GET    /sync/grants?ns=                    → { grants: NamespaceGrant[] }
POST   /sync/grants                        Body: { ns?, grantee, mode? }  → NamespaceGrant
DELETE /sync/grants/:id                    → { revoked: boolean }
```

`ns` defaults to the caller's `appId`. Grants are **namespace-scoped**, not
workspace-scoped: a sync grant on `"planner"` applies to that `ns` in every
workspace the caller can access. unified-api MUST filter `bootstrap`/`delta`
to granted namespaces and reject `apply` ops against an ungranted `ns` with
`403 sync_not_granted`. Storage collection ops against an ungranted `ns`
return `403 storage_not_granted`.

### Agent access

In-process agents (`sdk.agent.run`) are the calling app: bind
`storageTools(sdk.storage.namespace())` / `syncTools(ws, ns)` (optionally with
a collection allowlist and `write: true`). External/authenticated agents need
a `{ type: "agent" }` grant, then use the same tools or the same
`namespace("other-app")` / `workspace().collection(ns, name)` reads.

### Local-dev wiring (no production API)

This change is **local-first**. Production unified-api / unified-db deploy is
out of scope. The cloud Pro-gate and grant HTTP paths stay in the contract so
base-api can match them later; UnifiedApp desktop must work **in-process**.

The host constructs one grant table and injects it into every per-app SDK:

```ts
import { MemoryGrantStore } from "@unifiedai/sdk";
import { MemoryBackend } from "@unifiedai/sdk";
import { createLocalSharingRuntime } from "@unifiedai/sdk/testing";

// One-liner for local UnifiedApp / tests:
const host = createLocalSharingRuntime(); // optional { cloudPlanId: 0 } to model Free
const planner = host.client({ appId: "planner" });
const docs = host.client({ appId: "docs" });
const grok = host.client({ appId: "grok-bot", callerKind: "agent" });
```

Equivalent wiring by hand:

- One `MemoryGrantStore` passed as `UnifiedAI({ grantStore })`,
  `new MemoryBackend({ grants })`, and `new FakeSyncServer({ grants })`.
- `FakeSyncServer.fetch` as the client's `fetch` + `apiUrl: server.baseUrl`.
- Injected `MemoryBackend` so `sdk.storage` never opens `CloudStorageBackend`.
- `callerKind: "agent"` on the Grok Bot client.

Grant CRUD then stays in-process (`sdk.storage.grants` / `sdk.sync.grants`
do not hit `/storage/grants` or `/sync/grants` HTTP). `FakeSyncServer`
filters bootstrap/delta/apply against the same table. Set
`cloudPlanId: 0` to exercise `plan_required` locally — do not call
production billing.

Injected local backends (`MemoryBackend`, a host snapshot store) are **not**
Pro-gated. Only the fake/cloud sync HTTP paths (`bootstrap`/`delta`/`apply`)
honor `cloudPlanId`.

### Cloud persistence is Pro-gated

Cloud paths — `POST /storage/*` (except grant CRUD MAY be gated the same way),
`POST /fs/*`, and `GET|POST /sync/:workspaceId/{bootstrap,delta,apply}` — require
a paid plan. **Free is `plans.id = 0`** (the same numbering as
`users.me().account_type`). Pro is a higher id in the `plans` table; this
client treats `plan.id > 0` as entitled and does **not** hard-code a Pro id.
The server is authoritative.

A Free caller hitting a gated cloud path MUST receive HTTP **403** with body:

```json
{
  "code": "plan_required",
  "required_plan": "Pro",
  "current_plan_id": 0,
  "message": "Cloud sync and persistence require a Pro plan."
}
```

SDKs MUST key off `code: "plan_required"` (not the 403 status alone) and
surface a typed upgrade error (`PlanRequiredError` in the TS SDK) — never a
500, never a silent no-op. Injected local backends (MemoryBackend, a host
SQLite/snapshot store) are **not** gated: offline/local behavior that already
works keeps working. `GET /sync/workspaces` is not gated (discovery).

Entitlement source of truth is unified-db + base-api (`plans` joined from
`account_type`). This repo is the client: it maps the wire error and exposes
`isCloudPlan(plan)` / `PLAN_FREE_ID` for UX preflight via `sdk.usage.get()`.

## Decisions

Batched decision evaluation against Jev (TypeSafe). `state` is a text-only
snapshot of context — no images — and every question in one call is evaluated
in parallel, so callers batch a round of questions rather than looping calls.

```json
// Question — request
{
  "type": "choice | score | noul",
  "instructions": "string",
  "criteria": {} // choice: Record<string,string> options; score: string[]; noul: omitted
}
```

```json
// Answer — response
{
  "type": "choice | score | noul",
  "choice": "string",             // choice only
  "score": 0,                     // score only
  "noul": 0,                      // noul only
  "probabilities": {},            // optional
  "legend": {},                   // optional
  "confidence": 0                 // 0..1; derived as |noul − 0.5| × 2 when Jev omits it (noul)
}
```

```
POST /api/v1/decisions   Body: { state, questions: { [key]: Question }, model? }
                         → { model, answers: { [key]: Answer }, usage: { input_tokens, output_tokens } }
```

## Error codes

SDKs surface these as typed errors. Names normative; messages free-form.

- `not_bootstrapped` — `identity()` called before `bootstrap()`, or `client_id`
  not resolvable.
- `app_not_installed` — the authoritative env-injected desktop handoff 404'd
  the `client_id`. A discovery-file 404 is treated as stale and falls through,
  so it does not surface this code.
- `handoff_unreachable` — desktop handoff probe failed (used internally for
  fall-through; only surfaced if there is no fallback path).
- `auth_user_cancelled` — browser OAuth flow returned `error=access_denied` or
  equivalent.
- `auth_state_mismatch` — loopback callback's `state` did not match.
- `auth_timeout` — browser sign-in redirect did not arrive before the SDK's
  deadline; the flow was abandoned and the loopback listener closed.
- `auth_token_exchange_failed` — token endpoint rejected or returned malformed
  body.
- `auth_refresh_failed` — the refresh-token grant failed or a successful
  refresh was invalidated by a concurrent local session clear.
- `auth_retry_still_unauthorized` — the request still returned 401 after one
  successful credential refresh; SDKs MUST stop rather than loop.
- `browser_open_failed` — the system browser could not be launched for the
  PKCE step (missing/failed opener binary). The TS SDK identifies the failed
  opener and preserves the underlying process error.
- `keychain_unavailable` — OS keychain inaccessible (no native module, locked,
  etc.). SDKs MAY treat persist failures as non-fatal for the current session.
- `aborted` — the caller ended an operation. For auth, this includes
  `signOut()` winning a race with an in-flight `bootstrap()`; the pending
  bootstrap MUST NOT restore local state or emit a later signed-in event.
- `model_deprecated` — a call-time request named a model that has been retired.
  unified-api returns HTTP `410` with body `{code: "model_deprecated", message}`
  from any model endpoint (chat, messages, embeddings, images, responses, …);
  the model is also absent from `models.list()`. SDKs MUST key off the body
  `code`, not the `410` status alone — `410` is also returned for expired upload
  sessions. Retrying does not help; switch to a current model.

Sync API (HTTP status in parentheses):

- `invalid_cursor` (400) — a `bootstrap`/`delta` cursor was malformed.
- `cursor_epoch_mismatch` (409) — the cursor's epoch is stale; the client MUST
  discard ALL local state for the workspace and re-bootstrap (see §Sync). SDKs
  key off the body `code` (409 alone is not specific enough).
- `not_a_member` (403) — the caller is not a member of the workspace.
- `workspace_not_found` (404) — no workspace for the id.
- `blobs_not_supported_in_shared_workspaces` (400) — an `apply` op carried a blob
  field against a shared workspace.
- `plan_required` (403) — Free caller hit a Pro-gated cloud persistence path
  (`/storage/*`, `/fs/*`, `/sync/:id/{bootstrap,delta,apply}`). Body includes
  `required_plan: "Pro"` and `current_plan_id`. SDKs MUST key off the body
  `code` (403 alone is `forbidden` / grant-denial). Upgrade-shaped, not a 500.
- `storage_not_granted` (403) — cross-app `sdk.storage` access without a grant.
- `sync_not_granted` (403) — `apply` (or a filtered read that the client still
  attempted as a write) against a namespace the caller has no grant for.
- `fs_not_granted` (403) — reserved; same shape for `sdk.fs` if/when fs grants
  ship.
Ecosystem API (returned by both hostings; HTTP status in parentheses):

- `ecosystem_unreachable` — the local ecosystem hosting probe failed and no cloud
  fallback is configured or reachable (internal fall-through analogue of
  `handoff_unreachable`; only surfaced when offline with no cloud base).
- `scope_denied` (403) — the credential's OAuth scopes do not admit the route
  (checked before grants).
- `policy_denied` (403) — scopes admit the route but the per-project policy or a
  per-app grant does not (e.g. `appContrib` excludes a standalone caller, or
  `mcpRead` is false for an `mcp-external` reader).
- `artifact_not_found` (404) — no artifact/version for the id (`artifact://`
  resolution failures use this).
- `app_not_registered` (403) — an `actions:register`/OAuth caller whose
  `oauth_clients.id` has no linked `registered_apps` row, so app identity cannot
  be attributed.
- `route_not_found` (404) — no ecosystem route matches the method+path (distinct
  from `artifact_not_found`, which means the route matched but the resource is
  absent).
- `bad_request` (400) — a required parameter is missing or malformed (e.g. a
  `list_artifacts` with no `projectId`, or a `search_memory` with no `query`).
- `timeout` (504) — the local hosting forwarded the request to the webview but no
  reply arrived within the per-request deadline.
- `internal` (500) — an unclassified handler error; the message is diagnostic
  only and MUST NOT be branched on.

Decisions API (HTTP status in parentheses):

- `decision_unavailable` (503) — `TYPESAFE_API_KEY` is not configured server-side.
- `decision_invalid_request` (400) — question count outside `1..64`, a `choice`
  question with more than 255 criteria keys, or Jev rejected the request body.
- `decision_rate_limited` (429) — Jev rate-limited the upstream call.
- `decision_timeout` (504) — the upstream call did not complete within the
  server's deadline.
- `decision_upstream_error` (502) — any other Jev failure, including a
  rejected API key (401/403) — a rejected key is server misconfiguration,
  never the caller's fault.
