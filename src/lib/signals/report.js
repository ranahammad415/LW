/**
 * Plan §6.4: monthly report section "Where your enquiries came from", rendered into the existing monthly HTML report
 * (lib/security/securityReport.js, after the security sections; same CSP-served HTML, client and admin editions).
 * From the daily tables only: channel table (leads, visits, conversion %), AI assistants by source, top 5 landing
 * pages, month-over-month and year-over-year deltas, the Google AI Mode footnote, a data-quality sentence. The admin
 * edition adds the first × last attribution matrix. Every value is escaped; no ids, no visitor ids, no city. No AI.
 */
import { prisma } from '../prisma.js';
import { hasSignals } from './config.js';
import { CHANNELS, channelOf, sourceLabel } from './common.js';

function range(month) {
  const [y, m] = month.split('-').map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}
const shift = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};

function byChannel(rows) {
  const out = Object.fromEntries(CHANNELS.map((c) => [c.id, { id: c.id, label: c.label, leads: 0, visits: 0 }]));
  for (const r of rows) {
    const c = out[channelOf(r.refClass, r.refSource)];
    c.leads += r.leads;
    c.visits += r.sessions;
  }
  return out;
}

/** Read the month (+ previous month and the same month last year) for one project; null without capability signals. */
export async function gatherSignalsReport(project, month) {
  if (!hasSignals(project)) return null;
  const cur = range(month);
  const prevStart = range(shift(month, -1)).start;
  const yoy = range(shift(month, -12));
  const rows = await prisma.signalDailyBySource.findMany({ where: { projectId: project.id, OR: [{ date: { gte: prevStart, lt: cur.end } }, { date: { gte: yoy.start, lt: yoy.end } }] } });
  const pick = (start, end) => rows.filter((r) => new Date(r.date) >= start && new Date(r.date) < end);
  const thisRows = pick(cur.start, cur.end);
  const landing = await prisma.signalDailyByLanding.findMany({ where: { projectId: project.id, date: { gte: cur.start, lt: cur.end }, leads: { gt: 0 } }, select: { landingPath: true, leads: true } });
  const attributions = await prisma.leadAttribution.findMany({ where: { projectId: project.id, leadAt: { gte: cur.start, lt: cur.end } }, select: { firstTouch: true, siteSnapshot: true, lastClass: true } });
  return {
    month,
    current: byChannel(thisRows),
    previous: byChannel(pick(prevStart, cur.start)),
    lastYear: byChannel(pick(yoy.start, yoy.end)),
    hasLastYear: rows.some((r) => new Date(r.date) >= yoy.start && new Date(r.date) < yoy.end),
    ai: thisRows.filter((r) => r.refClass === 'ai').reduce((m, r) => {
      const k = sourceLabel('ai', r.refSource);
      m[k] = m[k] || { leads: 0, visits: 0 };
      m[k].leads += r.leads;
      m[k].visits += r.sessions;
      return m;
    }, {}),
    landing: Object.entries(landing.reduce((m, r) => ((m[r.landingPath] = (m[r.landingPath] || 0) + r.leads), m), {}))
      .map(([path, leads]) => ({ path, leads }))
      .sort((a, b) => b.leads - a.leads)
      .slice(0, 5),
    bots: thisRows.reduce((n, r) => n + r.botSessions, 0),
    matrix: attributions.reduce((m, a) => {
      const f = a.firstTouch?.class || a.siteSnapshot?.firstTouch?.class || 'unknown';
      m[f] = m[f] || {};
      m[f][a.lastClass] = (m[f][a.lastClass] || 0) + 1;
      return m;
    }, {}),
  };
}

const total = (ch, k) => Object.values(ch).reduce((n, c) => n + c[k], 0);
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10} %` : '–');
function delta(now, before) {
  if (!before) return now ? 'new' : '–';
  const d = Math.round(((now - before) / before) * 100);
  return `${d >= 0 ? '+' : ''}${d} %`;
}

/** The HTML section (pure). `esc` is the report's HTML escaper. Empty string without data. */
export function renderSignalsSection(data, { admin = false, esc }) {
  if (!data) return '';
  const leads = total(data.current, 'leads');
  const visits = total(data.current, 'visits');
  const rows = CHANNELS.map((c) => data.current[c.id])
    .filter((c) => c.leads || c.visits)
    .map((c) => `<tr><th>${esc(c.label)}</th><td>${esc(c.leads)}</td><td>${esc(c.visits)}</td><td>${esc(pct(c.leads, c.visits))}</td><td>${esc(delta(c.leads, data.previous[c.id].leads))}</td><td>${data.hasLastYear ? esc(delta(c.leads, data.lastYear[c.id].leads)) : '–'}</td></tr>`)
    .join('');
  const ai = Object.entries(data.ai).sort((a, b) => b[1].leads - a[1].leads || b[1].visits - a[1].visits);
  const parts = [];
  parts.push(`<h2>Where your enquiries came from</h2>
<p>${esc(leads)} enquir${leads === 1 ? 'y' : 'ies'} and ${esc(visits)} visits this month (previous month: ${esc(total(data.previous, 'leads'))} enquiries).</p>
${rows ? `<table><tr><th>Channel</th><td><strong>Enquiries</strong></td><td><strong>Visits</strong></td><td><strong>Conversion</strong></td><td><strong>vs last month</strong></td><td><strong>vs last year</strong></td></tr>${rows}</table>` : '<p class="muted">No visits recorded this month.</p>'}`);
  if (ai.length) parts.push(`<p><strong>AI assistants</strong>: ${ai.map(([k, v]) => `${esc(k)} ${esc(v.leads)} enquir${v.leads === 1 ? 'y' : 'ies'} / ${esc(v.visits)} visits`).join(' · ')}</p>`);
  if (data.landing.length) parts.push(`<p><strong>Pages that led to an enquiry</strong></p><ul>${data.landing.map((l) => `<li>${esc(l.path)}: ${esc(l.leads)}</li>`).join('')}</ul>`);
  parts.push(`<p class="small muted">Google's AI Mode and AI Overviews cannot be separated from Google Search; they are counted as Google Search.${data.bots ? ` ${esc(data.bots)} visits from bots were recognised and are not counted.` : ''}${leads < 20 ? ' With fewer than 20 enquiries, small changes can move these numbers a lot.' : ''}</p>`);
  if (admin) {
    const classes = [...new Set([...Object.keys(data.matrix), ...Object.values(data.matrix).flatMap((m) => Object.keys(m))])];
    parts.push(classes.length
      ? `<h3>Attribution matrix (first touch × last touch, agency only)</h3><table><tr><th>first \\ last</th>${classes.map((c) => `<td><strong>${esc(c)}</strong></td>`).join('')}</tr>${Object.entries(data.matrix).map(([f, m]) => `<tr><th>${esc(f)}</th>${classes.map((c) => `<td>${esc(m[c] || 0)}</td>`).join('')}</tr>`).join('')}</table>`
      : '<p class="muted small">No attributed enquiries this month.</p>');
  }
  return parts.join('\n');
}
