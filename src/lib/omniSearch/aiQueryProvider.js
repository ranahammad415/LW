/**
 * AI query provider — asks an AI platform a real question about a domain
 * to measure "Generative Engine Optimization" (GEO) visibility.
 *
 * Dispatches per platform:
 *   - chatgpt / openai    → OpenAI Chat Completions (OPENAI_API_KEY)
 *   - perplexity          → Perplexity Chat Completions (PERPLEXITY_API_KEY)
 *   - gemini / google     → Google Generative Language API (GOOGLE_AI_API_KEY)
 *   - claude / anthropic  → Anthropic Messages API (ANTHROPIC_API_KEY)
 *
 * Falls back to a simulated answer using Claude when the platform's own key is
 * missing, and stamps responseSource accordingly.
 *
 * Shape returned by queryAiPlatform({ platform, prompt, targetDomain, country }):
 *   {
 *     platform,
 *     answer: string,
 *     mentioned: boolean,    // did the answer mention targetDomain (host match)?
 *     mentionCount: number,
 *     position: number|null, // 1-based rank of first mention, or null
 *     citations: [{ url, title }],  // if the platform returned source citations
 *     responseSource: 'openai' | 'perplexity' | 'gemini' | 'anthropic' | 'simulated',
 *   }
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  AI_MODEL,
  SIMULATED_GEO_SOURCE,
  hasRealAiQueryProvider,
} from './omniSearchConfig.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function queryAiPlatform({ platform, prompt, targetDomain, country = 'US' }) {
  const normalizedPlatform = (platform || '').toLowerCase();
  if (hasRealAiQueryProvider(normalizedPlatform)) {
    try {
      if (normalizedPlatform === 'chatgpt' || normalizedPlatform === 'openai') {
        return analyze(await queryOpenAi(prompt), 'openai', targetDomain);
      }
      if (normalizedPlatform === 'perplexity') {
        return analyze(await queryPerplexity(prompt), 'perplexity', targetDomain);
      }
      if (normalizedPlatform === 'gemini' || normalizedPlatform === 'google') {
        return analyze(await queryGemini(prompt), 'gemini', targetDomain);
      }
      if (normalizedPlatform === 'claude' || normalizedPlatform === 'anthropic') {
        return analyze(await queryAnthropic(prompt), 'anthropic', targetDomain);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[aiQueryProvider] ${normalizedPlatform} failed, simulating with Claude: ${err.message}`,
      );
    }
  }
  // Fallback: simulate the platform's answer with Claude and mark as simulated
  return analyze(await simulateAnswer(prompt, normalizedPlatform, country), SIMULATED_GEO_SOURCE, targetDomain);
}

// ─── OpenAI ─────────────────────────────────────────────────────────────────
async function queryOpenAi(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  return { answer: data.choices?.[0]?.message?.content || '', citations: [] };
}

// ─── Perplexity ─────────────────────────────────────────────────────────────
async function queryPerplexity(prompt) {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.PERPLEXITY_MODEL || 'llama-3.1-sonar-large-128k-online',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    }),
  });
  if (!res.ok) throw new Error(`Perplexity ${res.status}`);
  const data = await res.json();
  const citations = (data.citations || []).map((url) => ({ url, title: '' }));
  return { answer: data.choices?.[0]?.message?.content || '', citations };
}

// ─── Gemini ─────────────────────────────────────────────────────────────────
async function queryGemini(prompt) {
  const model = process.env.GOOGLE_AI_MODEL || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return { answer: parts.map((p) => p.text || '').join(''), citations: [] };
}

// ─── Anthropic ──────────────────────────────────────────────────────────────
async function queryAnthropic(prompt) {
  const response = await anthropic.messages.create({
    model: AI_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  return { answer: response.content?.[0]?.text || '', citations: [] };
}

// ─── Claude-based simulation fallback ───────────────────────────────────────
async function simulateAnswer(prompt, platformName, country) {
  const simPrompt = `Simulate how "${platformName}" (a generative AI assistant) would answer the following user question in ${country}. Keep the style realistic for that platform. DO NOT invent facts; if you are unsure, be conservative.\n\nUser question: ${prompt}`;
  const response = await anthropic.messages.create({
    model: AI_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: simPrompt }],
  });
  return { answer: response.content?.[0]?.text || '', citations: [] };
}

// ─── post-processing ────────────────────────────────────────────────────────
function analyze({ answer, citations }, source, targetDomain) {
  const host = normalizeDomain(targetDomain);
  let mentioned = false;
  let mentionCount = 0;
  let position = null;

  if (host && answer) {
    const regex = new RegExp(host.replace(/\./g, '\\.'), 'gi');
    const matches = answer.match(regex);
    if (matches && matches.length > 0) {
      mentioned = true;
      mentionCount = matches.length;
      const first = answer.toLowerCase().indexOf(host.toLowerCase());
      // rough "position" = index among citations if present, else 1
      if (citations && citations.length > 0) {
        const idx = citations.findIndex((c) => normalizeDomain(c.url || '').includes(host));
        position = idx >= 0 ? idx + 1 : 1;
      } else {
        position = 1;
      }
      // Suppress unused variable warnings; first kept for potential future scoring
      void first;
    }
  }

  return {
    platform: source === SIMULATED_GEO_SOURCE ? null : source,
    answer,
    mentioned,
    mentionCount,
    position,
    citations: citations || [],
    responseSource: source,
  };
}

function normalizeDomain(input) {
  if (!input) return '';
  return input
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

/**
 * Secondary pass over an already-obtained answer — extracts sentiment about the
 * brand, competitor mentions, and a loose entity-accuracy score (0-1).
 * Uses Claude because it's a structured reasoning task, not a factual lookup.
 */
export async function analyzeGeoResponse({ prompt, brandName, answer }) {
  if (!answer) {
    return { sentiment: null, competitorsMentioned: [], entityAccuracy: null };
  }
  const system = `You analyze AI assistant answers for brand visibility. Return ONLY JSON of the shape:
{
  "sentiment": "positive" | "neutral" | "negative" | null,
  "competitorsMentioned": ["competitor1", "competitor2"],
  "entityAccuracy": <0.0-1.0 or null>
}
entityAccuracy reflects how accurately the answer describes ${brandName} (null if brand is not mentioned).`;

  const userMsg = `User question: ${prompt}\n\nAssistant answer:\n${answer}\n\nTarget brand: ${brandName}`;
  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = response.content?.[0]?.text || '{}';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return {
      sentiment: parsed.sentiment || null,
      competitorsMentioned: Array.isArray(parsed.competitorsMentioned)
        ? parsed.competitorsMentioned
        : [],
      entityAccuracy:
        typeof parsed.entityAccuracy === 'number' ? parsed.entityAccuracy : null,
    };
  } catch {
    return { sentiment: null, competitorsMentioned: [], entityAccuracy: null };
  }
}
