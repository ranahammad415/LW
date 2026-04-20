/**
 * Unified AI provider: Anthropic Claude Haiku.
 * Set ANTHROPIC_API_KEY in your .env file.
 * Optional: AI_MODEL overrides the default model.
 */

import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL = 'claude-haiku-4-5-20250514';

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
 * Generate a single response (system + user) or multi-turn (messages).
 * @param {Object} opts
 * @param {string} [opts.system] - System prompt
 * @param {string} [opts.user] - User message (use messages for multi-turn)
 * @param {Array<{role: string, content: string}>} [opts.messages] - Full messages array
 * @param {boolean} [opts.json] - Expect JSON response
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{ text: string, parsed?: object }>}
 */
export async function generateChat(opts) {
  const { system, user, messages: messagesOpt, json = false, temperature, maxTokens = 1024 } = opts || {};

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

  const response = await client.messages.create(body);
  const content = response.content?.[0];
  const text = content?.type === 'text' ? content.text : '';
  const result = { text };

  if (json && text) {
    try {
      result.parsed = JSON.parse(text);
    } catch (_) {
      result.parsed = null;
    }
  }
  return result;
}
