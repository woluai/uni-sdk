// Browser-safe entry. Pulls zero `node:*` modules — safe for Vite, Webpack,
// Rollup, esbuild, Workers, Deno, and any browser bundler.
//
// For OAuth flows (PKCE + keychain + handoff + loopback), import from
// "@unifiedai/sdk/node" instead.

export { UnifiedAI } from "./core/client";
export type { UnifiedAIOptions } from "./core/client";

// Browser PKCE sign-in (injectable loopback + URL opener for desktop hosts).
export {
  signInWithBrowser,
  runBrowserPkce,
  type BrowserSignInArgs,
  type LoopbackHandle,
  type LoopbackServer,
  type OpenUrl,
} from "./auth/browser-sign-in";
export type { TokenSet } from "./core/_internal/tokens";

export {
  extractServerMessage,
  formatBody,
  httpErrorMessage,
} from "./core/_internal/http-errors";

export { Core } from "./core/core";
export type {
  CacheConfig,
  CoreOptions,
  RequestOptions,
  RetryAttempt,
  RetryConfig,
  RetryListener,
  TokenProvider,
} from "./core/core";

export {
  UnifiedError,
  UnifiedAIError,
  UnifiedAIAuthError,
  AuthenticationError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  DeprecatedModelError,
  RateLimitError,
  UsageLimitError,
  PlanRequiredError,
  planRequiredError,
  isPlanRequiredBody,
  ServerError,
  StreamInterruptedError,
  buildHttpError,
  httpErrorCodeFromStatus,
} from "./core/errors";
export type {
  UnifiedErrorCode,
  UnifiedAIAuthErrorCode,
  UnifiedAIHttpErrorCode,
} from "./core/errors";

export type { Identity } from "./core/identity";

export { Session } from "./core/session";
export type {
  SessionStatus,
  SessionSnapshot,
  SessionEvent,
  SessionEventType,
  SessionListener,
} from "./core/session";

export { UnifiedStream } from "./core/_internal/stream";
export type { StreamUsage, StreamUsageExtractor } from "./core/_internal/stream";
export { parseSSE, type SSEMessage } from "./core/_internal/sse";

// Local agent CLIs (Claude Code / Cursor) on the user's UnifiedApp desktop,
// reached over the loopback bridge or the cross-device relay. Browser-safe;
// explicit /index because it is a directory barrel (same dts-fixup reason as
// storage).
export * from "./localAgents/index";

// Resource modules — all browser-safe.
// Explicit /index: agent is a directory barrel (same dts-fixup reason as storage).
export * from "./resources/agent/index";
export * from "./resources/audio";
export * from "./resources/actions";
export * from "./resources/artifacts";
// Explicit /index: calendar is a directory barrel (same dts-fixup reason as storage).
export * from "./resources/calendar/index";
export * from "./resources/chat";
export * from "./resources/memory";
export * from "./resources/embeddings";
export * from "./resources/decisions";
export * from "./resources/files";
// Explicit /index: fs is a directory barrel (same dts-fixup reason as storage).
export * from "./resources/fs/index";
export * from "./resources/helpers";
export * from "./resources/images";
export * from "./resources/messages";
export * from "./resources/models";
export * from "./resources/autoModel";
export * from "./resources/autoRouter";
export * from "./resources/projects";
export * from "./resources/references";
export * from "./resources/responses";
// Types-only cross-app search contract (no runtime `sdk.search` yet).
export * from "./resources/search/types";
// Types-only cross-app OPEN contract: the one action every app declares so any
// surface can put an artifact on screen. Depends on projects + search/types.
export * from "./resources/openArtifact";
// Explicit /index: storage is a directory barrel, so the emitted .d.ts must
// reference ".../storage/index.js" (the dts-fixup would otherwise produce a
// non-resolving ".../storage.js").
export * from "./resources/storage/index";
// Generic namespace sharing (grants for storage + sync). Types live here so
// the storage and sync barrels don't double-export them.
export * from "./resources/sharing";
// Explicit /index: sync is a directory barrel (same dts-fixup reason as storage).
export * from "./resources/sync/index";
export * from "./resources/usage";
export * from "./resources/usage-analytics";
export * from "./resources/users";
export * from "./resources/videos";
// Logo helpers (getProviderLogo, etc.) live behind "@unifiedai/sdk/logos" —
// the generated data-URI table is ~58 KB and must not ship in the core bundle.
