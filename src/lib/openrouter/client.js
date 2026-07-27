/**
 * OpenRouter chat client (OpenAI-compatible).
 * Env: OPENROUTER_API_KEY, optional OPENROUTER_SITE_URL / OPENROUTER_APP_NAME
 * Optional OPENROUTER_MODEL_MAP JSON to override platform → model ids.
 */

const DEFAULT_MODELS = {
  chatgpt: 'openai/gpt-4o-mini',
  // Prefer current OpenRouter slugs (old 3.5-haiku / gemini-2.0-flash-001 often return "No endpoints found")
  claude: 'anthropic/claude-haiku-4.5',
  gemini: 'google/gemini-2.5-flash',
  perplexity: 'perplexity/sonar',
};

export function isOpenRouterConfigured() {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

export function getOpenRouterModelMap() {
  const map = { ...DEFAULT_MODELS };
  const raw = process.env.OPENROUTER_MODEL_MAP;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') Object.assign(map, parsed);
    } catch {
      /* keep defaults */
    }
  }
  return map;
}

/**
 * @param {{ model: string, system?: string, user: string, maxTokens?: number }} args
 * @returns {Promise<{ text: string, model: string, usage?: object }>}
 */
export async function openRouterChat({ model, system, user, maxTokens = 800 }) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (process.env.OPENROUTER_SITE_URL) {
    headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL;
  }
  if (process.env.OPENROUTER_APP_NAME) {
    headers['X-Title'] = process.env.OPENROUTER_APP_NAME;
  }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(60000),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        lastErr = new Error(json.error?.message || 'OpenRouter rate limited');
        continue;
      }
      if (!res.ok) {
        throw new Error(json.error?.message || `OpenRouter ${res.status}`);
      }
      const text = json.choices?.[0]?.message?.content || '';
      return { text: String(text), model, usage: json.usage || null };
    } catch (err) {
      lastErr = err;
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new Error('OpenRouter request timed out');
      }
      if (attempt < 2 && /rate|429|temporar/i.test(err.message || '')) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('OpenRouter request failed');
}

/**
 * Ask a model for a search-style answer that may cite brands/URLs.
 */
export async function probeVisibilityQuery({ platform, model, query }) {
  const system =
    `You are answering as the ${platform} AI assistant would for a real user search/recommendation query. ` +
    `Be specific. When recommending businesses, agencies, or websites, include real-looking domain names and brand names. ` +
    `If you cite sources or websites, list them clearly.`;
  return openRouterChat({
    model,
    system,
    user: query,
    maxTokens: 900,
  });
}
