import { firstByHint, roleFor } from "./autoModel";
// "Auto" for the multi-step lane: not one model for one turn (see
// `autoModel.ts`) but a DISPATCHER that reads a request and picks a profile
// (one model, one job) or a sequence (plan → work → test, across several
// models and possibly several files).
//
// Still pure: no transport, no client, no I/O. The caller runs the dispatcher
// model itself, hands the raw reply to `parseDispatch`, and drives the
// sequence's stages by calling this module's prompt builders and parsers at
// each step. This module never talks to a model — it only builds the prompts
// and reads the replies.
//
// Money is opt-in by policy, not by guessing: a profile or sequence stage
// that costs more only runs when `stepUp` says so (or the session already
// said yes once). `gate` is the one place that decision is made, so a host
// can change its mind without touching the prompts.
import type { Model } from "./models";

/** How a costlier pick is allowed to run without asking every time. */
export type StepUpPolicy = "stay" | "ask" | "auto";

/** One job, one model. The unit a dispatch resolves to when the request is simple. */
export interface AutoProfile {
  id: string;
  name: string;
  /** Null when the catalogue has nothing that fits — the profile exists but is unusable. */
  modelId: string | null;
  useWhen: string;
  systemPrompt?: string;
  /** True when this profile is dearer than the everyday model, and so gated by `stepUp`. */
  costsMore?: boolean;
}

export type StageKind = "plan" | "work" | "test";

/** One stage of a sequence. A `work` stage may list a fallback fast-worker for mechanical steps. */
export interface AutoStage {
  kind: StageKind;
  profileIds: string[];
}

/** Plan → work → test across possibly several files, retried a bounded number of times. */
export interface AutoSequence {
  id: string;
  name: string;
  useWhen: string;
  stages: AutoStage[];
  retries: number;
}

export interface AutoConfig {
  dispatcherModelId: string | null;
  everydayId: string;
  profiles: AutoProfile[];
  sequences: AutoSequence[];
  stepUp: StepUpPolicy;
  /** Fall back to `fallbackDispatch` when the dispatcher model's reply cannot be parsed. */
  hintsFallback: boolean;
}

export type AutoDispatch = { kind: "profile" | "sequence"; id: string; why: string };

export type GateDecision =
  | { action: "run" }
  | { action: "ask" }
  | { action: "hold"; declined: AutoDispatch };

export interface PlanStep {
  title: string;
  criterion: string;
  /** A precise-enough spec that a cheaper model can carry it out (renames, boilerplate, formatting). */
  mechanical: boolean;
}

export interface TestResult {
  criterion: string;
  pass: boolean;
  evidence: string;
}

/** First `{...}` object in `raw`, tolerating fences and prose around it. Null on any failure. */
function firstJsonObject(raw: string): unknown | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function usableText(models: Model[]): Model[] {
  return models.filter((m) => m.type === "text");
}

/**
 * The shipped defaults, built from a catalogue. Each profile picks the first
 * model matching its hints, in order; a profile whose hints all miss just
 * gets the everyday model, so dispatch always has something to run.
 */
export function defaultConfig(models: Model[]): AutoConfig {
  const text = usableText(models);
  const everyday =
    firstByHint(text, ["haiku", "flash", "mini", "composer", "lite", "small", "fast", "turbo"]) ??
    text[0];
  const everydayId = everyday?.id ?? null;

  const pick = (hints: string[]) => firstByHint(text, hints)?.id ?? everydayId;
  const vision = models.find((m) => m.type === "text" && m.image_inp);

  const profiles: AutoProfile[] = [
    {
      id: "everyday",
      name: "Everyday",
      modelId: everydayId,
      useWhen: "Short questions, low effort, and anything nothing else claims.",
    },
    {
      id: "planner",
      name: "Planner",
      modelId: pick(["fable", "opus", "ultra", "pro", "thinking", "reasoner", "sonnet"]),
      useWhen:
        "Hard changes that need a plan first: the steps, and an acceptance criterion for each, before anyone touches a file.",
      costsMore: true,
    },
    {
      id: "executor",
      name: "Executor",
      modelId: pick(["grok", "sonnet", "cursor-agent", "agent", "pro"]),
      useWhen: "Carries out a step of a plan against real files, then reports what changed.",
    },
    {
      id: "fast-worker",
      name: "Fast worker",
      modelId: pick(["composer", "haiku", "flash", "mini"]),
      useWhen:
        "Mechanical steps with a precise spec — renames, boilerplate, formatting, a test that mirrors an existing one.",
    },
    {
      id: "tester",
      name: "Tester",
      modelId: pick(["opus", "fable", "sonnet", "pro"]),
      useWhen:
        "Checks a change against its acceptance criteria — runs what matters, returns pass or fail with the evidence.",
      costsMore: true,
    },
    {
      id: "design",
      name: "Design",
      modelId: pick(["kimi", "gemini", "gpt", "sonnet"]),
      useWhen: "Layout, type, palette, brand — when no workspace is attached.",
    },
    {
      id: "vision",
      name: "Reading an image",
      modelId: vision?.id ?? null,
      useWhen: "A picture or a PDF on the turn. A requirement, not a tier — never held back.",
    },
  ];

  const sequences: AutoSequence[] = [
    {
      id: "build",
      name: "Build",
      useWhen:
        "Changes across several files, or anything that says implement, migrate or refactor.",
      stages: [
        { kind: "plan", profileIds: ["planner"] },
        { kind: "work", profileIds: ["executor", "fast-worker"] },
        { kind: "test", profileIds: ["tester"] },
      ],
      retries: 2,
    },
    {
      id: "small-change",
      name: "Small change",
      useWhen: "A fix you can describe in one sentence.",
      stages: [
        { kind: "work", profileIds: ["fast-worker"] },
        { kind: "test", profileIds: ["tester"] },
      ],
      retries: 1,
    },
  ];

  return {
    dispatcherModelId: everydayId,
    everydayId: "everyday",
    profiles,
    sequences,
    stepUp: "stay",
    hintsFallback: true,
  };
}

export function profileById(config: AutoConfig, id: string): AutoProfile | undefined {
  return config.profiles.find((p) => p.id === id);
}

export function sequenceById(config: AutoConfig, id: string): AutoSequence | undefined {
  return config.sequences.find((s) => s.id === id);
}

function stageLabel(config: AutoConfig, stage: AutoStage): string {
  const names = stage.profileIds.map((id) => profileById(config, id)?.name ?? id);
  return names[0] ?? stage.kind;
}

/** The one-shot prompt for the dispatcher model: every option, and how to answer. */
export function dispatchPrompt(
  config: AutoConfig,
  text: string,
  ctx?: { codeWork?: boolean; needsVision?: boolean },
): string {
  const lines: string[] = [];
  for (const profile of config.profiles) {
    if (profile.modelId === null) continue;
    lines.push(`- ${profile.id} — ${profile.name}: ${profile.useWhen}`);
  }
  for (const seq of config.sequences) {
    const stageNames = seq.stages.map((s) => stageLabel(config, s)).join(" → ");
    lines.push(`- ${seq.id} — ${seq.name} (${stageNames}): ${seq.useWhen}`);
  }

  const notes: string[] = [
    "Pick exactly one id.",
    "Prefer a single profile unless the request needs a plan across several steps.",
  ];
  if (ctx?.codeWork) notes.push("A code workspace is attached.");
  // Without a workspace nothing can be written or run, so a sequence whose
  // criteria are "the tests pass" cannot finish — it burns three models to
  // report 0/N. Say so, and let the dispatcher prefer a written answer.
  else if (ctx?.codeWork === false)
    notes.push(
      "No workspace is attached: nothing can be written to disk or run, so prefer a single profile unless the request only needs a plan.",
    );
  if (ctx?.needsVision) notes.push("The turn carries an image; pick a profile that can read one.");

  return [
    "Choose which of these should handle this request:",
    ...lines,
    ...notes,
    "",
    "Request:",
    "```",
    text,
    "```",
    `Reply with JSON only: {"pick":"<id>","why":"<one short line>"}`,
  ].join("\n");
}

/** Read the dispatcher's reply. Null when it named nothing this config knows. */
export function parseDispatch(raw: string, config: AutoConfig): AutoDispatch | null {
  const parsed = firstJsonObject(raw) as { pick?: unknown; why?: unknown } | null;
  if (!parsed || typeof parsed.pick !== "string") return null;
  const pick = parsed.pick;
  const why = typeof parsed.why === "string" ? parsed.why : "";
  if (profileById(config, pick)) return { kind: "profile", id: pick, why };
  if (sequenceById(config, pick)) return { kind: "sequence", id: pick, why };
  return null;
}

/**
 * No model available (or the dispatcher's reply didn't parse): fall back to
 * the same signals `autoModel` uses, mapped onto profiles and sequences
 * instead of a bare model id.
 */
export function fallbackDispatch(
  config: AutoConfig,
  req: {
    text: string;
    effort?: "low" | "medium" | "high" | null;
    codeWork?: boolean;
    needsVision?: boolean;
  },
): AutoDispatch {
  const role = roleFor(req);
  const everyday: AutoDispatch = { kind: "profile", id: config.everydayId, why: "built-in hint" };

  if (role === "vision") {
    const vision = profileById(config, "vision");
    return vision?.modelId ? { kind: "profile", id: "vision", why: "built-in hint" } : everyday;
  }
  if (role === "design") {
    const design = profileById(config, "design");
    return design?.modelId ? { kind: "profile", id: "design", why: "built-in hint" } : everyday;
  }
  if (role === "deep") {
    const seq = config.sequences.find((s) => s.stages.some((st) => st.kind === "plan"));
    return seq ? { kind: "sequence", id: seq.id, why: "built-in hint" } : everyday;
  }
  return everyday;
}

/** Whether running this pick can spend more than the everyday model. */
export function costsMore(pick: AutoDispatch, config: AutoConfig): boolean {
  if (pick.kind === "profile") return profileById(config, pick.id)?.costsMore ?? false;
  const seq = sequenceById(config, pick.id);
  if (!seq) return false;
  return seq.stages.some((stage) =>
    stage.profileIds.some((id) => profileById(config, id)?.costsMore),
  );
}

/**
 * The one place a costlier pick is allowed to run. `stay` never spends more
 * on its own — it hands the pick back as `declined` so the host can offer it
 * — `ask` wants a per-turn yes, `auto` (or a session that already said yes)
 * just runs it.
 */
export function gate(
  pick: AutoDispatch,
  config: AutoConfig,
  opts?: { sessionAllowed?: boolean },
): GateDecision {
  if (!costsMore(pick, config)) return { action: "run" };
  if (config.stepUp === "auto" || opts?.sessionAllowed) return { action: "run" };
  if (config.stepUp === "ask") return { action: "ask" };
  return { action: "hold", declined: pick };
}

/** Which profile carries out a plan step: the fallback fast-worker when the step is mechanical. */
export function pickWorker(step: PlanStep, stage: AutoStage): string {
  return step.mechanical && stage.profileIds[1] ? stage.profileIds[1] : stage.profileIds[0]!;
}

export function planPrompt(request: string): string {
  return [
    `Plan how to do this: ${request}`,
    "Do not edit any file. Produce 2–7 steps in order.",
    "Each step has a short title, one acceptance criterion the tester can check, and mechanical=true when the step is a precise spec a cheaper model can carry out (renames, boilerplate, formatting).",
    `Reply with JSON only: {"steps":[{"title":"…","criterion":"…","mechanical":false}]}`,
  ].join("\n");
}

export function parsePlan(raw: string): PlanStep[] | null {
  const parsed = firstJsonObject(raw) as { steps?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.steps)) return null;
  if (parsed.steps.length < 1 || parsed.steps.length > 12) return null;
  const steps: PlanStep[] = [];
  for (const raw of parsed.steps) {
    const s = raw as { title?: unknown; criterion?: unknown; mechanical?: unknown };
    if (
      typeof s.title !== "string" ||
      !s.title ||
      typeof s.criterion !== "string" ||
      !s.criterion
    ) {
      return null;
    }
    steps.push({ title: s.title, criterion: s.criterion, mechanical: Boolean(s.mechanical) });
  }
  return steps;
}

export function stepPrompt(
  request: string,
  step: PlanStep,
  ctx: { index: number; total: number; priorNotes: string[]; failure?: string },
): string {
  const lines = [
    `Step ${ctx.index + 1} of ${ctx.total} of a plan for: ${request}.`,
    `Do this step: ${step.title}.`,
    `It is done when: ${step.criterion}.`,
  ];
  if (ctx.priorNotes.length) {
    lines.push("Notes from earlier steps:");
    for (const note of ctx.priorNotes) lines.push(`- ${note}`);
  }
  if (ctx.failure) lines.push(`The tester failed this step: ${ctx.failure}. Fix that.`);
  lines.push("End with one short paragraph of what changed.");
  return lines.join("\n");
}

export function testPrompt(request: string, steps: PlanStep[], workNotes: string[]): string {
  const lines = [`Check this work against its plan for: ${request}.`, "Criteria:"];
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step.criterion}`));
  if (workNotes.length) {
    lines.push("What was done:");
    for (const note of workNotes) lines.push(`- ${note}`);
  }
  lines.push("Check every criterion. Run what you need to. Do not fix anything.");
  lines.push(`Reply with JSON only: {"results":[{"criterion":"…","pass":true,"evidence":"…"}]}`);
  return lines.join("\n");
}

export function parseTestReport(raw: string, steps: PlanStep[]): TestResult[] | null {
  const parsed = firstJsonObject(raw) as { results?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.results)) return null;
  const results = parsed.results as unknown[];
  return steps.map((step, i) => {
    const r = results[i] as { pass?: unknown; evidence?: unknown } | undefined;
    return {
      criterion: step.criterion,
      pass: r ? Boolean(r.pass) : false,
      evidence: r && typeof r.evidence === "string" ? r.evidence : r ? "" : "not reported",
    };
  });
}
