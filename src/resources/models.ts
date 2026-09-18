import type { Core, RequestOptions } from "../core/core";

export type ModelType = "text" | "image" | "video" | "audio" | "embedding";

export interface ModelAuthor {
  name: string;
  color?: string | null;
}

export interface Model {
  id: string;
  name: string;
  type: ModelType;
  object: "model";
  created?: number;
  owned_by: string;
  text_inp?: boolean;
  image_inp?: boolean;
  audio_inp?: boolean;
  video_inp?: boolean;
  pdf_inp?: boolean;
  supports_caching?: boolean;
  /**
   * Gateway rates in USD per 1M tokens (input_token_cost, output_token_cost,
   * cached_input_token_cost, cache_creation_input_token_cost) or per unit for
   * image models (cost_per_image).
   */
  pricing?: Record<string, number>;
  /** From the AI Gateway catalog. */
  description?: string | null;
  tags?: string[];
  /** Max output tokens and training-knowledge cutoff (e.g. "2025-07-31"), when the gateway knows them. */
  max_tokens?: number | null;
  knowledge?: string | null;
  logo: string | null;
  model_author: ModelAuthor;
  /**
   * The model's context window in tokens, from the gateway's catalog. Null or
   * absent when unknown (the `auto` router, custom backends, older gateways).
   */
  context_size?: number | null;
}

export interface ListModelsResponse {
  object: "list";
  data: Model[];
}

export interface ListModelsOptions {
  signal?: AbortSignal;
  /** Optional expansions to include in each model entry. */
  include?: Array<"author">;
}

export class Models {
  constructor(private readonly client: Core) {}

  list(options: ListModelsOptions = {}): Promise<ListModelsResponse> {
    const req: RequestOptions = { method: "GET" };
    if (options.signal) req.signal = options.signal;
    const path = options.include?.length
      ? `/api/v1/models?include=${encodeURIComponent(options.include.join(","))}`
      : "/api/v1/models";
    return this.client.request<ListModelsResponse>(path, req);
  }
}
