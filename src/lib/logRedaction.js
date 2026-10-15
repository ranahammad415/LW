/**
 * Keeps secrets in URLs out of logs and error reports (review fix M5).
 *
 * Public interview links carry the plaintext token as a path segment
 * (`/knowledge-interview/<token>/...`). Fastify's default request logging and
 * Sentry's request/breadcrumb data would otherwise record it.
 */
const PATTERNS = [
  // /knowledge-interview/<token>  (API and frontend paths)
  [/(\/knowledge-interview\/)[^/?#\s]+/g, '$1[redacted]'],
  // ?token=... (SSE auth, signed issue links)
  [/([?&]token=)[^&#\s]+/gi, '$1[redacted]'],
  // EmDash bridge review links (?t=<capability token>) and preview tokens (plan §6 Logging)
  [/([?&]t=)[^&#\s]+/g, '$1[redacted]'],
  [/([?&]_preview=)[^&#\s]+/gi, '$1[redacted]'],
];

export function redactSensitiveUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  let out = url;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Fastify logger `req` serializer with the URL redacted. */
export function redactedRequestSerializer(req) {
  return {
    method: req.method,
    url: redactSensitiveUrl(req.url),
    host: req.host ?? req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/** Sentry beforeSend / beforeBreadcrumb helpers. */
export function redactSentryEvent(event) {
  if (!event || typeof event !== 'object') return event;
  if (event.request) {
    if (event.request.url) event.request.url = redactSensitiveUrl(event.request.url);
    if (event.request.query_string && typeof event.request.query_string === 'string') {
      event.request.query_string = redactSensitiveUrl(`?${event.request.query_string}`).slice(1);
    }
  }
  if (event.transaction) event.transaction = redactSensitiveUrl(event.transaction);
  if (event.extra?.url) event.extra.url = redactSensitiveUrl(event.extra.url);
  if (Array.isArray(event.breadcrumbs)) event.breadcrumbs = event.breadcrumbs.map(redactSentryBreadcrumb);
  return event;
}

export function redactSentryBreadcrumb(crumb) {
  if (!crumb || typeof crumb !== 'object') return crumb;
  if (crumb.data?.url) crumb.data = { ...crumb.data, url: redactSensitiveUrl(crumb.data.url) };
  if (typeof crumb.message === 'string') crumb.message = redactSensitiveUrl(crumb.message);
  return crumb;
}
