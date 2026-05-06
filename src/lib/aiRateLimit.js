/**
 * In-memory sliding-window rate limiter for AI-powered endpoints.
 * Per-user (falls back to IP) with configurable window / max via env:
 *   - AI_RATE_LIMIT_MAX     (default 10)
 *   - AI_RATE_LIMIT_WINDOW  (seconds, default 60)
 *
 * Fastify onRequest hook factory — use as:
 *   onRequest: [app.verifyJwt, app.requireClient, aiRateLimit('nova_chat')]
 */

const DEFAULT_MAX = Number(process.env.AI_RATE_LIMIT_MAX || 10);
const DEFAULT_WINDOW_SEC = Number(process.env.AI_RATE_LIMIT_WINDOW || 60);

// bucket -> timestamps[]
const buckets = new Map();

function prune(key, cutoff) {
  const arr = buckets.get(key);
  if (!arr) return [];
  const kept = arr.filter((t) => t >= cutoff);
  if (kept.length === 0) buckets.delete(key);
  else buckets.set(key, kept);
  return kept;
}

export function aiRateLimit(feature, max = DEFAULT_MAX, windowSec = DEFAULT_WINDOW_SEC) {
  return async function aiRateLimitHook(request, reply) {
    const now = Date.now();
    const cutoff = now - windowSec * 1000;
    const id = request.user?.id || request.ip || 'anonymous';
    const key = `${feature}:${id}`;
    const recent = prune(key, cutoff);
    if (recent.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((recent[0] + windowSec * 1000 - now) / 1000));
      reply.header('Retry-After', String(retryAfter));
      return reply.status(429).send({
        message: `Too many AI requests. Try again in ${retryAfter}s.`,
        retryAfter,
      });
    }
    recent.push(now);
    buckets.set(key, recent);
  };
}
