// `sdk.agent` — the unopinionated tool-loop scaffolding.
//
// A daemon-less generalization of OpenDesign's in-process `unified-agent.ts`:
// the loop mechanics (consume the OpenAI-compatible chat stream, accumulate
// streamed tool-calls, thread messages, honor abort + a step cap, surface usage)
// are ported verbatim, but the hardcoded SYSTEM_PROMPT and file TOOLS are gone —
// the app supplies its own prompt and composes its own `ToolSpec[]` (optionally
// `fsTools()`). The loop dispatches each model tool-call to the matching
// ToolSpec the app provided, so the APP orchestrates which tools exist and what
// they do. See docs/capability-platform.md.
import type { Core } from "../../core/core";
import { RateLimitError, UnifiedError } from "../../core/errors";
import {
  type ChatCompletionChunk,
  type ChatCompletionMessage,
  type ChatCompletionStream,
  ChatCompletions,
} from "../chat";
import type { AgentEvent, AgentUsage, RunAgentOptions, RunAgentResult, ToolSpec } from "./types";

/**
 * Lift the structured detail out of a thrown SDK error so a failed run can carry
 * the KIND of failure (not just a message) — letting callers branch on
 * `errorCode`/`errorStatus` to render a specific message. Returns only the keys
 * that apply (no `undefined` values, to satisfy `exactOptionalPropertyTypes`).
 */
function errorDetail(
  err: unknown,
): Pick<RunAgentResult, "errorCode" | "errorStatus" | "errorRetryAfter"> {
  const out: Pick<RunAgentResult, "errorCode" | "errorStatus" | "errorRetryAfter"> = {};
  if (err instanceof UnifiedError) {
    out.errorCode = err.code;
    if (err.status !== undefined) out.errorStatus = err.status;
  }
  if (err instanceof RateLimitError && err.retryAfter !== undefined) {
    out.errorRetryAfter = err.retryAfter;
  }
  return out;
}

/** Parse model tool-call JSON, recovering from trailing commas, truncated objects, and double-encoded strings. */
function parseToolArguments(raw?: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  let value: unknown = unwrapToolArgText(raw);
  for (let i = 0; i < 3 && typeof value === "string"; i++) {
    const next = parseJsonLenient(value);
    if (next === undefined) break;
    value = next;
  }
  if (Array.isArray(value)) return value as unknown as Record<string, unknown>;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    // `{}` + the real payload concatenated (`{}{"cards":[...]}`) parses as the
    // leading empty object. Prefer the richest complete object in the raw text.
    if (Object.keys(rec).length === 0) {
      return richestJsonObject(unwrapToolArgText(raw)) ?? rec;
    }
    return rec;
  }
  return richestJsonObject(unwrapToolArgText(raw)) ?? {};
}

function unwrapToolArgText(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) text = fenced[1].trim();
  return text;
}

function parseJsonLenient(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    /* try repairs */
  }
  const noTrailing = raw.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(noTrailing);
  } catch {
    /* try a complete prefix */
  }
  for (let i = noTrailing.length - 1; i > 8; i--) {
    const ch = noTrailing[i];
    if (ch !== "}" && ch !== "]") continue;
    try {
      return JSON.parse(noTrailing.slice(0, i + 1));
    } catch {
      /* keep walking back */
    }
  }
  return undefined;
}

function richestJsonObject(text: string): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined;
  let bestLen = 0;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice) as unknown;
          if (
            parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            slice.length > bestLen
          ) {
            best = parsed as Record<string, unknown>;
            bestLen = slice.length;
          }
        } catch {
          /* skip incomplete object */
        }
        start = -1;
      }
    }
  }
  return best;
}

/**
 * Merge a streamed tool-argument delta into the accumulator.
 *
 * Providers mix shapes: empty object `{}` on the first delta, then a JSON
 * string; or incremental strings; or a complete object on the finalized
 * `tool-call` event after `tool-input-start` already opened the call with "".
 * Appending `{}` + `{"cards":[...]}` produces unparseable JSON that collapses
 * back to `{}`. Replace empty/incomplete current text with a richer complete
 * payload; otherwise concatenate string chunks.
 */
function mergeToolCallArguments(current: string, incoming: unknown): string {
  if (incoming == null) return current;

  if (typeof incoming === "object") {
    const json = JSON.stringify(incoming);
    if (json === "{}" || json === "[]") return current || json;
    if (
      !current ||
      current === "{}" ||
      parseJsonLenient(current) === undefined ||
      json.length >= current.length
    ) {
      return json;
    }
    return current;
  }

  if (typeof incoming !== "string" || incoming === "") return current;
  if (!current) return incoming;
  if (current === "{}") {
    const trimmed = incoming.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return incoming;
    return current + incoming;
  }
  const incomingParsed = parseJsonLenient(incoming);
  const currentParsed = parseJsonLenient(current);
  if (incomingParsed !== undefined) {
    if (currentParsed === undefined || incoming.length >= current.length) return incoming;
    return current;
  }
  // Current is already valid JSON — appending a fragment would produce `}{...}`
  // and 500 the follow-up turn. Ignore the extra chunk.
  if (currentParsed !== undefined) return current;
  return current + incoming;
}

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
  /** Provider signature (e.g. Gemini/Vertex `thoughtSignature`) that must be
   *  echoed back on the next request — see ChatCompletionToolCall. */
  thoughtSignature?: string;
}

interface StreamTurnResult {
  assistantText: string;
  toolCalls: Array<{ id: string; name: string; arguments: string; thoughtSignature?: string }>;
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  /**
   * The concrete model the gateway actually served this turn, captured from the
   * chunk-level `model` field. For an `auto` request this is the router's pick,
   * not `"auto"`; `null` if no chunk carried a concrete (non-`auto`) model.
   */
  model: string | null;
}

// Consume one chat stream, emitting text/thinking deltas and accumulating any
// streamed tool-calls. The SDK surfaces stream-level `{error}` frames as a
// thrown error, so this only handles well-formed chunks; the caller catches.
async function consumeChatStream(
  stream: ChatCompletionStream,
  emit: (event: AgentEvent) => void,
  onText: () => void,
): Promise<StreamTurnResult> {
  let assistantText = "";
  let finishReason: string | null = null;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  let model: string | null = null;
  const toolAcc = new Map<number, ToolCallAccumulator>();

  for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
    // The gateway stamps the SERVED model on every chunk. For an `auto` request
    // that's the router's concrete pick — capture it the first time it appears
    // and emit a live event so the UI can flip a "Auto" badge mid-stream.
    if (!model && chunk.model && chunk.model !== "auto") {
      model = chunk.model;
      emit({ type: "model", model });
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      if (typeof delta.content === "string" && delta.content) {
        assistantText += delta.content;
        onText();
        emit({ type: "text_delta", delta: delta.content });
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        emit({ type: "thinking_delta", delta: delta.reasoning_content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          const acc = toolAcc.get(index) ?? { arguments: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          const fnArgs = tc.function?.arguments as unknown;
          if (fnArgs !== undefined) acc.arguments = mergeToolCallArguments(acc.arguments, fnArgs);
          // The gateway emits the provider signature on its own delta (keyed to
          // the same index) after the argument deltas — capture it so we can echo
          // it back verbatim next turn, or Gemini rejects the follow-up tool call.
          if (typeof tc.thought_signature === "string") acc.thoughtSignature = tc.thought_signature;
          toolAcc.set(index, acc);
        }
        // Heartbeat for the tool currently streaming (the last one with a name) so
        // a big write_file shows live byte progress rather than going silent.
        // `args` carries the raw arguments-JSON accrued so far (possibly truncated
        // mid-value) so a host can render a streaming preview of, e.g., the file a
        // `write_file` is emitting — see RunAgentOptions.onEvent consumers.
        let name = "";
        let chars = 0;
        let args = "";
        for (const acc of toolAcc.values())
          if (acc.name) {
            name = acc.name;
            chars = acc.arguments.length;
            args = acc.arguments;
          }
        if (name) emit({ type: "tool_partial", name, chars, args });
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }

  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]) => ({
      id: acc.id || `call_${index}`,
      name: acc.name || "",
      arguments: acc.arguments,
      ...(acc.thoughtSignature ? { thoughtSignature: acc.thoughtSignature } : {}),
    }))
    .filter((tc) => tc.name);

  return { assistantText, toolCalls, finishReason, usage, model };
}

/**
 * Tool-loop scaffolding. `sdk.agent.run(...)` runs the model with the app's
 * prompt + tools, dispatching tool-calls to the app's executors until the model
 * stops or `maxSteps` is hit. No prompt or tool policy is baked in.
 */
export class Agent {
  private readonly completions: ChatCompletions;

  constructor(client: Core) {
    this.completions = new ChatCompletions(client);
  }

  async run(options: RunAgentOptions): Promise<RunAgentResult> {
    const model = options.model?.trim() ? options.model : "auto";
    const maxSteps = options.maxSteps ?? 40;
    const signal = options.signal ?? new AbortController().signal;
    const emit = options.onEvent ?? (() => {});
    const tools = options.tools ?? [];

    // Build the starting transcript: an explicit `messages` array wins; else
    // assemble [system?, user]. The app owns the prompt — the SDK adds nothing.
    const messages: ChatCompletionMessage[] = options.messages
      ? [...options.messages]
      : [
          ...(options.system
            ? [{ role: "system", content: options.system } as ChatCompletionMessage]
            : []),
          { role: "user", content: options.prompt ?? "" } as ChatCompletionMessage,
        ];

    let producedOutput = false;
    // The concrete model the gateway served — last-turn-wins, so it reflects the
    // model that produced the final user-visible output. Threaded onto every
    // return path that follows at least one streamed turn; the guarded spread
    // contributes nothing on the abort-before-first-turn paths where it's unset.
    let resolvedModel: string | undefined;
    // The `finish_reason` of the most recent streamed turn — surfaced on the
    // result so a host can distinguish a clean stop from an output-token-limit
    // truncation (`"length"`) and auto-recover (e.g. retry with a larger budget).
    let lastFinishReason: string | null = null;
    // Usage totals across turns; `lastTurnInputTokens` tracks the final
    // request's prompt size (= real context occupancy). Stays undefined when
    // the gateway never emits usage, so the result omits the field entirely.
    let usageTotal: RunAgentResult["usage"];

    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted)
        return {
          ok: false,
          canceled: true,
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(usageTotal ? { usage: usageTotal } : {}),
          producedOutput,
          messages,
        };

      // Host guidance that arrived since the last step rides in front of this
      // request, after the tool results the model is waiting on.
      const steered = options.steer?.();
      if (steered?.length) messages.push(...steered);

      // Rebuilt every step (not hoisted) so the `tools` array is LIVE: a tool's
      // `execute` may append new ToolSpecs mid-run (deferred tool loading), and
      // both the next request's advertised definitions (below) and this map must
      // see them — a stale map would advertise a tool it then can't dispatch.
      const toolMap = new Map<string, ToolSpec>(tools.map((t) => [t.definition.function.name, t]));

      let turn: StreamTurnResult;
      try {
        const stream = this.completions.create(
          {
            model,
            messages,
            ...(tools.length > 0
              ? { tools: tools.map((t) => t.definition), tool_choice: "auto" as const }
              : {}),
            ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal },
        );
        turn = await consumeChatStream(stream, emit, () => {
          producedOutput = true;
        });
      } catch (err) {
        if (signal.aborted)
          return {
            ok: false,
            canceled: true,
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(usageTotal ? { usage: usageTotal } : {}),
            producedOutput,
            messages,
          };
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ...errorDetail(err),
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(usageTotal ? { usage: usageTotal } : {}),
          producedOutput,
          messages,
        };
      }

      // Last-turn-wins: the served model that produced the final output.
      if (turn.model) resolvedModel = turn.model;
      lastFinishReason = turn.finishReason;

      if (turn.usage) {
        // Build conditionally — `exactOptionalPropertyTypes` forbids assigning
        // an explicit `undefined` to these optional fields.
        const usage: AgentUsage = {};
        if (turn.usage.prompt_tokens !== undefined) usage.inputTokens = turn.usage.prompt_tokens;
        if (turn.usage.completion_tokens !== undefined) {
          usage.outputTokens = turn.usage.completion_tokens;
        }
        emit({ type: "usage", usage });
        usageTotal ??= { inputTokens: 0, outputTokens: 0 };
        usageTotal.inputTokens += turn.usage.prompt_tokens ?? 0;
        usageTotal.outputTokens += turn.usage.completion_tokens ?? 0;
        if (turn.usage.prompt_tokens !== undefined) {
          usageTotal.lastTurnInputTokens = turn.usage.prompt_tokens;
        }
      }

      const assistantMessage: ChatCompletionMessage = {
        role: "assistant",
        content: turn.assistantText || null,
        ...(turn.toolCalls.length > 0
          ? {
              tool_calls: turn.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                // A no-arg tool (e.g. `list_files`) streams its arguments as an
                // empty string. Send `"{}"` instead so the gateway can
                // `JSON.parse` it on the follow-up turn — `""` is invalid JSON
                // and 500s the next request, aborting the loop.
                // Canonical JSON so the follow-up turn never 500s on
                // concatenated/truncated streamed arguments.
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(parseToolArguments(tc.arguments)),
                },
                // Echo the provider signature back so the gateway can re-attach it
                // to the tool call for Gemini/Vertex on the next request.
                ...(tc.thoughtSignature ? { thought_signature: tc.thoughtSignature } : {}),
              })),
            }
          : {}),
      };
      messages.push(assistantMessage);

      // No tool calls → the model is done.
      if (turn.toolCalls.length === 0 || turn.finishReason !== "tool_calls") {
        // …unless it was CUT OFF at the output-token limit without producing
        // anything usable. Reasoning models can burn the whole budget on hidden
        // `reasoning_content` and end with `finish_reason: "length"` before any
        // visible text or tool call — which otherwise looks like a clean-but-empty
        // turn. Flag it so the caller can tell the user (vs. a silent no-op).
        if (turn.finishReason === "length" && !turn.assistantText.trim()) {
          return {
            ok: false,
            error:
              "The model's reply was cut off at the output-token limit before it produced any result — it likely spent the budget on internal reasoning. Retry, or switch to a different (non-reasoning) model.",
            errorCode: "response_truncated",
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(usageTotal ? { usage: usageTotal } : {}),
            producedOutput,
            messages,
          };
        }
        return {
          ok: true,
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(usageTotal ? { usage: usageTotal } : {}),
          ...(lastFinishReason ? { finishReason: lastFinishReason } : {}),
          producedOutput,
          messages,
        };
      }

      // Dispatch each requested tool to the app-supplied executor, feeding
      // results back for the next turn.
      for (const tc of turn.toolCalls) {
        if (signal.aborted)
          return {
            ok: false,
            canceled: true,
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(usageTotal ? { usage: usageTotal } : {}),
            producedOutput,
            messages,
          };
        const input: Record<string, unknown> = parseToolArguments(tc.arguments);
        producedOutput = true;
        emit({ type: "tool_use", id: tc.id, name: tc.name, input, raw: tc.arguments });
        const spec = toolMap.get(tc.name);
        let result: { content: string; isError: boolean };
        if (!spec) {
          result = { content: `Unknown tool: ${tc.name}`, isError: true };
        } else {
          try {
            const r = await spec.execute(input, signal);
            result = { content: r.content, isError: r.isError === true };
          } catch (err) {
            result = { content: err instanceof Error ? err.message : String(err), isError: true };
          }
        }
        emit({
          type: "tool_result",
          toolUseId: tc.id,
          content: result.content,
          isError: result.isError,
        });
        messages.push({ role: "tool", tool_call_id: tc.id, content: result.content });
      }
    }

    // Hit the step cap — successful-but-truncated if anything was produced.
    if (producedOutput)
      return {
        ok: true,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(lastFinishReason ? { finishReason: lastFinishReason } : {}),
        ...(usageTotal ? { usage: usageTotal } : {}),
        producedOutput,
        messages,
      };
    return {
      ok: false,
      error: "Reached the tool-call limit without output.",
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(usageTotal ? { usage: usageTotal } : {}),
      producedOutput,
      messages,
    };
  }
}
