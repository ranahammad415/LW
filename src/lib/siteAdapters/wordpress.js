/**
 * WordPress (Localwave Agent / agency-os-bridge plugin, `wp-json/lwa/v1`) side of the
 * SiteAdapter seam. MOVE-ONLY extraction of the fetch code that used to live inline in
 * routes/pm/pipeline.js, lib/pipelineSync.js, lib/wpSync.js, routes/projects.js and
 * routes/webhooks.js: same URLs, headers, User-Agents, timeouts, WAF-safe route names and
 * payload parsing. Callers keep their own response handling, so WordPress behaviour is
 * unchanged. See docs/ledger/emdash-bridge.md "WordPress extraction" for what moved and
 * what was deliberately left in place (tasks/issues JWT login, sessions, activity log).
 */
import { parseWpDate } from '../pipelineFormat.js';

/** Build WP agent headers (pipeline sync / pipeline mutations). */
export function wpHeaders(apiKey) {
  return {
    'X-LWA-API-Key': apiKey,
    Accept: 'application/json',
    'User-Agent': 'Localwaves-AgencyOS/1.0 (+https://localwaves; pipeline sync)',
  };
}

/** Headers many WordPress hosts expect (bare fetch() can be blocked as a bot). Page sync. */
export function wpAgentHeaders(apiKey) {
  return {
    'X-LWA-API-Key': apiKey,
    Accept: 'application/json',
    'User-Agent': 'Localwaves-AgencyOS/1.0 (+https://localwaves; WP page sync)',
  };
}

export function wpBaseUrl(wpUrl) {
  return String(wpUrl || '').replace(/\/$/, '');
}

/**
 * Abort OS→WP sooner than typical edge proxy_read_timeout so Fastify can
 * always return CORS-safe JSON (502) before the browser connection is reset.
 * Kept under ~5s so common edge/nginx read timeouts do not drop the browser
 * connection as a bare "Failed to fetch".
 */
export const WP_MUTATION_TIMEOUT_MS = 4500;

/** Short budget for a best-effort preview-URL heal after a failed mutate. */
export const WP_HEAL_TIMEOUT_MS = 2000;

/**
 * Best-effort: pull PM/client preview URLs for one pipeline from WordPress.
 * Used when regenerate times out/fails so OS can still backfill any URLs WP
 * is able to display (or when legacy rows omit token_plain until regenerate).
 */
export async function fetchWpPipelinePreviewUrls({ baseUrl, apiKey, pipelineId, wpPostId }) {
  const headers = wpHeaders(apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WP_HEAL_TIMEOUT_MS);
  try {
    let item = null;
    if (wpPostId) {
      const res = await fetch(`${baseUrl}/wp-json/lwa/v1/pipeline/${wpPostId}`, {
        headers,
        signal: controller.signal,
      });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json && Number(json.id) === pipelineId) item = json;
      }
    }
    if (!item) {
      const res = await fetch(
        `${baseUrl}/wp-json/lwa/v1/pipeline?page=1&per_page=100`,
        { headers, signal: controller.signal }
      );
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      const batch = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      item = batch.find((p) => Number(p.id) === pipelineId) || null;
    }
    if (!item) return null;
    const pmPreviewUrl = String(item.pmPreviewUrl || '').slice(0, 1000) || null;
    const clientPreviewUrl = String(item.clientPreviewUrl || '').slice(0, 1000) || null;
    if (!pmPreviewUrl && !clientPreviewUrl) return null;
    return { pmPreviewUrl, clientPreviewUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** POST /pipeline/:id/pm-review. Returns the raw fetch Response (throws on network/timeout). */
export function wpPmReview({ baseUrl, apiKey, pipelineId, body }) {
  return fetch(`${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/pm-review`, {
    method: 'POST',
    headers: {
      ...wpHeaders(apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

/** POST /pipeline/:id/publish. Returns the raw fetch Response. */
export function wpPublish({ baseUrl, apiKey, pipelineId }) {
  return fetch(`${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/publish`, {
    method: 'POST',
    headers: {
      ...wpHeaders(apiKey),
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
}

/**
 * Ordered rotate/renew attempts. change-type first: already known to pass the
 * Milwaukee Signs WAF.
 */
export function wpRenewAttempts(baseUrl, pipelineId) {
  return [
    {
      method: 'POST',
      url: `${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/change-type`,
      body: JSON.stringify({ rotate_links: true }),
    },
    { method: 'POST', url: `${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/rotate`, body: '{}' },
    { method: 'GET', url: `${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/rotate` },
    {
      method: 'POST',
      url: `${baseUrl}/?rest_route=/lwa/v1/pipeline/${pipelineId}/rotate`,
      body: '{}',
    },
    { method: 'POST', url: `${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/renew-preview`, body: '{}' },
    { method: 'POST', url: `${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/regenerate-links`, body: '{}' },
  ];
}

/** One rotate/renew attempt with the mutation timeout. Returns the raw fetch Response. */
export async function callWpRenew({ apiKey, method, url, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WP_MUTATION_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      headers: {
        ...wpHeaders(apiKey),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /pipeline/:id/change-type. The WP path deliberately avoids the literal
 * token "content-type" because some hosts' WAF/ModSecurity rules reset
 * connections to URLs containing it (flagged as header-injection).
 */
export async function wpChangeType({ baseUrl, apiKey, pipelineId, contentType, actor }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WP_MUTATION_TIMEOUT_MS);
  try {
    return await fetch(`${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/change-type`, {
      method: 'POST',
      headers: {
        ...wpHeaders(apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content_type: contentType, actor: actor || '' }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** POST /pipeline/:id/cancel with force + as_admin (owner delete). Returns the raw Response. */
export function wpCancelForce({ baseUrl, apiKey, pipelineId }) {
  return fetch(`${baseUrl}/wp-json/lwa/v1/pipeline/${pipelineId}/cancel`, {
    method: 'POST',
    headers: {
      ...wpHeaders(apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ force: true, as_admin: true }),
    signal: AbortSignal.timeout(15000),
  });
}

/** GET /pipeline?page=&per_page=100 (pipeline sync). Returns the raw Response. */
export function wpFetchPipelinePage({ baseUrl, apiKey, page }) {
  return fetch(`${baseUrl}/wp-json/lwa/v1/pipeline?page=${page}&per_page=100`, {
    headers: wpHeaders(apiKey),
    signal: AbortSignal.timeout(15000),
  });
}

/**
 * Normalize REST payload: supports top-level array or { data: [...] } (and accidental nesting).
 */
export function extractWpPagesArray(json) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json)) return json;
  const d = json.data;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object' && Array.isArray(d.data)) return d.data;
  return [];
}

/**
 * Fetch all pages from a WP site's Localwave Agent REST API, paginating until exhausted.
 */
export async function fetchAllWpPages(wpUrl, wpApiKey) {
  const baseUrl = String(wpUrl || '').trim().replace(/\/$/, '');
  const allPages = [];
  const perPage = 100;
  let page = 1;

  while (true) {
    const url = `${baseUrl}/wp-json/lwa/v1/pages?per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      headers: wpAgentHeaders(wpApiKey),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown');
      throw new Error(`WP API error ${res.status}: ${body.slice(0, 500)}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error(
        'WP site did not return JSON for /wp-json/lwa/v1/pages. Check the site URL (include https) and that the Localwave Agent plugin is active.'
      );
    }
    const json = await res.json();
    const items = extractWpPagesArray(json);
    allPages.push(...items);

    if (items.length === 0) break;

    const reportedTotalPages = parseInt(json.total_pages, 10);
    const moreByMeta = Number.isFinite(reportedTotalPages) && page < reportedTotalPages;
    const moreByFullPage = items.length >= perPage && !Number.isFinite(reportedTotalPages);
    if (!moreByMeta && !moreByFullPage) break;
    page++;
  }

  return allPages;
}

export async function fetchWpSiteInfo(wpUrl, wpApiKey) {
  const baseUrl = String(wpUrl || '').trim().replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/wp-json/lwa/v1/site-info`, {
    headers: wpAgentHeaders(wpApiKey),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return {
    theme: json?.theme || null,
    plugins: Array.isArray(json?.plugins)
      ? json.plugins.filter((p) => p && p.active).map((p) => ({ name: String(p.name || ''), version: String(p.version || '') }))
      : [],
  };
}

/** GET /pages/:id/timeline. Returns the raw Response (caller tolerates failure). */
export function wpPageTimeline({ wpUrl, apiKey, wpPostId }) {
  const url = `${wpUrl.replace(/\/$/, '')}/wp-json/lwa/v1/pages/${wpPostId}/timeline`;
  return fetch(url, {
    headers: { 'X-LWA-API-Key': apiKey },
    signal: AbortSignal.timeout(15000),
  });
}

/** POST /pages/:id/create-update-draft ("Update Content"). Returns the raw Response. */
export function wpCreateUpdateDraft({ baseUrl, apiKey, postId }) {
  return fetch(`${baseUrl}/wp-json/lwa/v1/pages/${postId}/create-update-draft`, {
    method: 'POST',
    headers: { 'X-LWA-API-Key': apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
}

/**
 * Parse a `wp-pipeline-event` webhook body into the shared normalized review event
 * (lib/reviewEvents.js). Moved verbatim from routes/webhooks.js.
 */
export function normalizePipelineWebhook(body) {
  const wpPipelineId = Number(body.pipelineId);
  const eventType = String(body.eventType || '').trim();
  const wpPostId = Number(body.postId) || 0;
  const postTitle = String(body.postTitle || '').slice(0, 500);
  const postType = body.postType ? String(body.postType).slice(0, 50) : 'Page';
  // Worker-selected content/page type (landing_page, pillar_page, article, ...).
  const contentType = body.contentType ? String(body.contentType).slice(0, 50) : null;
  // "Update Content" workflow: the live parent page a review draft was cloned
  // from, and a generic human-readable log line (e.g. content-type change).
  const parentWpPostId = Number.isInteger(Number(body.parentPostId)) && Number(body.parentPostId) > 0
    ? Number(body.parentPostId)
    : null;
  const logMessage = body.logMessage ? String(body.logMessage).slice(0, 500) : null;
  const status = String(body.status || '').slice(0, 50);
  const revisionNumber = Number(body.revisionNumber) || 1;
  const pmPreviewUrl = String(body.pmPreviewUrl || '').slice(0, 1000) || null;
  const clientPreviewUrl = String(body.clientPreviewUrl || '').slice(0, 1000) || null;
  const pmDecision = body.pmDecision ? String(body.pmDecision).slice(0, 50) : null;
  const pmComment = body.pmComment ? String(body.pmComment).slice(0, 10000) : null;
  const clientDecision = body.clientDecision ? String(body.clientDecision).slice(0, 50) : null;
  const clientComment = body.clientComment ? String(body.clientComment).slice(0, 10000) : null;

  const submittedByName = body.submittedBy?.name ? String(body.submittedBy.name).slice(0, 200) : null;
  const submittedById = body.submittedBy?.memberId ? String(body.submittedBy.memberId).slice(0, 100) : null;
  const pmMemberName = body.pmAssigned?.name ? String(body.pmAssigned.name).slice(0, 200) : null;
  const pmMemberId = body.pmAssigned?.memberId ? String(body.pmAssigned.memberId).slice(0, 100) : null;
  const workerNote = body.workerNote ? String(body.workerNote).slice(0, 10000) : null;
  const pmReviewedAt = body.pmReviewedAt ? String(body.pmReviewedAt).slice(0, 50) : null;
  const clientReviewedAt = body.clientReviewedAt ? String(body.clientReviewedAt).slice(0, 50) : null;
  const wpCreatedAt = parseWpDate(body.createdAt);
  const wpUpdatedAt = parseWpDate(body.updatedAt) || new Date();

  return {
    source: 'WORDPRESS',
    wpPipelineId,
    eventType,
    wpPostId,
    postTitle,
    postType,
    contentType,
    parentWpPostId,
    logMessage,
    status,
    revisionNumber,
    pmPreviewUrl,
    clientPreviewUrl,
    pmDecision,
    pmComment,
    clientDecision,
    clientComment,
    submittedByName,
    submittedById,
    pmMemberName,
    pmMemberId,
    workerNote,
    pmReviewedAt,
    clientReviewedAt,
    wpCreatedAt,
    wpUpdatedAt,
    // AI summary source on submit / resubmit / resend (WP sends the excerpt).
    summaryExcerpt: String(body.postExcerpt || body.postContent || '').slice(0, 4000),
    isElementor: !!body.isElementor,
    testMode: body.testMode === true || body.testMode === 'true' || body.testMode === 1,
    testEmails: body.testEmails || {},
    cms: null,
  };
}

/** Adapter descriptor (capabilities as the OS uses them; the WP plugin has no flags). */
export const wordpressAdapter = {
  type: 'WORDPRESS',
  info() {
    return {
      type: 'WORDPRESS',
      contractVersion: null,
      capabilities: {
        publishFromOs: true,
        rotateLinks: true,
        previewLinks: true,
        updateContentClone: true,
        autoLogin: true,
        timeline: true,
      },
    };
  },
  isConfigured(project) {
    return !!(project?.wpUrl && project?.wpApiKey);
  },
};
