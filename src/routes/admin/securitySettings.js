/**
 * Agency security settings (plan §5.6 / §5.4): on-call users for critical/high security alerts
 * (AgencySetting.securityOnCallUserIds) and the OS retention of security history (securityRetentionDays, default 400).
 * OWNER only, people only (agents and API tokens: 403). Slack is an env var (SECURITY_SLACK_WEBHOOK_URL); only
 * whether it is set is returned, never the URL.
 */
import { prisma } from '../../lib/prisma.js';
import { rejectAgentSecurityWrite } from '../pm/security.js';

async function settingsRow() {
  let s = await prisma.agencySetting.findFirst();
  if (!s) s = await prisma.agencySetting.create({ data: {} });
  return s;
}

async function view(s) {
  const ids = Array.isArray(s.securityOnCallUserIds) ? s.securityOnCallUserIds.filter((x) => typeof x === 'string') : [];
  const candidates = await prisma.user.findMany({
    where: { role: { in: ['OWNER', 'PM'] }, isActive: true, isAgent: false },
    select: { id: true, name: true, role: true },
    orderBy: { name: 'asc' },
  });
  return {
    onCallUserIds: ids.filter((id) => candidates.some((c) => c.id === id)),
    retentionDays: s.securityRetentionDays ?? 400,
    slackConfigured: Boolean(String(process.env.SECURITY_SLACK_WEBHOOK_URL || '').trim()),
    candidates,
  };
}

export async function adminSecuritySettingsRoutes(app) {
  app.get('/security-settings', { onRequest: [app.verifyJwt, app.requireOwner] }, async (request, reply) => {
    return reply.send(await view(await settingsRow()));
  });

  app.patch('/security-settings', { onRequest: [app.verifyJwt, app.requireOwner, rejectAgentSecurityWrite] }, async (request, reply) => {
    const body = request.body || {};
    const s = await settingsRow();
    const data = {};
    if (body.onCallUserIds !== undefined) {
      if (!Array.isArray(body.onCallUserIds) || body.onCallUserIds.length > 20 || !body.onCallUserIds.every((x) => typeof x === 'string' && x.length <= 191)) {
        return reply.status(400).send({ message: 'onCallUserIds must be a list of at most 20 user ids' });
      }
      const ids = [...new Set(body.onCallUserIds)];
      const ok = await prisma.user.findMany({ where: { id: { in: ids }, role: { in: ['OWNER', 'PM'] }, isActive: true, isAgent: false }, select: { id: true } });
      if (ok.length !== ids.length) return reply.status(400).send({ message: 'On-call users must be active owners or PMs (not agent accounts)' });
      data.securityOnCallUserIds = ids;
    }
    if (body.retentionDays !== undefined) {
      const d = Number(body.retentionDays);
      if (!Number.isInteger(d) || d < 90 || d > 3650) return reply.status(400).send({ message: 'Retention must be 90–3650 days' });
      data.securityRetentionDays = d;
    }
    const updated = Object.keys(data).length ? await prisma.agencySetting.update({ where: { id: s.id }, data }) : s;
    return reply.send(await view(updated));
  });
}
