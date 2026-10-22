/**
 * Plan §5.3 `signals.reclassify` (manual, OWNER): re-run the ported classify() (referrers.js, table
 * REFERRER_TABLE_VERSION) on the project's stored visits of the last 13 months that still hold their payload (the
 * referrer URL and UTM live in the payload, so compacted visits older than 90 days keep their class). A visit whose
 * class / source changes gets its scalars updated (the session is rebuilt from them), its session touch is rewritten,
 * the lead attributions of that session are re-derived and the days are re-rolled. Bounded per call.
 */
import { prisma } from '../prisma.js';
import { classify, REFERRER_TABLE_VERSION } from './referrers.js';
import { addMonths, markDirty, touchFromVisit } from './common.js';

function siteHostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return null;
  }
}

/** Pure: the class / source of one stored visit (payload + scalars) under the current table. */
export function reclassifyVisit(row, siteHost) {
  const p = row.payload && typeof row.payload === 'object' ? row.payload : null;
  if (!p) return null;
  const q = p.page?.query && typeof p.page.query === 'object' ? p.page.query : {};
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => typeof v === 'string')).toString();
  const landingUrl = siteHost ? `https://${siteHost}${row.pagePath || '/'}${qs ? `?${qs}` : ''}` : null;
  const r = classify({ referrerUrl: p.referrer?.url ?? null, landingUrl, siteHost, utm: p.utm || null, clickIds: p.clickIds || null });
  return { refClass: r.class, refSource: r.source };
}

export async function reclassifyProject(projectId, { now = new Date(), batch = 5000, maxBatches = 20, log } = {}) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { wpUrl: true } });
  const siteHost = siteHostOf(project?.wpUrl);
  const since = addMonths(now, -13);
  let cursor = null;
  const out = { scanned: 0, changed: 0, sessions: 0, table: REFERRER_TABLE_VERSION };
  const dirty = [];
  for (let i = 0; i < maxBatches; i += 1) {
    const rows = await prisma.signalEvent.findMany({
      where: { projectId, type: 'visit', at: { gte: since }, payloadCompactedAt: null, ...(cursor ? { at: { gt: cursor } } : {}) },
      orderBy: { at: 'asc' },
      take: batch,
      select: { eventId: true, at: true, sessionId: true, pagePath: true, refClass: true, refSource: true, payload: true },
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].at;
    out.scanned += rows.length;
    for (const row of rows) {
      const next = reclassifyVisit(row, siteHost);
      if (!next || (next.refClass === row.refClass && (next.refSource || null) === (row.refSource || null))) continue;
      out.changed += 1;
      const payload = { ...row.payload, referrer: { ...(row.payload.referrer || {}), table: REFERRER_TABLE_VERSION } };
      await prisma.signalEvent.updateMany({ where: { projectId, eventId: row.eventId }, data: { refClass: next.refClass, refSource: next.refSource, payload } });
      const session = await prisma.signalSession.findUnique({ where: { projectId_sessionId: { projectId, sessionId: row.sessionId } }, select: { id: true, startedAt: true, landingPath: true, utmCampaign: true, touch: true } });
      if (session) {
        const touch = touchFromVisit({ at: session.touch?.at || row.at, refClass: next.refClass, refSource: next.refSource, utm: row.payload.utm, landing: session.landingPath });
        await prisma.signalSession.update({ where: { id: session.id }, data: { refClass: touch.class, refSource: touch.source, touch } });
        await prisma.leadAttribution.updateMany({ where: { projectId, sessionId: row.sessionId }, data: { needsDerive: true } });
        dirty.push(session.startedAt);
        out.sessions += 1;
      }
    }
    if (rows.length < batch) break;
  }
  await markDirty(projectId, dirty);
  log?.info?.(out, 'signals.reclassify');
  return out;
}
