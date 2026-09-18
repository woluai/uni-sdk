import { LOGO_DATA_URIS, type LogoSlug } from "./logos.generated";

export type LogoTheme = "light" | "dark";

/**
 * Anything that can resolve to a brand logo: a bare author/provider name, or a
 * catalog model-shaped object. UI stores often shim `author`; the gateway
 * returns `model_author.name` / `owned_by` — accept all three so Meta (and
 * every other author) renders without a client-side rename.
 */
export type ProviderLogoInput =
  | string
  | {
      author?: string | null;
      model_author?: { name?: string | null } | null;
      owned_by?: string | null;
    }
  | null
  | undefined;

const NORMALIZE_RE = /[\s.]+/g;

function normalizeKey(input: ProviderLogoInput): string | null {
  if (!input) return null;
  const raw =
    typeof input === "string"
      ? input
      : (input.author ?? input.model_author?.name ?? input.owned_by);
  if (!raw) return null;
  return raw.toLowerCase().replace(NORMALIZE_RE, "");
}

function hasSlug(slug: string): slug is LogoSlug {
  return slug in LOGO_DATA_URIS;
}

/**
 * Provider names that share another provider's brand mark. Keys are already
 * normalized (lowercased, whitespace and dots stripped).
 *
 * "Claude Code" is its own provider surface in a catalog — a local CLI running on
 * the user's own subscription, listed apart from gateway Anthropic models — but it
 * carries the Claude mark, and clients group by the author string they display.
 */
const SLUG_ALIASES: Record<string, string> = {
  // Both spellings: normalization strips whitespace but not hyphens, so the
  // display name ("Claude Code") and the slug (`owned_by: "claude-code"`) differ.
  claudecode: "claude",
  "claude-code": "claude",
  // Gateway `owned_by` creator slugs that differ from the asset's own name.
  alibaba: "qwen",
  deepseek: "deepseekai",
  minimax: "minimaxai",
  spacexai: "xai",
  "fish-audio": "fishaudio",
};

function resolveSlug(input: ProviderLogoInput, theme: LogoTheme): LogoSlug | null {
  const normalized = normalizeKey(input);
  if (!normalized) return null;
  const key = SLUG_ALIASES[normalized] ?? normalized;
  if (theme === "dark") {
    const dark = `${key}-dark`;
    if (hasSlug(dark)) return dark;
  }
  return hasSlug(key) ? key : null;
}

/**
 * Returns a data-URI for the given provider/author's logo, or an empty string
 * when there is no brand mark (unknown / missing author).
 * Works in any environment (Node, browser, Electron, Tauri) with no bundler config.
 */
export function getProviderLogo(input: ProviderLogoInput, theme: LogoTheme = "light"): string {
  const slug = resolveSlug(input, theme);
  return slug ? LOGO_DATA_URIS[slug] : "";
}

/** Author keys with a logo available (e.g. "anthropic", "openai"). */
export function listProviderLogos(): string[] {
  return Object.keys(LOGO_DATA_URIS).filter((slug) => !slug.endsWith("-dark"));
}

/** Minimal shape needed to resolve a catalog model's brand logo. */
export interface ModelLogoInput {
  model_author?: { name?: string | null } | null;
  owned_by?: string | null;
}

/**
 * Resolve a catalog model's brand logo, preferring the friendly
 * `model_author.name` (present when models are listed with
 * `include: ["author"]`) and falling back to the `owned_by` slug. A
 * convenience over {@link getProviderLogo} that encodes the correct field to
 * key on — logos are indexed by author/provider name, not by model id.
 */
export function getModelLogo(model: ModelLogoInput, theme: LogoTheme = "light"): string {
  return getProviderLogo(model, theme);
}
