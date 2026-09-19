import type { Core, RequestOptions } from "../core/core";

export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

export interface DecisionAnswer {
  type: "choice" | "score" | "noul";
  choice?: string;
  score?: number;
  noul?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
  /** 0..1. Jev omits it on `noul`; derived here as |noul − 0.5| × 2. */
  confidence: number;
}

export interface DecideResponse {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export class Decisions {
  constructor(private readonly client: Core) {}

  async decide(
    state: string,
    questions: Record<string, DecisionQuestion>,
    options: { model?: string; signal?: AbortSignal } = {},
  ): Promise<DecideResponse> {
    const req: RequestOptions = {
      method: "POST",
      idempotent: true,
      body: { state, questions, ...(options.model ? { model: options.model } : {}) },
    };
    if (options.signal) req.signal = options.signal;
    const res = await this.client.request<DecideResponse>("/api/v1/decisions", req);
    for (const a of Object.values(res.answers ?? {})) {
      if (typeof a.confidence !== "number") {
        a.confidence = typeof a.noul === "number" ? Math.abs(a.noul - 0.5) * 2 : 0;
      }
    }
    return res;
  }
}

/** True when the answer exists and is certain enough to act on. */
export function confident(answer: DecisionAnswer | undefined, threshold = 0.8): boolean {
  return !!answer && answer.confidence >= threshold;
}
