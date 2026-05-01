/**
 * Lightweight Sentry wrapper for OmniSearch (and the rest of the app).
 *
 * Behaviour:
 *   - If SENTRY_DSN is set AND @sentry/node is installed, real Sentry is initialized
 *     and errors are forwarded to Sentry with tags/context.
 *   - If SENTRY_DSN is set but @sentry/node is NOT installed, a warning is logged
 *     once and errors fall back to server logs.
 *   - If SENTRY_DSN is not set, this module is a complete no-op.
 *
 * This keeps Sentry truly optional — teams can install @sentry/node later
 * without any code changes here. To enable:
 *   npm install --save @sentry/node
 *   set SENTRY_DSN in .env
 */

let sentry = null;
let initialized = false;
let warnedMissingPackage = false;

async function loadSentry(logger) {
  if (initialized) return sentry;
  initialized = true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;

  try {
    // Dynamic import so the package is only required when SENTRY_DSN is set
    const mod = await import('@sentry/node');
    sentry = mod;
    sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.SENTRY_RELEASE,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0,
    });
    logger?.info?.('Sentry initialized');
    return sentry;
  } catch (err) {
    if (!warnedMissingPackage) {
      warnedMissingPackage = true;
      logger?.warn?.(
        '[sentry] SENTRY_DSN is set but @sentry/node is not installed. Run `npm install @sentry/node` to enable error reporting. Falling back to server logs.',
      );
    }
    return null;
  }
}

/**
 * Initialize Sentry early in app boot. Safe to call even without DSN.
 */
export async function initSentry(logger) {
  return loadSentry(logger);
}

/**
 * Capture a generic exception with optional context. Always safe to call.
 */
export async function captureException(err, context = {}) {
  const s = await loadSentry();
  if (!s) return;
  try {
    s.withScope((scope) => {
      if (context.tags) scope.setTags(context.tags);
      if (context.extra) scope.setExtras(context.extra);
      if (context.user) scope.setUser(context.user);
      if (context.level) scope.setLevel(context.level);
      s.captureException(err);
    });
  } catch {
    /* never let Sentry itself throw */
  }
}

/**
 * Specialized helper for OmniSearch errors. Stamps the `omnisearch.source` tag
 * (e.g. "rankings", "backlinks", "geo") so errors can be filtered by module.
 */
export async function captureOmniSearchError(source, err, extra = {}) {
  await captureException(err, {
    tags: { 'omnisearch.source': source },
    extra,
  });
}

/**
 * Fastify error hook — attach this to the OmniSearch plugin to forward any
 * unhandled route error to Sentry without changing individual handlers.
 *
 * Usage (in routes/omniSearch/index.js):
 *   import { registerOmniSearchSentryHook } from '../../lib/sentry.js';
 *   registerOmniSearchSentryHook(app);
 */
export function registerOmniSearchSentryHook(app) {
  app.addHook('onError', async (request, reply, error) => {
    // best-effort — never block the response
    const source = request.routeOptions?.url?.split('/')[1] || 'unknown';
    captureOmniSearchError(source, error, {
      url: request.url,
      method: request.method,
      userId: request.user?.id,
    }).catch(() => {});
  });
}
