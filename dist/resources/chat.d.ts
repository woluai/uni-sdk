import type { UnifiedStream } from "../core/_internal/stream.js";
import type { Core } from "../core/core.js";
export type ChatCompletionMessage = ChatCompletionSystemMessage | ChatCompletionUserMessage | ChatCompletionAssistantMessage | ChatCompletionToolMessage;
export interface ChatCompletionSystemMessage {
    role: "system";
    content: string;
    name?: string;
}
export interface ChatCompletionUserMessage {
    role: "user";
    content: string | ChatCompletionUserContentPart[];
    name?: string;
}
export type ChatCompletionUserContentPart = {
    type: "text";
    text: string;
} | {
    type: "image_url";
    image_url: {
        url: string;
        detail?: "auto" | "low" | "high";
    };
} | {
    type: "input_audio";
    input_audio: {
        data: string;
        format: "wav" | "mp3";
    };
} | {
    type: "video_url";
    video_url: {
        url: string;
    };
} | {
    type: "file";
    file: {
        file_data?: string;
        file_url?: string;
        /**
         * Stable file id. Accepts both gateway-managed ids from
         * `sdk.files.upload()` / `sdk.files.create()` (resolved server-side
         * to the right transport per routed provider) and provider-native
         * ids (e.g. OpenAI `file-...`). Mutually exclusive with `file_url`
         * and `file_data`.
         */
        file_id?: string;
        filename?: string;
    };
};
export interface ChatCompletionAssistantMessage {
    role: "assistant";
    content?: string | null;
    name?: string;
    tool_calls?: ChatCompletionToolCall[];
}
export interface ChatCompletionToolMessage {
    role: "tool";
    content: string;
    tool_call_id: string;
}
export interface ChatCompletionToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
    /**
     * Opaque provider signature that must be echoed back verbatim on the next
     * request. Gemini/Vertex stamps every function call it emits while thinking
     * with a `thoughtSignature`; omitting it on the follow-up turn makes Google
     * reject or degrade the tool call. The gateway surfaces it here and re-attaches
     * it as `providerOptions` on the way back in — so callers only need to preserve
     * it round-trip (which the agent loop does automatically).
     */
    thought_signature?: string;
}
export interface ChatCompletionToolDefinition {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: unknown;
        strict?: boolean;
    };
}
export type ChatCompletionResponseFormat = {
    type: "text";
} | {
    type: "json_object";
} | {
    type: "json_schema";
    json_schema: {
        name: string;
        description?: string;
        schema?: unknown;
        strict?: boolean;
    };
};
export type ChatCompletionToolChoice = "none" | "auto" | "required" | {
    type: "function";
    function: {
        name: string;
    };
};
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export interface ChatCompletionCreateParams {
    model: string;
    messages: ChatCompletionMessage[];
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    stop?: string | string[];
    n?: number;
    seed?: number;
    logprobs?: boolean;
    top_logprobs?: number;
    tools?: ChatCompletionToolDefinition[];
    tool_choice?: ChatCompletionToolChoice;
    response_format?: ChatCompletionResponseFormat;
    stream_options?: {
        include_usage?: boolean;
    };
    thinking?: {
        type: "enabled";
        budget_tokens?: number;
    };
    reasoning_effort?: ReasoningEffort;
    /**
     * Ask the gateway to deterministically compress older conversation context
     * (tool outputs, long prior assistant turns) server-side before routing.
     * Falls back to the client-level `compression` default when unset; an
     * explicit `false` here overrides a client default of `true`.
     */
    compression?: boolean;
    user?: string;
}
export interface ChatCompletionResponse {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: ChatCompletionChoice[];
    usage: ChatCompletionUsage;
    system_fingerprint?: string | null;
}
export interface ChatCompletionChoice {
    index: number;
    message: {
        role: "assistant";
        content: string | null;
        reasoning_content?: string | null;
        tool_calls?: ChatCompletionToolCall[];
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
    logprobs?: unknown | null;
}
export interface ChatCompletionUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}
export interface ChatCreateOptions {
    signal?: AbortSignal;
}
export interface ChatCompletionChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: ChatCompletionChunkChoice[];
    usage?: ChatCompletionUsage | null;
    system_fingerprint?: string | null;
}
export interface ChatCompletionChunkChoice {
    index: number;
    delta: {
        role?: "assistant";
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: Array<{
            index: number;
            id?: string;
            type?: "function";
            function?: {
                name?: string;
                arguments?: string;
            };
            /** See {@link ChatCompletionToolCall.thought_signature}. Arrives on its own
             *  delta after the tool's argument deltas, keyed to the same `index`. */
            thought_signature?: string;
        }>;
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
    logprobs?: unknown | null;
}
export type ChatCompletionStream = UnifiedStream<ChatCompletionChunk>;
export declare class ChatCompletions {
    private readonly client;
    constructor(client: Core);
    create(params: ChatCompletionCreateParams & {
        stream: true;
    }, options?: ChatCreateOptions): ChatCompletionStream;
    create(params: ChatCompletionCreateParams & {
        stream?: false;
    }, options?: ChatCreateOptions): Promise<ChatCompletionResponse>;
    private createStream;
}
export declare class Chat {
    readonly completions: ChatCompletions;
    constructor(client: Core);
}
//# sourceMappingURL=chat.d.ts.map