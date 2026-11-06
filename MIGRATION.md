# Migration Guide

## 0.2.0 → Unreleased

### Move optional imports to subpath entries

Logo data and sync test doubles no longer ship from the production root/node
entries:

```diff
- import { getModelLogo, FakeSyncServer, type FakeSyncServerOptions } from "@unifiedai/sdk";
+ import { getModelLogo } from "@unifiedai/sdk/logos";
+ import { FakeSyncServer, type FakeSyncServerOptions } from "@unifiedai/sdk/testing";
```

The node entry now re-exports the full browser-safe resource surface, so
resource classes and types can be imported from the same `/node` entry as the
OAuth client.

### Calendar removal

`sdk.calendar` and the calendar-specific date, recurrence, and sync-adapter
exports are no longer available.

### Node OAuth behavior

- The first API call auto-bootstraps when `token` is absent; explicit
  `bootstrap()` remains supported.
- A missing or locked keychain now falls through to handoff/browser PKCE.
- Browser PKCE times out after 5 minutes by default; configure
  `signInTimeoutMs`.
- Access tokens proactively refresh 60 seconds before expiry; configure
  `refreshSkewSeconds`, or set it to `0` to retain reactive-only refresh.
- After `signOut()`, requests do not silently restart OAuth. Call
  `bootstrap()` explicitly to sign back in.

## 0.0.x → 0.1.0

The SDK now ships two entry points instead of one. The default
`@unifiedai/sdk` import is browser-safe — it contains no `node:*` modules
and no native dependencies, so Vite/Webpack/Rollup/esbuild can bundle it for
browsers without polyfills.

**Most consumers don't need to change anything.** Bundlers auto-resolve the
`browser` or `node` export condition based on target.

### If you were using OAuth

The OAuth flow (`bootstrap()` opens a browser, runs PKCE, stores tokens in
the OS keychain) moved to the `/node` subpath. Update your import:

```diff
- import { UnifiedAI } from "@unifiedai/sdk";
+ import { UnifiedAI } from "@unifiedai/sdk/node";

  const sdk = new UnifiedAI({ appId: "your-client-id" });
  await sdk.bootstrap();
```

All other APIs (`sdk.chat`, `sdk.responses`, `sdk.usage`, `sdk.models`,
`sdk.messages`, `sdk.identity()`, `sdk.signOut()`) are unchanged.

In Node, the package's `node` export condition still resolves to the OAuth-
capable client when you do `import "@unifiedai/sdk"` — but the explicit
`/node` import makes the intent visible to readers.

### If you were using trusted-token mode

No change required. Pass `token` (string or async function) as before:

```ts
import { UnifiedAI } from "@unifiedai/sdk";
const sdk = new UnifiedAI({ token: async () => readBearer() });
```

### If you customized OAuth internals

The `keychain`, `loopback`, `discovery`, `env`, `openUrl`, `authorizeUrl`,
`tokenUrl`, and `revokeUrl` options moved off the browser-safe
`UnifiedAIOptions` interface. Import the node options type explicitly:

```ts
import { UnifiedAI, type UnifiedAIOptions } from "@unifiedai/sdk/node";

const opts: UnifiedAIOptions = {
  appId: "x",
  keychain: myInMemoryKeychain,
};
```

### Bundle-size note

The browser bundle is ~75 KB raw ESM (~22 KB gzipped). The node bundle is
~93 KB raw (~28 KB gzipped). The 18 KB delta is OAuth machinery — PKCE,
loopback, handoff, refresh, revoke — only present where it's actually used.

### Error message format

`UnifiedAIError.message` now appends the server-extracted message when one
is available:

```
// 0.0.x
"request to /v1/responses returned 429"

// 0.1.0
"request to /v1/responses returned 429: rate limit exceeded"
```

The full body is still attached on `err.body`. Tests that match on a
substring of the base format (`"request to"`, `"returned 429"`) keep
passing.

### Removed (intentional)

Nothing — every public symbol from 0.0.x is still exported from one of the
two entries. The `UnifiedAIErrorCode` type was a typo and was never
exported; it's `UnifiedErrorCode`.
