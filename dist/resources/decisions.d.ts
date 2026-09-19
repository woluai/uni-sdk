import type { Core } from "../core/core.js";
export type DecisionQuestion = {
    type: "choice";
    instructions: string;
    criteria: Record<string, string>;
} | {
    type: "score";
    instructions: string;
    criteria: string[];
} | {
    type: "noul";
    instructions: string;
};
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
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
}
export declare class Decisions {
    private readonly client;
    constructor(client: Core);
    decide(state: string, questions: Record<string, DecisionQuestion>, options?: {
        model?: string;
        signal?: AbortSignal;
    }): Promise<DecideResponse>;
}
/** True when the answer exists and is certain enough to act on. */
export declare function confident(answer: DecisionAnswer | undefined, threshold?: number): boolean;
//# sourceMappingURL=decisions.d.ts.map