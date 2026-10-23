/**
 * Client IP for MCP / OAuth rate limits and audit rows. Production sits behind Cloudflare and runs Fastify with
 * trustProxy=true, which takes the left-most X-Forwarded-For value: anyone can spoof it (known-issues.md). Cloudflare
 * overwrites CF-Connecting-IP on every proxied request, so prefer it when present; else request.ip.
 * (A request that reaches the origin directly, bypassing Cloudflare, can still forge either header.)
 */
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,45})$/;

export function clientIp(request) {
  const cf = request?.headers?.['cf-connecting-ip'];
  if (typeof cf === 'string' && IP_RE.test(cf.trim())) return cf.trim();
  return request?.ip || '0.0.0.0';
}

/** @fastify/rate-limit route config with the MCP client-IP key. */
export function mcpRateLimit(max, timeWindow) {
  return { max, timeWindow, keyGenerator: clientIp };
}
