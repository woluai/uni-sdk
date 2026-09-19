import { describe, expect, test } from "bun:test";
import { type Model, firstByHint, roleFor } from "../../src/index";

// The built-in hints behind Auto's fallback: what kind of work a request looks
// like comes from what the user has already told us — the words, the effort
// they picked, whether a workspace is attached — never from guessing that a
// cheap model "seems to be struggling".

describe("roleFor", () => {
  test("a short question is fast work", () => {
    expect(roleFor({ text: "which column holds cash flows?" })).toBe("fast");
  });

  test("asking for a plan, a diagnosis or trade-offs is deep work", () => {
    for (const text of [
      "plan the migration off MySQL",
      "why does the upload time out under load?",
      "what are the trade-offs between the two queues",
    ]) {
      expect(roleFor({ text })).toBe("deep");
    }
  });

  test("a very long message is deep work even without the words", () => {
    expect(roleFor({ text: "a".repeat(1500) })).toBe("deep");
  });

  test("editing real files is deep work", () => {
    expect(roleFor({ text: "rename this", codeWork: true })).toBe("deep");
  });

  test("the effort the user picked outranks the words", () => {
    // They asked for a plan but set effort low: that is their call, not ours.
    expect(roleFor({ text: "plan the migration", effort: "low" })).toBe("fast");
    expect(roleFor({ text: "hi", effort: "high" })).toBe("deep");
  });

  test("visual work is its own role, but not when it is code work", () => {
    expect(roleFor({ text: "design a landing page" })).toBe("design");
    expect(roleFor({ text: "design a landing page", codeWork: true })).toBe("deep");
  });

  test("needing to read an image outranks everything", () => {
    expect(roleFor({ text: "plan this", needsVision: true, effort: "high" })).toBe("vision");
  });
});

describe("firstByHint", () => {
  const model = (id: string, name = id): Model => ({
    id,
    name,
    type: "text",
    object: "model",
    owned_by: "someone",
    logo: null,
    model_author: { name: "someone" },
  });
  const catalog = [
    model("anthropic-c5", "Claude Opus 5"),
    model("deepseek-v4-flash", "DeepSeek V4 Flash"),
  ];

  test("hint order wins over catalogue order", () => {
    expect(firstByHint(catalog, ["flash", "opus"])?.id).toBe("deepseek-v4-flash");
  });

  test("matches on the display name as well as the id", () => {
    expect(firstByHint(catalog, ["opus"])?.id).toBe("anthropic-c5");
  });

  test("nothing matching is undefined", () => {
    expect(firstByHint(catalog, ["haiku"])).toBeUndefined();
  });
});
