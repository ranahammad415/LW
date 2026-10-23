import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
import { prisma } from '../../lib/prisma.js';
import {
  buildAgencyConnectUrl,
  exchangeAgencyCode,
  saveAgencyConnection,
  getAgencyConnectionStatus,
  getAgencyOAuth2Client,
  getGscAuth,
  isAgencyGoogleOAuthConfigured,
} from '../../lib/analytics/googleAuth.js';
import { runGscSync } from '../../lib/gscSync.js';
import { runNativeAnalyticsSync } from '../../lib/analytics/runNativeSync.js';
import { normalizeGmbIdentifier, resolveMapsShortLink } from '../../lib/analytics/gmbIdentifier.js';
import { startBackgroundRun, getRun, runView } from '../../lib/analytics/syncRuns.js';
import { rejectAgentRefresh } from '../pm/siteMetrics.js';
import { runConnectionHealth, probeProjectGmbDfs } from '../../lib/analytics/connectionHealth.js';
import { DisconnectError, disconnectAgencyGoogle, isConsentStale } from '../../lib/analytics/googleDisconnect.js';
import { isAgentOrToken } from '../../lib/apiTokens.js';
import { getUserSites, BingApiError } from '../../lib/bing/client.js';
import {
  getBingConnectionStatus,
  saveBingConnection,
  disconnectBing,
  isPlausibleApiKey,
  isBingEnabled,
} from '../../lib/bing/bingAuth.js';
import {
  listBingSites,
  primeBingSitesCache,
  invalidateBingSitesCache,
  runAutoBind,
  isListedVerifiedSite,
} from '../../lib/bing/bingBinding.js';
import { runBingSync } from '../../lib/bing/bingSync.js';
import { bingFleet } from '../../lib/bing/bingViews.js';

/** Staff-facing reply for a Bing failure: kind + Bing's message word, never the URL or the key. */
function bingFailure(reply, request, err, what) {
  if (err?.code === 'BING_NOT_CONNECTED') {
    return reply.status(409).send({ code: 'NOT_CONNECTED', message: 'Connect the agency Bing Webmaster account first.' });
  }
  request.log.warn({ code: err?.code, kind: err?.kind }, `${what} failed`);
  const status = err?.kind === 'auth' ? 401 : err?.kind === 'throttle' ? 429 : 502;
  const hint =
    err?.kind === 'auth'
      ? 'Bing rejected the API key. Generate a new key in Bing Webmaster → Settings → API Access.'
      : err?.kind === 'throttle'
        ? 'Bing is throttling requests. Try again later.'
        : `Bing did not answer (${err?.message || 'error'}). Try again later.`;
  return reply.status(status).send({ code: err?.code || 'BING_FAILED', kind: err?.kind || 'other', message: hint });
}

const accessSecret = process.env.JWT_ACCESS_SECRET;
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

function domainFromUrl(url) {
  if (!url) return '';
  return String(url)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^sc-domain:/, '')
    .split('/')[0];
}

// Turn a raw Google Business Profile API error into an actionable hint. A quota
// of 0 (429 / RESOURCE_EXHAUSTED) is the common cause of an empty locations list.
function quotaHint(message) {
  const msg = message || 'Failed to list GMB locations';
  if (/quota|429|RESOURCE_EXHAUSTED|rate limit/i.test(msg)) {
    return 'Business Profile API quota is 0 (pending Google approval). Bind the business manually below; data is pulled via DataForSEO meanwhile.';
  }
  return msg;
}

/**
 * Project data for a manually entered GBP identifier (features/local-seo.md). CID → gmbCid (digits only), place_id →
 * gmbPlaceId, a name → legacy keyword in gmbCid (Find business turns it into a CID). An unchanged identifier changes
 * nothing; a new one replaces the other id, drops the verification and the old profile, and resets the review cycle.
 * An empty value clears the DataForSEO identity (the native location, if any, stays).
 */
export function manualIdentityData(project, normalized) {
  let next;
  if (normalized.kind === 'cid' && normalized.cid) next = { gmbCid: normalized.cid, gmbPlaceId: null };
  else if (normalized.kind === 'place_id' && normalized.placeId) next = { gmbCid: null, gmbPlaceId: normalized.placeId };
  else if (normalized.kind === 'name' && normalized.identifier) next = { gmbCid: normalized.identifier, gmbPlaceId: null };
  else next = { gmbCid: null, gmbPlaceId: null };

  const curCid = project.gmbCid ? String(project.gmbCid).replace(/^cid:/i, '') : null;
  const unchanged =
    (next.gmbCid && next.gmbCid === curCid) ||
    (next.gmbPlaceId && next.gmbPlaceId === project.gmbPlaceId) ||
    (!next.gmbCid && !next.gmbPlaceId && !project.gmbCid && !project.gmbPlaceId);
  if (unchanged) return {};
  const empty = !next.gmbCid && !next.gmbPlaceId;
  return {
    ...next,
    gmbIdentitySource: empty ? (project.gmbLocationId ? 'native' : null) : 'manual',
    gmbIdentityVerifiedAt: null,
    gmbProfileSyncedAt: null,
    gmbFeatureId: null,
    gmbLat: null,
    gmbLng: null,
    gmbAddress: null,
    gmbPhone: null,
    gmbCategory: null,
    gmbWebsite: null,
    gmbRating: null,
    gmbReviewsCount: null,
    gmbReviewsFullAt: null,
    gmbReviewsTaskId: null,
    gmbReviewsTaskAt: null,
    gmbReviewsTaskDepth: null,
    gmbSyncError: null,
  };
}

export async function adminIntegrationsRoutes(app) {
  const requireOwner = app.requireOwner;

  // ── Agency Google connection status ────────────────────────────────────
  app.get(
    '/integrations/google/status',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (_request, reply) => {
      const status = await getAgencyConnectionStatus();
      return reply.send(status);
    }
  );

  // ── Start OAuth (OWNER) ────────────────────────────────────────────────
  app.get(
    '/integrations/google/connect',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      if (!isAgencyGoogleOAuthConfigured()) {
        return reply.status(400).send({
          message: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured',
        });
      }
      const state = jwt.sign(
        { purpose: 'agency_google', uid: request.user.id },
        accessSecret,
        { expiresIn: '15m' }
      );
      const url = buildAgencyConnectUrl({ state });
      return reply.send({ url });
    }
  );

  // ── OAuth callback (no JWT — uses state) ───────────────────────────────
  app.get('/integrations/google/callback', async (request, reply) => {
    const { code, state, error } = request.query || {};
    const redirectFail = `${frontendUrl}/portal/admin/integrations?google=error`;
    if (error || !code || !state) {
      return reply.redirect(`${redirectFail}&reason=${encodeURIComponent(error || 'missing_code')}`);
    }
    try {
      const payload = jwt.verify(String(state), accessSecret);
      if (payload.purpose !== 'agency_google') throw new Error('Invalid state');
      // OS-18: a consent started before the latest agency disconnect cannot reconnect.
      if (await isConsentStale(payload.iat)) throw new Error('stale_consent: start Connect Google again');
      const exchanged = await exchangeAgencyCode(String(code));
      await saveAgencyConnection({
        refreshToken: exchanged.refreshToken,
        googleEmail: exchanged.googleEmail,
        scopes: exchanged.scopes,
        connectedById: payload.uid,
      });
      return reply.redirect(`${frontendUrl}/portal/admin/integrations?google=connected`);
    } catch (err) {
      request.log.error({ err }, 'Agency Google OAuth callback failed');
      return reply.redirect(
        `${redirectFail}&reason=${encodeURIComponent(err.message || 'oauth_failed')}`
      );
    }
  });

  // ── Disconnect (agency-wide; SEO Engine OS-18) ─────────────────────────
  // Body {scope:'entire-agency-google', confirmAgencyWide:true}. Revokes the refresh token at Google and wipes the
  // stored credential. 200 when Google confirmed the revocation, 202 when it could not be confirmed (credential still
  // wiped locally; the owner must remove the app from the Google account).
  app.post(
    '/integrations/google/disconnect',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      try {
        const receipt = await disconnectAgencyGoogle({
          actor: request.user,
          scope: request.body?.scope,
          confirmAgencyWide: request.body?.confirmAgencyWide,
        });
        request.log.info({ status: receipt.status, revoked: receipt.revokedCredentials, unconfirmed: receipt.unconfirmedCredentials }, 'Agency Google disconnected');
        return reply.status(receipt.remoteRevocationConfirmed ? 200 : 202).send(receipt);
      } catch (err) {
        if (err instanceof DisconnectError) return reply.status(err.status).send({ message: err.message, code: err.code });
        request.log.error({ code: err?.code }, 'Agency Google disconnect failed');
        return reply.status(500).send({ message: 'Disconnect failed; check the connection state before retrying' });
      }
    }
  );

  // ── Trigger analytics sync on demand ───────────────────────────────────
  // Runs GSC + GA4/GMB/DataForSEO syncs (instead of waiting for the nightly cron) in the BACKGROUND: answers 202 with
  // a run id at once (the sync can take minutes: DataForSEO review tasks queue) and the UI polls
  // GET /integrations/sync/runs/:runId for the per-project results. A run already in progress is returned instead of
  // starting a second one (paid calls). People only.
  app.post(
    '/integrations/sync',
    { onRequest: [app.verifyJwt, requireOwner, rejectAgentRefresh], config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { run, existing } = await startBackgroundRun(
        { kind: 'integrations_sync', requestedById: request.user.id, log: request.log },
        async () => {
          let gsc;
          try {
            // Force full ~16 month daily pull so YoY compare has history.
            gsc = await runGscSync({ forceFullDaily: true });
          } catch (err) {
            request.log.error({ err }, 'Manual GSC sync failed');
            gsc = { error: err.message };
          }
          const native = await runNativeAnalyticsSync(request.log);
          // Bing Webmaster (features/bing-webmaster.md): skipped when disabled or not connected; never fails the run.
          let bing;
          try {
            bing = await runBingSync({ log: request.log });
          } catch (err) {
            request.log.error({ code: err?.code }, 'Manual Bing sync failed');
            bing = { error: err?.code || 'BING_FAILED' };
          }
          return { gsc, ...native, bing };
        }
      );
      return reply.status(202).send({ run: runView(run), existing });
    }
  );

  app.get(
    '/integrations/sync/runs/:runId',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const run = await getRun(request.params.runId);
      if (!run || run.kind !== 'integrations_sync') return reply.status(404).send({ message: 'Run not found' });
      reply.header('cache-control', 'no-store');
      return reply.send(runView(run));
    }
  );

  // ── Agency Bing Webmaster (features/bing-webmaster.md) ─────────────────
  // API-key mode only (OAuth is Phase 3). The key is sent once, validated with one GetUserSites call, stored
  // AES-256-GCM encrypted and never returned, logged or echoed. Writes: people only (HUMAN_ONLY); API tokens cannot
  // reach /api/admin/integrations/bing/* at all (lib/apiTokens.js DENIED_PREFIXES).
  const bingWrite = { onRequest: [app.verifyJwt, requireOwner, rejectAgentRefresh], config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } };

  app.get('/integrations/bing/status', { onRequest: [app.verifyJwt, requireOwner] }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return reply.send(await getBingConnectionStatus());
  });

  app.post('/integrations/bing/connect', bingWrite, async (request, reply) => {
    const apiKey = typeof request.body?.apiKey === 'string' ? request.body.apiKey.trim() : '';
    const accountLabel = typeof request.body?.accountLabel === 'string' ? request.body.accountLabel.trim().slice(0, 255) : null;
    if (!isPlausibleApiKey(apiKey)) {
      return reply.status(400).send({ code: 'BAD_KEY', message: 'Paste the API key from Bing Webmaster → Settings → API Access.' });
    }
    let sites;
    try {
      sites = await getUserSites({ credential: { mode: 'api_key', apiKey } });
    } catch (err) {
      if (err instanceof BingApiError && err.kind === 'auth') {
        return reply.status(422).send({ code: 'BING_KEY_REJECTED', message: 'Bing rejected this API key. Check it and try again.' });
      }
      return bingFailure(reply, request, err, 'Bing key validation');
    }
    const connection = await saveBingConnection({ apiKey, accountLabel, connectedById: request.user.id });
    primeBingSitesCache(sites);
    request.log.info({ sites: sites.length, verified: sites.filter((s) => s.verified).length }, 'Agency Bing Webmaster connected');
    return reply.send({ connected: true, connection, sites });
  });

  app.post('/integrations/bing/disconnect', { onRequest: [app.verifyJwt, requireOwner, rejectAgentRefresh] }, async (request, reply) => {
    const changed = await disconnectBing();
    invalidateBingSitesCache();
    request.log.info({ changed }, 'Agency Bing Webmaster disconnected');
    return reply.send({ connected: false, disconnected: changed });
  });

  app.get('/integrations/properties/bing', { onRequest: [app.verifyJwt, requireOwner] }, async (request, reply) => {
    try {
      const force = request.query?.refresh === '1' || request.query?.refresh === 'true';
      return reply.send(await listBingSites({ force }));
    } catch (err) {
      return bingFailure(reply, request, err, 'List Bing sites');
    }
  });

  app.post('/integrations/bing/auto-bind', bingWrite, async (request, reply) => {
    let sites;
    try {
      sites = (await listBingSites({ force: true })).sites;
    } catch (err) {
      return bingFailure(reply, request, err, 'Bing auto-bind');
    }
    const out = await runAutoBind({ sites });
    return reply.send({ bound: out.bound, ambiguous: out.ambiguous, unmatched: out.unmatched });
  });

  app.get('/integrations/bing/fleet', { onRequest: [app.verifyJwt, requireOwner] }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return reply.send({ enabled: isBingEnabled(), ...(await bingFleet()) });
  });

  // ── List GSC sites ─────────────────────────────────────────────────────
  app.get(
    '/integrations/properties/gsc',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      try {
        const auth = await getGscAuth();
        const sc = google.searchconsole({ version: 'v1', auth });
        const res = await sc.sites.list();
        const sites = (res.data.siteEntry || []).map((s) => ({
          siteUrl: s.siteUrl,
          permissionLevel: s.permissionLevel,
        }));
        return reply.send({ sites });
      } catch (err) {
        request.log.error({ err }, 'List GSC sites failed');
        return reply.status(502).send({ message: err.message || 'Failed to list GSC sites' });
      }
    }
  );

  // ── List GA4 properties ────────────────────────────────────────────────
  app.get(
    '/integrations/properties/ga4',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      try {
        const auth = await getAgencyOAuth2Client();
        const admin = google.analyticsadmin({ version: 'v1beta', auth });
        const accountsRes = await admin.accounts.list({ pageSize: 200 });
        const accounts = accountsRes.data.accounts || [];
        const properties = [];
        for (const account of accounts) {
          const accountId = account.name; // accounts/123
          try {
            const propsRes = await admin.properties.list({
              filter: `parent:${accountId}`,
              pageSize: 200,
            });
            for (const p of propsRes.data.properties || []) {
              // name = properties/123456
              const id = String(p.name || '').replace(/^properties\//, '');
              properties.push({
                propertyId: id,
                displayName: p.displayName || id,
                accountName: account.displayName || accountId,
                propertyName: p.name,
              });
            }
          } catch {
            // skip account if listing fails
          }
        }
        return reply.send({ properties });
      } catch (err) {
        request.log.error({ err }, 'List GA4 properties failed');
        return reply.status(502).send({ message: err.message || 'Failed to list GA4 properties' });
      }
    }
  );

  // ── List GMB locations ─────────────────────────────────────────────────
  app.get(
    '/integrations/properties/gmb',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      try {
        const auth = await getAgencyOAuth2Client();
        // Account Management API v1
        const mybusiness = google.mybusinessaccountmanagement({ version: 'v1', auth });
        const accountsRes = await mybusiness.accounts.list({});
        const accounts = accountsRes.data.accounts || [];
        const locations = [];

        // Business Information API for locations
        const bizInfo = google.mybusinessbusinessinformation({ version: 'v1', auth });
        let lastError = null;
        let failedAccounts = 0;
        for (const account of accounts) {
          const accountName = account.name; // accounts/123
          try {
            const locRes = await bizInfo.accounts.locations.list({
              parent: accountName,
              readMask: 'name,title,storefrontAddress,metadata',
              pageSize: 100,
            });
            for (const loc of locRes.data.locations || []) {
              locations.push({
                accountId: accountName.replace(/^accounts\//, ''),
                accountName: account.accountName || accountName,
                locationId: loc.name, // accounts/.../locations/...
                locationName: loc.title || loc.name,
                address: loc.storefrontAddress
                  ? [loc.storefrontAddress.addressLines?.join(' '), loc.storefrontAddress.locality]
                      .filter(Boolean)
                      .join(', ')
                  : null,
              });
            }
          } catch (err) {
            failedAccounts += 1;
            lastError = err.message;
            request.log.warn({ err: err.message, accountName }, 'GMB locations list partial failure');
          }
        }

        // If accounts exist but every listing failed (typically the Business
        // Profile API quota being 0), surface the reason instead of a silent
        // empty list so the UI can explain it.
        let warning = null;
        if (locations.length === 0 && accounts.length > 0 && failedAccounts > 0) {
          warning = quotaHint(lastError);
        }
        return reply.send({ locations, warning });
      } catch (err) {
        request.log.error({ err }, 'List GMB locations failed');
        return reply.status(502).send({ message: quotaHint(err.message) });
      }
    }
  );

  // ── Read project integrations ──────────────────────────────────────────
  app.get(
    '/integrations/clients/:clientId/projects/:projectId',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, projectId } = request.params;
      const project = await prisma.project.findFirst({
        where: { id: projectId, clientId },
        select: {
          id: true,
          name: true,
          clientId: true,
          gscSiteUrl: true,
          gscLastSyncedAt: true,
          ga4PropertyId: true,
          ga4PropertyName: true,
          ga4LastSyncedAt: true,
          gmbAccountId: true,
          gmbLocationId: true,
          gmbLocationName: true,
          gmbCid: true,
          gmbPlaceId: true,
          gmbIdentitySource: true,
          gmbIdentityVerifiedAt: true,
          gmbRating: true,
          gmbReviewsCount: true,
          localLocationName: true,
          gmbLastSyncedAt: true,
          dataforseoDomain: true,
          targetMarket: true,
          bingSiteUrl: true,
          bingLastSyncedAt: true,
          bingSyncError: true,
          client: { select: { agencyName: true, websiteUrl: true } },
        },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      return reply.send({
        ...project,
        suggestedDomain:
          project.dataforseoDomain ||
          domainFromUrl(project.client?.websiteUrl) ||
          domainFromUrl(project.gscSiteUrl),
      });
    }
  );

  // ── Bind project integrations ──────────────────────────────────────────
  app.put(
    '/integrations/clients/:clientId/projects/:projectId',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, projectId } = request.params;
      const body = request.body || {};
      const project = await prisma.project.findFirst({ where: { id: projectId, clientId } });
      if (!project) return reply.status(404).send({ message: 'Project not found' });

      const data = {};
      // Bing site binding (features/bing-webmaster.md): people only; must be one of the VERIFIED sites Bing lists
      // (exact string), else 422 BING_SITE_UNKNOWN. An empty value unbinds (stored Bing data is kept).
      if (body.bingSiteUrl !== undefined) {
        if (isAgentOrToken(request)) {
          return reply.status(403).send({ code: 'HUMAN_ONLY', message: 'Agent accounts and API tokens cannot change the Bing binding' });
        }
        const want = body.bingSiteUrl ? String(body.bingSiteUrl).trim() : '';
        if (want && want !== project.bingSiteUrl) {
          let sites;
          try {
            sites = (await listBingSites()).sites;
          } catch (err) {
            return bingFailure(reply, request, err, 'List Bing sites');
          }
          if (!isListedVerifiedSite(want, sites)) {
            return reply.status(422).send({ code: 'BING_SITE_UNKNOWN', message: 'That site is not a verified site of the agency Bing account. Pick one from the list.' });
          }
        }
        if (want !== (project.bingSiteUrl || '')) {
          data.bingSiteUrl = want || null;
          data.bingSyncError = null;
        }
      }
      if (body.gscSiteUrl !== undefined) data.gscSiteUrl = body.gscSiteUrl || null;
      if (body.ga4PropertyId !== undefined) {
        data.ga4PropertyId = body.ga4PropertyId || null;
        data.ga4PropertyName = body.ga4PropertyName || null;
      }
      if (body.gmbLocationId !== undefined) {
        // A native location never clears the CID / place_id: both are kept so the DataForSEO fallback stays available.
        data.gmbLocationId = body.gmbLocationId || null;
        data.gmbAccountId = body.gmbAccountId || null;
        if (body.gmbLocationId || body.gmbLocationName) data.gmbLocationName = body.gmbLocationName || null;
        if (body.gmbLocationId && !project.gmbIdentitySource) data.gmbIdentitySource = 'native';
      }
      if (body.targetMarket !== undefined) {
        const tm = body.targetMarket ? String(body.targetMarket).trim().slice(0, 120) : '';
        data.targetMarket = tm || null;
      }
      if (body.dataforseoDomain !== undefined) {
        data.dataforseoDomain = body.dataforseoDomain
          ? domainFromUrl(body.dataforseoDomain)
          : null;
      }
      if (body.gmbCid !== undefined) {
        const market =
          data.targetMarket !== undefined
            ? data.targetMarket
            : body.targetMarket !== undefined
              ? String(body.targetMarket || '').trim() || null
              : project.targetMarket;
        let normalized = normalizeGmbIdentifier(body.gmbCid, {
          targetMarket: market,
          displayName: body.gmbLocationName,
        });
        if (normalized.kind === 'short_link') {
          // maps.app.goo.gl: follow the redirects (SSRF-guarded, Google Maps hosts only, capped) to the long URL.
          const resolved = await resolveMapsShortLink(normalized.url);
          if (!resolved.ok) {
            return reply.status(422).send({
              code: `SHORT_LINK_${resolved.code}`,
              message: 'That short link could not be opened. Paste the full Google Maps link, the CID or the place_id.',
            });
          }
          normalized = normalizeGmbIdentifier(resolved.url, { targetMarket: market, displayName: body.gmbLocationName });
        }
        Object.assign(data, manualIdentityData(project, normalized));
        if (body.gmbLocationName !== undefined) {
          data.gmbLocationName = body.gmbLocationName
            ? String(body.gmbLocationName).trim().slice(0, 255)
            : normalized.displayName;
        } else if (normalized.displayName && !project.gmbLocationName) {
          data.gmbLocationName = normalized.displayName.slice(0, 255);
        }
      } else if (body.gmbLocationName !== undefined) {
        data.gmbLocationName = body.gmbLocationName || null;
      }

      const updated = await prisma.project.update({
        where: { id: projectId },
        data,
        select: {
          id: true,
          name: true,
          gscSiteUrl: true,
          ga4PropertyId: true,
          ga4PropertyName: true,
          gmbAccountId: true,
          gmbLocationId: true,
          gmbLocationName: true,
          gmbCid: true,
          gmbPlaceId: true,
          gmbIdentitySource: true,
          gmbIdentityVerifiedAt: true,
          gmbRating: true,
          gmbReviewsCount: true,
          localLocationName: true,
          dataforseoDomain: true,
          targetMarket: true,
          bingSiteUrl: true,
          bingLastSyncedAt: true,
          bingSyncError: true,
        },
      });
      return reply.send(updated);
    }
  );

  /** Live connection / adapter health for Owner admin. */
  app.get(
    '/integrations/health',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      try {
        const result = await runConnectionHealth();
        return reply.send(result);
      } catch (err) {
        request.log.error({ err }, 'Connection health failed');
        return reply.status(500).send({ message: err.message || 'Health check failed' });
      }
    }
  );

  /** Probe DataForSEO Business Data for one project's gmbCid. */
  app.post(
    '/integrations/health/probe-gmb',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const projectId = request.body?.projectId;
      if (!projectId) return reply.status(400).send({ message: 'projectId is required' });
      try {
        const result = await probeProjectGmbDfs(projectId);
        if (result.status === 'fail' && /not found/i.test(result.message || '')) {
          return reply.status(404).send(result);
        }
        return reply.send(result);
      } catch (err) {
        request.log.error({ err }, 'GMB DFS probe failed');
        return reply.status(500).send({ message: err.message || 'Probe failed' });
      }
    }
  );

  // ── List all projects with integration bindings (for admin UI) ──────────
  app.get(
    '/integrations/projects',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (_request, reply) => {
      const projects = await prisma.project.findMany({
        where: { client: { isActive: true } },
        select: {
          id: true,
          name: true,
          clientId: true,
          gscSiteUrl: true,
          ga4PropertyId: true,
          ga4PropertyName: true,
          gmbLocationId: true,
          gmbLocationName: true,
          gmbCid: true,
          gmbPlaceId: true,
          gmbIdentitySource: true,
          gmbIdentityVerifiedAt: true,
          gmbRating: true,
          gmbReviewsCount: true,
          localLocationName: true,
          dataforseoDomain: true,
          targetMarket: true,
          bingSiteUrl: true,
          bingLastSyncedAt: true,
          bingSyncError: true,
          gscLastSyncedAt: true,
          ga4LastSyncedAt: true,
          gmbLastSyncedAt: true,
          client: { select: { agencyName: true, websiteUrl: true } },
        },
        orderBy: [{ client: { agencyName: 'asc' } }, { name: 'asc' }],
      });
      return reply.send(projects);
    }
  );
}
