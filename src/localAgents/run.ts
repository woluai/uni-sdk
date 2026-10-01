import type { AgentEvent, RunAgentResult, ToolSpec } from "../resources/agent/types";
// One agent turn on a LOCAL CLI (Claude Code / Cursor) running on the user's
// desktop, reached over the loopback bridge or the cross-device relay.
//
// The point of this module is that a caller cannot tell the lanes apart: it
// emits the SAME `AgentEvent` union `sdk.agent.run` emits and returns the same
// `RunAgentResult` shape, so an app can swap `runLocalAgent` in wherever the
// picked model happens to be a `claude-code/*` or `cursor/*` id.
//
// Ported from the desktop's `claudeCode/agent.ts` + `cursor/agent.ts`, which
// keep their translators unchanged across every transport because every
// transport carries the CLI's RAW NDJSON lines.
import type { ChatCompletionMessage, ChatCompletionUserContentPart } from "../resources/chat";
import {
  CLAUDE_CODE_SESSIONS_KEY,
  CURSOR_SESSIONS_KEY,
  EPHEMERAL_CONVERSATION_PREFIX,
  foldHistoryPrompt,
  forgetSession,
  rememberSession,
  sessionFor,
  sessionScope,
  systemText,
  withSystemPrompt,
} from "./_internal/prompt";
import { createToolServer } from "./_internal/toolServer";
import {
  createClaudeCodeStreamTranslator,
  createCursorStreamTranslator,
  explainFailure,
  isMissingSession,
} from "./_internal/translators";
import { claudeCodeCliModel, cursorCliModel, laneForModel } from "./catalog";
import { type Lane, type LocalAgentSourcePref, type RunHandle, startAgentRun } from "./transport";

export interface RunLocalAgentOptions {
  /** A `claude-code/*` or `cursor/*` id. Anything else rejects. */
  model: string;
  /**
   * The full transcript to start from — `system` blocks included, and honored:
   * they become the agent's system prompt (or, on a lane with no such flag, a
   * labelled block at the head of the prompt) on EVERY turn, exactly as the
   * gateway would. That is what makes picking a local model a provider swap
   * rather than a jump into someone else's coding agent.
   */
  messages?: ChatCompletionMessage[];
  /**
   * System instructions, overriding any `system` blocks in `messages`. Callers
   * that keep the system prompt out of the transcript pass it here.
   */
  system?: string;
  /**
   * The newest user turn. When omitted it is taken from the last user message in
   * `messages`. Multimodal parts are flattened to their text — a local CLI takes
   * text only, and dropping the rest beats failing the turn.
   */
  prompt?: string | ChatCompletionUserContentPart[];
  /**
   * Tools the CLI may call, served to it over the desktop's per-run MCP server.
   * A LIVE array: a tool that pushes more specs into it mid-run is visible to
   * the agent's next `tools/list`, exactly as in the SDK agent loop. Each call
   * runs the spec's own `execute` HERE, in this page's context.
   */
  tools?: ToolSpec[];
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /**
   * Code-work mode: run in this real directory on the DESKTOP instead of the
   * app's scratch workspace. Get the path from `pickWorkspaceFolder()` — the
   * host only honors `trustWorkspace` for folders its own user picked there.
   */
  workspace?: string;
  /** Write access for `workspace`. Must reflect an explicit user opt-in, never a default. */
  trustWorkspace?: boolean;
  /** Additional attached folders, passed as `--add-dir` (code-work mode only). */
  extraDirs?: string[];
  /** Claude Code `--effort` level. Ignored on the Cursor lane (effort is a sibling model id there). */
  effort?: string | null;
  /**
   * Stable key for multi-turn continuity — it maps to the CLI's own thread state
   * (`--resume`). OMIT it for a fresh, throwaway session: that is the right
   * choice for subagents and any fan-out worker, which must not inherit or
   * mutate the parent thread's context.
   */
  conversationId?: string;
  /**
   * Run on a SPECIFIC device instead of the active source — the per-surface
   * compute choice. Take it from `listLocalAgentDevices()[n].pref`. Omitted, the
   * turn runs wherever the global source selection points.
   */
  source?: LocalAgentSourcePref;
}

/** The newest user turn as plain text — what a local CLI takes as its prompt. */
function latestUserText(messages: ChatCompletionMessage[] | undefined): string {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages?.[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return flattenParts(m.content);
  }
  return "";
}

function flattenParts(parts: readonly unknown[]): string {
  return parts
    .map((p) =>
      p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text ?? "") : "",
    )
    .filter(Boolean)
    .join("\n");
}

interface Attempt extends RunAgentResult {
  sessionMissing?: boolean;
}

/**
 * One CLI invocation. `resume` null starts a fresh session (history folded in).
 * `mcp` asks the active source to host this run's tools; where that MCP server
 * lives (the paired desktop, a remote host) is the transport's problem.
 */
function runAttempt(
  lane: Lane,
  opts: RunLocalAgentOptions,
  messages: ChatCompletionMessage[],
  userText: string,
  system: string,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void,
  resume: string | null,
  scope: string,
): Promise<Attempt> {
  const modelId = opts.model;
  const runId = crypto.randomUUID();
  // Claude Code takes a real system prompt; Cursor's CLI has no such flag, so
  // that lane carries the same text at the head of the prompt instead.
  const folded = foldHistoryPrompt(messages, userText, !!resume);
  const prompt = lane === "claude-code" ? folded : withSystemPrompt(system, folded);
  const tools = createToolServer(opts.tools, signal);
  const mcp = !!opts.tools?.length;

  const translator =
    lane === "claude-code"
      ? createClaudeCodeStreamTranslator(onEvent)
      : createCursorStreamTranslator(onEvent);
  const sessionsKey = lane === "claude-code" ? CLAUDE_CODE_SESSIONS_KEY : CURSOR_SESSIONS_KEY;

  return new Promise<Attempt>((resolve) => {
    let settled = false;
    let handle: RunHandle | null = null;

    const finish = (result: Attempt) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      handle?.stop();
    };
    signal.addEventListener("abort", onAbort);

    const produced = () => translator.allText.length > 0 || translator.toolActivity;

    const fail = (error: string, sessionMissing = false) =>
      finish({
        ok: false,
        error,
        ...(sessionMissing ? { sessionMissing: true } : {}),
        model: modelId,
        producedOutput: produced(),
        messages,
      });

    void (async () => {
      try {
        if (signal.aborted) {
          finish({ ok: false, canceled: true, model: modelId, producedOutput: false, messages });
          return;
        }
        handle = await startAgentRun(
          lane,
          {
            runId,
            prompt,
            model: lane === "claude-code" ? claudeCodeCliModel(modelId) : cursorCliModel(modelId),
            ...(lane === "claude-code"
              ? { effort: opts.effort ?? null, systemPrompt: system || null }
              : {}),
            resume,
            workspace: opts.workspace ?? null,
            trustWorkspace: opts.trustWorkspace ?? false,
            extraDirs: opts.extraDirs ?? [],
            mcp,
          },
          {
            onLine: (line) => translator.handleLine(line),
            onMcpList: () => tools.list(),
            onMcpCall: (name, args) => tools.call(name, args),
            onExit({ code, canceled, stderr }) {
              if (canceled || signal.aborted) {
                finish({
                  ok: false,
                  canceled: true,
                  model: modelId,
                  producedOutput: produced(),
                  messages,
                });
                return;
              }
              // Remember the session even on failure: the CLI already persisted
              // it, and a retry should continue the same thread rather than
              // start a new one.
              // Claude Code's translator also tracks a session id seen on any
              // line (Cursor only reports one on `result`).
              const sessionId =
                translator.result?.sessionId ??
                (translator as { sessionId?: string | undefined }).sessionId;
              if (sessionId) rememberSession(sessionsKey, scope, sessionId);

              const result = translator.result;
              if (result && !result.isError) {
                // Nothing streamed (an all-tools turn, or a CLI without partial
                // messages): fall back to the aggregated result text.
                if (!translator.allText && result.text) translator.emitText(result.text);
                finish({
                  ok: true,
                  model: modelId,
                  producedOutput: produced(),
                  messages: [...messages, { role: "assistant", content: translator.allText }],
                });
                return;
              }
              const detail =
                result?.text.trim() ||
                stderr.trim() ||
                `${lane} exited with code ${code ?? "unknown"}`;
              fail(
                lane === "claude-code" ? explainFailure(detail) : detail,
                lane === "claude-code" && isMissingSession(stderr),
              );
            },
          },
          opts.source,
        );
        // Aborted while the run was being accepted — the listener is attached
        // now, so the stop lands and `exit` still arrives.
        if (signal.aborted) handle.stop();
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    })();
  });
}

/**
 * Run one turn on the active local source.
 *
 * Never rejects for an ordinary failure: like `sdk.agent.run`, a failed turn
 * comes back as `{ ok: false, error }`. It DOES reject when `model` is not a
 * local-agent id — that is a caller bug, not a turn outcome.
 *
 * The fields a local lane cannot produce (`errorCode`, `errorStatus`,
 * `finishReason`, `usage` totals) stay absent, which is what
 * `isLocalAgentModel()` warns callers about.
 */
export async function runLocalAgent(opts: RunLocalAgentOptions): Promise<RunAgentResult> {
  const lane = laneForModel(opts.model);
  if (!lane) throw new Error(`"${opts.model}" is not a local agent model.`);

  // Same starting transcript as `sdk.agent.run`: explicit `messages` win, else
  // [system?, user]. Building it here (not just reading `opts.system`) is what
  // keeps the returned transcript resumable — a caller that saves `messages`
  // and refines from it must get its system prompt back.
  const messages: ChatCompletionMessage[] = opts.messages ?? [
    ...(opts.system ? [{ role: "system", content: opts.system } as ChatCompletionMessage] : []),
    { role: "user", content: opts.prompt ?? "" } as ChatCompletionMessage,
  ];
  const promptText =
    typeof opts.prompt === "string"
      ? opts.prompt
      : Array.isArray(opts.prompt)
        ? flattenParts(opts.prompt)
        : latestUserText(messages);
  const signal = opts.signal ?? new AbortController().signal;
  const onEvent = opts.onEvent ?? (() => {});

  // No conversationId => a throwaway thread id, so the CLI starts fresh and this
  // turn never resumes (or pollutes) another surface's conversation. The prefix
  // is the shared contract: the session store skips it entirely, so an ephemeral
  // turn leaves no permanently-unreachable row behind.
  const conversationId =
    opts.conversationId ?? `${EPHEMERAL_CONVERSATION_PREFIX}${crypto.randomUUID()}`;
  // Sessions are scoped per workspace: the CLIs key their session stores by cwd,
  // so a scratch-mode session cannot be resumed from an attached repo.
  const scope = sessionScope(conversationId, opts.workspace);
  const sessionsKey = lane === "claude-code" ? CLAUDE_CODE_SESSIONS_KEY : CURSOR_SESSIONS_KEY;
  const resume = sessionFor(sessionsKey, scope);

  // Computed once: identical on the retry below, and joining every system block
  // of a composed request is an O(messages) scan plus a copy of all of them.
  const system = opts.system ?? systemText(messages);

  const attempt = await runAttempt(
    lane,
    opts,
    messages,
    promptText,
    system,
    signal,
    onEvent,
    resume,
    scope,
  );

  // A pruned session store would otherwise wedge this conversation forever:
  // every later turn replays an id the CLI no longer knows. Nothing was rendered
  // yet, so starting a fresh session (history folded back in) is invisible.
  if (resume && attempt.sessionMissing && !attempt.producedOutput && !signal.aborted) {
    forgetSession(sessionsKey, scope);
    const retry = await runAttempt(
      lane,
      opts,
      messages,
      promptText,
      system,
      signal,
      onEvent,
      null,
      scope,
    );
    return published(retry);
  }
  return published(attempt);
}

/** Drop the internal retry flag — `sessionMissing` is not part of the result contract. */
function published(attempt: Attempt): RunAgentResult {
  const { sessionMissing: _sessionMissing, ...result } = attempt;
  return result;
}
