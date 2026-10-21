/**
 * EmDash side of the SiteAdapter seam: signed OS → site calls to
 * `POST {siteUrl}/_emdash/api/plugins/agency-os-bridge/<route>` (contract v1 §5.1) and the
 * pure normalisers that turn contract `Review` / `entry` objects into the legacy
 * WpContentReview / WpPage shapes (surrogate integers in wpPipelineId / wpPostId, §8.3).
 *
 * Phase 1: no publish/schedule from the OS (§1 owner decision). `publishNotAllowed()`
 * builds the actionable 403 locally; the site would answer the same.
 */
import crypto from 'node:crypto';
import {
  SITE_ROUTE_PREFIX,
  SUPPORTED_CONTRACTS,
  signRequest,
  signedPathFor,
  ERROR_CODES,
} from './signing.js';
import { decryptCmsSecret, cmsAad } from '../cmsKeyCrypto.js';
import { guardedFetch } from './netGuard.js';
import { safeEmdashLink, sanitizeEmdashLinks } from '../siteLinks.js';
import { limitOutline } from './outline.js';
import { STATUS_LABELS } from '../pipelineFormat.js';

export const EMDASH_USER_AGENT = 'Localwaves-AgencyOS/1.0 (agency-os-bridge)';
export const READ_RETRY_DELAYS_MS = Object.freeze([1000, 4000, 10000]);
/** Interactive (PM clicked a button): one quick retry, then surface the error. */
export const INTERACTIVE_RETRY_DELAYS_MS = Object.freeze([1000]);
export const DEFAULT_TIMEOUT_MS = 10_000;

export const MUTATION_ROUTES = new Set([
  'draft-upsert',
  'pipeline-submit',
  'pipeline-review',
  'pipeline-send-to-client',
  'pipeline-cancel',
  'pipeline-change-type',
  'pipeline-rotate-links',
  'media-import',
  'pipeline-client-review',
  'pipeline-publish',
  'pipeline-schedule',
  // v1.3.0 §24
  'pipeline-unschedule',
  'preview-link',
  // v1.4.0 §25
  'proposal-create',
  'profile-upsert',
  'brief-upsert',
  // v1.5.0 §26
  'lead-erase',
  // v1.6.1 §37 (human OWNER / PM only; the OS refuses agents and tokens before calling)
  'security-config-set',
  'security-run',
  'security-ack',
]);

export class CmsBridgeError extends Error {
  constructor({ status = 502, code = 'UPSTREAM_UNAVAILABLE', message, retryable = false, details } = {}) {
    super(message || code);
    this.name = 'CmsBridgeError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}

const CONTRACT_HELP =
  'Update the agency-os-bridge plugin on the site (or Agency OS) so both speak the same contract version.';

/** One actionable message when the site's contract is not one this OS supports (plan O6). */
export function assertContractSupported(project) {
  const v = project?.cmsContractVersion;
  if (v != null && !SUPPORTED_CONTRACTS.includes(Number(v))) {
    throw new CmsBridgeError({
      status: 426,
      code: 'CONTRACT_UNSUPPORTED',
      message: `This site speaks bridge contract v${v}; this Agency OS supports v${SUPPORTED_CONTRACTS.join(', v')}. ${CONTRACT_HELP}`,
      details: { siteContract: v, supported: [...SUPPORTED_CONTRACTS] },
    });
  }
}

/**
 * Decrypt a CmsCredential row into an inbound/outbound keyring.
 * { inbound: {current:{id,secret}, prev?}, outbound: {current, prev?}, pending? }
 */
export function credentialToRings(credential, now = Date.now()) {
  if (!credential) return null;
  const aIn = cmsAad(credential.projectId, 'inbound');
  const aOut = cmsAad(credential.projectId, 'outbound');
  const prevAlive =
    credential.prevKeyId != null &&
    credential.inboundKeyPrevEnc &&
    credential.outboundKeyPrevEnc &&
    (!credential.prevExpiresAt || new Date(credential.prevExpiresAt).getTime() > now);
  const prevExpiresAt = credential.prevExpiresAt ? new Date(credential.prevExpiresAt).getTime() : null;
  return {
    inbound: {
      current: { id: credential.keyId, secret: decryptCmsSecret(credential.inboundKeyEnc, aIn) },
      prev: prevAlive
        ? { id: credential.prevKeyId, secret: decryptCmsSecret(credential.inboundKeyPrevEnc, aIn), expiresAt: prevExpiresAt }
        : null,
    },
    outbound: {
      current: { id: credential.keyId, secret: decryptCmsSecret(credential.outboundKeyEnc, aOut) },
      prev: prevAlive
        ? { id: credential.prevKeyId, secret: decryptCmsSecret(credential.outboundKeyPrevEnc, aOut), expiresAt: prevExpiresAt }
        : null,
    },
  };
}

/** Connection object for the request helpers. Throws CmsBridgeError when the project is not paired. */
export function connectionFor(project, credential, { now = Date.now() } = {}) {
  if (!project || project.cmsType !== 'EMDASH') {
    throw new CmsBridgeError({ status: 400, code: 'VALIDATION', message: 'Project is not connected to an EmDash site.' });
  }
  if (!project.wpUrl || !project.cmsSiteId || !credential) {
    throw new CmsBridgeError({
      status: 503,
      code: 'NOT_PAIRED',
      message: 'This EmDash site is not paired yet. Create a pairing code in the Website tab and paste it into the site plugin.',
      retryable: false,
    });
  }
  assertContractSupported(project);
  const rings = credentialToRings(credential, now);
  return { siteUrl: String(project.wpUrl).replace(/\/$/, ''), siteId: project.cmsSiteId, inbound: rings.inbound };
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function retryAfterMs(res) {
  const v = res?.headers?.get?.('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.min(n * 1000, 30_000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.min(t - Date.now(), 30_000)) : null;
}

/**
 * Contract error envelope → CmsBridgeError. Non-contract bodies (answered by the EmDash host before
 * the plugin runs, e.g. INVALID_PLUGIN_REQUEST, or a bare 404) are INTERNAL: retryable for 5xx/429,
 * final for 4xx; a non-contract 404 means the plugin is missing or disabled (contract v1.0.1 §9).
 */
export function errorFromResponse(status, json) {
  const e = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error : null;
  const isContract = !!(json && json.ok === false && e && typeof e.code === 'string' && ERROR_CODES[e.code]);
  if (!isContract && status === 403 && e?.code === 'AGENT_NOT_ALLOWED') {
    // v1.5.7 §33.1: the site's agent-guard middleware answers REST calls in EmDash's shape, not the bridge envelope.
    return new CmsBridgeError({
      status: 403,
      code: 'AGENT_NOT_ALLOWED',
      message: String(e.message || 'Agents cannot do this on the site. Ask an editor.').slice(0, 500),
      retryable: false,
      details: {},
    });
  }
  if (!isContract) {
    const pluginMissing = status === 404;
    return new CmsBridgeError({
      status,
      code: 'INTERNAL',
      message: pluginMissing
        ? 'The EmDash site does not answer the Agency OS bridge route: the agency-os-bridge plugin is missing or disabled.'
        : `The EmDash site returned HTTP ${status}${e?.code ? ` (${String(e.code).slice(0, 60)})` : ''}.`,
      retryable: (status >= 500 && status !== 501) || status === 429,
      details: { nonContract: true, ...(pluginMissing ? { pluginMissing: true } : {}), ...(e?.code ? { hostCode: String(e.code).slice(0, 60) } : {}) },
    });
  }
  const def = ERROR_CODES[e.code];
  return new CmsBridgeError({
    status,
    code: e.code,
    message: String(e.message || `EmDash site returned HTTP ${status}`).slice(0, 500),
    retryable: typeof e.retryable === 'boolean' ? e.retryable : def.retryable,
    details: e.details,
  });
}

/**
 * Signed POST to one plugin route. Retries retryable errors, 5xx, 429 and network
 * failures on `retryDelays` (honouring Retry-After); mutations keep the SAME
 * idempotency key across retries (contract §7, §10). A 401 UNKNOWN_KEY while a
 * previous inbound key is still in its 24 h overlap is retried once with that key
 * (the site has not installed the rotated pair yet).
 */
export async function siteRequest(conn, route, body = {}, opts = {}) {
  const {
    // guardedFetch: connect-time private-IP refusal (DNS rebinding) and no redirect following.
    fetchImpl = guardedFetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelays = READ_RETRY_DELAYS_MS,
    sleep = sleepMs,
    idempotencyKey = MUTATION_ROUTES.has(route) ? crypto.randomUUID() : undefined,
    now = () => Date.now(),
  } = opts;
  const url = `${conn.siteUrl}${SITE_ROUTE_PREFIX}${route}`;
  const path = signedPathFor(url);
  const raw = body === undefined || body === null ? '{}' : JSON.stringify(body);
  let key = conn.inbound.current;
  let triedPrev = false;
  let attempt = 0;

  for (;;) {
    const headers = signRequest({
      secret: key.secret,
      keyId: key.id,
      siteId: conn.siteId,
      path,
      body: raw,
      timestamp: Math.floor(now() / 1000),
      idempotencyKey,
    });
    headers['user-agent'] = EMDASH_USER_AGENT;
    headers.accept = 'application/json';

    let res = null;
    let err = null;
    let json = null;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body: raw, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 300 && res.status < 400) {
        // Never follow a redirect with a signed request (SSRF; the signature is bound to the path).
        // v1.0.2 C2: a 3xx is UPSTREAM_UNAVAILABLE, not retryable until an OWNER fixes the URL / re-pairs.
        throw new CmsBridgeError({
          status: 502,
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'The EmDash site answered with a redirect (HTTP ' + res.status + '). If the site moved, create a new pairing code for the new address.',
          retryable: false,
          details: { redirect: true },
        });
      }
      json = await res.json().catch(() => null);
    } catch (e) {
      if (e instanceof CmsBridgeError) throw e;
      const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      err = new CmsBridgeError({
        status: 502,
        code: 'UPSTREAM_UNAVAILABLE',
        message: isTimeout ? 'The EmDash site did not respond in time.' : 'Unable to reach the EmDash site.',
        retryable: true,
      });
    }

    if (res && res.ok && json && json.ok !== false) {
      // Security hotfix rule: preview / edit links only on the stored site host (https unless the dev opt-in).
      sanitizeEmdashLinks(json, conn.siteUrl);
      Object.defineProperty(json, 'idempotentReplay', { value: isIdempotentReplay(res, json), enumerable: false, configurable: true });
      return json;
    }
    if (res && !err) {
      err = res.ok
        ? new CmsBridgeError({ status: 502, code: 'UPSTREAM_UNAVAILABLE', message: 'The EmDash site returned an unreadable response.', retryable: true })
        : errorFromResponse(res.status, json);
      if (err.details && typeof err.details === 'object') sanitizeEmdashLinks(err.details, conn.siteUrl);
    }

    if (err.code === 'UNKNOWN_KEY' && !triedPrev && conn.inbound.prev) {
      triedPrev = true;
      key = conn.inbound.prev;
      continue;
    }
    // The error's own retryable flag decides (contract body / ERROR_CODES; non-contract: 5xx except 501, and 429).
    // 501 NOT_IMPLEMENTED (capability off) and every other 4xx fail at once, so the caller can fall back.
    const retryable = !!err.retryable;
    if (retryable && attempt < retryDelays.length) {
      const wait = (res && retryAfterMs(res)) ?? retryDelays[attempt];
      attempt += 1;
      const jitter = Math.floor(Math.random() * 250);
      await sleep(wait + jitter);
      continue;
    }
    throw err;
  }
}

/**
 * Was this mutation response a stored idempotent replay? Contract errata v1.0.1 moves the signal
 * into the body (EmDash strips the X-AOS-Idempotent-Replay header); read the body first and fall
 * back to the header. Informational only: the OS never depends on it.
 */
export function isIdempotentReplay(res, json) {
  if (json && typeof json === 'object') {
    if (json.idempotentReplay === true || json.replayed === true) return true;
    if (json.idempotency && typeof json.idempotency === 'object' && json.idempotency.replay === true) return true;
  }
  return String(res?.headers?.get?.('x-aos-idempotent-replay') || '').toLowerCase() === 'true';
}

// ---------------------------------------------------------------- route helpers

export const emdashRoutes = {
  siteInfo: (conn, opts) => siteRequest(conn, 'site-info', {}, opts),
  health: (conn, opts) => siteRequest(conn, 'health', {}, opts),
  inventory: (conn, q = {}, opts) => siteRequest(conn, 'inventory', compact({ status: 'any', limit: 100, ...q }), opts),
  entryGet: (conn, entryId, variant = 'draft', opts) => siteRequest(conn, 'entry-get', { entryId, variant }, opts),
  /** v1.1.0 §21.3: text values of every block field + entry-level fields (OS portal content view). */
  entryGetFields: (conn, entryId, variant = 'draft', opts) => siteRequest(conn, 'entry-get', { entryId, variant, includeFields: true }, opts),
  /** v1.5.1 §27 (capability layoutRead): the stored content as draft-upsert accepts it + rev (lossless round trip). */
  entryGetLayout: (conn, entryId, variant = 'draft', opts) => siteRequest(conn, 'entry-get', { entryId, variant, includeLayout: true }, opts),
  pipelineList: (conn, q = {}, opts) => siteRequest(conn, 'pipeline-list', compact({ status: 'any', limit: 100, ...q }), opts),
  pipelineGet: (conn, ref, opts) =>
    siteRequest(conn, 'pipeline-get', ref.reviewId ? { reviewId: ref.reviewId } : { entryId: ref.entryId }, opts),
  pipelineSubmit: (conn, body, opts) => siteRequest(conn, 'pipeline-submit', body, opts),
  pipelineReview: (conn, body, opts) => siteRequest(conn, 'pipeline-review', compact(body), opts),
  pipelineSendToClient: (conn, body, opts) => siteRequest(conn, 'pipeline-send-to-client', compact(body), opts),
  pipelineCancel: (conn, body, opts) => siteRequest(conn, 'pipeline-cancel', compact(body), opts),
  pipelineChangeType: (conn, body, opts) => siteRequest(conn, 'pipeline-change-type', body, opts),
  pipelineRotateLinks: (conn, body, opts) => siteRequest(conn, 'pipeline-rotate-links', compact(body), opts),
  eventsReplay: (conn, q, opts) => siteRequest(conn, 'events-replay', compact(q), opts),
  /** v1.1.0 §21.2 (capability clientReviewFromOs). Mutation: idempotency key kept across retries. */
  pipelineClientReview: (conn, body, opts) => siteRequest(conn, 'pipeline-client-review', compact(body), opts),
  /** v1.1.0 §21.3: { reviewId, state?, round?, cursor?, limit<=100 } → { items, next }. */
  pipelineSuggestions: (conn, q, opts) => siteRequest(conn, 'pipeline-suggestions', compact({ limit: 100, ...q }), opts),
  /** v1.2 §22.2 (capability draftPushFromOs for exact slug/bylines/terms). Mutation; body ≤ 2 MiB. */
  draftUpsert: (conn, body, opts) => siteRequest(conn, 'draft-upsert', compact(body), opts),
  /** v1.2 §22.3 (capability mediaImport). Mutation; the OS waits 30 s (v1.2.1 §23(3)). */
  mediaImport: (conn, body, opts) => siteRequest(conn, 'media-import', compact(body), { timeoutMs: 30_000, ...opts }),
  /** v1.3.0 §24 (capabilities publishFromOs / scheduleFromOs): human OWNER/PM only; OWNER override needs a reason. */
  pipelinePublish: (conn, body, opts) => siteRequest(conn, 'pipeline-publish', compact(body), opts),
  pipelineSchedule: (conn, body, opts) => siteRequest(conn, 'pipeline-schedule', compact(body), opts),
  pipelineUnschedule: (conn, body, opts) => siteRequest(conn, 'pipeline-unschedule', compact(body), opts),
  /** v1.3.0 §24.3: short-lived staff preview URL; never stored or logged by the OS, never shown to clients. */
  previewLink: (conn, body, opts) => siteRequest(conn, 'preview-link', compact(body), opts),
  /** v1.4.0 §25 (capability seoProfiles): reads; proposals are the only OS write used (D13: no decisions). */
  profilesList: (conn, q = {}, opts) => siteRequest(conn, 'profiles-list', compact({ limit: 100, ...q }), opts),
  profileGet: (conn, ref, opts) => siteRequest(conn, 'profile-get', compact(ref), opts),
  keywordRegistry: (conn, q = {}, opts) => siteRequest(conn, 'keyword-registry', compact({ limit: 100, ...q }), opts),
  briefGet: (conn, ref, opts) => siteRequest(conn, 'brief-get', compact(ref), opts),
  proposalCreate: (conn, body, opts) => siteRequest(conn, 'proposal-create', compact(body), opts),
  /** v1.5.0 §26.1 (capability leads): erase a lead and its photos on the site. */
  leadErase: (conn, body, opts) => siteRequest(conn, 'lead-erase', compact(body), opts),
  /** v1.5.0 §26.2 (capability reports): read-only dashboards. */
  redirectLedger: (conn, q = {}, opts) => siteRequest(conn, 'redirect-ledger', compact({ limit: 500, ...q }), opts),
  missesSummary: (conn, q = {}, opts) => siteRequest(conn, 'misses-summary', compact({ days: 30, limit: 100, ...q }), opts),
  crawlLatest: (conn, q = {}, opts) => siteRequest(conn, 'crawl-latest', compact(q), opts),
  /** v1.5.0 §26.3 (capability migrationMap): WP post id → entry map, paged. */
  migrationMap: (conn, q = {}, opts) => siteRequest(conn, 'migration-map', compact({ limit: 500, ...q }), opts),
  /** v1.6.0 §36 (capability security / backups): read-only, no idempotency key, 60/min per key on the site. */
  securityStatus: (conn, q = {}, opts) => siteRequest(conn, 'security-status', compact({ detail: 'full', ...q }), opts),
  securityHistory: (conn, q = {}, opts) => siteRequest(conn, 'security-history', compact({ days: 90, ...q }), opts),
  backupStatus: (conn, opts) => siteRequest(conn, 'backup-status', {}, opts),
  /** v1.6.0: schema only; the site answers 501 NOT_IMPLEMENTED until capability logs (Phase 3). */
  logsPull: (conn, q = {}, opts) => siteRequest(conn, 'logs-pull', compact({ limit: 500, ...q }), opts),
  /** v1.6.1 §37 (capability securityConfig). Writes are mutations (idempotency key kept across retries). */
  securityConfigGet: (conn, opts) => siteRequest(conn, 'security-config-get', {}, opts),
  securityConfigSet: (conn, body, opts) => siteRequest(conn, 'security-config-set', compact(body), opts),
  securityRun: (conn, body, opts) => siteRequest(conn, 'security-run', compact(body), opts),
  securityAck: (conn, body, opts) => siteRequest(conn, 'security-ack', compact(body), opts),
};

function siteCaps(project) {
  return project?.cmsCapabilities && typeof project.cmsCapabilities === 'object' ? project.cmsCapabilities : {};
}
/** v1.3.0: the site allows publishing / scheduling from the OS (build option AND admin setting). */
export function hasPublishFromOs(project) {
  return siteCaps(project).publishFromOs === true;
}
export function hasScheduleFromOs(project) {
  return siteCaps(project).scheduleFromOs === true;
}
export function hasPreviewLinks(project) {
  return siteCaps(project).previewLinks === true;
}

/** v1.2 §22: OS draft push (exact slug, bylines, terms) and media import, as advertised by the site. */
export function hasDraftPushFromOs(project) {
  const caps = project?.cmsCapabilities && typeof project.cmsCapabilities === 'object' ? project.cmsCapabilities : {};
  return caps.draftPushFromOs === true;
}
/** v1.5.1: the site returns editable layouts (entry-get includeLayout). Never inferred from contractRevision. */
export function hasLayoutRead(project) {
  const caps = project?.cmsCapabilities && typeof project.cmsCapabilities === 'object' ? project.cmsCapabilities : {};
  return caps.layoutRead === true;
}
export function hasMediaImport(project) {
  const caps = project?.cmsCapabilities && typeof project.cmsCapabilities === 'object' ? project.cmsCapabilities : {};
  return caps.mediaImport === true;
}

/** v1.1.0 §21.1: the site implements client review from the OS (else: keep the review-link flow). */
export function hasClientReviewFromOs(project) {
  const caps = project?.cmsCapabilities && typeof project.cmsCapabilities === 'object' ? project.cmsCapabilities : {};
  return caps.clientReviewFromOs === true;
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) out[k] = v;
  return out;
}

/** OS actor for a signed call (contract common.json#/$defs/osActor). */
export function osActor(user) {
  return {
    // SEO Engine OS-01/OS-21: an agent account is never presented as a person (routes that publish refuse agents anyway).
    kind: user?.isAgent === true ? 'agent' : 'human',
    osUserId: String(user?.id || ''),
    name: String(user?.name || 'Agency OS user').slice(0, 200),
    ...(user?.role ? { role: user.role } : {}),
  };
}

/** The Phase 1 answer to "Publish" on an EmDash review (contract §1, §9). */
export function publishNotAllowed(editUrl) {
  return new CmsBridgeError({
    status: 403,
    code: 'PUBLISH_NOT_ALLOWED',
    message: 'Approved. Publish in the site admin.',
    retryable: false,
    details: editUrl ? { editUrl } : {},
  });
}

// ---------------------------------------------------------------- normalisers (pure)

const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
const int = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

function postTypeFor(collection) {
  return collection === 'posts' ? 'Post' : 'Page';
}

/**
 * Contract `Review` (+ envelope bits) → the normalized review event consumed by
 * lib/reviewEvents.js applyReviewEvent (same keys as wordpress.normalizePipelineWebhook).
 */
export function normalizeReviewEvent(review, { eventType, seq, message = null, override = false, snapshotText = null, clientActor = null, siteUrl } = {}) {
  const r = review || {};
  // Security hotfix rule for EmDash: links only on the stored site host (https; http only in the insecure dev opt-in).
  // Callers that know the project pass its siteUrl; applyReviewEvent re-checks every event anyway.
  const link = (v) => (siteUrl === undefined ? str(v, 1000) : safeEmdashLink(v, siteUrl));
  const reviewNo = int(r.reviewNo);
  const entryNo = int(r.entryNo) || 0;
  let logMessage = str(message, 500);
  if (override && eventType === 'pipeline_published') {
    logMessage = (logMessage ? `${logMessage} ` : '') + '(published in the site admin before client approval)';
    logMessage = logMessage.slice(0, 500);
  }
  return {
    source: 'EMDASH',
    wpPipelineId: reviewNo,
    eventType: String(eventType || '').slice(0, 100),
    wpPostId: entryNo,
    postTitle: String(r.title || '').slice(0, 500),
    postType: postTypeFor(r.collection),
    contentType: str(r.contentType, 50),
    parentWpPostId: r.updateMode ? entryNo || null : null,
    logMessage,
    status: String(r.status || '').slice(0, 50),
    revisionNumber: Number(r.round) || 1,
    pmPreviewUrl: link(r.pmPreviewUrl),
    clientPreviewUrl: link(r.clientPreviewUrl),
    pmDecision: str(r.pmDecision, 50),
    pmComment: str(r.pmComment, 10000),
    clientDecision: str(r.clientDecision, 50),
    clientComment: str(r.clientComment, 10000),
    submittedByName: str(r.submittedBy?.name, 200),
    submittedById: str(r.submittedBy?.memberId, 100),
    pmMemberName: str(r.pmAssigned?.name, 200),
    pmMemberId: str(r.pmAssigned?.memberId, 100),
    workerNote: str(r.workerNote, 10000),
    pmReviewedAt: str(r.pmReviewedAt, 50),
    clientReviewedAt: str(r.clientReviewedAt, 50),
    wpCreatedAt: parseDate(r.createdAt),
    wpUpdatedAt: parseDate(r.updatedAt) || new Date(),
    summaryExcerpt: snapshotText ? String(snapshotText).slice(0, 4000) : '',
    isElementor: false,
    testMode: false,
    testEmails: {},
    cms: {
      // v1.0.1: token-free link state { pm, client: { state, issuedAt, expiresAt } } on every Review.
      links: r.links && typeof r.links === 'object' ? sanitizeLinks(r.links) : null,
      reviewId: str(r.reviewId, 64),
      entryId: str(r.entryId, 64),
      revisionId: str(r.draftRevisionId, 64),
      seq: Number.isInteger(seq) ? seq : Number.isInteger(r.seq) ? r.seq : null,
      editUrl: link(r.editUrl),
      // v1.1.0 §21: CAS rev (sent back as expectedRev), decision channel, suggestion counts.
      rev: Number.isInteger(r.rev) ? r.rev : null,
      clientDecisionSource: r.clientDecisionSource === 'os' || r.clientDecisionSource === 'review-link' ? r.clientDecisionSource : null,
      suggestionCounts: suggestionCounts(r.suggestionCounts),
      // v1.5.2 §28.1: undefined = not sent (older site: leave the column alone); null = the entry is not live.
      ...(Object.prototype.hasOwnProperty.call(r, 'liveRevisionId') ? { liveRevisionId: r.liveRevisionId == null ? null : str(r.liveRevisionId, 64) } : {}),
      // v1.1.0: who made a client decision (names only), for notification wording.
      clientActor: clientActor && typeof clientActor === 'object' ? clientActor : null,
      // v1.3.0 §24: scheduled state and publish audit (names only).
      scheduledAt: str(r.scheduledAt, 40),
      publishOrigin: ['admin', 'os', 'scheduler'].includes(r.publishOrigin) ? r.publishOrigin : null,
      publishedBy: r.publishedBy && typeof r.publishedBy === 'object' ? { name: str(r.publishedBy.name, 200), source: str(r.publishedBy.source, 32), osUserId: str(r.publishedBy.osUserId, 64) } : null,
      // e2e O11: undefined = the Review did not say (older site: leave the column); null = no override on it now.
      override: !Object.prototype.hasOwnProperty.call(r, 'override')
        ? undefined
        : r.override && typeof r.override === 'object'
          ? { byName: str(r.override.by?.name, 200), reason: str(r.override.reason, 1000), at: str(r.override.at, 40), action: str(r.override.action, 16) }
          : null,
    },
  };
}

/** v1.3.0 Review fields → WpContentReview columns (scheduledAt follows the status: cleared when not scheduled). */
export function emdashPublishColumns(cms) {
  if (!cms) return {};
  const out = {};
  out.cmsScheduledAt = cms.scheduledAt ? parseDate(cms.scheduledAt) : null;
  if (cms.publishOrigin) out.cmsPublishOrigin = cms.publishOrigin;
  if (cms.publishedBy) out.cmsPublishedBy = cms.publishedBy;
  if (cms.override !== undefined) out.cmsOverride = cms.override;
  if (cms.liveRevisionId !== undefined) out.cmsLiveRevisionId = cms.liveRevisionId;
  return out;
}

function suggestionCounts(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const out = {};
  for (const k of ['open', 'accepted', 'rejected', 'applied', 'closed']) out[k] = Number.isInteger(c[k]) && c[k] >= 0 ? c[k] : 0;
  return out;
}

const LINK_STATES = new Set(['none', 'active', 'expired', 'revoked']);
function sanitizeLinks(links) {
  const one = (l) =>
    l && typeof l === 'object' && LINK_STATES.has(l.state)
      ? { state: l.state, issuedAt: str(l.issuedAt, 40), expiresAt: str(l.expiresAt, 40) }
      : null;
  const out = {};
  const pm = one(links.pm);
  const client = one(links.client);
  if (pm) out.pm = pm;
  if (client) out.client = client;
  return Object.keys(out).length ? out : null;
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Contract `Review` → WpContentReview column values for a pull sync / response mirror
 * (no event, no notification). `seq` is NOT written here: only the event stream advances
 * cmsSeq, so a later event with the same seq is still applied and notified.
 */
export function reviewToMirrorData(review, siteUrl) {
  const n = normalizeReviewEvent(review, { eventType: '', siteUrl: siteUrl ?? null });
  const isPublished = n.status === 'published';
  const isCancelled = n.status === 'cancelled';
  return {
    wpPipelineId: n.wpPipelineId,
    data: {
      wpPostId: n.wpPostId,
      ...(n.postTitle ? { postTitle: n.postTitle } : {}),
      ...(n.parentWpPostId ? { parentWpPostId: n.parentWpPostId } : {}),
      status: n.status,
      submittedByName: n.submittedByName,
      submittedById: n.submittedById,
      pmMemberName: n.pmMemberName,
      pmMemberId: n.pmMemberId,
      ...(n.pmPreviewUrl ? { pmPreviewUrl: n.pmPreviewUrl } : {}),
      ...(n.clientPreviewUrl ? { clientPreviewUrl: n.clientPreviewUrl } : {}),
      pmDecision: n.pmDecision,
      pmComment: n.pmComment,
      clientDecision: n.clientDecision,
      clientComment: n.clientComment,
      workerNote: n.workerNote,
      ...(n.contentType ? { contentType: n.contentType } : {}),
      pmReviewedAt: n.pmReviewedAt,
      clientReviewedAt: n.clientReviewedAt,
      revisionNumber: n.revisionNumber,
      ...(n.wpCreatedAt ? { wpCreatedAt: n.wpCreatedAt } : {}),
      wpUpdatedAt: n.wpUpdatedAt,
      cmsReviewId: n.cms.reviewId,
      cmsEntryId: n.cms.entryId,
      cmsRevisionId: n.cms.revisionId,
      cmsEditUrl: n.cms.editUrl,
      ...(n.cms.links ? { cmsLinks: n.cms.links } : {}),
      ...(Number.isInteger(n.cms.rev) ? { cmsRev: n.cms.rev } : {}),
      ...(n.cms.clientDecisionSource ? { cmsClientDecisionSource: n.cms.clientDecisionSource } : {}),
      ...(n.cms.suggestionCounts ? { cmsSuggestionCounts: n.cms.suggestionCounts } : {}),
      ...emdashPublishColumns(n.cms),
      ...(isPublished || isCancelled ? { isPublished: true } : {}),
    },
    postTitle: n.postTitle || 'Untitled',
    seq: n.cms.seq,
    history: Array.isArray(review?.history) ? review.history : [],
  };
}

/** Contract `entry` → WpPage column values (content is filled from snapshotText when present). */
/** Outline (contract v1.0.6): validated and capped with the contract's own limitOutline(). */
export function sanitizeOutline(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const nonNeg = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return limitOutline({
    headings: Array.isArray(o.headings) ? o.headings.filter((h) => h && typeof h === 'object') : [],
    internalLinks: Array.isArray(o.internalLinks) ? o.internalLinks : [],
    externalLinkCount: nonNeg(o.externalLinkCount),
    imageCount: nonNeg(o.imageCount),
  });
}

/**
 * Contract `entry` → WpPage column values.
 * Top-level entry fields describe the WORKING COPY (the draft when `hasPendingDraft`); `live` (v1.0.6) carries the
 * live values then. The mirror's published state uses the live values when present; the draft title is kept for
 * the "Pending draft" badge. Older plugins (no `live`): values kept as sent, flag still set (title may be the draft's).
 * SEO, slug and path are not versioned by EmDash and are taken as sent.
 * `outlinePending` = the site omitted `outline` (size guard) but sent `outlineHash`: fetch via entry-get when it changed.
 */
export function entryToPageData(entry, siteUrl) {
  const e = entry || {};
  const base = String(siteUrl || '').replace(/\/$/, '');
  const path = typeof e.path === 'string' ? e.path : '';
  const pending = e.hasPendingDraft === true;
  const live = pending && e.live && typeof e.live === 'object' && !Array.isArray(e.live) ? e.live : null;
  const src = live || e;
  const outline = sanitizeOutline(src.outline);
  const outlineHash = typeof src.outlineHash === 'string' ? src.outlineHash.slice(0, 64) : null;
  const wordCount = Number.isInteger(src.wordCount) && src.wordCount >= 0 ? src.wordCount : null;
  return {
    wpPostId: int(e.entryNo),
    outlinePending: !outline && !!outlineHash,
    outlineHash,
    // entry-get variant for an omitted outline: what is live for a published entry, else the draft.
    outlineVariant: e.status === 'published' ? 'live' : 'draft',
    data: {
      title: String((live ? live.title : e.title) || '').slice(0, 500),
      slug: String(e.slug || '').slice(0, 500),
      status: String(e.status || 'draft').slice(0, 50),
      postType: e.collection === 'posts' ? 'post' : 'page',
      url: (path && base ? `${base}${path.startsWith('/') ? '' : '/'}${path}` : path).slice(0, 500),
      excerpt: (live ? live.excerpt : e.excerpt) == null ? null : String(live ? live.excerpt : e.excerpt).slice(0, 1000),
      template: null,
      seoTitle: e.seo?.title ? String(e.seo.title).slice(0, 500) : null,
      seoDescription: e.seo?.description ? String(e.seo.description).slice(0, 1000) : null,
      contentHash: String((live ? live.contentHash : e.contentHash) || e.contentHash || '').slice(0, 64) || String(Date.now()),
      // Ordering key for content.* events: the entry's last change (draft included), not live.updatedAt.
      modifiedAt: parseDate(e.updatedAt),
      // Entry-level publish time (never a draft value); null for never-published entries.
      cmsPublishedAt: parseDate(e.publishedAt),
      // v1.2.1 §23(1): the exact baseRev token for draft-upsert updates (never derived from draftRevisionId).
      ...(e.rev ? { cmsRev: str(e.rev, 64) } : {}),
      // v1.3.0: scheduled entries carry their publish time.
      cmsScheduledAt: e.status === 'scheduled' ? parseDate(e.scheduledAt) : null,
      cmsHasPendingDraft: pending,
      cmsDraftTitle: pending ? String(e.title || '').slice(0, 500) : null,
      cmsWordCount: wordCount,
      ...(outline ? { cmsOutline: outline, cmsOutlineHash: outlineHash } : {}),
      cmsEntryId: str(e.entryId, 64),
      cmsCollection: str(e.collection, 64),
      cmsDraftRevisionId: str(e.draftRevisionId, 64),
      cmsLiveRevisionId: str(e.liveRevisionId, 64),
      cmsEditUrl: safeEmdashLink(e.editUrl, siteUrl),
    },
  };
}

/** Status label shown for an EmDash review (same STATUS_LABELS as WP, plus reserved `scheduled`). */
export function emdashStatusLabel(status) {
  return STATUS_LABELS[status] || status;
}

export const emdashAdapter = {
  type: 'EMDASH',
  info(project) {
    const caps = project?.cmsCapabilities && typeof project.cmsCapabilities === 'object' ? project.cmsCapabilities : {};
    return {
      type: 'EMDASH',
      contractVersion: project?.cmsContractVersion ?? null,
      capabilities: {
        ...caps,
        // Phase 1: never publish or schedule from the OS, whatever the site advertises.
        publishFromOs: false,
        scheduleFromOs: false,
        clientReviewFromOs: false,
        autoLogin: false,
        updateContentClone: false,
      },
    };
  },
  isConfigured(project) {
    return !!(project?.wpUrl && project?.cmsSiteId && project?.cmsPairedAt);
  },
};
