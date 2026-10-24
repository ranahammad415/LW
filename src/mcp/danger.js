/**
 * Danger classification for every OS request made through MCP (features/mcp-server.md §Danger classification).
 *
 * classifyRequest({ method, routePattern, path, query, body, routeConfig }) → { level, reasons, scopeRequired }
 *   level: 'read' | 'write' | 'dangerous' | 'critical' | 'blocked'
 * Order: the first `blocked` reason wins; then `critical` reasons; then `dangerous` reasons; else write / read.
 * - blocked:   never callable through MCP (auth, tokens/secrets, session-minting links, webhooks, files, MCP itself).
 * - critical:  preview + confirm_action + out-of-band approval by the owner in the OS UI (MCP_CRITICAL_APPROVAL):
 *              people / roles / invites, key / token / secret rotation, site publish / schedule, sends to clients,
 *              CMS migration, site URL / CMS changes, deleting a client / project / user, lead / visitor erasure.
 * - dangerous: preview + confirm_action in the chat: other deletes, plans, HUMAN_ONLY / approval routes, completing or
 *              cancelling a task, bulk, credential-adjacent settings, and costly (paid AI / DataForSEO / site) calls.
 * - write:     every other non-GET (audited, no confirm).
 * - read:      GET / HEAD (the only level an os:read grant may use).
 * `routeConfig.mcp` ('blocked' | 'critical' | 'costly' | 'dangerous') on a Fastify route adds to the rules.
 * Pure and deterministic; tests/unit/mcp/danger.test.js is a table over the rules. The same function runs again on
 * the route Fastify actually matched (src/mcp/routeGuard.js), so an encoded path cannot dodge it.
 */
import { isSecretKey } from './redact.js';

const BLOCKED_PREFIXES = [
  '/api/auth/',
  '/api/mcp',
  '/api/admin/mcp',
  // OS Backups (features/os-backups.md): human-only full-DB backup, restore and download; reads included.
  '/api/admin/os-backups',
  '/api/public/',
  '/api/webhooks/',
  '/api/tool/',
  '/api/omni-search/',
  '/api/realtime/',
  '/api/engine/',
  '/api/engine-review/',
  '/uploads/',
  '/health',
];

/** METHOD + route pattern never reachable: mint sessions / login links, return plaintext secrets, set passwords. */
export const BLOCKED_ROUTES = new Set([
  'POST /api/admin/impersonate',
  'POST /api/admin/change-password',
  'GET /api/admin/integrations/google/connect',
  'GET /api/admin/integrations/google/callback',
  'POST /api/admin/api-tokens',
  'POST /api/projects/:id/cms/pairing-code',
  'POST /api/projects/:id/cms/rotate-keys',
  'POST /api/pm/projects/:projectId/integrations/ghl-forms/token',
  'POST /api/pm/projects/:projectId/integrations/ghl-forms/rotate',
  'POST /api/pm/projects/:projectId/integrations/ghl-forms/header-secret',
  'POST /api/admin/clients/:id/reset-password',
  // One-click WordPress logins (`?agency_token=` login URLs) and staff preview links (capability URLs).
  'POST /api/tasks/:id/wp-login',
  'POST /api/pm/issues/:id/wp-login',
  'POST /api/pm/pipeline/:projectId/:wpPipelineId/preview-link',
  'POST /api/pm/pipeline/:projectId/:wpPipelineId/renew-preview',
  'POST /api/pm/pipeline/:projectId/:wpPipelineId/regenerate-preview-links',
]);

/**
 * Routes that return files / HTML or take uploads (os_api_request cannot carry them usefully), and the per-task
 * Engine exact-result review routes (browser Origin + human reviewer only).
 */
const BLOCKED_PATTERN_RES = [/\/engine-review\//, /\/pdf$/, /\/export\.csv$/, /\/photos\/:photoId$/, /\/reports\/:month$/];

/** Exact names kept for clarity; the suffix rule of redact.js isSecretKey (password, token, secret, apiKey, …) also applies. */
const SECRET_INPUT_KEYS = new Set(['password', 'passwordhash', 'clientsecret', 'wpapikey', 'apikey', 'secret', 'privatekey']);

const DANGEROUS_SEGMENT_RE = /\/(delete|erase|purge|revoke|reset|disconnect|restore|bulk|bulk-approve|bulk-reject|plans?|packages?|billing|subscription|invoice|external-erased|disavow)(\/|$)/i;
const CRITICAL_SEGMENT_RE = /\/(rotate|rotate-keys|keys?|tokens?|secret|pairing|publish|unpublish|schedule|unschedule|deploy|send|resend|email|sms|notify|invites?|impersonate|members|users|roles?)(\/|$)/i;

/** Body keys that change plans / ownership / sender identity, or point the OS at another host (credential exfiltration). */
const DANGEROUS_BODY_KEY_RE = /^(packageId|package|plan|tier|isActive|email|billing|leadPmId|secondaryPmId|canApproveDeliverables|canSignContracts|emailHeaderHtml|emailFooterHtml|emailFromAddress|emailFromName)$/;
const DANGEROUS_BODY_KEY_LOOSE_RE = /url$|webhook/i;
/** Email content keys: dangerous on notification / email / template routes (re-review N1: phishing from the agency sender). */
const EMAIL_CONTENT_KEY_RE = /^(subject|bodyHtml|bodyText|inAppMessage|ctaLabel)$/;
const EMAIL_ROUTE_RE = /\/(notifications?|emails?|templates?|digest)(\/|-|$)/i;
/** Body keys that are critical: roles / agent flag, and the site the OS sends its plugin key to. */
const CRITICAL_BODY_KEY_RE = /^(role|isAgent|wpUrl|siteUrl|cmsType)$|webhook/i;

const WRITE = /^(POST|PUT|PATCH|DELETE)$/;

/** Explicit dangerous list (HUMAN_ONLY and approval routes, paid routes the costly words miss). [method, pattern, reason]. */
const EXPLICIT_DANGEROUS = [
  [WRITE, /^\/api\/pm\/security\//, 'security'],
  [WRITE, /^\/api\/admin\/security-settings/, 'security'],
  [WRITE, /^\/api\/pm\/projects\/:projectId\/health/, 'health'],
  [WRITE, /^\/api\/pm\/clients\/:clientId\/health-note$/, 'health'],
  [WRITE, /^\/api\/admin\/health\//, 'health'],
  [WRITE, /\/local-seo(\/|$)/, 'local-seo'],
  [WRITE, /\/seo-monitoring(\/|$)/, 'seo-monitoring'],
  [WRITE, /^\/api\/pm\/signals\//, 'signals'],
  [WRITE, /\/site-metrics\/.*refresh/, 'costly'],
  [WRITE, /^\/api\/pm\/projects\/:projectId\/integrations\/ghl-forms/, 'integrations'],
  [WRITE, /\/citations(\/|$)/, 'citations'],
  [/^POST$/, /^\/api\/pm\/pipeline\/:projectId\/:wpPipelineId\/(review|client-review)$/, 'approval'],
  [/^(POST|PATCH)$/, /^\/api\/pm\/keyword-suggestions\/:id\/(approve|reject)$/, 'approval'],
  [/^POST$/, /^\/api\/pm\/okf-review\/drafts\/(:id\/(approve|reject)|bulk-approve|bulk-reject)$/, 'approval'],
  [/^(POST|PATCH)$/, /^\/api\/pm\/reports\/:id\/approve$/, 'approval'],
  [/^PATCH$/, /^\/api\/projects\/:id\/keywords\/:keywordId\/(accept-edit|reject-edit)$/, 'approval'],
  [/^POST$/, /^\/api\/admin\/integrations\/google\/disconnect$/, 'disconnect'],
  [/^POST$/, /^\/api\/admin\/work-cycles/, 'work cycle'],
  // Notification / email templates and their test sends (re-review N1).
  [WRITE, /^\/api\/admin\/notifications\/(templates|test)(\/|$)/, 'email templates'],
  [/^POST$/, /^\/api\/admin\/projects\/:id\/next-month/, 'bulk'],
  [/^POST$/, /^\/api\/projects\/:id\/tasks\/bulk$/, 'bulk'],
  [/^POST$/, /^\/api\/admin\/backlinks\/bulk$/, 'bulk'],
  [/^POST$/, /^\/api\/pm\/content-maps\/:mapId\/drift\/bulk$/, 'bulk'],
  // Every non-GET of the knowledge engine and intake (AI article / strategy / interview / crawl / reindex …).
  [WRITE, /\/knowledge\//, 'costly'],
  [WRITE, /\/intake\//, 'costly'],
  // Paid AI / DataForSEO / site calls found by tracing handlers to lib/ai.js, openrouter, dataforseo, voice and
  // AiUsageLog (the costly path words miss them).
  [/^POST$/, /\/(suggest-tasks|prioritize-tasks|auto-assign-wp-access)$/, 'costly'],
  [/^POST$/, /^\/api\/pm\/input-requests\/:id\/draft$/, 'costly'],
  [/^POST$/, /\/(chat|interview\/(start|finish|review-site|turn|followup))$/, 'costly'],
  [/^PUT$/, /^\/api\/admin\/integrations\/clients\/:clientId\/projects\/:projectId$/, 'costly'],
  [/^POST$/, /^\/api\/admin\/integrations\/health\/probe-gmb$/, 'costly'],
  [/^POST$/, /^\/api\/admin\/interviews\/agenda\/preview$/, 'costly'],
  [WRITE, /^\/api\/(admin|pm)\/project-html-reports/, 'costly'],
  [/^POST$/, /^\/api\/pm\/clients\/:clientId\/pm-update$/, 'sends to the client'],
  [/^POST$/, /^\/api\/pm\/projects\/:projectId\/seo-profiles\/:pageId\/proposals$/, 'site'],
  [/^POST$/, /^\/api\/client\/analytics\/ai-html-report$/, 'costly'],
  [/^POST$/, /^\/api\/client\/voice-agent\//, 'costly'],
  [/^POST$/, /^\/api\/pm\/reports\/generate$/, 'costly'],
];

/**
 * Explicit critical list (out-of-band owner approval). Tested in danger.test.js; keep it explicit.
 * [method, pattern, reason].
 */
export const EXPLICIT_CRITICAL = [
  [/^POST$/, /^\/api\/pm\/pipeline\/:projectId\/:wpPipelineId\/(publish|schedule|unschedule)$/, 'site publish'],
  [/^POST$/, /^\/api\/admin\/notifications\/send-test-email$/, 'sends email'],
  [/^POST$/, /^\/api\/admin\/interviews\/invites/, 'sends email to clients'],
  [/^POST$/, /^\/api\/staff\/clients\/:clientId\/knowledge\/invites/, 'sends email to clients'],
  [/^POST$/, /^\/api\/admin\/clients\/:id\/users$/, 'people'],
  [/^(PATCH|DELETE)$/, /^\/api\/admin\/clients\/:id\/users\/:userId$/, 'people'],
  [WRITE, /^\/api\/admin\/team\/members/, 'people'],
  [WRITE, /^\/api\/admin\/users/, 'people'],
  [/^POST$/, /^\/api\/projects\/:id\/cms\/migration\/apply$/, 'cms migration'],
  [/^POST$/, /^\/api\/projects\/:id\/cms\/disconnect$/, 'site disconnect'],
  [/^DELETE$/, /^\/api\/(admin\/clients|projects|admin\/projects)\/:[A-Za-z]+$/, 'deletes a client / project'],
  [/^DELETE$/, /\/(users|members)\/:[A-Za-z]+$/, 'deletes a user'],
  [WRITE, /\/cms-leads\/:leadId\/erase$/, 'lead erase'],
  [WRITE, /^\/api\/pm\/signals\/projects\/:projectId\/erase$/, 'visitor erase'],
];

/** HUMAN_ONLY_STATUSES in lib/agentPolicy.js. */
const HUMAN_ONLY_STATUSES = new Set(['COMPLETED', 'CANCELLED']);

/** Costly words, matched per static path segment token ('-' separated). `ai` and `run` are exact tokens. */
const COSTLY_TOKENS = ['generate', 'summar', 'sweep', 'sync', 'refresh', 'recompute', 'crawl', 'check', 'lighthouse', 'pagespeed', 'rank', 'grid', 'citations', 'visibility', 'nova', 'voice', 'extract', 'import', 'aeo', 'transcribe'];

function isCostlyPattern(pattern) {
  for (const seg of String(pattern).split('/')) {
    if (!seg || seg.startsWith(':')) continue;
    for (const tok of seg.toLowerCase().split('-')) {
      if (tok === 'ai' || tok === 'run' || tok === 'runs') return true;
      if (COSTLY_TOKENS.some((w) => tok.includes(w))) return true;
    }
  }
  return false;
}

function truthy(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return ['1', 'true', 'yes'].includes(v.trim().toLowerCase());
  return false;
}

/** True when any key (any depth ≤ 4) looks like a secret: exact names or the redact.js suffix rule. */
export function hasSecretKey(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  if (Array.isArray(value)) return value.some((v) => hasSecretKey(v, depth + 1));
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_INPUT_KEYS.has(k.toLowerCase()) || isSecretKey(k)) return true;
    if (hasSecretKey(v, depth + 1)) return true;
  }
  return false;
}

function largestArray(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return 0;
  if (Array.isArray(value)) return Math.max(value.length, ...value.map((v) => largestArray(v, depth + 1)));
  return Math.max(0, ...Object.values(value).map((v) => largestArray(v, depth + 1)));
}

/** Route patterns compare without a trailing slash (Fastify registers `/x` and `/x/` for a prefix + '/'). */
export function normalizePattern(p) {
  const s = String(p || '');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

export function classifyRequest({ method, routePattern, path, query, body, routeConfig } = {}) {
  const m = String(method || 'GET').toUpperCase() === 'HEAD' ? 'GET' : String(method || 'GET').toUpperCase();
  const pattern = normalizePattern(routePattern || path || '');
  const actual = String(path || pattern).split('?')[0];
  const blocked = (reason) => ({ level: 'blocked', reasons: [reason], scopeRequired: null });
  const mark = routeConfig && typeof routeConfig.mcp === 'string' ? routeConfig.mcp : null;

  // 1. Blocked
  if (!actual.startsWith('/api/') || !pattern.startsWith('/api/')) return blocked('outside /api');
  if (actual.includes('%') || pattern.includes('%')) return blocked('encoded path');
  for (const p of BLOCKED_PREFIXES) {
    if (actual === p || actual.startsWith(p) || pattern.startsWith(p)) return blocked(`blocked area ${p}`);
  }
  if (mark === 'blocked') return blocked('route marked blocked for MCP');
  if (BLOCKED_ROUTES.has(`${m} ${pattern}`)) return blocked('returns or sets a secret / mints a session or login link');
  if (BLOCKED_PATTERN_RES.some((re) => re.test(pattern))) return blocked('file / upload route');
  if (hasSecretKey(query) || hasSecretKey(body)) return blocked('secret field in the request');

  if (m === 'GET') {
    // 4. Read (a GET with ?refresh=true may trigger a paid recompute)
    if ((query && truthy(query.refresh)) || mark === 'costly') return { level: 'dangerous', reasons: ['costly'], scopeRequired: 'os:write' };
    return { level: 'read', reasons: [], scopeRequired: 'os:read' };
  }

  const reasons = [];
  const add = (r) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  const bodyKeys = (m === 'POST' || m === 'PATCH' || m === 'PUT') && body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];

  // 2. Critical
  const critical = [];
  const addC = (r) => {
    if (!critical.includes(r)) critical.push(r);
  };
  if (mark === 'critical') addC('route marked critical for MCP');
  const cseg = pattern.match(CRITICAL_SEGMENT_RE);
  if (cseg) addC(`path: ${cseg[1].toLowerCase()}`);
  for (const k of bodyKeys) if (CRITICAL_BODY_KEY_RE.test(k)) addC(`changes ${k}`);
  for (const [mre, pre, why] of EXPLICIT_CRITICAL) if (mre.test(m) && pre.test(pattern)) addC(why);

  // 3. Dangerous
  if (m === 'DELETE') add('delete');
  if (mark === 'costly' || mark === 'dangerous') add(mark);
  const seg = pattern.match(DANGEROUS_SEGMENT_RE);
  if (seg) add(`path: ${seg[1].toLowerCase()}`);
  for (const k of bodyKeys) if (DANGEROUS_BODY_KEY_RE.test(k) || DANGEROUS_BODY_KEY_LOOSE_RE.test(k)) add(`changes ${k}`);
  if (EMAIL_ROUTE_RE.test(pattern)) for (const k of bodyKeys) if (EMAIL_CONTENT_KEY_RE.test(k)) add(`changes email ${k}`);
  for (const [mre, pre, why] of EXPLICIT_DANGEROUS) if (mre.test(m) && pre.test(pattern)) add(why);
  if (m === 'PATCH' && pattern === '/api/tasks/:id/status' && HUMAN_ONLY_STATUSES.has(String(body?.status || '').toUpperCase())) {
    add('completes or cancels a task');
  }
  if (/\/bulk/.test(pattern) || largestArray(body) > 20) add('bulk');
  if (isCostlyPattern(pattern)) add('costly');

  if (critical.length) return { level: 'critical', reasons: [...critical, ...reasons.filter((r) => !critical.includes(r))], scopeRequired: 'os:write' };
  if (reasons.length) return { level: 'dangerous', reasons, scopeRequired: 'os:write' };
  // 4. Write
  return { level: 'write', reasons: [], scopeRequired: 'os:write' };
}

/** dangerous or critical: needs a confirm step. */
export function needsConfirm(level) {
  return level === 'dangerous' || level === 'critical';
}
