import { describe, expect, test } from "bun:test";
import {
  type AutoConfig,
  type Model,
  type PlanStep,
  costsMore,
  defaultConfig,
  dispatchPrompt,
  fallbackDispatch,
  gate,
  parseDispatch,
  parsePlan,
  parseTestReport,
  pickWorker,
  planPrompt,
  profileById,
  sequenceById,
  stepPrompt,
  testPrompt,
} from "../../src/index";

// The dispatcher never talks to a model itself — it builds prompts and reads
// replies. These tests cover both directions: the defaults built from a
// catalogue, and the prompt/parse round trip a host drives by hand.

function model(id: string, over: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    type: "text",
    object: "model",
    owned_by: "someone",
    logo: null,
    model_author: { name: "someone" },
    ...over,
  };
}

// The local CLI lanes: a realistic mixed catalogue with one model per hint.
const lanes = [
  model("cursor/composer-2.5", { name: "Composer 2.5" }),
  model("cursor/grok-4.6", { name: "Cursor Grok 4.6" }),
  model("cursor/kimi-k3", { name: "Kimi K3" }),
  model("claude-code/haiku", { name: "Claude Haiku" }),
  model("claude-code/fable", { name: "Claude Fable" }),
  model("claude-code/opus", { name: "Claude Opus" }),
];

describe("defaultConfig", () => {
  const config = defaultConfig(lanes);

  test("picks the expected model per profile by hint", () => {
    expect(profileById(config, "everyday")?.modelId).toBe("claude-code/haiku");
    expect(profileById(config, "planner")?.modelId).toBe("claude-code/fable");
    expect(profileById(config, "executor")?.modelId).toBe("cursor/grok-4.6");
    expect(profileById(config, "fast-worker")?.modelId).toBe("cursor/composer-2.5");
    expect(profileById(config, "tester")?.modelId).toBe("claude-code/opus");
    expect(profileById(config, "design")?.modelId).toBe("cursor/kimi-k3");
  });

  test("vision is null when nothing in the catalogue reads images", () => {
    expect(profileById(config, "vision")?.modelId).toBeNull();
  });

  test("a profile with no usable model is left out of the dispatch prompt", () => {
    expect(dispatchPrompt(config, "hello")).not.toContain("vision —");
  });

  test("sequences reference real profile ids", () => {
    const build = sequenceById(config, "build")!;
    expect(build.stages.map((s) => s.kind)).toEqual(["plan", "work", "test"]);
    expect(build.stages[1]!.profileIds).toEqual(["executor", "fast-worker"]);
    const small = sequenceById(config, "small-change")!;
    expect(small.stages.map((s) => s.kind)).toEqual(["work", "test"]);
  });

  test("dispatcher model is the everyday model, stepUp defaults to stay", () => {
    expect(config.dispatcherModelId).toBe("claude-code/haiku");
    expect(config.everydayId).toBe("everyday");
    expect(config.stepUp).toBe("stay");
    expect(config.hintsFallback).toBe(true);
  });
});

describe("dispatchPrompt / parseDispatch", () => {
  const config = defaultConfig(lanes);

  test("lists profiles and sequences and asks for JSON", () => {
    const prompt = dispatchPrompt(config, "rename this variable everywhere");
    expect(prompt).toContain("rename this variable everywhere");
    expect(prompt).toContain("everyday — Everyday");
    expect(prompt).toContain("build — Build");
    expect(prompt).toContain('{"pick":"<id>","why":"<one short line>"}');
  });

  test("accepts a fenced reply and a known profile id", () => {
    const dispatch = parseDispatch(
      '```json\n{"pick":"fast-worker","why":"one-line fix"}\n```',
      config,
    );
    expect(dispatch).toEqual({ kind: "profile", id: "fast-worker", why: "one-line fix" });
  });

  test("accepts a known sequence id", () => {
    const dispatch = parseDispatch('{"pick":"build","why":"needs a plan"}', config);
    expect(dispatch).toEqual({ kind: "sequence", id: "build", why: "needs a plan" });
  });

  test("rejects an id that is not in the config", () => {
    expect(parseDispatch('{"pick":"nonexistent"}', config)).toBeNull();
  });

  test("rejects unparseable text", () => {
    expect(parseDispatch("not json at all", config)).toBeNull();
  });
});

describe("fallbackDispatch", () => {
  const config = defaultConfig(lanes);

  test("deep work falls to the build sequence", () => {
    const pick = fallbackDispatch(config, { text: "plan the migration off MySQL" });
    expect(pick).toEqual({ kind: "sequence", id: "build", why: "built-in hint" });
  });

  test("a short question falls to everyday", () => {
    const pick = fallbackDispatch(config, { text: "what time is it?" });
    expect(pick).toEqual({ kind: "profile", id: "everyday", why: "built-in hint" });
  });

  test("vision without a vision model falls back to everyday", () => {
    const pick = fallbackDispatch(config, { text: "what is in this image?", needsVision: true });
    expect(pick.id).toBe("everyday");
  });
});

describe("costsMore / gate", () => {
  const config = defaultConfig(lanes);

  test("a cheap profile never costs more", () => {
    expect(costsMore({ kind: "profile", id: "everyday", why: "" }, config)).toBe(false);
  });

  test("a profile marked costsMore does", () => {
    expect(costsMore({ kind: "profile", id: "planner", why: "" }, config)).toBe(true);
  });

  test("a sequence costs more if any stage profile does", () => {
    expect(costsMore({ kind: "sequence", id: "build", why: "" }, config)).toBe(true);
    expect(costsMore({ kind: "sequence", id: "small-change", why: "" }, config)).toBe(true);
  });

  test("an unknown id never costs more", () => {
    expect(costsMore({ kind: "profile", id: "nope", why: "" }, config)).toBe(false);
  });

  test("stay holds a costlier pick and reports it as declined", () => {
    const pick = { kind: "profile" as const, id: "planner", why: "" };
    expect(gate(pick, { ...config, stepUp: "stay" })).toEqual({ action: "hold", declined: pick });
  });

  test("ask asks", () => {
    const pick = { kind: "profile" as const, id: "planner", why: "" };
    expect(gate(pick, { ...config, stepUp: "ask" })).toEqual({ action: "ask" });
  });

  test("auto runs without asking", () => {
    const pick = { kind: "profile" as const, id: "planner", why: "" };
    expect(gate(pick, { ...config, stepUp: "auto" })).toEqual({ action: "run" });
  });

  test("a session that already said yes runs even under stay", () => {
    const pick = { kind: "profile" as const, id: "planner", why: "" };
    expect(gate(pick, { ...config, stepUp: "stay" }, { sessionAllowed: true })).toEqual({
      action: "run",
    });
  });

  test("a cheap pick always runs, regardless of policy", () => {
    const pick = { kind: "profile" as const, id: "everyday", why: "" };
    expect(gate(pick, { ...config, stepUp: "stay" })).toEqual({ action: "run" });
  });
});

describe("pickWorker", () => {
  const config = defaultConfig(lanes);
  const workStage = sequenceById(config, "build")!.stages[1]!;

  test("a mechanical step goes to the fast-worker fallback", () => {
    const step: PlanStep = { title: "rename", criterion: "renamed everywhere", mechanical: true };
    expect(pickWorker(step, workStage)).toBe("fast-worker");
  });

  test("a non-mechanical step goes to the primary executor", () => {
    const step: PlanStep = {
      title: "design the schema",
      criterion: "schema exists",
      mechanical: false,
    };
    expect(pickWorker(step, workStage)).toBe("executor");
  });

  test("a stage with no fallback always uses the primary", () => {
    const soloStage = sequenceById(config, "small-change")!.stages[0]!;
    const step: PlanStep = { title: "fix it", criterion: "fixed", mechanical: true };
    expect(pickWorker(step, soloStage)).toBe("fast-worker");
  });
});

describe("plan prompts", () => {
  test("planPrompt names the request and asks for JSON, no edits", () => {
    const prompt = planPrompt("migrate off MySQL");
    expect(prompt).toContain("migrate off MySQL");
    expect(prompt).toContain("Do not edit any file");
    expect(prompt).toContain('"steps"');
  });

  test("parsePlan accepts a valid plan", () => {
    const raw = JSON.stringify({
      steps: [
        { title: "Add the column", criterion: "column exists", mechanical: true },
        { title: "Backfill data", criterion: "no null rows", mechanical: false },
      ],
    });
    expect(parsePlan(raw)).toEqual([
      { title: "Add the column", criterion: "column exists", mechanical: true },
      { title: "Backfill data", criterion: "no null rows", mechanical: false },
    ]);
  });

  test("parsePlan tolerates a fenced reply", () => {
    const raw = '```json\n{"steps":[{"title":"a","criterion":"b","mechanical":false}]}\n```';
    expect(parsePlan(raw)).toEqual([{ title: "a", criterion: "b", mechanical: false }]);
  });

  test("parsePlan rejects no steps array, empty, too many, or a missing field", () => {
    expect(parsePlan("not json")).toBeNull();
    expect(parsePlan('{"steps":[]}')).toBeNull();
    const tooMany = JSON.stringify({
      steps: Array.from({ length: 13 }, (_, i) => ({ title: `t${i}`, criterion: `c${i}` })),
    });
    expect(parsePlan(tooMany)).toBeNull();
    expect(parsePlan('{"steps":[{"title":"a"}]}')).toBeNull();
  });
});

describe("stepPrompt / testPrompt", () => {
  const step: PlanStep = { title: "Add the column", criterion: "column exists", mechanical: true };

  test("stepPrompt names the request, the step, and prior notes", () => {
    const prompt = stepPrompt("migrate off MySQL", step, {
      index: 0,
      total: 2,
      priorNotes: ["did the first thing"],
    });
    expect(prompt).toContain("migrate off MySQL");
    expect(prompt).toContain("Step 1 of 2");
    expect(prompt).toContain("Add the column");
    expect(prompt).toContain("did the first thing");
  });

  test("stepPrompt mentions a prior test failure when given one", () => {
    const prompt = stepPrompt("migrate off MySQL", step, {
      index: 1,
      total: 2,
      priorNotes: [],
      failure: "column still missing",
    });
    expect(prompt).toContain("column still missing");
  });

  test("testPrompt lists every criterion and asks for JSON in order", () => {
    const steps: PlanStep[] = [
      { title: "a", criterion: "column exists", mechanical: false },
      { title: "b", criterion: "no null rows", mechanical: false },
    ];
    const prompt = testPrompt("migrate off MySQL", steps, ["added the column"]);
    expect(prompt).toContain("migrate off MySQL");
    expect(prompt).toContain("1. column exists");
    expect(prompt).toContain("2. no null rows");
    expect(prompt).toContain("added the column");
    expect(prompt).toContain('"results"');
    expect(prompt).toContain("Do not fix anything");
  });
});

describe("parseTestReport", () => {
  const steps: PlanStep[] = [
    { title: "a", criterion: "column exists", mechanical: false },
    { title: "b", criterion: "no null rows", mechanical: false },
  ];

  test("aligns results by index, criterion text from the step wins", () => {
    const raw = JSON.stringify({
      results: [
        { criterion: "ignored", pass: true, evidence: "checked schema" },
        { criterion: "ignored", pass: false, evidence: "found 3 nulls" },
      ],
    });
    expect(parseTestReport(raw, steps)).toEqual([
      { criterion: "column exists", pass: true, evidence: "checked schema" },
      { criterion: "no null rows", pass: false, evidence: "found 3 nulls" },
    ]);
  });

  test("a shorter results array marks the missing steps failed", () => {
    const raw = JSON.stringify({ results: [{ pass: true, evidence: "checked schema" }] });
    expect(parseTestReport(raw, steps)).toEqual([
      { criterion: "column exists", pass: true, evidence: "checked schema" },
      { criterion: "no null rows", pass: false, evidence: "not reported" },
    ]);
  });

  test("no results array is null", () => {
    expect(parseTestReport("not json", steps)).toBeNull();
    expect(parseTestReport('{"foo":1}', steps)).toBeNull();
  });
});

describe("dispatchPrompt — workspace context", () => {
  // Learned live: with nothing attached, "implement X" drew the Build sequence,
  // which then reported 0/4 because no file could be written or run.
  const config = defaultConfig([
    {
      id: "claude-code/haiku",
      name: "Claude Haiku",
      type: "text",
      object: "model",
      owned_by: "x",
      logo: null,
      model_author: { name: "x" },
    },
    {
      id: "claude-code/opus",
      name: "Claude Opus",
      type: "text",
      object: "model",
      owned_by: "x",
      logo: null,
      model_author: { name: "x" },
    },
  ]);

  test("says so when no workspace is attached, and not when one is", () => {
    expect(dispatchPrompt(config, "implement it", { codeWork: false })).toContain(
      "No workspace is attached",
    );
    expect(dispatchPrompt(config, "implement it", { codeWork: true })).not.toContain(
      "No workspace is attached",
    );
    expect(dispatchPrompt(config, "implement it")).not.toContain("No workspace is attached");
  });
});
