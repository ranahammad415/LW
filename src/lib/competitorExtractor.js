/**
 * CompetitorExtractionService
 * ───────────────────────────
 * LLM-powered utility that takes a response snippet from an AI engine,
 * extracts the domain names / brand entities recommended in the text,
 * and returns them as a string array.
 *
 * When no AI provider is configured it falls back to a regex-based
 * domain extractor so the pipeline still works without API keys.
 */

import { generateChat, isAiConfigured } from './ai.js';

// ── Regex fallback ────────────────────────────────────────────────────

/**
 * Simple heuristic: pull anything that looks like a domain name
 * (word.tld) from the text. Good enough for mocked responses and as a
 * safety-net when the LLM is unavailable.
 */
function extractDomainsRegex(text) {
  // Matches patterns like "example.com", "my-site.agency", "brand.co.uk"
  const domainRe = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|net|org|io|co|agency|dev|ai|app|xyz|biz|info|co\.[a-z]{2}))\b/gi;
  const matches = text.match(domainRe) || [];
  // Deduplicate & lowercase
  return [...new Set(matches.map((d) => d.toLowerCase()))];
}

// ── LLM-based extraction ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a data extraction assistant. Given a snippet of text from an AI search engine response, extract ALL domain names, brand names, or company entities that are recommended, cited, or mentioned as alternatives.

Return a JSON object with a single key "competitors" whose value is an array of strings. Each string should be either a domain (e.g. "acme-digital.com") or a brand name (e.g. "BrightWave"). Do NOT include the user's own brand. If none are found, return {"competitors":[]}.`;

/**
 * Extract competitor domains / brands from a response snippet.
 *
 * @param {string} responseSnippet  The AI-generated text to analyse
 * @returns {Promise<string[]>}     Array of competitor identifiers
 */
export async function extractCompetitors(responseSnippet) {
  if (!responseSnippet || responseSnippet.trim().length === 0) {
    return [];
  }

  // Try LLM extraction first
  if (isAiConfigured()) {
    try {
      const { parsed } = await generateChat({
        system: SYSTEM_PROMPT,
        user: responseSnippet,
        json: true,
        maxTokens: 512,
        temperature: 0,
      });

      if (parsed && Array.isArray(parsed.competitors)) {
        return parsed.competitors
          .map((c) => (typeof c === 'string' ? c.trim() : ''))
          .filter(Boolean);
      }
    } catch (err) {
      console.warn('[CompetitorExtractor] LLM extraction failed, falling back to regex:', err.message);
    }
  }

  // Fallback to regex-based extraction
  return extractDomainsRegex(responseSnippet);
}
