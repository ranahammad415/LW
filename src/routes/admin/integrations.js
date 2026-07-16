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

const accessSecret = process.env.JWT_ACCESS_SECRET;
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

function requireOwner(request, reply) {
  if (request.user?.role !== 'OWNER') {
    return reply.status(403).send({ message: 'Owner access required' });
  }
}

function domainFromUrl(url) {
  if (!url) return '';
  return String(url)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^sc-domain:/, '')
    .split('/')[0];
}

export async function adminIntegrationsRoutes(app) {
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
            request.log.warn({ err: err.message, accountName }, 'GMB locations list partial failure');
          }
        }
        return reply.send({ locations });
      } catch (err) {
        request.log.error({ err }, 'List GMB locations failed');
        return reply.status(502).send({ message: err.message || 'Failed to list GMB locations' });
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
          gmbLastSyncedAt: true,
          dataforseoDomain: true,
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
      if (body.dataforseoDomain !== undefined) {
        data.dataforseoDomain = body.dataforseoDomain
          ? domainFromUrl(body.dataforseoDomain)
          : null;
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
          dataforseoDomain: true,
        },
      });
      return reply.send(updated);
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
          dataforseoDomain: true,
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
