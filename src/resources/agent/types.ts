import type { UnifiedAIHttpErrorCode, UnifiedErrorCode } from "../../core/errors";
// Public types for `sdk.agent` — the unopinionated tool-loop SCAFFOLDING.
//
// The SDK provides the loop mechanics (stream-consume, accumulate streamed
// tool-calls, thread messages, abort, step cap, usage events) and a TOOL SPEC
// abstraction. It provides NO system prompt and NO tool policy: the app supplies
// its own prompt and composes its own tool set (optionally including the
// `fsTools()` / `webTools()` packs). This is a daemon-less generalization of OpenDesign's
// in-process unified-agent loop. See docs/capability-platform.md.
import type {
  ChatCompletionMessage,
  ChatCompletionToolDefinition,
  ChatCompletionUserContentPart,
} from "../chat";

/** What a tool's `execute` returns: text fed back to the model, flagged on error. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/**
 * One tool the model may call: its wire DEFINITION (name/description/JSON-schema
 * params, OpenAI function shape) plus the host-side `execute` the loop runs when
 * the model calls it. The app owns these — it can use `fsTools()`, `webTools()`, subset them,
 * wrap them, or supply entirely its own.
 */
export interface ToolSpec {
  definition: ChatCompletionToolDefinition;
  /** Run the tool. `input` is the parsed JSON arguments; honor `signal` for cancellation. */
  execute: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<ToolResult> | ToolResult;
}

/**
 * Token usage counters for a turn/run. `inputTokens`/`outputTokens` are the
 * base counts; `cachedInputTokens` (prompt tokens served from cache) and
 * `cacheCreationInputTokens` (tokens written to cache on this turn) are
 * present only when the gateway/provider reports them.
 */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** Streamed events the loop emits so the app can render progress as it happens. */
export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  // A tool call is still STREAMING its arguments (not yet dispatched). Emitted as
  // the arguments accrue so a long tool call (e.g. write_file streaming a big
  // file) shows live progress instead of going silent between the model's text
  // and the `tool_use` that fires once the arguments are complete. `chars` is the
  // length of the arguments JSON streamed so far; `args` is that raw JSON itself
  // (a partial object, possibly truncated mid-value) so a host can render a live
  // preview of the in-flight tool input — e.g. the file a write_file is emitting.
  | { type: "tool_partial"; name: string; chars: number; args: string }
  // `parentId` is set when the call was made by a subagent: the tool-use id of the
  // spawning Agent/Task call, so hosts nest these under that row.
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      raw?: string;
      parentId?: string;
    }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean; parentId?: string }
  // The concrete model the gateway served for the current turn — fires once per
  // turn, on the first chunk carrying a non-`auto` model. Lets the UI flip an
  // "Auto" badge to the router's actual pick while the turn is still streaming.
  | { type: "model"; model: string }
  | { type: "usage"; usage: AgentUsage };

export interface RunAgentOptions {
  /**
   * The full message array to start from. Takes precedence over `system`/`prompt`
   * — pass this to continue or refine a prior run (the app persists the transcript
   * returned in `RunAgentResult.messages`).
   */
  messages?: ChatCompletionMessage[];
  /** App-supplied system prompt. The SDK injects none. Ignored when `messages` is set. */
  system?: string;
  /** The first user turn — plain text or multimodal content parts. Ignored when `messages` is set. */
  prompt?: string | ChatCompletionUserContentPart[];
  /**
   * Tools the model may call. Compose `fsTools(ns)` / `webTools()` with your own;
   * omit/empty for a plain completion. The array is read LIVE at each step: a
   * tool's `execute` may push additional ToolSpecs into it mid-run (deferred
   * tool loading) and they are advertised and dispatchable from the next step on.
   */
  tools?: ToolSpec[];
  /** Model id; defaults to the gateway's `auto` router. */
  model?: string;
  /** Safety cap on tool-call round trips (default 40). */
  maxSteps?: number;
  /**
   * Per-completion output-token cap (`max_tokens`). Raise it for REASONING models
   * that otherwise spend the whole default budget on hidden `reasoning_content` and
   * hit `finish_reason: "length"` before producing any visible text or tool call.
   * Omit to use the gateway/provider default. A generous value is safe: the gateway
   * clamps an over-large `max_tokens` down to each model's real limit rather than
   * erroring.
   */
  maxTokens?: number;
  /** Cancellation. When aborted mid-run the loop stops and returns `canceled: true`. */
  signal?: AbortSignal;
  /** Progress sink — text/thinking deltas, tool calls, tool results, usage. */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Polled at the top of every step. Whatever it returns is appended to the
   * transcript before that step's request — how a host steers a RUNNING turn
   * (a follow-up typed while tools are still executing) without aborting it.
   * Return nothing when nothing is pending. Only consulted between steps: a
   * message that arrives during the final text turn is never seen here.
   */
  steer?: () => ChatCompletionMessage[] | undefined;
}

export interface RunAgentResult {
  ok: boolean;
  canceled?: boolean;
  /** Human-readable failure message (the typed error's `.message`). */
  error?: string;
  /**
   * Structured detail of the failing error, lifted from the SDK's typed error
   * hierarchy (see `core/errors`) so callers can branch on the KIND of failure —
   * e.g. `"rate_limited"` vs `"usage_limit_exceeded"` vs `"unauthorized"` — and
   * render a specific message instead of a generic one. Absent on success/cancel
   * and on synthetic failures (e.g. the tool-call-limit guard) that have no HTTP
   * error behind them.
   */
  errorCode?: UnifiedAIHttpErrorCode | UnifiedErrorCode;
  /** HTTP status of the failing request, when the error is an HTTP error. */
  errorStatus?: number;
  /** Seconds to back off before retrying — present only on a rate-limit error. */
  errorRetryAfter?: number;
  /**
   * The concrete model the gateway actually served; for an `auto` request this is
   * the router's pick, not `"auto"`. Last-turn-wins across a multi-step run.
   * Absent on runs that never streamed a chunk (e.g. abort before the first turn),
   * or against a host bundling an older uni-sdk that doesn't capture it.
   */
  model?: string;
  /**
   * The `finish_reason` of the final streamed turn — `"stop"` (clean), `"length"`
   * (cut off at the output-token limit), `"tool_calls"`, etc. Lets a caller detect
   * an output-token-limit truncation on an otherwise-`ok` run and auto-recover
   * (e.g. retry with a larger `maxTokens`). Absent on runs that never completed a
   * turn, or against a host bundling an older uni-sdk that doesn't capture it.
   */
  finishReason?: string;
  /**
   * Token usage aggregated across every streamed turn of the run, from the
   * gateway's `stream_options.include_usage` chunks. `inputTokens`/
   * `outputTokens` are run totals (input is per-request, so re-sent context is
   * counted every turn). `lastTurnInputTokens` is the prompt size of the FINAL
   * request — i.e. how many tokens of the model's context window the transcript
   * actually occupied — which is what context-usage meters want. Absent when the
   * gateway never emitted usage (e.g. an older gateway, or a run that failed
   * before its first turn finished).
   */
  usage?: { inputTokens: number; outputTokens: number; lastTurnInputTokens?: number };
  /** Whether any assistant text or tool activity was produced. */
  producedOutput: boolean;
  /** The full transcript after the run — persist it to continue/refine later. */
  messages: ChatCompletionMessage[];
}
