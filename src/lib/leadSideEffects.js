/**
 * What happens once a NEW lead is stored, whichever way it arrived (one place, so both paths behave the same):
 *   - EmDash site form: `lead.created` (lib/cmsLeads.js applyLeadEvent), provider "emdash";
 *   - embedded GoHighLevel form: the OS webhook (lib/ghlForms/receive.js), provider "ghl".
 * Side effects (PII-free; never called again for a duplicate, a replay or a mirror):
 *   1. SiteLeadEvent (form_submit) + SiteLeadDailyMetric bump (leads / formSubmits; breakdowns rules, paths and the
 *      `providers` dimension). Health v2 L1 and the Leads analytics read these rows.
 *   2. Staff notification `lead_received` (project lead PM + the client's lead / secondary PM; in-app, e-mail for PMs
 *      per template flags). Text: project name and form label only.
 *   3. Realtime `lead.created` on the project channel ({ leadId, provider } only).
 */
import { prisma } from './prisma.js';
import { notify as notifyDefault } from './notificationService.js';
import { publish as publishDefault } from './realtimeBus.js';
import { buildRecipients } from './notifyRecipients.js';

export const LEAD_PROVIDERS = Object.freeze(['emdash', 'ghl']);
export const PROVIDER_LABELS = Object.freeze({ emdash: 'Website form', ghl: 'GoHighLevel form' });

const utcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const providerOf = (row) => (row?.provider === 'ghl' ? 'ghl' : 'emdash');

/** The PII-free part of a lead for analytics (SiteLeadEvent meta). */
export function leadMeta(row) {
  return { source: providerOf(row), provider: providerOf(row), leadId: row.leadId, formId: row.formId ?? null, spam: row.spamVerdict ?? null, utm: row.utm || null };
}

/** Pure: breakdowns after one more lead (rules, paths, providers). */
export function bumpBreakdowns(prev, row) {
  const b = prev && typeof prev === 'object' ? prev : {};
  const rules = Array.isArray(b.rules) ? b.rules.map((x) => ({ ...x })) : [];
  const paths = Array.isArray(b.paths) ? b.paths.map((x) => ({ ...x })) : [];
  const providers = Array.isArray(b.providers) ? b.providers.map((x) => ({ ...x })) : [];
  const provider = providerOf(row);
  const ruleId = `${provider}:${row.formId || 'form'}`.slice(0, 80);
  const r = rules.find((x) => x.eventType === 'form_submit' && (x.ruleId || x.ruleLabel) === ruleId);
  if (r) r.count += 1;
  else rules.push({ ruleId, ruleLabel: row.formName || null, eventType: 'form_submit', count: 1 });
  if (row.sourcePath) {
    const p = paths.find((x) => x.path === row.sourcePath);
    if (p) p.count += 1;
    else paths.push({ path: row.sourcePath, count: 1 });
  }
  const pv = providers.find((x) => x.provider === provider);
  if (pv) pv.count += 1;
  else providers.push({ provider, label: PROVIDER_LABELS[provider], count: 1 });
  return { ...b, rules, paths, providers, ruleId };
}

export async function bumpLeadMetrics(projectId, row, db = prisma) {
  const occurredAt = row.siteCreatedAt || row.receivedAt || new Date();
  const { ruleId, ...next } = bumpBreakdowns(null, row);
  await db.siteLeadEvent.create({
    data: { projectId, eventType: 'form_submit', ruleId, ruleLabel: row.formName ?? null, pagePath: row.sourcePath ?? null, occurredAt, meta: leadMeta(row) },
  });
  const day = utcDay(new Date(occurredAt));
  const existing = await db.siteLeadDailyMetric.findUnique({ where: { projectId_date: { projectId, date: day } } });
  if (existing) {
    const { ruleId: _r, ...breakdowns } = bumpBreakdowns(existing.breakdowns, row);
    await db.siteLeadDailyMetric.update({ where: { id: existing.id }, data: { formSubmits: { increment: 1 }, leads: { increment: 1 }, breakdowns } });
  } else {
    await db.siteLeadDailyMetric.create({ data: { projectId, date: day, formSubmits: 1, leads: 1, breakdowns: next } });
  }
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Staff recipients of `lead_received`: project lead PM + the client's lead / secondary PM (never a client user). */
export async function leadRecipients(projectId, db = prisma) {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, leadPmId: true, client: { select: { leadPmId: true, secondaryPmId: true } } } });
  if (!p) return { project: null, ids: [] };
  return { project: p, ids: buildRecipients(null, [p.leadPmId], [p.client?.leadPmId, p.client?.secondaryPmId]) };
}

/** Notification + realtime for one new lead. Never throws (a failed notification never loses the lead). */
export async function announceNewLead(projectId, row, { notify = notifyDefault, publish = publishDefault, db = prisma, log } = {}) {
  const provider = providerOf(row);
  try {
    const { project, ids } = await leadRecipients(projectId, db);
    if (project && ids.length) {
      await notify({
        slug: 'lead_received',
        recipientIds: ids,
        variables: { projectName: escapeHtml(project.name || 'a project'), formLabel: provider === 'ghl' ? 'GoHighLevel form' : 'website form' },
        actionUrl: `/portal/admin/projects/${projectId}?tab=wp-pages`,
        metadata: { projectId, kind: 'lead', provider, leadId: row.leadId },
      });
    }
  } catch (err) {
    log?.warn?.({ code: err?.code || 'NOTIFY_FAILED', projectId }, 'Lead notification failed');
  }
  try {
    publish(projectId, 'lead.created', { leadId: row.leadId, provider });
  } catch {
    /* realtime is best-effort */
  }
}

/** Every side effect of a new lead (metrics, notification, realtime). Errors are swallowed per step. */
export async function afterNewLead(projectId, row, opts = {}) {
  await bumpLeadMetrics(projectId, row, opts.db || prisma).catch((err) => opts.log?.warn?.({ code: err?.code || 'METRICS_FAILED', projectId }, 'Lead metrics bump failed'));
  await announceNewLead(projectId, row, opts);
}
