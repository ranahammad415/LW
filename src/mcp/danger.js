/**
 * Danger classification for every OS request made through MCP (features/mcp-server.md §Danger classification).
 *
 * classifyRequest({ method, routePattern, path, query, body }) → { level, reasons, scopeRequired }
 *   level: 'read' | 'write' | 'dangerous' | 'blocked'
 * Order: the first `blocked` reason wins; otherwise every `dangerous` reason accumulates; else write (non-GET) or read.
 * - blocked:   never callable through MCP, with or without confirm (auth, tokens/secrets, webhooks, files, MCP itself).
 * - dangerous: needs the two-step confirm (preview + confirm_action): deletes, people/roles/plans, sends, publish,
 *              HUMAN_ONLY / approval routes, completing or cancelling a task, bulk, and costly (paid AI / DataForSEO /
 *              site) calls.
 * - write:     every other non-GET (audited, no confirm).
 * - read:      GET / HEAD (the only level an os:read grant may use).
 * Pure and deterministic; tests/unit/mcp/danger.test.js is a table over the rules.
 */

const BLOCKED_PREFIXES = [
  '/api/auth/',
  '/api/mcp',
  '/api/admin/mcp',
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

/** METHOD + route pattern that are never reachable (mint tokens, return plaintext secrets, set passwords, OAuth hops). */
const BLOCKED_ROUTES = new Set([
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
]);

/**
 * Routes that return files / HTML or take uploads (os_api_request cannot carry them usefully), and the per-task
 * Engine exact-result review routes (browser Origin + human reviewer only).
 */
const BLOCKED_PATTERN_RES = [/\/engine-review\//, /\/pdf$/,/\/export\.csv$/, /\/photos\/:photoId$/, /\/reports\/:month$/];

/** Never write secrets through MCP (checked in query and body, any depth ≤ 4). */
const SECRET_INPUT_KEYS = new Set(['password', 'passwordhash', 'clientsecret', 'wpapikey', 'apikey', 'secret', 'privatekey']);

const DANGEROUS_SEGMENT_RE = /\/(delete|erase|purge|revoke|rotate|reset|disconnect|publish|unpublish|schedule|unschedule|deploy|restore|send|resend|email|sms|notify|bulk|bulk-approve|bulk-reject|impersonate|members|users|roles?|plans?|packages?|billing|subscription|invoice|secret|tokens?|keys?|pairing|external-erased|disavow)(\/|$)/i;

const DANGEROUS_BODY_KEY_RE = /^(role|packageId|package|plan|tier|isActive|email|billing|leadPmId|secondaryPmId|canApproveDeliverables|canSignContracts|isAgent)$/;

/**
 * Explicit list (HUMAN_ONLY and approval routes: human-gated for agents and API tokens; MCP acts as the human, so the
 * human confirms). Each entry: [method regex, route pattern regex, reason].
 */
const WRITE = /^(POST|PUT|PATCH|DELETE)$/;
const EXPLICIT = [
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
  [WRITE, /\/cms-leads\/:leadId\/erase$/, 'erase'],
  [WRITE, /\/citations(\/|$)/, 'citations'],
  [/^POST$/, /^\/api\/pm\/pipeline\/:projectId\/:wpPipelineId\/(review|publish|schedule|unschedule|client-review)$/, 'approval'],
  [/^(POST|PATCH)$/, /^\/api\/pm\/keyword-suggestions\/:id\/(approve|reject)$/, 'approval'],
  [/^POST$/, /^\/api\/pm\/okf-review\/drafts\/(:id\/(approve|reject)|bulk-approve|bulk-reject)$/, 'approval'],
  [/^(POST|PATCH)$/, /^\/api\/pm\/reports\/:id\/approve$/, 'approval'],
  [/^PATCH$/, /^\/api\/projects\/:id\/keywords\/:keywordId\/(accept-edit|reject-edit)$/, 'approval'],
  [/^POST$/, /^\/api\/admin\/integrations\/google\/disconnect$/, 'disconnect'],
  [/^POST$/, /^\/api\/admin\/notifications\/send-test-email$/, 'sends email'],
  [/^POST$/, /^\/api\/admin\/interviews\/invites/, 'sends email'],
  [/^POST$/, /^\/api\/staff\/clients\/:clientId\/knowledge\/invites/, 'sends email'],
  [/^POST$/, /^\/api\/admin\/clients\/:id\/users$/, 'people'],
  [/^(PATCH|DELETE)$/, /^\/api\/admin\/clients\/:id\/users\/:userId$/, 'people'],
  [WRITE, /^\/api\/admin\/team\/members/, 'people'],
  [/^POST$/, /^\/api\/admin\/work-cycles/, 'work cycle'],
  [/^POST$/, /^\/api\/admin\/projects\/:id\/next-month/, 'bulk'],
  [/^POST$/, /^\/api\/projects\/:id\/tasks\/bulk$/, 'bulk'],
  [/^POST$/, /^\/api\/admin\/backlinks\/bulk$/, 'bulk'],
  [/^POST$/, /^\/api\/pm\/content-maps\/:mapId\/drift\/bulk$/, 'bulk'],
  // Paid AI / DataForSEO calls whose path words the costly token list does not catch (found by reading the handlers).
  [/^POST$/, /\/(suggest-tasks|prioritize-tasks|auto-assign-wp-access)$/, 'costly'],
  [/^POST$/, /^\/api\/pm\/input-requests\/:id\/draft$/, 'costly'],
  [/^POST$/, /\/(chat|interview\/(start|finish|review-site))$/, 'costly'],
  [/^PUT$/, /^\/api\/admin\/integrations\/clients\/:clientId\/projects\/:projectId$/, 'costly'],
];

/** HUMAN_ONLY_STATUSES in lib/agentPolicy.js. */
const HUMAN_ONLY_STATUSES = new Set(['COMPLETED', 'CANCELLED']);

/** Costly words, matched per static path segment token ('-' separated). `ai` and `run` are exact tokens. */
const COSTLY_TOKENS = ['generate', 'summar', 'sweep', 'sync', 'refresh', 'recompute', 'crawl', 'check', 'lighthouse', 'pagespeed', 'rank', 'grid', 'citations', 'visibility', 'nova', 'voice', 'extract', 'import'];

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

function hasSecretKey(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  if (Array.isArray(value)) return value.some((v) => hasSecretKey(v, depth + 1));
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_INPUT_KEYS.has(k.toLowerCase())) return true;
    if (hasSecretKey(v, depth + 1)) return true;
  }
  return false;
}

function largestArray(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return 0;
  if (Array.isArray(value)) return Math.max(value.length, ...value.map((v) => largestArray(v, depth + 1)));
  return Math.max(0, ...Object.values(value).map((v) => largestArray(v, depth + 1)));
}

export function classifyRequest({ method, routePattern, path, query, body } = {}) {
  const m = String(method || 'GET').toUpperCase() === 'HEAD' ? 'GET' : String(method || 'GET').toUpperCase();
  const pattern = String(routePattern || path || '');
  const actual = String(path || pattern).split('?')[0];
  const blocked = (reason) => ({ level: 'blocked', reasons: [reason], scopeRequired: null });

  // 1. Blocked
  if (!actual.startsWith('/api/') || !pattern.startsWith('/api/')) return blocked('outside /api');
  for (const p of BLOCKED_PREFIXES) {
    if (actual === p || actual.startsWith(p) || pattern.startsWith(p)) return blocked(`blocked area ${p}`);
  }
  if (BLOCKED_ROUTES.has(`${m} ${pattern}`)) return blocked('returns or sets a secret / mints a session');
  if (BLOCKED_PATTERN_RES.some((re) => re.test(pattern))) return blocked('file / upload route');
  if (hasSecretKey(query) || hasSecretKey(body)) return blocked('secret field in the request');

  if (m === 'GET') {
    // 4. Read (a GET with ?refresh=true may trigger a paid recompute)
    if (query && truthy(query.refresh)) return { level: 'dangerous', reasons: ['costly'], scopeRequired: 'os:write' };
    return { level: 'read', reasons: [], scopeRequired: 'os:read' };
  }

  // 2. Dangerous
  const reasons = [];
  const add = (r) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  if (m === 'DELETE') add('delete');
  const seg = pattern.match(DANGEROUS_SEGMENT_RE);
  if (seg) add(`path: ${seg[1].toLowerCase()}`);
  if ((m === 'POST' || m === 'PATCH' || m === 'PUT') && body && typeof body === 'object' && !Array.isArray(body)) {
    for (const k of Object.keys(body)) if (DANGEROUS_BODY_KEY_RE.test(k)) add(`changes ${k}`);
  }
  for (const [mre, pre, why] of EXPLICIT) if (mre.test(m) && pre.test(pattern)) add(why);
  if (m === 'PATCH' && pattern === '/api/tasks/:id/status' && HUMAN_ONLY_STATUSES.has(String(body?.status || '').toUpperCase())) {
    add('completes or cancels a task');
  }
  if (/\/bulk/.test(pattern) || largestArray(body) > 20) add('bulk');
  if (isCostlyPattern(pattern)) add('costly');
  if (reasons.length) return { level: 'dangerous', reasons, scopeRequired: 'os:write' };

  // 3. Write
  return { level: 'write', reasons: [], scopeRequired: 'os:write' };
}
