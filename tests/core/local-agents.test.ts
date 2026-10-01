import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ToolSpec } from "../../src/resources/agent/types";

// End-to-end over a FAKE desktop: source selection → model catalog → one run,
// with the CLI's raw NDJSON going in and `AgentEvent`s coming out. The wire is
// the real one (agent-bridge.md); only `fetch`, `localStorage` and `WebSocket`
// are stubbed.

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as unknown as Storage;
}
(globalThis as { localStorage?: Storage }).localStorage = makeStorage();

const { UnifiedAI } = await import("../../src/core/client");
const { configureLocalAgents } = await import("../../src/localAgents/config");
const { isLocalAgentModel, laneForModel, listLocalModels, invalidateCursorModels } = await import(
  "../../src/localAgents/catalog"
);
const { _resetLocalAgentState, getLocalAgentStatus, resolveLocalAgentSource } = await import(
  "../../src/localAgents/transport"
);
const { runLocalAgent } = await import("../../src/localAgents/run");
const { listRelayHosts } = await import("../../src/localAgents/relayClient");

const HEALTH = "http://127.0.0.1:47825/health";
const SERVICE_BODY = { service: "unified-agent-bridge", version: 1 };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fake desktop: answers the bridge's routes and lets a test push SSE frames. */
class FakeDesktop {
  calls: Call[] = [];
  claudeCode = { found: true, path: "/usr/local/bin/claude" };
  cursor = { found: false, path: null as string | null };
  cursorRoster = "";
  /** `POST /mcp/result` bodies, in order. */
  mcpResults: Array<{ id: string; result: unknown }> = [];
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ url, method: init?.method ?? "GET", body });

    if (url === HEALTH) return this.json(SERVICE_BODY);
    if (url.endsWith("/detect"))
      return this.json({ claudeCode: this.claudeCode, cursor: this.cursor });
    if (url.includes("/cursor/models"))
      return this.json({ output: this.cursorRoster, code: 0, stderr: "" });
    if (url.endsWith("/mcp/result")) {
      this.mcpResults.push(body as { id: string; result: unknown });
      return this.json({ ok: true });
    }
    if (url.includes("/events")) {
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          this.controller = c;
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.endsWith("/runs")) return this.json({ ok: true });
    if (url.includes("/stop")) return this.json({ ok: true });
    if (url.includes("/relay/hosts")) return this.json([]);
    throw new Error(`connection refused: ${url}`);
  };

  private json(value: unknown): Response {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Push one named SSE event onto the live run stream. */
  emit(event: string, data: unknown): void {
    this.controller?.enqueue(
      this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  }

  /** Push one raw CLI NDJSON line. */
  line(payload: unknown): void {
    this.emit("line", { line: JSON.stringify(payload) });
  }

  finish(stderr = ""): void {
    this.emit("exit", { code: 0, canceled: false, stderr });
    this.controller?.close();
    this.controller = null;
  }
}

let desktop: FakeDesktop;
const realFetch = globalThis.fetch;

/** Let queued microtasks/stream reads land. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  desktop = new FakeDesktop();
  globalThis.fetch = desktop.fetch as typeof fetch;
  localStorage.clear();
  _resetLocalAgentState();
  invalidateCursorModels();
  configureLocalAgents({ client: undefined });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetLocalAgentState();
});

/** Pretend this origin paired earlier, which is what lets auto-select use the bridge. */
function paired(): void {
  localStorage.setItem("unified.agentBridge.token", "tok");
}

describe("isLocalAgentModel", () => {
  test("recognizes both local lanes and nothing else", () => {
    expect(isLocalAgentModel("claude-code/opus")).toBe(true);
    expect(isLocalAgentModel("cursor/auto")).toBe(true);
    expect(isLocalAgentModel("anthropic/claude-opus-5")).toBe(false);
    expect(isLocalAgentModel("auto")).toBe(false);
    expect(isLocalAgentModel(null)).toBe(false);
    expect(isLocalAgentModel(undefined)).toBe(false);
  });

  test("maps a local id to its lane", () => {
    expect(laneForModel("claude-code/sonnet")).toBe("claude-code");
    expect(laneForModel("cursor/composer-2.5")).toBe("cursor");
    expect(laneForModel("openai/gpt-5.5")).toBeNull();
  });
});

describe("source selection", () => {
  test("an origin the desktop does not approve reports not-connected, and never prompts", async () => {
    const source = await resolveLocalAgentSource();
    expect(source).toBeNull();
    const status = getLocalAgentStatus();
    expect(status.connected).toBe(false);
    expect(status.bridgePaired).toBe(false);
    // A load DOES ask the desktop whether this origin is approved — that is how a
    // browser that lost its token gets it back without re-prompting the user. The
    // invariant is not "never call /pair", it is "never raise a modal": every pair
    // a load path makes must be silent, which an unapproved origin gets refused
    // with 403 rather than a consent card.
    for (const call of desktop.calls.filter((c) => c.url.endsWith("/pair"))) {
      expect((call.body as { silent?: boolean } | undefined)?.silent).toBe(true);
    }
  });

  test("a paired origin resolves to the bridge", async () => {
    paired();
    expect(await resolveLocalAgentSource()).toEqual({ kind: "bridge" });
    expect(getLocalAgentStatus().connected).toBe(true);
  });
});

describe("listLocalModels", () => {
  test("is empty with no connected source", async () => {
    expect(await listLocalModels()).toEqual([]);
  });

  test("returns the claude-code/* catalog when only that CLI is installed", async () => {
    paired();
    const models = await listLocalModels();
    expect(models.map((m) => m.id)).toEqual([
      "claude-code/opus",
      "claude-code/sonnet",
      "claude-code/haiku",
      "claude-code/fable",
    ]);
    const opus = models[0];
    // Shaped like a normal catalog row so callers can concat it onto the gateway list.
    expect(opus).toMatchObject({
      id: "claude-code/opus",
      "model-id": "claude-code/opus",
      name: "Claude Opus",
      author: "Claude Code",
      owned_by: "claude-code",
      type: "text",
    });
    expect(opus?.context_size).toBe(200_000);
    expect(opus?.efforts?.some((e) => e.default)).toBe(true);
  });

  test("adds cursor/* entries parsed from the CLI's own roster", async () => {
    paired();
    desktop.cursor = { found: true, path: "/usr/local/bin/cursor-agent" };
    desktop.cursorRoster = JSON.stringify({
      models: [{ id: "auto" }, { id: "cursor-grok-4.6" }, { id: "cursor-grok-4.6-high" }],
    });
    const ids = (await listLocalModels()).map((m) => m.id);
    expect(ids).toContain("cursor/auto");
    expect(ids.some((id) => id.startsWith("cursor/cursor-grok-4.6"))).toBe(true);
    // Ids keep their exact namespace so a conversation stays portable.
    expect(ids.every((id) => id.startsWith("claude-code/") || id.startsWith("cursor/"))).toBe(true);
  });
});

describe("runLocalAgent", () => {
  test("rejects a gateway model — that is a caller bug, not a turn outcome", async () => {
    await expect(runLocalAgent({ model: "openai/gpt-5.5" })).rejects.toThrow(/not a local agent/i);
  });

  test("translates the CLI's NDJSON into the SDK's AgentEvent union", async () => {
    paired();
    const events: Array<Record<string, unknown>> = [];
    const run = runLocalAgent({
      model: "claude-code/opus",
      prompt: "hi",
      onEvent: (e) => events.push(e as unknown as Record<string, unknown>),
    });
    await flush();

    desktop.line({ type: "system", subtype: "init", session_id: "sess-1" });
    desktop.line({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    });
    desktop.line({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm" },
      },
    });
    desktop.line({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "t1", name: "Read", input: { p: 1 } },
        ],
      },
    });
    desktop.line({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    });
    desktop.line({
      type: "result",
      is_error: false,
      result: "Hello",
      session_id: "sess-1",
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    desktop.finish();

    const result = await run;
    expect(result.ok).toBe(true);
    expect(result.producedOutput).toBe(true);
    expect(result.model).toBe("claude-code/opus");
    expect(result.messages.at(-1)).toEqual({ role: "assistant", content: "Hello" });

    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "thinking_delta",
      "text_delta",
      "tool_use",
      "tool_result",
      "usage",
    ]);
    // Deltas first, then only the aggregate's UNSEEN suffix — nothing renders twice.
    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => e.delta)
        .join(""),
    ).toBe("Hello");
    expect(events.find((e) => e.type === "tool_use")).toMatchObject({
      name: "Read",
      input: { p: 1 },
    });
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 4 },
    });

    // The run was started with the CLI alias, not the namespaced picker id.
    const start = desktop.calls.find((c) => c.url.endsWith("/runs"));
    expect(start?.body).toMatchObject({ lane: "claude-code", model: "opus", mcp: false });
  });

  // The app's system prompt is what makes a local model a PROVIDER rather than a
  // window onto someone else's coding agent: without it the CLI answers as
  // Claude Code / Cursor and ignores the calling app's instructions entirely.
  test("Claude Code gets the caller's system blocks as a real system prompt", async () => {
    paired();
    const run = runLocalAgent({
      model: "claude-code/opus",
      messages: [
        { role: "system", content: "You are the Notes assistant." },
        { role: "system", content: "Read a note before editing it." },
        { role: "user", content: "summarize my note" },
      ],
    });
    await flush();

    const start = desktop.calls.find((c) => c.url.endsWith("/runs"));
    expect(start?.body).toMatchObject({
      // Both blocks, in order, joined the way the gateway concatenates them.
      systemPrompt: "You are the Notes assistant.\n\nRead a note before editing it.",
      // The prompt itself stays the user's words.
      prompt: "summarize my note",
    });

    desktop.line({ type: "result", is_error: false, result: "ok" });
    desktop.finish();
    await run;
  });

  // An app's FIRST turn is `system` + `prompt` with no transcript (the design
  // app's brief). The system prompt must reach the CLI, and the returned
  // transcript must carry it so a saved-and-refined thread keeps it too.
  test("system + prompt without messages: sent as the system prompt and kept in the transcript", async () => {
    paired();
    const run = runLocalAgent({
      model: "claude-code/opus",
      system: "You are the Design assistant.",
      prompt: "a pricing page",
    });
    await flush();

    const start = desktop.calls.find((c) => c.url.endsWith("/runs"));
    expect(start?.body).toMatchObject({
      systemPrompt: "You are the Design assistant.",
      prompt: "a pricing page",
    });

    desktop.line({ type: "result", is_error: false, result: "done" });
    desktop.finish();
    const result = await run;
    expect(result.messages).toEqual([
      { role: "system", content: "You are the Design assistant." },
      { role: "user", content: "a pricing page" },
      { role: "assistant", content: "done" },
    ]);
  });

  test("Cursor, which has no such flag, carries them at the head of the prompt", async () => {
    paired();
    desktop.cursor = { found: true, path: "/usr/local/bin/cursor-agent" };
    const run = runLocalAgent({
      model: "cursor/auto",
      messages: [
        { role: "system", content: "You are the Notes assistant." },
        { role: "user", content: "summarize my note" },
      ],
    });
    await flush();

    const start = desktop.calls.find((c) => c.url.endsWith("/runs"));
    const body = start?.body as { prompt: string; systemPrompt?: unknown };
    expect(body.prompt).toBe(
      "<system-instructions>\nYou are the Notes assistant.\n</system-instructions>\n\nsummarize my note",
    );
    // Sending it BOTH ways would bill the same text twice.
    expect(body.systemPrompt).toBeUndefined();

    desktop.line({ type: "result", is_error: false, result: "ok" });
    desktop.finish();
    await run;
  });

  test("a failing turn comes back as ok:false rather than throwing", async () => {
    paired();
    const run = runLocalAgent({ model: "claude-code/opus", prompt: "hi" });
    await flush();
    desktop.line({ type: "result", is_error: true, result: "invalid api key" });
    desktop.finish();
    const result = await run;
    expect(result.ok).toBe(false);
    // The lane explains an unauthenticated CLI rather than passing the raw text through.
    expect(result.error).toMatch(/isn't signed in/i);
  });

  test("the caller's tools answer the CLI's MCP round-trips, and a retried call runs once", async () => {
    paired();
    let executions = 0;
    // A tool that parks until the test releases it, so both round-trips for the
    // same call are in flight at once — which is the case the dedup exists for.
    const releases: Array<() => void> = [];
    const gate = new Promise<void>((r) => releases.push(r));
    const tools: ToolSpec[] = [
      {
        definition: {
          type: "function",
          function: { name: "add_note", description: "adds", parameters: { type: "object" } },
        },
        async execute(input) {
          executions++;
          await gate;
          return { content: `noted ${String(input.text)}` };
        },
      },
    ];

    const run = runLocalAgent({ model: "claude-code/opus", prompt: "hi", tools });
    await flush();
    expect(desktop.calls.find((c) => c.url.endsWith("/runs"))?.body).toMatchObject({ mcp: true });

    desktop.emit("mcp-list", { id: "l1" });
    await flush();
    expect(desktop.mcpResults).toEqual([
      {
        id: "l1",
        result: {
          tools: [{ name: "add_note", description: "adds", inputSchema: { type: "object" } }],
        },
      },
    ]);

    // A CLI whose MCP client timed out re-issues the IDENTICAL call. Key order
    // differs, which is why the dedup key is a stable stringify.
    desktop.emit("mcp-call", { id: "c1", name: "add_note", arguments: { text: "a", n: 1 } });
    desktop.emit("mcp-call", { id: "c2", name: "add_note", arguments: { n: 1, text: "a" } });
    await flush();
    expect(executions).toBe(1);
    expect(desktop.mcpResults).toHaveLength(1); // still parked on the gate

    releases[0]?.();
    await flush();
    // Both request ids get the same answer — one execution, two results.
    expect(executions).toBe(1);
    expect(desktop.mcpResults.slice(1)).toEqual([
      { id: "c1", result: { content: [{ type: "text", text: "noted a" }], isError: false } },
      { id: "c2", result: { content: [{ type: "text", text: "noted a" }], isError: false } },
    ]);

    // A DIFFERENT call is not deduped against it.
    desktop.emit("mcp-call", { id: "c3", name: "add_note", arguments: { text: "b" } });
    await flush();
    expect(executions).toBe(2);

    desktop.line({ type: "result", is_error: false, result: "done" });
    desktop.finish();
    await run;
  });

  test("an unknown tool is answered as an error rather than left hanging", async () => {
    paired();
    const run = runLocalAgent({
      model: "claude-code/opus",
      prompt: "hi",
      tools: [
        {
          definition: {
            type: "function",
            function: { name: "known", parameters: { type: "object" } },
          },
          execute: () => ({ content: "" }),
        },
      ],
    });
    await flush();
    desktop.emit("mcp-call", { id: "x", name: "nope", arguments: {} });
    await flush();
    expect(desktop.mcpResults[0]).toMatchObject({ id: "x", result: { isError: true } });
    desktop.line({ type: "result", is_error: false, result: "" });
    desktop.finish();
    await run;
  });

  test("session continuity replays the CLI's own session id on the next turn", async () => {
    paired();
    const first = runLocalAgent({
      model: "claude-code/opus",
      prompt: "one",
      conversationId: "conv-1",
    });
    await flush();
    desktop.line({ type: "result", is_error: false, result: "a", session_id: "sess-42" });
    desktop.finish();
    await first;

    _resetLocalAgentState();
    paired();
    const second = runLocalAgent({
      model: "claude-code/opus",
      prompt: "two",
      conversationId: "conv-1",
    });
    await flush();
    const starts = desktop.calls.filter((c) => c.url.endsWith("/runs"));
    expect((starts[0]?.body as { resume: unknown }).resume).toBeNull();
    expect((starts[1]?.body as { resume: unknown }).resume).toBe("sess-42");
    // With a session, only the newest turn is sent — no folded history.
    expect((starts[1]?.body as { prompt: string }).prompt).toBe("two");
    desktop.line({ type: "result", is_error: false, result: "b" });
    desktop.finish();
    await second;
  });

  test("no conversationId means a throwaway session that is never persisted", async () => {
    paired();
    const run = runLocalAgent({ model: "claude-code/opus", prompt: "hi" });
    await flush();
    desktop.line({ type: "result", is_error: false, result: "a", session_id: "sess-eph" });
    desktop.finish();
    await run;
    expect(localStorage.getItem("unified.claudeCodeSessions")).toBeNull();
  });
});

describe("relay listing", () => {
  test("authenticates with the configured client's own credential and base URL", async () => {
    const client = new UnifiedAI({ apiUrl: "http://api.test", token: "uapi_dev" });
    configureLocalAgents({ client });
    await listRelayHosts();
    const call = desktop.calls.find((c) => c.url.includes("/relay/hosts"));
    expect(call?.url).toBe("http://api.test/api/v1/relay/hosts");
  });

  test("the WebSocket goes straight to unified-api under the /api/v1 relay prefix", async () => {
    const { relayWsUrl } = await import("../../src/localAgents/relayClient");
    // `Core.apiUrl` is an origin — the version prefix lives in the paths — so
    // the relay base has to add it back, or the upgrade 404s.
    configureLocalAgents({ client: new UnifiedAI({ apiUrl: "https://api.test", token: "t" }) });
    expect(relayWsUrl("/connect/dev-1")).toBe("wss://api.test/api/v1/relay/connect/dev-1");
    // An explicitly configured base that already carries a version is left alone.
    configureLocalAgents({ wsBaseUrl: "http://localhost:3141/api/v1" });
    expect(relayWsUrl("/host")).toBe("ws://localhost:3141/api/v1/relay/host");
  });

  test("no client configured means no hosts, and no request", async () => {
    configureLocalAgents({ client: undefined });
    expect(await listRelayHosts()).toEqual([]);
    expect(desktop.calls.filter((c) => c.url.includes("/relay"))).toHaveLength(0);
  });
});
