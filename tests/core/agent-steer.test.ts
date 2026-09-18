import { describe, expect, test } from "bun:test";
import { type ToolSpec, UnifiedAI } from "../../src/index";

// RunAgentOptions.steer: polled at the top of every step, so a host can drop a
// user message into a RUNNING turn without aborting it. The message lands after
// the tool results of the step before it and before the next request goes out.

type Turn = { text: string } | { toolCalls: Array<{ id: string; name: string; args: string }> };

function sseBody(turn: Turn): string {
  const frames: string[] = [];
  const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "test-model" };
  if ("text" in turn) {
    frames.push(
      JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: turn.text } }] }),
    );
    frames.push(
      JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    );
  } else {
    turn.toolCalls.forEach((tc, index) => {
      frames.push(
        JSON.stringify({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index, id: tc.id, function: { name: tc.name, arguments: tc.args } }],
              },
            },
          ],
        }),
      );
    });
    frames.push(
      JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    );
  }
  return `${frames.map((f) => `data: ${f}\n\n`).join("")}data: [DONE]\n\n`;
}

function scriptedGateway(turns: Turn[]) {
  const requests: Array<Array<{ role: string; content?: unknown }>> = [];
  let call = 0;
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string }> };
    requests.push(body.messages ?? []);
    const turn = turns[call++];
    if (!turn) throw new Error("gateway over-called");
    return new Response(sseBody(turn), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

const echo: ToolSpec = {
  definition: {
    type: "function",
    function: { name: "echo", description: "echo", parameters: { type: "object" } },
  },
  execute: async () => ({ content: "echoed" }),
};

describe("agent loop: steer", () => {
  test("a steered message rides on the next step, after the tool result", async () => {
    const pending: string[] = [];
    const { fetch: gw, requests } = scriptedGateway([
      { toolCalls: [{ id: "t1", name: "echo", args: "{}" }] },
      { text: "Done." },
    ]);
    const tools: ToolSpec[] = [
      {
        ...echo,
        // Guidance typed while the tool runs.
        execute: async () => {
          pending.push("actually, skip the tests");
          return { content: "echoed" };
        },
      },
    ];

    const result = await new UnifiedAI({
      apiUrl: "https://gateway.test",
      fetch: gw,
      token: "t",
    }).agent.run({
      prompt: "run it",
      tools,
      steer: () =>
        pending.length
          ? pending.splice(0).map((content) => ({ role: "user", content }))
          : undefined,
    });

    expect(result.ok).toBe(true);
    expect(requests[0]?.map((m) => m.role)).toEqual(["user"]);
    expect(requests[1]?.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(requests[1]?.at(-1)?.content).toBe("actually, skip the tests");
    // …and it is part of the returned transcript, in place.
    expect(result.messages.at(-2)?.content).toBe("actually, skip the tests");
    expect(pending).toEqual([]);
  });
});
