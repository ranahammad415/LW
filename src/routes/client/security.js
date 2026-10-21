/**
 * Client portal security view (plan §5.5, decision O-4). Prefix /api/client.
 * Scoped to the caller's client accounts (an OWNER acts on a client through X-Client-Id via requireClient).
 * Shown only for EmDash projects whose site reports capabilities.security; WordPress projects get {available: false}
 * (the UI shows nothing, not red). The response is an allow-list (lib/security/securityViews.js
 * buildClientSecurityView): no score, check id, evidence, remediation, log, version, host, setting or acknowledgement.
 */
import { prisma } from '../../lib/prisma.js';
import { clientSecurityView } from '../../lib/security/securityViews.js';

export async function clientSecurityRoutes(app) {
  app.get('/projects/:id/security', { onRequest: [app.verifyJwt, app.requireClient] }, async (request, reply) => {
    const clientIds = request.clientAccountIds;
    if (!clientIds?.length) return reply.status(404).send({ message: 'No client account linked to this user' });
    const project = await prisma.project.findUnique({
      where: { id: String(request.params.id) },
      select: { id: true, clientId: true, cmsType: true, cmsCapabilities: true },
    });
    if (!project || !clientIds.includes(project.clientId)) return reply.status(404).send({ message: 'Project not found' });
    reply.header('cache-control', 'no-store');
    return reply.send(await clientSecurityView(project));
  });
}
