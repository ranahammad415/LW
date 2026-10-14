/**
 * Admin Interview Scheduler (plan §4, §9; owner decision D8: OWNER only).
 *
 * Mounted at /api/admin with [verifyJwt, requireOwner] on every route. Bodies
 * are validated with Zod in the handlers (the app bypasses Fastify's
 * validator). Responses never include token hashes, nonces or plaintext
 * tokens, except the one-time link returned when an invite is created/resent.
 */
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import {
  createInvites,
  dispatchInvite,
  publicShape,
  logDispatch,
  frontendBase,
  renderInviteEmail,
  MAX_TTL_DAYS,
  TERMINAL_STATUSES,
} from '../../lib/interviewInvites.js';
import { buildInterviewAgenda } from '../../lib/interviewAgenda.js';
import { templateCatalog, QUESTION_BANK, TEMPLATE_KEYS, FOLDER_LABELS } from '../../lib/interviewQuestionBank.js';
import { buildSummaryEmail, agencyDisplayName } from '../../lib/interviewEmail.js';
import {
  resolveInterviewSettings,
  sanitizeSettingsPatch,
  upsertInterviewSettings,
  deleteClientOverride,
  listInterviewSettingRows,
  baseDefaults,
  AGENCY_SCOPE,
} from '../../lib/interviewSettings.js';
import { getAgencyUsage, getUsageByClient, costPerMinuteUsd } from '../../lib/voiceUsage.js';
import { CAPTURE_FOLDERS } from '../../lib/expertInterview.js';
import { listInviteCaptures } from '../../lib/interviewCapture.js';
import { openQuestions } from '../../lib/interviewAgenda.js';

const questionSchema = z.object({
  id: z.string().max(120).optional(),
  folder: z.string().max(100),
  prompt: z.string().min(1).max(300),
  topic: z.string().max(200).optional().nullable(),
  probe: z.string().max(200).optional().nullable(),
  factType: z.string().max(30).optional().nullable(),
  kind: z.enum(['primary', 'followup']).optional(),
  source: z.string().max(20).optional(),
});
const agendaSchema = z.object({
  goals: z.array(z.string().max(200)).max(5).optional(),
  questions: z.array(questionSchema).min(1).max(20),
});
const overridesSchema = z.object({
  goals: z.array(z.string().max(200)).max(5).optional(),
  removeQuestionIds: z.array(z.string().max(120)).max(40).optional(),
  addQuestions: z.array(questionSchema).max(20).optional(),
}).optional().nullable();

const createInviteSchema = z.object({
  clientId: z.string().min(1).max(191),
  projectId: z.string().max(191).optional().nullable(),
  templateKey: z.enum(TEMPLATE_KEYS).default('CUSTOM'),
  recipients: z.array(z.object({
    name: z.string().max(120).optional().nullable(),
    email: z.string().trim().email().max(255).optional().nullable().or(z.literal('')),
  })).min(1).max(20),
  scheduledSendAt: z.string().datetime({ offset: true }).optional().nullable(),
  expiresInDays: z.number().int().min(1).max(MAX_TTL_DAYS).default(14),
  agenda: agendaSchema.optional().nullable(),
  agendaOverrides: overridesSchema,
  emailSubject: z.string().max(200).optional().nullable(),
  emailIntro: z.string().max(4000).optional().nullable(),
  reminderDays: z.array(z.number().int().min(1).max(60)).max(5).optional(),
  minutesBudget: z.number().int().min(1).max(120).optional().nullable(),
  language: z.string().max(10).optional(),
  mode: z.enum(['VOICE', 'TEXT']).optional(),
  sendEmail: z.boolean().default(true),
  autoApproveLowRisk: z.boolean().optional().nullable(),
});

const previewEmailSchema = z.object({
  clientId: z.string().min(1).max(191),
  templateKey: z.enum(TEMPLATE_KEYS).default('CUSTOM'),
  recipientName: z.string().max(120).optional().nullable(),
  agenda: agendaSchema.optional().nullable(),
  agendaOverrides: overridesSchema,
  emailSubject: z.string().max(200).optional().nullable(),
  emailIntro: z.string().max(4000).optional().nullable(),
  expiresInDays: z.number().int().min(1).max(MAX_TTL_DAYS).default(14),
  minutesBudget: z.number().int().min(1).max(120).optional().nullable(),
  kind: z.enum(['invite', 'reminder']).default('invite'),
});

function zodError(reply, err) {
  return reply.status(400).send({ message: err.issues?.[0]?.message || 'Invalid request', code: 'VALIDATION' });
}

async function clientNames(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const clients = await prisma.clientAccount.findMany({ where: { id: { in: unique } }, select: { id: true, agencyName: true } });
  return new Map(clients.map((c) => [c.id, c.agencyName]));
}

const PREVIEW_URL = () => `${frontendBase()}/knowledge-interview/preview-link`;

export async function adminInterviewRoutes(app) {
  const guard = { onRequest: [app.verifyJwt, app.requireOwner] };

  // ── Overview + budget card ────────────────────────────────────────────────
  app.get('/interviews/overview', guard, async (request, reply) => {
    const settings = await resolveInterviewSettings(null);
    const [grouped, upcoming, agency, perClientRaw, overrides] = await Promise.all([
      prisma.knowledgeInterviewInvite.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.knowledgeInterviewInvite.findMany({
        where: { status: 'SCHEDULED' },
        orderBy: { scheduledSendAt: 'asc' },
        take: 20,
      }),
      getAgencyUsage({ settings }),
      getUsageByClient(),
      listInterviewSettingRows(),
    ]);
    const names = await clientNames([...perClientRaw.map((r) => r.clientId), ...upcoming.map((u) => u.clientId)]);
    const overrideByClient = new Map(overrides.filter((o) => o.scope !== AGENCY_SCOPE).map((o) => [o.scope, o]));
    const rate = costPerMinuteUsd();
    const counts = {};
    for (const g of grouped) counts[g.status] = g._count._all;
    return reply.send({
      counts,
      upcoming: upcoming.map((u) => ({ ...publicShape(u), agenda: undefined, clientName: names.get(u.clientId) || 'Unknown client' })),
      budget: {
        costPerMinuteUsd: rate,
        agencyUsedMinutes: agency.usedMinutes,
        agencyLimitMinutes: agency.limitMinutes,
        perClient: perClientRaw
          .map((r) => {
            const limit = overrideByClient.get(r.clientId)?.monthlyMinutesPerClient ?? settings.monthlyMinutesPerClient;
            const usedMinutes = Math.round(r.usedSeconds / 60);
            return { clientId: r.clientId, clientName: names.get(r.clientId) || 'Unknown client', usedMinutes, limitMinutes: limit, estCostUsd: Math.round(usedMinutes * rate * 100) / 100 };
          })
          .sort((a, b) => b.usedMinutes - a.usedMinutes),
      },
    });
  });

  // ── Templates + question bank ─────────────────────────────────────────────
  app.get('/interviews/templates', guard, async (request, reply) => {
    return reply.send({
      templates: templateCatalog(),
      folders: CAPTURE_FOLDERS.map((f) => ({ folder: f, label: FOLDER_LABELS[f] || f })),
      questionBank: QUESTION_BANK.map((q) => ({ id: q.id, folder: q.folder, factType: q.factType, topic: q.topic, prompt: q.prompt, templates: q.templates })),
    });
  });

  // ── Agenda preview (local KB only; no AI, no live fetch) ──────────────────
  app.post('/interviews/agenda/preview', guard, async (request, reply) => {
    const parsed = z.object({
      clientId: z.string().min(1).max(191),
      templateKey: z.enum(TEMPLATE_KEYS).default('CUSTOM'),
      overrides: overridesSchema,
    }).safeParse(request.body || {});
    if (!parsed.success) return zodError(reply, parsed.error);
    const client = await prisma.clientAccount.findUnique({ where: { id: parsed.data.clientId }, select: { id: true } });
    if (!client) return reply.status(404).send({ message: 'Client not found' });
    const agenda = await buildInterviewAgenda({
      clientId: parsed.data.clientId,
      templateKey: parsed.data.templateKey,
      overrides: parsed.data.overrides || {},
    });
    return reply.send({ agenda });
  });

  // ── Recipient picker: client contacts ─────────────────────────────────────
  app.get('/interviews/clients/:clientId/contacts', guard, async (request, reply) => {
    const contacts = await prisma.clientUser.findMany({
      where: { clientId: request.params.clientId },
      select: { isPrimaryContact: true, jobTitle: true, user: { select: { id: true, name: true, email: true, isActive: true } } },
    });
    return reply.send({
      contacts: contacts
        .filter((c) => c.user?.isActive !== false)
        .map((c) => ({ userId: c.user.id, name: c.user.name, email: c.user.email, isPrimaryContact: c.isPrimaryContact, jobTitle: c.jobTitle }))
        .sort((a, b) => Number(b.isPrimaryContact) - Number(a.isPrimaryContact)),
    });
  });

  // ── Invites: list ─────────────────────────────────────────────────────────
  app.get('/interviews/invites', guard, async (request, reply) => {
    const parsed = z.object({
      clientId: z.string().max(191).optional(),
      status: z.string().max(20).optional(),
      rootInviteId: z.string().max(191).optional(),
      page: z.coerce.number().int().min(1).max(1000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }).safeParse(request.query || {});
    if (!parsed.success) return zodError(reply, parsed.error);
    const { clientId, status, rootInviteId, page, pageSize } = parsed.data;
    const where = {
      ...(clientId ? { clientId } : {}),
      ...(status ? { status } : {}),
      ...(rootInviteId ? { rootInviteId } : { delegationDepth: 0 }),
    };
    const [rows, total] = await Promise.all([
      prisma.knowledgeInterviewInvite.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.knowledgeInterviewInvite.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const [names, children, drafts] = await Promise.all([
      clientNames(rows.map((r) => r.clientId)),
      ids.length ? prisma.knowledgeInterviewInvite.groupBy({ by: ['parentInviteId'], where: { parentInviteId: { in: ids } }, _count: { _all: true } }) : [],
      ids.length ? prisma.okfDraftChange.groupBy({ by: ['rootInviteId', 'status'], where: { rootInviteId: { in: ids } }, _count: { _all: true } }) : [],
    ]);
    const childCount = new Map(children.map((c) => [c.parentInviteId, c._count._all]));
    const draftCounts = new Map();
    for (const d of drafts) {
      const cur = draftCounts.get(d.rootInviteId) || { PENDING: 0, APPROVED: 0, REJECTED: 0 };
      cur[d.status] = d._count._all;
      draftCounts.set(d.rootInviteId, cur);
    }
    return reply.send({
      total,
      page,
      pageSize,
      invites: rows.map((r) => ({
        ...publicShape(r),
        agenda: undefined,
        topicCount: Array.isArray(r.agenda?.questions) ? r.agenda.questions.length : 0,
        clientName: names.get(r.clientId) || 'Unknown client',
        childCount: childCount.get(r.id) || 0,
        drafts: draftCounts.get(r.id) || { PENDING: 0, APPROVED: 0, REJECTED: 0 },
      })),
    });
  });

  // ── Invites: create (send now / schedule / link only) ─────────────────────
  app.post('/interviews/invites', guard, async (request, reply) => {
    const parsed = createInviteSchema.safeParse(request.body || {});
    if (!parsed.success) return zodError(reply, parsed.error);
    const b = parsed.data;
    const client = await prisma.clientAccount.findUnique({ where: { id: b.clientId }, select: { id: true } });
    if (!client) return reply.status(404).send({ message: 'Client not found' });
    if (b.projectId) {
      const project = await prisma.project.findFirst({ where: { id: b.projectId, clientId: b.clientId }, select: { id: true } });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
    }
    if (b.sendEmail && b.recipients.some((r) => !r.email)) {
      return reply.status(400).send({ message: 'Every recipient needs an email address when sending by email.' });
    }
    const { invites, urls } = await createInvites({
      clientId: b.clientId,
      projectId: b.projectId || null,
      createdById: request.user.id,
      templateKey: b.templateKey,
      recipients: b.recipients.map((r) => ({ name: r.name || null, email: r.email || null })),
      scheduledSendAt: b.scheduledSendAt || null,
      expiresInDays: b.expiresInDays,
      agenda: b.agenda || null,
      agendaOverrides: b.agendaOverrides || null,
      emailSubject: b.emailSubject || null,
      emailIntro: b.emailIntro || null,
      reminderDays: b.reminderDays,
      minutesBudget: b.minutesBudget || null,
      language: b.language || 'en',
      mode: b.mode || 'VOICE',
      sendEmail: b.sendEmail,
      autoApproveLowRisk: typeof b.autoApproveLowRisk === 'boolean' ? b.autoApproveLowRisk : null,
    });
    // Plaintext links are returned exactly once, here.
    return reply.status(201).send({ invites: invites.map(publicShape), urls });
  });

  // ── Invites: detail with tree, sessions, drafts, log ──────────────────────
  app.get('/interviews/invites/:id', guard, async (request, reply) => {
    const invite = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: request.params.id } });
    if (!invite) return reply.status(404).send({ message: 'Invite not found' });
    const withTranscript = String(request.query?.transcript || '') === '1';
    const rootId = invite.rootInviteId || invite.id;
    const tree = await prisma.knowledgeInterviewInvite.findMany({ where: { rootInviteId: rootId }, orderBy: { createdAt: 'asc' } });
    const treeIds = tree.length ? tree.map((t) => t.id) : [invite.id];
    const [sessions, drafts, log, names] = await Promise.all([
      prisma.voiceInterviewSession.findMany({
        where: { inviteId: { in: treeIds } },
        orderBy: { startedAt: 'asc' },
        select: {
          id: true, inviteId: true, mode: true, status: true, startedAt: true, endedAt: true, durationSeconds: true,
          consolidationStatus: true, summary: true, ...(withTranscript ? { transcript: true } : {}),
        },
      }),
      prisma.okfDraftChange.findMany({
        where: { inviteId: { in: treeIds } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, inviteId: true, title: true, folder: true, filename: true, status: true, changeKind: true,
          riskLevel: true, factType: true, respondentName: true, respondentRole: true, clientCorrected: true, createdAt: true,
        },
      }),
      prisma.interviewDispatchLog.findMany({ where: { inviteId: { in: treeIds } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      clientNames([invite.clientId]),
    ]);
    const root = tree.find((t) => t.id === rootId) || invite;
    return reply.send({
      invite: { ...publicShape(invite), clientName: names.get(invite.clientId) || 'Unknown client' },
      agenda: invite.agenda ? { ...invite.agenda, knowledgeDigest: undefined } : null,
      root: publicShape({ ...root, agenda: undefined }),
      children: tree.filter((t) => t.id !== rootId).map((c) => ({ ...publicShape(c), agenda: undefined })),
      sessions,
      drafts,
      dispatchLog: log,
    });
  });

  async function loadInvite(request, reply) {
    const invite = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: request.params.id } });
    if (!invite) {
      reply.status(404).send({ message: 'Invite not found' });
      return null;
    }
    return invite;
  }

  app.post('/interviews/invites/:id/resend', guard, async (request, reply) => {
    const invite = await loadInvite(request, reply);
    if (!invite) return;
    if (['COMPLETED', 'REVOKED', 'DECLINED', 'PENDING_CONFIRM'].includes(invite.status)) {
      return reply.status(409).send({ message: `A ${invite.status.toLowerCase()} invite cannot be resent.` });
    }
    if (!invite.sentToEmail) return reply.status(400).send({ message: 'This invite has no email address.' });
    // Resending an expired invite reopens it for the original TTL window.
    if (invite.status === 'EXPIRED' || invite.expiresAt.getTime() < Date.now()) {
      await prisma.knowledgeInterviewInvite.update({
        where: { id: invite.id },
        data: { status: 'PENDING', expiresAt: new Date(Date.now() + 7 * 864e5), statusReason: null },
      });
    }
    const fresh = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: invite.id } });
    const res = await dispatchInvite(fresh, { kind: 'RESEND' });
    const after = await prisma.knowledgeInterviewInvite.findUnique({ where: { id: invite.id } });
    return reply.send({ invite: publicShape(after), url: res.url, emailed: res.ok, error: res.error || null });
  });

  app.post('/interviews/invites/:id/revoke', guard, async (request, reply) => {
    const invite = await loadInvite(request, reply);
    if (!invite) return;
    if (TERMINAL_STATUSES.includes(invite.status) && invite.status !== 'EXPIRED') {
      return reply.send({ invite: publicShape(invite) });
    }
    const updated = await prisma.knowledgeInterviewInvite.update({
      where: { id: invite.id },
      data: { status: 'REVOKED', revokedAt: new Date(), statusReason: 'revoked by owner' },
    });
    await logDispatch({ inviteId: invite.id, kind: 'REVOKE', detail: `by ${request.user.id}` });
    return reply.send({ invite: publicShape(updated) });
  });

  app.post('/interviews/invites/:id/extend', guard, async (request, reply) => {
    const invite = await loadInvite(request, reply);
    if (!invite) return;
    const parsed = z.object({ expiresInDays: z.number().int().min(1).max(MAX_TTL_DAYS) }).safeParse(request.body || {});
    if (!parsed.success) return zodError(reply, parsed.error);
    if (['COMPLETED', 'REVOKED', 'DECLINED'].includes(invite.status)) {
      return reply.status(409).send({ message: `A ${invite.status.toLowerCase()} invite cannot be extended.` });
    }
    const base = Math.max(Date.now(), invite.expiresAt.getTime());
    const expiresAt = new Date(Math.min(base + parsed.data.expiresInDays * 864e5, Date.now() + MAX_TTL_DAYS * 864e5));
    const updated = await prisma.knowledgeInterviewInvite.update({
      where: { id: invite.id },
      data: {
        expiresAt,
        ...(invite.status === 'EXPIRED' ? { status: invite.sentAt ? 'SENT' : 'PENDING', statusReason: null } : {}),
      },
    });
    await logDispatch({ inviteId: invite.id, kind: 'EXTEND', detail: `to ${expiresAt.toISOString()}` });
    return reply.send({ invite: publicShape(updated) });
  });

  // ── Email previews (placeholder link; never sends) ────────────────────────
  app.post('/interviews/invites/:id/preview-email', guard, async (request, reply) => {
    const invite = await loadInvite(request, reply);
    if (!invite) return;
    const kind = String(request.body?.kind || 'invite');
    if (kind === 'summary') {
      const tree = await prisma.knowledgeInterviewInvite.findMany({ where: { rootInviteId: invite.rootInviteId || invite.id } });
      const captures = await listInviteCaptures(tree.map((t) => t.id));
      const drafts = await prisma.okfDraftChange.findMany({
        where: { id: { in: captures.map((c) => c.id) } },
        select: { title: true, folder: true, proposedBody: true, respondentName: true, respondentRole: true, status: true, proposedMetadata: true, changeKind: true },
      });
      const client = await prisma.clientAccount.findUnique({ where: { id: invite.clientId }, select: { agencyName: true } });
      const email = await buildSummaryEmail({
        root: invite,
        businessName: client?.agencyName || 'your business',
        agencyName: await agencyDisplayName(),
        url: PREVIEW_URL(),
        captures: drafts,
        children: tree.filter((t) => t.id !== invite.id),
        openQuestions: openQuestions(invite.agenda),
      });
      return reply.send(email);
    }
    const email = await renderInviteEmail(invite, { url: PREVIEW_URL(), isReminder: kind === 'reminder' });
    return reply.send({ subject: email.subject, html: email.html, text: email.text });
  });

  app.post('/interviews/preview-email', guard, async (request, reply) => {
    const parsed = previewEmailSchema.safeParse(request.body || {});
    if (!parsed.success) return zodError(reply, parsed.error);
    const b = parsed.data;
    const client = await prisma.clientAccount.findUnique({ where: { id: b.clientId }, select: { id: true } });
    if (!client) return reply.status(404).send({ message: 'Client not found' });
    const agenda = b.agenda
      ? { goals: b.agenda.goals, questions: b.agenda.questions.map((q) => ({ ...q, kind: q.kind || 'primary' })), estMinutes: Math.max(5, Math.round(b.agenda.questions.length * 1.2)) }
      : await buildInterviewAgenda({ clientId: b.clientId, templateKey: b.templateKey, overrides: b.agendaOverrides || {} });
    const fake = {
      id: 'preview',
      clientId: b.clientId,
      recipientName: b.recipientName || null,
      agenda,
      emailSubject: b.emailSubject || null,
      emailIntro: b.emailIntro || null,
      expiresAt: new Date(Date.now() + b.expiresInDays * 864e5),
      minutesBudget: b.minutesBudget || 20,
      respondentRole: 'CLIENT',
    };
    const email = await renderInviteEmail(fake, { url: PREVIEW_URL(), isReminder: b.kind === 'reminder' });
    return reply.send({ subject: email.subject, html: email.html, text: email.text });
  });

  // ── Settings (D5/D6/D7) ───────────────────────────────────────────────────
  app.get('/interviews/settings', guard, async (request, reply) => {
    const rows = await listInterviewSettingRows();
    const agencyRow = rows.find((r) => r.scope === AGENCY_SCOPE) || null;
    const clientRows = rows.filter((r) => r.scope !== AGENCY_SCOPE);
    const names = await clientNames(clientRows.map((r) => r.scope));
    const effectiveAgency = await resolveInterviewSettings(null);
    return reply.send({
      defaults: baseDefaults(),
      agency: agencyRow,
      effectiveAgency,
      clients: await Promise.all(
        clientRows.map(async (r) => ({
          clientId: r.scope,
          clientName: names.get(r.scope) || 'Unknown client',
          override: r,
          effective: await resolveInterviewSettings(r.scope),
        }))
      ),
    });
  });

  app.put('/interviews/settings/agency', guard, async (request, reply) => {
    const { data, error } = sanitizeSettingsPatch(request.body || {}, { isAgency: true });
    if (error) return reply.status(400).send({ message: error, code: 'VALIDATION' });
    const row = await upsertInterviewSettings(AGENCY_SCOPE, data, request.user.id);
    return reply.send({ agency: row, effectiveAgency: await resolveInterviewSettings(null) });
  });

  app.put('/interviews/settings/clients/:clientId', guard, async (request, reply) => {
    const client = await prisma.clientAccount.findUnique({ where: { id: request.params.clientId }, select: { id: true } });
    if (!client) return reply.status(404).send({ message: 'Client not found' });
    const { data, error } = sanitizeSettingsPatch(request.body || {}, { isAgency: false });
    if (error) return reply.status(400).send({ message: error, code: 'VALIDATION' });
    const row = await upsertInterviewSettings(client.id, data, request.user.id);
    return reply.send({ override: row, effective: await resolveInterviewSettings(client.id) });
  });

  app.delete('/interviews/settings/clients/:clientId', guard, async (request, reply) => {
    await deleteClientOverride(request.params.clientId);
    return reply.send({ success: true });
  });

}

export default adminInterviewRoutes;
