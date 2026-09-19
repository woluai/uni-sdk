import { describe, expect, test } from "bun:test";
import { UnifiedAI } from "../../src/core/client";
import { confident } from "../../src/resources/decisions";

describe("decisions.decide", () => {
  test("posts to /api/v1/decisions with the {state, questions} body, omitting model", async () => {
    let received: { url: string; body: unknown } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      received = { url, body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({
          model: "jev-latest",
          answers: { q1: { type: "score", score: 3, confidence: 0.9 } },
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({ apiUrl: "https://example.test", token: "t", fetch: fetchImpl });
    const questions = {
      q1: { type: "score" as const, instructions: "rate it", criteria: ["a", "b"] },
    };
    await sdk.decisions.decide("some state", questions);

    expect(received?.url).toBe("https://example.test/api/v1/decisions");
    expect(received?.body).toEqual({ state: "some state", questions });
  });

  test("includes model when passed", async () => {
    let received: { body: unknown } | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      received = { body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({
          model: "custom",
          answers: {},
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({ apiUrl: "https://example.test", token: "t", fetch: fetchImpl });
    await sdk.decisions.decide(
      "state",
      { q: { type: "noul", instructions: "x" } },
      { model: "custom" },
    );

    expect((received?.body as { model?: string }).model).toBe("custom");
  });

  test("derives noul confidence as |noul - 0.5| * 2 when Jev omits it", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          model: "jev-latest",
          answers: { q: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const sdk = new UnifiedAI({ apiUrl: "https://example.test", token: "t", fetch: fetchImpl });
    const res = await sdk.decisions.decide("state", { q: { type: "noul", instructions: "x" } });

    expect(res.answers.q?.confidence).toBeCloseTo(0.8);
  });
});

describe("confident", () => {
  test("true exactly at the threshold boundary", () => {
    expect(confident({ type: "score", confidence: 0.8 }, 0.8)).toBe(true);
  });

  test("false below the threshold", () => {
    expect(confident({ type: "score", confidence: 0.79 }, 0.8)).toBe(false);
  });

  test("false when the answer is undefined", () => {
    expect(confident(undefined)).toBe(false);
  });
});
