/**
 * Brand / domain citation detection for AI Visibility probe answers.
 */

import { domainFromUrl } from '../analytics/providers.js';

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} responseText
 * @param {{ domain?: string|null, brandNames?: string[] }} opts
 * @returns {{ cited: boolean, citationType: 'domain'|'brand'|'url'|'none' }}
 */
export function detectCitation(responseText, { domain = null, brandNames = [] } = {}) {
  const text = String(responseText || '');
  const lower = text.toLowerCase();
  if (!lower.trim()) return { cited: false, citationType: 'none' };

  const host = domainFromUrl(domain || '');
  if (host) {
    const hostBare = host.replace(/^www\./, '');
    if (lower.includes(hostBare) || lower.includes(`www.${hostBare}`)) {
      return { cited: true, citationType: hostBare.includes('.') ? 'domain' : 'url' };
    }
    // Also match without TLD sometimes mentioned as brand site
    const label = hostBare.split('.')[0];
    if (label && label.length >= 4) {
      const re = new RegExp(`\\b${escapeRe(label)}\\b`, 'i');
      if (re.test(text) && lower.includes(hostBare.split('.').pop() || '')) {
        return { cited: true, citationType: 'domain' };
      }
    }
  }

  for (const raw of brandNames || []) {
    const name = String(raw || '').trim();
    if (!name || name.length < 2) continue;
    // Prefer multi-word / longer brands; skip tiny tokens
    const tokens = name.split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length === 0) continue;
    if (tokens.length === 1 && tokens[0].length < 4) continue;
    const pattern = tokens.map(escapeRe).join('\\s+');
    const re = new RegExp(`\\b${pattern}\\b`, 'i');
    if (re.test(text)) {
      return { cited: true, citationType: 'brand' };
    }
  }

  return { cited: false, citationType: 'none' };
}

/** Lightweight competitor domain scrape (no extra LLM cost). */
export function extractCompetitorDomains(responseText, ownDomain) {
  const domainRe =
    /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|net|org|io|co|agency|dev|ai|app|xyz|biz|info|co\.[a-z]{2}))\b/gi;
  const matches = String(responseText || '').match(domainRe) || [];
  const own = domainFromUrl(ownDomain || '').replace(/^www\./, '');
  const set = new Set();
  for (const m of matches) {
    const d = m.toLowerCase().replace(/^www\./, '');
    if (own && (d === own || d.endsWith(`.${own}`))) continue;
    set.add(d);
  }
  return [...set].slice(0, 20);
}
