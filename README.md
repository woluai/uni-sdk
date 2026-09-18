# @unifiedai/sdk

Official SDK for Unifiedai marketplace apps. Ships two runtime client entries
plus optional logos/testing subpaths, so the same package works in the browser,
in Workers/edge, and in Node CLIs — without forcing consumers to bundle
Node-only or test-only modules.

## Install

`@unifiedai/sdk` is **not published to npm** — `bun add @unifiedai/sdk` 404s.
Install it from GitHub. `dist/` JS and `.d.ts` are committed, so a default
`bun install` resolves `.`, `./app`, `./logos`, and the other documented
subpaths **without** `trustedDependencies` or `bun install --trust`:

```sh
bun add @unifiedai/sdk@github:greedyafinc/uni-sdk#main

# Pin a commit in CI — `main` moves, and the `version` field moves slower still.
bun add @unifiedai/sdk@github:greedyafinc/uni-sdk#<sha>
```

```json
{
  "dependencies": {
    "@unifiedai/sdk": "github:greedyafinc/uni-sdk#main"
  }
}
```

Do **not** add `"trustedDependencies": ["@unifiedai/sdk"]`. Bun blocks
lifecycle scripts for git dependencies by default; that is fine. `prepare`
would otherwise `rm -rf dist` and then fail (`tsc` is a devDependency). When
the package *is* trusted, `prepare` is a no-op inside `node_modules` and
uses the committed `dist/`.

**UnifiedApp CI:** depend on a git SHA (or `#main` after this lands), run
plain `bun install` / `bun install --frozen-lockfile`, and import
`@unifiedai/sdk/app` and `@unifiedai/sdk/logos` as usual. No `--trust` flag.
Local UnifiedApp checkouts that sit next to this repo can keep
`"@unifiedai/sdk": "file:../../uni-sdk"` so SDK edits are picked up without
pushing; that path also needs a built `dist/` (`bun install` or
`bun run build` in uni-sdk).

The package is ESM-only. The Node entry requires Node 18 or newer and the
published types target TypeScript 5. Example commands below run with Bun.

## Which entry should I import?

```ts
// Browser, Tauri WebViews, Workers, edge runtimes, server-side trusted hosts
import { UnifiedAI } from "@unifiedai/sdk";

// Node CLIs and desktop apps that run OAuth via local loopback + OS keychain
import { UnifiedAI } from "@unifiedai/sdk/node";
```

The default entry is **browser-safe**: it never resolves `node:*` specifiers
or `@napi-rs/keyring`, and Vite/Webpack/Rollup/esbuild will bundle it without
polyfills. It requires you to supply a bearer token via the `token` option.

The `/node` entry is a **strict superset**: same resources, plus the
Authorization Code + PKCE OAuth flow with a local loopback HTTP listener,
discovery file lookups, and OS keychain storage. Same class name (`UnifiedAI`)
in both — call sites read identically. The keychain module
(`@napi-rs/keyring`) is an **optional** dependency: if it fails to install,
the SDK still works and treats the keychain as unavailable.

Two additional subpath entries keep optional payloads out of the core bundle:

```ts
// Provider/model brand logos (~58 KB of data-URI SVGs; browser-safe)
import { getProviderLogo, getModelLogo, listProviderLogos } from "@unifiedai/sdk/logos";
import type { LogoTheme, ProviderLogoInput, ModelLogoInput } from "@unifiedai/sdk/logos";

// Test doubles — never ship in production bundles
import { FakeSyncServer, createLocalSharingRuntime } from "@unifiedai/sdk/testing";
import type { FakeSyncServerOptions, LocalSharingRuntime } from "@unifiedai/sdk/testing";
```

> **Breaking (unreleased):** the logo helpers and `FakeSyncServer` were
> previously exported from the root/node entries. Import them from
> `@unifiedai/sdk/logos` and `@unifiedai/sdk/testing` now.

Building an **embedded marketplace app** for the UnifiedApp shell? That's a
first-class SDK surface with its own subpaths:

```ts
// Action + search + text helper kernel for embedded apps (dependency-free)
import { safeRegisterActions, makeOpenArtifactAdapter, scoreFields, toSearchHit } from "@unifiedai/sdk/app";

// Search-contract validator + micro-benchmark for your test suite
import { findHitViolations, benchmark } from "@unifiedai/sdk/app/testkit";

// Vite plugin that wires the @unified/host-api bridge for build + standalone dev
import { unifiedApp } from "@unifiedai/sdk/app/vite";

// Types for the host bridge; the /ambient entry declares the bare specifier
// for your tsconfig: { "types": ["@unifiedai/sdk/host-api/ambient"] }
import type { HostApi } from "@unifiedai/sdk/host-api";
```

An app that also renders an inline **preview** (a chat card or side panel)
imports the embed protocol from its own separate subpath — it runs inside a
sandboxed, opaque-origin iframe, so it is kept out of `@unifiedai/sdk/app` on
purpose:

```ts
// Embed-side helpers for the host's inline-preview protocol
import { ready, onInit, onTheme, resize, openFull, fail, reference } from "@unifiedai/sdk/app/embed";
import type { EmbedInit, EmbedReference } from "@unifiedai/sdk/app/embed";

onInit(({ payload, theme }) => {
  // render `payload` at `theme`...
});
onTheme((theme) => {
  // live theme change...
});

// Push something the user picked onto the host's chat composer as a mention chip.
reference({ id: "doc-1#p=3", label: "Paragraph 3", artifactType: "doc-paragraph" });

ready(); // call last — the host replies with `init`
```

Start with [APP_GUIDE.md](APP_GUIDE.md) (tutorial), the runnable
[`templates/app-template`](templates/app-template/README.md), and
[PROTOCOL.md § Embedded apps](PROTOCOL.md#embedded-apps) (the normative
manifest, search-provider, and host-limits contract).

When both `token` and `appId` are supplied, `token` selects trusted-token
authentication while `appId` still namespaces `sdk.storage` and `sdk.fs`,
and is sent as `X-Unified-App` so a shared `uapi_` testing key can attribute
usage per app.
The browser entry cannot run OAuth: `appId` without `token` does not
authenticate there.

Runnable examples use the working-tree source directly:

- [`examples/browser-trusted-token`](examples/browser-trusted-token/README.md) — browser
  host supplies a token and observes `sdk.session`
- [`examples/streaming-chat`](examples/streaming-chat/README.md) — Node OAuth
  auto-bootstrap, auth events, and chat SSE
- [`examples/file-upload`](examples/file-upload/README.md) — general file upload with
  byte progress, list/content round-trip, and cleanup

## Usage

### Trusted-token mode (browser, edge, server)

```ts
import { UnifiedAI } from "@unifiedai/sdk";

const sdk = new UnifiedAI({
  apiUrl: "https://api.unifiedai.app",
  // Static string, or async function called on every request.
  token: async () => readBearerFromSession(),
});

const usage = await sdk.usage.get();
const stream = sdk.responses.create({
  model: "gpt-4",
  input: [{ role: "user", content: "Hello" }],
  stream: true,
});
for await (const event of stream) {
  if (event.type === "response.output_text.delta") process.stdout.write(event.delta);
}
```

The SDK calls your `token` provider on every request. On 401 it calls it once
more (single-flighted across concurrent requests) so your host can rotate the
token; if the retry still 401s, the SDK throws `UnifiedAIAuthError`.

#### Embeddings

```ts
const res = await sdk.embeddings.create({
  model: "togethercomputer/m2-bert-80M-8k-retrieval",
  input: ["the quick brown fox", "jumps over the lazy dog"],
});
for (const item of res.data) {
  console.log(item.index, item.embedding.length);
}
```

`input` accepts a single string or an array of strings (OpenAI parity). The
response mirrors the OpenAI Embeddings shape:
`{ object, data: [{ object, embedding, index }], model, usage }`.

#### Files (upload + reference by `file_id`)

```ts
// 1. User picks a file (browser File picker, drag-drop, fs.readFile, …).
const file: File = pickedByUser;

// 2. Upload it. Returns a stable `file_id` plus a short-lived signed URL.
const { file_id, image_url } = await sdk.files.upload(file);

// 3. Reference the uploaded image by URL in any chat / responses / images call.
//    The signed URL is publicly reachable and expires in ~1 hour, which is
//    long enough for typical request chains; for longer-lived references,
//    keep the bytes locally or re-upload.
const res = await sdk.responses.create({
  model: "gpt-4o",
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: "What's in this image?" },
        { type: "input_image", image_url },
      ],
    },
  ],
});

await sdk.images.edit({
  model: "gpt-image-1",
  images: [{ image_url }],
  prompt: "make it sepia",
});
```

`sdk.files.upload(source, { filename?, contentType?, signal?, onProgress? })` accepts a
`Blob`, `File`, `Buffer`, `Uint8Array`, `ArrayBuffer`, or a base64 `data:` URL.
Filename and content-type are auto-detected from `File`/`Blob` metadata when
present and can be overridden via the options object. `files.upload()` is the
image-only convenience that also returns a signed `image_url` for
`images.edit` (PNG/JPEG/WEBP up to 25 MB). For audio, video, and PDF inputs
use `files.create()` instead — same source types, returns a `FileObject` with
metadata only.

> **`file_id` and `image_url` both work downstream.** The id returned by
> `files.upload()` / `files.create()` is usable as `file_id` on any multimodal
> content part (`input_image`, `input_audio`, `input_video`, `input_file`, or
> chat `file`) across `chat.completions.create`, `responses.create`, and
> `messages.create` — the gateway resolves it server-side to a signed URL for
> the routed provider. `image_url` (returned by `files.upload()`) is the same
> signed URL passed through verbatim; pick whichever your call site reads
> more naturally.

### Managing uploaded files

```ts
const file = await sdk.files.create(audioBytes, { filename: "clip.mp3" });
// `file.id` → "uni_…", `file.mime_type`, `file.bytes`, `file.purpose`

const { data } = await sdk.files.list();
const meta = await sdk.files.retrieve(file.id);
const { bytes, contentType, filename } = await sdk.files.content(file.id);
await sdk.files.del(file.id);
```

`files.create()` also accepts `purpose` and switches to resumable chunked
upload above 5 MB by default. Override the threshold with
`chunkedUploadThreshold` (`Infinity` disables chunking). To survive a process
restart, persist the id received by `onPersistUploadId` and pass it back as
`resumeFrom`; the hook receives `null` after completion or caller abort. A
resumed call must use the same filename, MIME type, and byte length.

#### Messages (Anthropic) streaming

```ts
const stream = sdk.messages.create({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Stream a haiku." }],
  stream: true,
});

// Walk events as they arrive…
for await (const event of stream) {
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    process.stdout.write(event.delta.text);
  }
}

// …or skip the events and just await the assembled message:
const message = await sdk.messages
  .create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Stream a haiku." }],
    stream: true,
  })
  .finalMessage();
console.log(message.stop_reason, message.usage);
```

Call `stream.abort()` to cancel mid-flight; it closes the underlying fetch and
ends the iterator. `stream.usage` is populated once `message_delta` lands.

### OAuth mode (Node CLI, desktop)

```ts
import { UnifiedAI } from "@unifiedai/sdk/node";

const sdk = new UnifiedAI({
  appId: "your-client-id", // OAuth client_id from app registration
  signInTimeoutMs: 5 * 60_000, // optional: bound the browser sign-in wait (default 5 min)
  refreshSkewSeconds: 60, // optional: proactively refresh before expiry; 0 disables
  revokeTimeoutMs: 5_000, // optional: bound best-effort sign-out revocation
  onAuthEvent: (e) => console.error("[auth]", e.type), // optional observability hook
});

// Either bootstrap explicitly…
await sdk.bootstrap(); // → opens browser, runs PKCE, stores in OS keychain
const me = sdk.identity();

// …or just make a call: with no `token` configured, the first request
// auto-bootstraps (lazily, once per instance).
const usage = await sdk.usage.get();
```

Bootstrap tries cached keychain tokens → environment-supplied handoff port →
discovery-file handoff → fresh browser PKCE. A locked or unavailable OS
keychain falls through to the next source instead of failing; desktop handoff
probes are bounded at 3 s; the browser wait is bounded by `signInTimeoutMs`
(default 5 minutes, then `auth_timeout`). If the system browser can't be
launched, the SDK throws `browser_open_failed` naming the failed opener and
underlying process error. Access tokens refresh proactively
60 seconds before expiry by default (`refreshSkewSeconds`), with the
single-flighted 401 refresh path as a fallback.

`onAuthEvent` receives an `AuthEvent` union — `keychain_lookup`,
`handoff_attempt`, `handoff_result`, `browser_pkce_start`, `refresh_start`,
`refresh_success`, `refresh_failure`, `sign_out` — for logging/telemetry.
Events include the handoff `source`, `port`, and `result`, or a refresh-failure
`code` where applicable. The listener runs synchronously; a thrown listener
error is swallowed so telemetry cannot break auth. Failed lazy bootstrap
attempts may be retried by a later request. A successful bootstrap or
`signOut()` disarms lazy bootstrap, so a signed-out request will not silently
reopen a browser — call `bootstrap()` explicitly to sign in again.
If `signOut()` races an in-flight bootstrap, sign-out wins: bootstrap rejects
with `code: "aborted"`, no late `signedIn` event fires, and any newly minted
token family is revoked best-effort.

### Session lifecycle

`sdk.session` exposes the current auth state and an observable event stream:

```ts
const unsubscribe = sdk.session.onChange((event) => {
  if (event.type === "expired") showSignInAgain();
  if (event.type === "error") console.error(event.error);
});

console.log(sdk.session.status); // "active" | "expired" | "signed_out"
console.log(sdk.session.isAuthenticated());
unsubscribe();
```

Trusted-token clients start active when a token provider is configured. A
retried 401 that still fails transitions the session to `expired`. OAuth
clients additionally emit `signedIn`, `refreshed`, and `signedOut`; their
`expiresAt` values are epoch milliseconds. Trusted-token sessions have no
known `expiresAt`, and `signOut()` only updates local observable state—the
host remains responsible for revoking its credential.

### Client behavior options

- `retry` configures transient 429/5xx/network retry, or `false` disables it;
  `onRetry` observes each attempt. Non-idempotent POST/PATCH requests do not
  retry network/5xx failures unless the resource marks them safe.
- `cache` enables the bounded in-memory cache used by cacheable deterministic
  calls.
- `compression` sets the default gateway context-compression flag for chat,
  messages, and responses. An explicit per-request value takes precedence.

## Error handling

The SDK throws typed errors from `@unifiedai/sdk` so consumers can branch on
the failure mode without parsing strings. Every SDK error extends
`UnifiedError`, which carries a stable `code` (`UnifiedErrorCode`), an
optional `status`, the standard ES2022 `cause` (the original transport error,
where relevant), and an `isUnifiedSdkError: true` marker that survives
bundler-duplicated class identities where `instanceof` breaks. HTTP failures
extend `UnifiedAIError` (itself a `UnifiedError`), which adds `body`,
`headers`, and `requestId` (from `x-request-id` / `request-id`).
`instanceof Error` keeps working for catch-all handlers.

| Class                    | HTTP | Trigger                                                        | Extra fields |
| ------------------------ | ---- | -------------------------------------------------------------- | ------------ |
| `UnifiedError`           | —    | base of every SDK error, incl. non-HTTP subsystem errors       | `code`, `status?`, `isUnifiedSdkError` |
| `StreamInterruptedError` | —    | reading an established SSE response failed mid-stream — provider timeout or socket close; retry or switch models | `cause` (e.g. `ECONNRESET`) |
| `UnifiedAIError`         | any  | base of all HTTP errors; generic 4xx fallback                  | `body`, `headers`, `requestId` |
| `BadRequestError`        | 400  | request rejected as invalid                                    | —            |
| `AuthenticationError`    | 401  | credential missing, invalid, or expired — refresh may help     | —            |
| `UnifiedAIAuthError`     | 401  | the SDK's own refresh flow failed, or a retried 401 still 401'd; extends `AuthenticationError` | — |
| `ForbiddenError`         | 403  | credential accepted but not permitted (app-scoped token, disabled key) — terminal, refreshing won't help | — |
| `NotFoundError`          | 404  | no such resource (model, file, conversation, …)                | —            |
| `DeprecatedModelError`   | 410  | model retired; keyed off body `code: "model_deprecated"`, not the status alone (410 is also used for expired upload sessions) — switch models | `isDeprecated` |
| `RateLimitError`         | 429  | transient throttling — wait and retry                          | `retryAfter` (seconds) |
| `UsageLimitError`        | 429  | plan quota exhausted for the billing period — retrying won't help | `periodCost`, `limit`, `resetAt`, `isUsageLimit` |
| `PlanRequiredError`      | 403  | Free caller hit a Pro-gated cloud storage/fs/sync path — upgrade, not a permission bug. Sibling of `ForbiddenError` (not a subclass). | `requiredPlan`, `currentPlanId`, `isPlanRequired` |
| `ServerError`            | 5xx  | upstream provider / gateway failure                            | —            |

`RateLimitError` and `UsageLimitError` are **siblings**, not parent/child —
`UsageLimitError` does *not* pass an `instanceof RateLimitError` check, so a
generic retry wrapper must catch both explicitly. Always check the more
specific class first.

All three streaming surfaces (`chat`, `messages`, `responses`) throw
`StreamInterruptedError` when reading an established stream fails — a request
that never got a 200 throws the HTTP error instead, and a caller-initiated
abort surfaces as the caller's own `AbortError`.

`err.code` is typed against a single `UnifiedErrorCode` registry covering:

- **HTTP** — `bad_request`, `unauthorized`, `forbidden`, `not_found`,
  `model_deprecated`, `rate_limited`, `usage_limit_exceeded`, `plan_required`,
  `storage_not_granted`, `sync_not_granted`, `fs_not_granted`, `server_error`,
  `request_failed`
- **Auth / bootstrap (node)** — `not_bootstrapped`, `app_not_installed`,
  `handoff_unreachable`, `auth_user_cancelled`, `auth_state_mismatch`,
  `auth_timeout`, `auth_token_exchange_failed`, `auth_refresh_failed`,
  `auth_retry_still_unauthorized`, `browser_open_failed`,
  `keychain_unavailable`
- **Streaming** — `stream_interrupted`
- **Client-side** — `invalid_input`, `aborted`, `not_implemented`
- **Storage subsystem** — `storage_unavailable`, `storage_read_only`,
  `storage_not_granted`
- **Sync subsystem** — `sync_not_granted`
- **Fs subsystem** — `fs_unavailable`, `fs_read_only`, `fs_not_granted`,
  `invalid_path`, `edit_not_found`, `edit_not_unique`

Registered codes get autocomplete and exhaustiveness help; unregistered
strings still compile (forward compatibility). Non-HTTP subsystem errors are
built through the shared `subsystemError()` factory and are plain
`UnifiedError`s.

```ts
import {
  UnifiedAI,
  AuthenticationError,
  ForbiddenError,
  DeprecatedModelError,
  RateLimitError,
  UsageLimitError,
  BadRequestError,
  ServerError,
  StreamInterruptedError,
  UnifiedAIError,
} from "@unifiedai/sdk";

const sdk = new UnifiedAI({ token: process.env.UNIFIEDAI_TOKEN });

try {
  await sdk.chat.completions.create({ model: "gpt-4o-mini", messages: [...] });
} catch (err) {
  if (err instanceof UsageLimitError) {
    console.error(`Quota exhausted: $${err.periodCost} / $${err.limit}`);
  } else if (err instanceof RateLimitError) {
    console.error(`Throttled — retry in ${err.retryAfter ?? "?"}s`);
  } else if (err instanceof DeprecatedModelError) {
    console.error("Model retired — pick a current one from models.list()");
  } else if (err instanceof ForbiddenError) {
    console.error("Credential not permitted for this operation");
  } else if (err instanceof AuthenticationError) {
    console.error("API key invalid or revoked");
  } else if (err instanceof BadRequestError) {
    console.error("Request rejected:", err.body);
  } else if (err instanceof ServerError) {
    console.error("Upstream failure:", err.requestId);
  } else if (err instanceof StreamInterruptedError) {
    console.error("Stream dropped mid-response:", err.cause);
  } else if (err instanceof UnifiedAIError) {
    console.error(`Unexpected ${err.status}:`, err.message);
  } else {
    throw err;
  }
}
```

## Resources

Everything hangs off one client. Resources are memoized lazy getters —
constructed on first access, so `sdk.chat` alone doesn't pay for the other 21.

| Resource | What it does |
| --- | --- |
| `sdk.chat` | OpenAI-compatible `chat/completions` — text generation with SSE streaming. |
| `sdk.messages` | Anthropic-style `messages` API, streaming events + `finalMessage()`. |
| `sdk.responses` | Unified multimodal responses endpoint (text, vision, audio, tools). |
| `sdk.embeddings` | Vector embeddings (OpenAI parity — string or string-array input). |
| `sdk.images` | Image generation, editing, and variations. |
| `sdk.audio` | Text-to-speech synthesis and speech transcription. |
| `sdk.videos` | Video generation jobs — submit, poll, retrieve content. |
| `sdk.files` | Upload/download/manage files, incl. resumable chunked uploads. |
| `sdk.models` | Model catalog with provider, pricing, and capability metadata. |
| `sdk.usage` | Account usage stats (tokens, costs) + subscription plan details. |
| `sdk.users` | Authenticated profile (`me()`) and public user lookup by id(s). |
| `sdk.helpers` | Stateless multimodal helpers — source normalization, part construction. |
| `sdk.calendar` | Stateless date math: timezone-aware recurrence expansion, sync-adapter serialization. |
| `sdk.projects` | Cross-app projects — user-owned containers gathering work from many apps. |
| `sdk.references` | Resolve `uniref://` project links back into renderable content. |
| `sdk.artifacts` | Canonical, versioned snapshots of app work (docs, sheets, designs). |
| `sdk.memory` | Append-only agent-memory ledger with server-stamped taint origin. |
| `sdk.actions` | Cross-app action registry — declare `ActionSpec`s, serve or invoke actions. |
| `sdk.storage` | App-namespaced typed collections + blobs (see [`STORAGE-SPEC.md`](STORAGE-SPEC.md)). Cross-app/agent access via `sdk.storage.grants`. |
| `sdk.fs` | App-namespaced jailed file workspace — read/write/edit a directory tree. |
| `sdk.sync` | Per-workspace sync engine: bootstrap/delta hydration + optimistic writes (see [`PROTOCOL.md`](PROTOCOL.md) §Sync; `FakeSyncServer` ships in `@unifiedai/sdk/testing`). Namespace grants: `sdk.sync.grants`. |
| `sdk.agent` | Unopinionated tool-loop scaffolding — run a model over app-supplied tools. Opt-in packs: `fsTools(ns)`, `storageTools(ns)`, `syncTools(ws, ns)`, and `webTools()`. |

### App data, sync, and polling

- `sdk.storage` uses the cloud backend when the client can authenticate, or a
  host-injected backend. There is no browser-local fallback. The app's own
  namespace is read-write; cross-app namespaces default to read-only and
  require a grant (`sdk.storage.grants`). Cloud writes/reads are Pro-gated
  (`PlanRequiredError` / `plan_required`); injected local backends are not.
  Collections support metadata queries, out-of-line blobs, and versioning.
  Local UnifiedApp/desktop injects `MemoryBackend` + a shared `grantStore`
  (see `createLocalSharingRuntime` in `@unifiedai/sdk/testing`) so sharing
  works without production unified-api.
- `sdk.fs` follows the same cloud/injected/no-fallback selection. It exposes a
  jailed POSIX-style tree with text/byte reads, writes, unique-string edits,
  listing, stat, and delete. Cloud fs is Pro-gated the same way.
- `sdk.sync.workspace(id)` caches a `WorkspaceSync`. `start()` hydrates an
  optional snapshot then catches up, background polling reads deltas, `sync()`
  forces catch-up, and `apply()` performs optimistic writes with rollback on
  failure. Observe `workspace.status`; cursor epoch mismatch automatically
  discards stale state and re-bootstraps. `sdk.sync.grants` shares a namespace
  with other apps and authenticated agents. Bootstrap/delta/apply are
  Pro-gated; `listWorkspaces()` is not.
- `videos.waitUntilReady()` polls every 5 seconds for up to 10 minutes by
  default, supports abort, throws on timeout, and returns both completed and
  failed terminal jobs. `actions.awaitResult()` polls every 400 ms for up to
  30 seconds and returns the last pending result on timeout.

The hand-written guide in [`site/`](site/index.html) covers install, auth, the
three text surfaces, streaming, and errors in more depth.

## Project layout

```
src/
├── index.ts                  # browser entry (browser-safe surface)
├── logos/                    # @unifiedai/sdk/logos entry (brand logos)
├── testing/                  # @unifiedai/sdk/testing entry (test doubles)
├── auth/                     # browser sign-in helper
├── core/                     # shared base (UnifiedAI, Core, errors, retry, SSE/stream)
├── resources/                # one file/dir per resource — the 22 above
└── node/                     # OAuth extension (PKCE, keychain, loopback, handoff)
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the dep graph and conventions.

## Development

```sh
bun install
bun run lint        # biome
bun run typecheck   # tsc --noEmit
bun test            # bun test (core + node + bundle integrity)
bun run build       # browser bundle + node bundle + types + verify
bun run docs        # typedoc → ./docs (generated API reference)
bun run site        # serve ./site/index.html on :4321 (PORT=… to override)
```

`site/` is the hand-written guide (install, auth, the three text surfaces,
streaming, errors, feature reference); `docs/` is the generated typedoc API
reference and is gitignored. `bun run site` serves the file verbatim — no
bundling — so what you see is what ships.

The build runs a structural-invariant check (`scripts/verify-browser-bundle.ts`)
that fails if the browser bundle ever picks up a `node:*` specifier or
`@napi-rs/keyring`.

## Releasing

Releases are driven by [Changesets](https://github.com/changesets/changesets).
A PR with a `.changeset/*.md` file lands on `main`; the release workflow opens
a "Version Packages" PR; merging that PR publishes to npm.

Requires the `NPM_TOKEN` repo secret.

> **No release has been published yet** — the name is unclaimed on the public
> registry, so the pipeline above describes the intended flow rather than the
> current state. Until a version lands, consume the SDK from GitHub as shown
> in [Install](#install).

## License

MIT
