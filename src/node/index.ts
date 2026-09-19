// Node entry. Provides the OAuth-capable UnifiedAI subclass plus everything
// from the browser-safe core. Pulls Node-only modules (`node:http`, `node:fs`,
// `@napi-rs/keyring`) — do not import this from a browser bundle.
//
// Imports are explicit (rather than `export * from "../"`) because Bun's
// bundler silently drops the local UnifiedAI subclass when both a wildcard
// re-export and a named override declare the same symbol.

// Core class — for advanced consumers wiring a custom transport.
export { Core } from "../core/core";
export type {
  CacheConfig,
  CoreOptions,
  RequestOptions,
  RetryAttempt,
  RetryConfig,
  RetryListener,
  TokenProvider,
} from "../core/core";

// Errors.
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
} from "../core/errors";
export type {
  UnifiedErrorCode,
  UnifiedAIAuthErrorCode,
  UnifiedAIHttpErrorCode,
} from "../core/errors";

// Identity.
export type { Identity } from "../core/identity";

// Session surface.
export { Session } from "../core/session";
export type {
  SessionStatus,
  SessionSnapshot,
  SessionEvent,
  SessionEventType,
  SessionListener,
} from "../core/session";

// Stream + SSE.
export { UnifiedStream } from "../core/_internal/stream";
export type { StreamUsage, StreamUsageExtractor } from "../core/_internal/stream";
export { parseSSE, type SSEMessage } from "../core/_internal/sse";

// Error helpers.
export {
  extractServerMessage,
  formatBody,
  httpErrorMessage,
} from "../core/_internal/http-errors";

// Resources.
// Explicit /index: agent is a directory barrel (see src/index.ts note).
export * from "../resources/agent/index";
export * from "../resources/audio";
export * from "../resources/actions";
export * from "../resources/artifacts";
// Explicit /index: calendar is a directory barrel (see src/index.ts note).
export * from "../resources/calendar/index";
export * from "../resources/chat";
export * from "../resources/memory";
export * from "../resources/embeddings";
export * from "../resources/decisions";
export * from "../resources/files";
// Explicit /index: fs is a directory barrel (see src/index.ts note).
export * from "../resources/fs/index";
export * from "../resources/helpers";
export * from "../resources/images";
export * from "../resources/messages";
export * from "../resources/models";
export * from "../resources/autoModel";
export * from "../resources/autoRouter";
export * from "../resources/projects";
export * from "../resources/references";
export * from "../resources/responses";
// Types-only cross-app search contract (no runtime `sdk.search` yet).
export * from "../resources/search/types";
export * from "../resources/openArtifact";
// Explicit /index: storage is a directory barrel (see src/index.ts note).
export * from "../resources/storage/index";
export * from "../resources/sharing";
// Explicit /index: sync is a directory barrel (see src/index.ts note).
export * from "../resources/sync/index";
export * from "../resources/usage";
export * from "../resources/users";
export * from "../resources/videos";
// Explicit /index: localAgents is a directory barrel (see src/index.ts note).
//
// Present on the NODE entry too, at browser parity: the module is browser-safe
// (no `node:` builtins), and the surfaces that consume it — the UnifiedApp
// desktop's webview among them — resolve the node condition under a bundler or
// a test runner even though they run in a browser. Omitting it here made
// `import { invalidateBridgePort } from "@unifiedai/sdk"` a load-time
// SyntaxError in exactly those places.
export * from "../localAgents/index";
// Logo helpers live behind "@unifiedai/sdk/logos" (see src/index.ts note).

// The node-capable UnifiedAI — supersedes the browser entry's class. Consumers
// importing from this entry get the OAuth-capable client under the same name.
export { UnifiedAI } from "./client";
export type { UnifiedAIOptions, AuthEvent, AuthEventListener } from "./client";

// Local-first Ecosystem API discovery (PROTOCOL.md "Local ecosystem hosting & discovery").
// Resolves the running desktop app's loopback hosting (env handoff → discovery file + probe
// → class-4 enroll upgrade), or null to fall back to cloud.
export {
  discoverLocalEcosystem,
  defaultEcosystemDiscoveryPath,
  type LocalEcosystem,
  type DiscoverOptions,
  type EcosystemDiscoveryRecord,
} from "./_internal/ecosystem-discovery";

// Node-specific configuration types.
export type { DiscoveryReader, DiscoveryRecord } from "./_internal/discovery";
export type { Env, EnvReader } from "./_internal/env";
export type { KeychainAdapter } from "./_internal/keychain";
export {
  signInWithBrowser,
  runBrowserPkce,
  type BrowserSignInArgs,
  type LoopbackServer,
  type LoopbackHandle,
  type OpenUrl,
} from "../auth/browser-sign-in";
export type { TokenSet } from "../core/_internal/tokens";
