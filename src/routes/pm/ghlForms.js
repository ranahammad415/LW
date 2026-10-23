/**
 * Project → Integrations → "Website forms (GoHighLevel)" (features/ghl-forms.md). Prefix /api/pm.
 * Who: OWNER (every project) and PM (projects they can access: ensureProjectAccess). TEAM_MEMBER / CONTRACTOR /
 * clients: 403. API tokens never use these routes; agent accounts may read the page but every write (token, rotate,
 * revoke, header secret, mirror Retry, GHL-deleted tick) is for people only → 403 HUMAN_ONLY.
 * The token and the header secret are returned ONCE (in the response that minted them) and never again; responses
 * carry hashes' prefixes, counts and statuses only (receipts have no field values). no-store everywhere.
 */
import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { isAgentOrToken } from '../../lib/apiTokens.js';
import { CmsBridgeError } from '../../lib/siteAdapters/emdash.js';
import { endpointView, generateEndpoint, loadEndpoint, publicBaseUrl, revokeEndpoint, rotateEndpoint, setHeaderSecret, webhookSetup, HEADER_SECRET_NAME } from '../../lib/ghlForms/endpoints.js';
import { retryLeadImport, mirrorView } from '../../lib/ghlForms/leadImport.js';
import { siteFormIdFor } from '../../lib/ghlForms/receive.js';
import { confirmExternalErase } from '../../lib/cmsLeads.js';

export const GHL_FORMS_ROLES = ['OWNER', 'PM'];

export async function rejectToken(request, reply) {
  if (request?.authMethod === 'apiToken') return reply.status(403).send({ code: 'HUMAN_ONLY', message: 'API tokens cannot use the GoHighLevel forms integration' });
}
export async function rejectAgentWrite(request, reply) {
  if (isAgentOrToken(request)) return reply.status(403).send({ code: 'HUMAN_ONLY', message: 'Agent accounts and API tokens cannot change webhook credentials or retry lead mirrors' });
}

async function projectFor(request, reply, roles = GHL_FORMS_ROLES) {
  if (!roles.includes(request.user?.role)) {
    reply.status(403).send({ message: 'Access denied' });
    return null;
  }
  const project = await prisma.project.findUnique({
    where: { id: String(request.params.projectId) },
    select: { id: true, name: true, clientId: true, leadPmId: true, cmsType: true, cmsCapabilities: true, cmsHealth: true },
  });
  if (!project || !(await ensureProjectAccess(project, request.user))) {
    reply.status(project ? 403 : 404).send({ message: project ? 'Access denied' : 'Project not found' });
    return null;
  }
  return project;
}

function sendError(reply, err, log) {
  if (err instanceof CmsBridgeError) {
    let status = err.status || 502;
    if (status === 401 || (status >= 500 && status !== 503)) status = 502;
    return reply.status(status).send({ code: err.code, message: err.message });
  }
  if (err?.status && err.status < 500) return reply.status(err.status).send({ code: err.code, message: err.message });
  log?.error?.({ code: err?.code || 'INTERNAL' }, 'GoHighLevel forms route failed');
  return reply.status(500).send({ message: 'Request failed' });
}

const noStore = (reply) => reply.header('cache-control', 'no-store');

/** Last receipts: status / reason / shape / sizes / lead ids only (never a value, never the contact id). */
export function receiptView(r) {
  return { at: r.receivedAt, status: r.status, reason: r.reason || null, shape: r.shape || null, bytes: r.bytes, leadId: r.leadId || null, duplicateOf: r.duplicateOf || null, contact: !!r.externalId };
}

async function integrationView(project, request, { token = null, secret = null } = {}) {
  const [ep, receipts, mirrorRows] = await Promise.all([
    loadEndpoint(project.id),
    prisma.externalFormReceipt.findMany({ where: { projectId: project.id }, orderBy: { receivedAt: 'desc' }, take: 50 }),
    prisma.cmsLead.findMany({
      where: { projectId: project.id, provider: 'ghl', erasedAt: null },
      orderBy: { receivedAt: 'desc' },
      take: 200,
      select: { leadId: true, provider: true, receivedAt: true, mirrorState: true, mirrorAttempts: true, mirrorNextAt: true, mirrorError: true, cmsMirrorLeadId: true },
    }),
  ]);
  const lastForm = receipts.find((r) => r.status === 'accepted' && r.formId)?.formId || null;
  const counts = {};
  for (const l of mirrorRows) counts[l.mirrorState || 'none'] = (counts[l.mirrorState || 'none'] || 0) + 1;
  const forms = Array.isArray(project.cmsHealth?.leads?.forms) ? project.cmsHealth.leads.forms : [];
  return {
    endpoint: endpointView(ep),
    ...(token ? { token } : {}),
    ...(secret ? { headerSecret: secret, headerSecretName: HEADER_SECRET_NAME } : {}),
    setup: webhookSetup({ baseUrl: publicBaseUrl(request), token, secret, headerSecret: !!ep?.headerSecretHash, form: { id: lastForm || '<GHL form id>', name: '<GHL form name>' } }),
    site: {
      emdash: project.cmsType === 'EMDASH',
      leadImport: project.cmsCapabilities?.leadImport === true,
      forms: forms.map((f) => ({ id: f.id, name: f.name, provider: f.provider || 'emdash', external: f.external === true })),
      ghlFormId: siteFormIdFor(project).id,
    },
    receipts: receipts.map(receiptView),
    mirror: {
      counts,
      items: mirrorRows.filter((l) => l.mirrorState && l.mirrorState !== 'done').slice(0, 50).map((l) => ({ leadId: l.leadId, receivedAt: l.receivedAt, ...mirrorView(l) })),
    },
  };
}

export async function pmGhlFormsRoutes(app) {
  const read = { onRequest: [app.verifyJwt, rejectToken] };
  const write = { onRequest: [app.verifyJwt, rejectAgentWrite] };
  const base = '/projects/:projectId/integrations/ghl-forms';

  app.get(base, read, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      noStore(reply);
      return reply.send(await integrationView(project, request));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // Generate (first time / after a revoke). The token is in THIS response only.
  app.post(`${base}/token`, write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      const { token } = await generateEndpoint(project.id, request.user);
      request.log.info({ projectId: project.id }, 'GHL forms webhook token generated');
      noStore(reply);
      return reply.send(await integrationView(project, request, { token }));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // Rotate: new token now, the old one keeps working for 24 h.
  app.post(`${base}/rotate`, write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      const { token } = await rotateEndpoint(project.id);
      request.log.info({ projectId: project.id }, 'GHL forms webhook token rotated');
      noStore(reply);
      return reply.send(await integrationView(project, request, { token }));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.post(`${base}/revoke`, write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      await revokeEndpoint(project.id);
      request.log.info({ projectId: project.id }, 'GHL forms webhook token revoked');
      noStore(reply);
      return reply.send(await integrationView(project, request));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // Optional header secret: { clear: true } removes it; otherwise a new one (shown once).
  app.post(`${base}/header-secret`, write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      const { secret } = await setHeaderSecret(project.id, { clear: request.body?.clear === true });
      request.log.info({ projectId: project.id, cleared: !secret }, 'GHL forms header secret changed');
      noStore(reply);
      return reply.send(await integrationView(project, request, { secret }));
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // lead-import mirror "Retry" (people only, OWNER / PM): sends now as the person.
  app.post('/projects/:projectId/cms-leads/:leadId/mirror-retry', write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply);
      if (!project) return;
      const out = await retryLeadImport(project.id, String(request.params.leadId), request.user, { log: request.log });
      noStore(reply);
      return reply.send(out);
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  // Erasure checklist: "Delete the contact in GoHighLevel too" was done (OWNER, people only).
  app.post('/projects/:projectId/cms-leads/:leadId/external-erased', write, async (request, reply) => {
    try {
      const project = await projectFor(request, reply, ['OWNER']);
      if (!project) return;
      const done = await confirmExternalErase(project.id, String(request.params.leadId));
      if (!done) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Nothing to confirm for this lead.' });
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });
}
