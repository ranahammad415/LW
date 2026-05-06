/**
 * Unified AI provider: Anthropic Claude Haiku.
 * Set ANTHROPIC_API_KEY in your .env file.
 * Optional: AI_MODEL overrides the default model.
 *
 * Features:
 *   - Automatic retries with exponential backoff on 529/503/network errors
 *   - Fire-and-forget usage logging to AiUsageLog
 *   - Basic prompt-injection sanitization helper
 */

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from './prisma.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL = 'claude-haiku-4-5-20250514';

// Retry tuning (override via env for tests)
const RETRY_ATTEMPTS = Number(process.env.AI_RETRY_ATTEMPTS || 3);
const RETRY_DELAYS_MS = [500, 1500, 4000];

function getModel() {
  return process.env.AI_MODEL || DEFAULT_MODEL;
}

/**
 * Check if the AI provider is configured.
 */
export function isAiConfigured() {
  return !!ANTHROPIC_KEY;
}

/**
 * Get the active provider name for error messages.
 */
export function getActiveProviderName() {
  return ANTHROPIC_KEY ? 'Claude Haiku' : null;
}

/**
 * Sanitize free-form user input before embedding into a prompt.
 * Strips obvious prompt-injection markers and truncates to 8000 chars.
 */
export function sanitizeUserInputForPrompt(input, maxChars = 8000) {
  if (typeof input !== 'string') return '';
  let s = input;
  // Neutralize common injection patterns (case-insensitive, multi-line).
  s = s.replace(/<\/?(system|assistant|user|instructions?)>/gi, ' ');
  s = s.replace(/\b(system|assistant|user)\s*:\s*/gi, ' ');
  s = s.replace(/\bignore (all|previous|prior) (instructions?|prompts?)\b/gi, ' ');
  // Collapse excessive whitespace
  s = s.replace(/\s{3,}/g, '  ');
  if (s.length > maxChars) s = s.slice(0, maxChars);
  return s;
}

function shouldRetry(err) {
  if (!err) return false;
  const status = err.status || err.statusCode;
  if (status === 529 || status === 503 || status === 502 || status === 504) return true;
  if (status === 429) return true; // rate-limited
  // Network-level errors typically lack status
  if (!status) return true;
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function logUsage(entry) {
  // Fire-and-forget. Never throw.
  try {
    await prisma.aiUsageLog.create({ data: entry });
  } catch (_) {
    // Swallow — observability must never break the request.
  }
}

/**
 * Generate a single response (system + user) or multi-turn (messages).
 * @param {Object} opts
 * @param {string} [opts.system] - System prompt
 * @param {string} [opts.user] - User message (use messages for multi-turn)
 * @param {Array<{role: string, content: string}>} [opts.messages] - Full messages array
 * @param {boolean} [opts.json] - Expect JSON response
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.feature] - Feature tag for usage log (e.g. "nova_chat")
 * @param {string} [opts.userId]
 * @param {string} [opts.clientId]
 * @param {string} [opts.requestId]
 * @returns {Promise<{ text: string, parsed?: object, tokensIn?: number, tokensOut?: number }>}
 */
export async function generateChat(opts) {
  const {
    system,
    user,
    messages: messagesOpt,
    json = false,
    temperature,
    maxTokens = 1024,
    feature = 'unspecified',
    userId = null,
    clientId = null,
    requestId = null,
  } = opts || {};

  if (!ANTHROPIC_KEY) {
    throw new Error('AI is not configured. Set ANTHROPIC_API_KEY in your .env file.');
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const model = getModel();

  // Build system prompt
  let systemPrompt = '';
  if (messagesOpt && messagesOpt.length > 0) {
    const sysMsg = messagesOpt.find((m) => m.role === 'system');
    if (sysMsg) systemPrompt = sysMsg.content;
  } else if (system) {
    systemPrompt = system;
  }

  // When JSON is requested, append instruction to system prompt
  if (json) {
    const jsonInstruction = '\n\nYou MUST respond with valid JSON only. No markdown, no explanation outside the JSON.';
    systemPrompt = systemPrompt ? systemPrompt + jsonInstruction : jsonInstruction.trim();
  }

  // Build messages array (exclude system messages — Anthropic uses separate system param)
  let messages;
  if (messagesOpt && messagesOpt.length > 0) {
    messages = messagesOpt
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
  } else {
    messages = [];
    if (user) messages.push({ role: 'user', content: user });
  }
  if (messages.length === 0) throw new Error('No messages provided');

  const body = {
    model,
    max_tokens: maxTokens,
    messages,
    ...(systemPrompt && { system: systemPrompt }),
    ...(temperature !== undefined && { temperature }),
  };

  const startedAt = Date.now();
  let lastErr = null;
  let response = null;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      response = await client.messages.create(body);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_ATTEMPTS - 1 && shouldRetry(err)) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 4000;
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  const latencyMs = Date.now() - startedAt;

  if (lastErr) {
    logUsage({
      model,
      feature,
      userId,
      clientId,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs,
      success: false,
      errorCode: String(lastErr.status || lastErr.code || 'ERR').slice(0, 20),
    });
    const wrapped = new Error(lastErr.message || 'AI request failed');
    wrapped.cause = lastErr;
    wrapped.requestId = requestId;
    wrapped.status = lastErr.status || lastErr.statusCode;
    throw wrapped;
  }

  const content = response.content?.[0];
  const text = content?.type === 'text' ? content.text : '';
  const tokensIn = response.usage?.input_tokens ?? 0;
  const tokensOut = response.usage?.output_tokens ?? 0;

  logUsage({
    model,
    feature,
    userId,
    clientId,
    tokensIn,
    tokensOut,
    latencyMs,
    success: true,
    errorCode: null,
  });

  const result = { text, tokensIn, tokensOut };

  if (json && text) {
    try {
      // Strip code fences (```json ... ```) that models sometimes wrap around JSON
      let jsonText = text.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      result.parsed = JSON.parse(jsonText);
    } catch (_) {
      result.parsed = null;
    }
  }
  return result;
}
