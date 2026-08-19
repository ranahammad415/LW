import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
import { prisma } from '../../lib/prisma.js';
import {
  buildAgencyConnectUrl,
  exchangeAgencyCode,
  saveAgencyConnection,
  getAgencyConnectionStatus,
  disconnectAgencyConnection,
  getAgencyOAuth2Client,
  getGscAuth,
  isAgencyGoogleOAuthConfigured,
} from '../../lib/analytics/googleAuth.js';
import { runGscSync } from '../../lib/gscSync.js';
import { runNativeAnalyticsSync } from '../../lib/analytics/runNativeSync.js';
import { normalizeGmbIdentifier } from '../../lib/analytics/gmbIdentifier.js';
import { runConnectionHealth, probeProjectGmbDfs } from '../../lib/analytics/connectionHealth.js';

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

  // ── Disconnect ─────────────────────────────────────────────────────────
  app.post(
    '/integrations/google/disconnect',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (_request, reply) => {
      await disconnectAgencyConnection();
      return reply.send({ success: true });
    }
  );

  // ── Trigger analytics sync on demand ───────────────────────────────────
  // Runs GSC + GA4/GMB/DataForSEO syncs immediately (instead of waiting for the
  // nightly cron) and returns per-project results so API errors surface.
  app.post(
    '/integrations/sync',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      let gsc;
      try {
        // Force full ~16 month daily pull so YoY compare has history.
        gsc = await runGscSync({ forceFullDaily: true });
      } catch (err) {
        request.log.error({ err }, 'Manual GSC sync failed');
        gsc = { error: err.message };
      }
      const native = await runNativeAnalyticsSync(request.log);
      return reply.send({ gsc, ...native });
    }
  );

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
          gmbLastSyncedAt: true,
          dataforseoDomain: true,
          targetMarket: true,
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
      if (body.gscSiteUrl !== undefined) data.gscSiteUrl = body.gscSiteUrl || null;
      if (body.ga4PropertyId !== undefined) {
        data.ga4PropertyId = body.ga4PropertyId || null;
        data.ga4PropertyName = body.ga4PropertyName || null;
      }
      if (body.gmbLocationId !== undefined) {
        data.gmbLocationId = body.gmbLocationId || null;
        data.gmbAccountId = body.gmbAccountId || null;
        data.gmbLocationName = body.gmbLocationName || null;
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
        const normalized = normalizeGmbIdentifier(body.gmbCid, {
          targetMarket: market,
          displayName: body.gmbLocationName,
        });
        data.gmbCid = normalized.identifier;
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
          dataforseoDomain: true,
          targetMarket: true,
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
          dataforseoDomain: true,
          targetMarket: true,
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
