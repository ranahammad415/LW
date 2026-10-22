/**
 * Monthly security report (plan §5.7), HTML only (no PDF until formalReportPdf is fixed). Two editions from the same
 * stored data (daily points, transitions, backup runs, check states, incidents, site status):
 *   - client: sections 1–9 in plain language. No numeric score, check id, evidence, remediation, version string, host,
 *     destination id/type, setting, acknowledgement or log row (decision O-4).
 *   - admin: the same plus section 10 (full check table with evidence, incident log, log statistics).
 * Served like uploaded HTML reports: `Content-Security-Policy: HTML_REPORT_VIEW_CSP` (no scripts). Every value is
 * HTML-escaped; site text is text. No AI calls.
 */
import { prisma } from '../prisma.js';
import { hasSecurity, hasBackups } from './securitySync.js';
import { gatherSignalsReport, renderSignalsSection } from '../signals/report.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isReportMonth = (m) => typeof m === 'string' && MONTH_RE.test(m);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  const days = Math.round((end - start) / 86400_000);
  return { start, end, days, from: start.toISOString().slice(0, 10), to: new Date(end - 86400_000).toISOString().slice(0, 10) };
}

const COLOR = { ok: '#10b981', warn: '#f59e0b', fail: '#ef4444', unknown: '#94a3b8' };
const WORD = { ok: 'Protected', warn: 'Needs attention', fail: 'Action required', unknown: 'Not measured' };
const fmtDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'never');

/** Plain word for a check's state at month end (client wording; never the id). */
function stateWord(row, okWord = 'OK') {
  if (!row) return 'not measured';
  if (row.state === 'ok') return okWord;
  if (row.state === 'unknown') return 'not measured';
  if (row.state === 'n/a') return 'not applicable';
  return row.state === 'fail' ? 'needs action' : 'needs attention';
}

/** State strip (client: colours only) or score sparkline (admin: with numbers in titles). */
function trendSvg(points, { withScores }) {
  if (!points.length) return '<p class="muted">No daily data this month.</p>';
  const w = 10;
  const h = 40;
  const bars = points
    .map((p, i) => {
      const bh = withScores ? Math.max(3, Math.round((p.score / 100) * h)) : h;
      const title = withScores ? `${p.date}: ${p.overallState}, score ${p.score}` : `${p.date}: ${WORD[p.overallState] || p.overallState}`;
      return `<rect x="${i * (w + 2)}" y="${h - bh}" width="${w}" height="${bh}" fill="${COLOR[p.overallState] || COLOR.unknown}"><title>${esc(title)}</title></rect>`;
    })
    .join('');
  return `<svg width="${points.length * (w + 2)}" height="${h}" role="img" aria-label="Daily state">${bars}</svg>`;
}

const ITEM_STATE = { ok: 'resolved', warn: 'needs attention', fail: 'needs action', unknown: 'not measured', 'n/a': 'not applicable' };

/**
 * The month's transitions grouped per check (pure, O-R2-5). `opened`: the check turned fail / warn this month with
 * client wording; `resolved`: it went fail / warn → ok this month and is ok at its last change.
 */
export function collapseItems(transitions, byId = new Map()) {
  const per = new Map();
  for (const t of [...(transitions || [])].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    let i = per.get(t.checkId);
    if (!i) {
      i = { checkId: t.checkId, firstAt: null, lastState: null, lastAt: null, changes: 0, clientSummary: null, opened: false, resolved: false, resolvedAt: null, resolvedSummary: null };
      per.set(t.checkId, i);
    }
    i.changes += 1;
    i.lastState = t.toState;
    i.lastAt = t.at;
    if (t.clientSummary && (t.toState === 'fail' || t.toState === 'warn')) {
      i.opened = true;
      if (!i.firstAt) i.firstAt = t.at;
      i.clientSummary = t.clientSummary;
    }
    if (t.toState === 'ok' && (t.fromState === 'fail' || t.fromState === 'warn') && byId.get(t.checkId)?.clientSummary) {
      i.resolvedAt = t.at;
      i.resolvedSummary = byId.get(t.checkId).clientSummary;
    }
  }
  for (const i of per.values()) i.resolved = !!i.resolvedAt && i.lastState === 'ok';
  return [...per.values()];
}

function okDaysFor(points, checkId) {
  return points.filter((p) => p.checks && p.checks[checkId] === 'ok').length;
}

/** Gather everything for one project and month (pure reads). */
export async function gatherReportData(projectId, month) {
  const { start, end, from, to, days } = monthRange(month);
  const [project, status, points, transitions, runs, checks, incidents] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, cmsType: true, cmsCapabilities: true, client: { select: { agencyName: true } } } }),
    prisma.securitySiteStatus.findUnique({ where: { projectId } }),
    prisma.securityDailyPoint.findMany({ where: { projectId, date: { gte: from, lte: to } }, orderBy: { date: 'asc' } }),
    prisma.securityTransition.findMany({ where: { projectId, at: { gte: start, lt: end } }, orderBy: { at: 'asc' }, take: 2000 }),
    prisma.securityBackupRun.findMany({ where: { projectId, OR: [{ startedAt: { gte: start, lt: end } }, { finishedAt: { gte: start, lt: end } }] }, take: 2000 }),
    prisma.securityCheckState.findMany({ where: { projectId } }),
    prisma.securityIncident.findMany({ where: { projectId, lastAt: { gte: start } }, orderBy: { lastAt: 'asc' } }),
  ]);
  // v1.7.0 plan §6.4: "Where your enquiries came from" (sites with capabilities.signals only).
  const signals = project ? await gatherSignalsReport(project, month).catch(() => null) : null;
  return { project, status, points, transitions, runs, checks, incidents, month, days, signals };
}

/** Build both editions (pure). */
export function renderSecurityReport(data, { planNote = null, agencyName = 'Your agency' } = {}) {
  const { project, status, points, transitions, runs, checks, incidents, month, days, signals = null } = data;
  const byId = new Map((checks || []).map((c) => [c.checkId, c]));
  const endState = points.length ? points[points.length - 1].overallState : status?.overallState || 'unknown';
  const counts = { ok: 0, warn: 0, fail: 0, unknown: 0 };
  for (const p of points) counts[p.overallState] = (counts[p.overallState] || 0) + 1;

  // 3. Backups
  const agencyOkDays = new Set(runs.filter((r) => r.owner === 'agency' && r.result === 'ok').map((r) => fmtDay(r.finishedAt || r.startedAt))).size;
  const backups = status?.backups && typeof status.backups === 'object' ? status.backups : null;
  const restore = status?.lastRestoreTest || backups?.lastRestoreTest || null;
  const clientDest = (backups?.client || []).map((d) => {
    const fails = runs.filter((r) => r.destinationId === d.destinationId && (r.result === 'failed' || r.result === 'missed')).length;
    const oks = runs.filter((r) => r.destinationId === d.destinationId && r.result === 'ok').length;
    return { label: d.label || 'Your backup destination', lastOkAt: d.files?.lastOkAt || d.db?.lastOkAt || null, oks, fails };
  });

  // 7. Items (client wording only), one row per check (O-R2-5): first seen this month, last state, number of changes.
  const items = collapseItems(transitions, byId);
  const opened = items.filter((i) => i.opened);
  const closed = items.filter((i) => i.resolved);
  const disabled = new Set(Array.isArray(status?.disabled) ? status.disabled : []);
  const carried = (checks || []).filter((c) => c.clientSummary && (c.state === 'fail' || c.state === 'warn') && !disabled.has(c.checkId));

  const summary = [
    `In ${month} your website was ${endState === 'ok' ? 'protected and backed up at the end of the month' : endState === 'unknown' ? 'not fully measured at the end of the month' : 'being worked on at the end of the month'}.`,
    `The agency backup succeeded on ${agencyOkDays} of ${days} days${restore ? ` and the last restore test ${restore.result === 'ok' ? 'passed' : 'did not pass'} (${fmtDay(restore.at)})` : ''}.`,
    `${opened.length} item${opened.length === 1 ? '' : 's'} needed attention this month, ${closed.length} ${closed.length === 1 ? 'was' : 'were'} resolved and ${carried.length} ${carried.length === 1 ? 'is' : 'are'} still open.`,
  ];

  const audit = status?.lastBuild?.npmAudit || null;
  const protection = [
    ['Secure connection certificate', stateWord(byId.get('edge.tls_cert_expiry'), 'valid')],
    ['Cloudflare protection', points.some((p) => p.checks) ? `active on ${okDaysFor(points, 'edge.cloudflare_proxied')} of ${points.length} measured days` : stateWord(byId.get('edge.cloudflare_proxied'), 'active')],
    ['Always-secure connections (HSTS)', stateWord(byId.get('edge.hsts'), 'on')],
    ['Content security policy', stateWord(byId.get('edge.csp_mode'), 'enforcing')],
    ['Spam protection on forms', stateWord(byId.get('app.quote_spam_rate'), 'working')],
    ['Unsafe uploads refused', stateWord(byId.get('app.upload_rejections'), 'working')],
  ];
  const accounts = [
    ['Admin accounts protected by passkeys', byId.get('cms.passkeys_per_admin') ? (byId.get('cms.passkeys_per_admin').state === 'ok' ? 'yes' : stateWord(byId.get('cms.passkeys_per_admin'))) : 'not measured'],
    ['Admin accounts within the agreed number', stateWord(byId.get('cms.admin_users_inventory'), 'yes')],
    ['Agent accounts reviewed', 'not recorded yet'],
  ];
  const software = [
    ['Website software up to date', stateWord(byId.get('supply.emdash_version_latest'), 'yes')],
    ['Known high-risk vulnerabilities in shipped software', audit ? (audit.high === 0 && audit.critical === 0 ? 'none' : 'some (being fixed)') : 'not measured'],
  ];
  const email = [
    ['SPF', stateWord(byId.get('email.spf'))],
    ['DKIM', stateWord(byId.get('email.dkim'))],
    ['DMARC', stateWord(byId.get('email.dmarc_policy'))],
  ];
  const rows = (list) => list.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const li = (list, f) => (list.length ? `<ul>${list.map((x) => `<li>${f(x)}</li>`).join('')}</ul>` : '<p class="muted">None.</p>');

  const css = `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:860px;margin:24px auto;padding:0 16px;line-height:1.5}
h1{font-size:24px;margin:0}h2{font-size:18px;margin-top:28px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top}th{font-weight:600;width:45%}
.muted{color:#64748b}.light{display:inline-block;width:14px;height:14px;border-radius:50%;margin-right:6px;vertical-align:middle}
pre{white-space:pre-wrap;background:#f8fafc;padding:6px;font-size:11px;margin:0}.small{font-size:12px}`;

  const body = (admin) => {
    const parts = [];
    parts.push(`<header><p class="muted">${esc(agencyName)} · Monthly security report${admin ? ' (agency edition)' : ''}</p>
<h1>${esc(project?.name || 'Your website')}: ${esc(month)}</h1>
<p><span class="light" style="background:${COLOR[endState] || COLOR.unknown}"></span>${esc(WORD[endState] || 'Not measured')} at the end of the month</p>
${trendSvg(points, { withScores: admin })}
${admin && points.length ? `<p class="small muted">Score ${esc(points[0].score)} → ${esc(points[points.length - 1].score)}; days ok ${counts.ok}, warning ${counts.warn}, failing ${counts.fail}, unknown ${counts.unknown}</p>` : ''}</header>`);
    parts.push(`<h2>1. Summary</h2><p>${summary.map(esc).join(' ')}</p>`);
    parts.push(`<h2>2. Backups</h2><table>${rows([
      ['Days with a successful agency backup', `${agencyOkDays} of ${days}`],
      ['Off-site copy', backups?.agency?.offsite?.lastOkAt ? `last ${fmtDay(backups.agency.offsite.lastOkAt)}` : 'not reported'],
      ['Last restore test', restore ? `${restore.result === 'ok' ? 'passed' : 'did not pass'} on ${fmtDay(restore.at)}` : 'none yet'],
    ])}</table>${clientDest.length ? `<p>Your own backup destinations:</p>${li(clientDest, (d) => `${esc(d.label)}: last success ${esc(fmtDay(d.lastOkAt))}${d.fails ? `, ${d.fails} problem${d.fails === 1 ? '' : 's'} this month` : ''}`)}` : ''}`);
    parts.push(`<h2>3. Protection</h2><table>${rows(protection)}</table>`);
    parts.push(`<h2>4. Accounts</h2><table>${rows(accounts)}</table>`);
    parts.push(`<h2>5. Software</h2><table>${rows(software)}</table>`);
    parts.push(`<h2>6. Email domain</h2><table>${rows(email)}</table>`);
    parts.push(`<h2>7. Items this month</h2><p><strong>Needed attention</strong></p>${li(opened, (i) => `${esc(i.clientSummary)} <span class="muted small">(first seen ${esc(fmtDay(i.firstAt))}; ${esc(ITEM_STATE[i.lastState] || 'not measured')} at month end${i.changes > 1 ? `; changed ${esc(i.changes)} times` : ''})</span>${admin ? ` <span class="small">[${esc(i.checkId)}]</span>` : ''}`)}
<p><strong>Resolved</strong></p>${li(closed, (i) => `${esc(i.resolvedSummary)} <span class="muted small">(${esc(fmtDay(i.resolvedAt))})</span>`)}
<p><strong>Still open</strong></p>${li(carried, (c) => `${esc(c.clientSummary)}${c.pmNote ? ` · The agency: ${esc(c.pmNote)}` : ''}${c.pmNoteEta ? ` · expected by ${esc(fmtDay(c.pmNoteEta))}` : ''}`)}`);
    const enquiries = renderSignalsSection(signals, { admin, esc });
    if (enquiries) parts.push(enquiries);
    parts.push(`<h2>8. Next month</h2><p>${planNote ? esc(planNote) : 'The agency keeps watching your website every day and will tell you if anything needs your attention.'}</p>`);
    if (admin) {
      const all = [...(checks || [])].sort((a, b) => a.checkId.localeCompare(b.checkId));
      parts.push(`<h2>9. Appendix (agency only)</h2>
<h3>Checks at report time</h3><table><tr><th>Check</th><td><strong>State · severity · since</strong></td></tr>${all
        .map((c) => `<tr><th>${esc(c.checkId)}</th><td>${esc(c.state)} · ${esc(c.severity)} · ${esc(fmtDay(c.since))}<br>${esc(c.summary || '')}${c.evidence ? `<pre>${esc(JSON.stringify(c.evidence, null, 1))}</pre>` : ''}${c.remediation ? `<div class="small">Fix: ${esc(c.remediation)}</div>` : ''}</td></tr>`)
        .join('')}</table>
<h3>Transitions this month (${transitions.length})</h3>${li(transitions.slice(0, 500), (t) => `${esc(fmtDay(t.at))} ${esc(t.checkId)}: ${esc(t.fromState || 'new')} → ${esc(t.toState)} (${esc(t.severity)})`)}
<h3>Incidents</h3>${li(incidents, (i) => `${esc(i.phase)} · ${esc(i.severity)}: ${esc(i.summary)} (${esc(fmtDay(i.lastAt))})`)}
<h3>Backup runs this month (${runs.length})</h3><p class="small">${runs.filter((r) => r.result === 'ok').length} ok, ${runs.filter((r) => r.result === 'failed').length} failed, ${runs.filter((r) => r.result === 'missed').length} missed.</p>
<h3>Site</h3><p class="small">Catalogue ${esc(status?.catalogueVersion || '?')} · sentinel ${esc(status?.sentinelVersion || '?')} · last build ${esc(status?.lastBuild?.commit || '?')}</p>
<h3>Log statistics</h3><p class="muted">Logs are not collected yet (contract 1.6.0: logs-pull is Phase 3).</p>`);
    }
    return parts.join('\n');
  };
  const doc = (admin) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(project?.name || 'Website')} security report ${esc(month)}</title><style>${css}</style></head><body>${body(admin)}</body></html>`;
  return { clientHtml: doc(false), adminHtml: doc(true), overallState: endState };
}

/** Generate (or regenerate) and store the report for one project and month. */
export async function generateSecurityReport(projectId, month, { userId = null, planNote = null } = {}) {
  if (!isReportMonth(month)) throw Object.assign(new Error('Invalid month, expected YYYY-MM'), { statusCode: 400 });
  const data = await gatherReportData(projectId, month);
  if (!data.project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  const agency = await prisma.agencySetting.findFirst({ select: { agencyName: true } }).catch(() => null);
  const note = typeof planNote === 'string' && planNote.trim() ? planNote.trim().slice(0, 2000) : null;
  const { clientHtml, adminHtml, overallState } = renderSecurityReport(data, { planNote: note, agencyName: agency?.agencyName || 'Your agency' });
  const row = { clientHtml, adminHtml, overallState, generatedAt: new Date(), generatedById: userId };
  return prisma.securityMonthlyReport.upsert({
    where: { projectId_month: { projectId, month } },
    update: row,
    create: { projectId, month, ...row },
    select: { id: true, month: true, overallState: true, generatedAt: true },
  });
}

/** Leader-only monthly job (1st of the month): last month's report for every site with security or backups. */
export async function generateMonthlySecurityReports({ now = new Date(), log } = {}) {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const month = prev.toISOString().slice(0, 7);
  const projects = await prisma.project.findMany({ where: { cmsType: 'EMDASH', cmsPairedAt: { not: null }, status: { not: 'ARCHIVED' } }, select: { id: true, cmsType: true, cmsCapabilities: true } });
  let n = 0;
  for (const p of projects) {
    if (!hasSecurity(p) && !hasBackups(p)) continue;
    const exists = await prisma.securityMonthlyReport.findUnique({ where: { projectId_month: { projectId: p.id, month } }, select: { id: true } });
    if (exists) continue; // a person may already have generated it (with a plan note): never overwrite automatically
    try {
      await generateSecurityReport(p.id, month);
      n += 1;
    } catch (err) {
      log?.warn?.({ projectId: p.id, message: err?.message }, 'Monthly security report failed');
    }
  }
  return { month, generated: n };
}

export async function listSecurityReports(projectId, { take = 24 } = {}) {
  return prisma.securityMonthlyReport.findMany({ where: { projectId }, orderBy: { month: 'desc' }, take, select: { month: true, overallState: true, generatedAt: true } });
}
