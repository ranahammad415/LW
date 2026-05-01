/**
 * OmniSearch shared configuration.
 *
 * Single source of truth for:
 *   - Anthropic model name (standardized to claude-haiku-4-5 per project policy)
 *   - Data provider selection (SERP, keyword data, backlinks, AI query)
 *
 * Consumers should import AI_MODEL from here instead of hard-coding model strings.
 */

// ─── AI Model ───────────────────────────────────────────────────────────────
export const AI_MODEL = process.env.OMNISEARCH_AI_MODEL || 'claude-haiku-4-5-20250514';

// ─── SERP provider selection ────────────────────────────────────────────────
// Allowed values: 'serpapi' | 'dataforseo' | 'none'
export const SERP_PROVIDER = (process.env.SERP_PROVIDER || 'none').toLowerCase();

// ─── Keyword data provider selection ────────────────────────────────────────
// Allowed values: 'dataforseo' | 'none'
export const KEYWORD_DATA_PROVIDER = (process.env.KEYWORD_DATA_PROVIDER || 'none').toLowerCase();

// ─── Backlink provider selection ────────────────────────────────────────────
// Allowed values: 'dataforseo' | 'majestic' | 'ahrefs' | 'none'
export const BACKLINK_PROVIDER = (process.env.BACKLINK_PROVIDER || 'none').toLowerCase();

// ─── Helper: which dataSource label to stamp when falling back to Claude ────
export const CLAUDE_ESTIMATED_SOURCE = 'claude_estimated';
export const SIMULATED_GEO_SOURCE = 'simulated';

/**
 * Returns true if a real provider is configured for the given category.
 * Used by consumers to decide whether to call a provider or fall back to Claude.
 */
export function hasRealSerpProvider() {
  if (SERP_PROVIDER === 'serpapi') return Boolean(process.env.SERPAPI_API_KEY);
  if (SERP_PROVIDER === 'dataforseo')
    return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
  return false;
}

export function hasRealKeywordProvider() {
  if (KEYWORD_DATA_PROVIDER === 'dataforseo')
    return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
  return false;
}

export function hasRealBacklinkProvider() {
  if (BACKLINK_PROVIDER === 'dataforseo')
    return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
  if (BACKLINK_PROVIDER === 'majestic') return Boolean(process.env.MAJESTIC_API_KEY);
  if (BACKLINK_PROVIDER === 'ahrefs') return Boolean(process.env.AHREFS_API_KEY);
  return false;
}

export function hasRealAiQueryProvider(platform) {
  switch (platform) {
    case 'chatgpt':
    case 'openai':
      return Boolean(process.env.OPENAI_API_KEY);
    case 'perplexity':
      return Boolean(process.env.PERPLEXITY_API_KEY);
    case 'gemini':
    case 'google':
      return Boolean(process.env.GOOGLE_AI_API_KEY);
    case 'claude':
    case 'anthropic':
      return Boolean(process.env.ANTHROPIC_API_KEY);
    default:
      return false;
  }
}
