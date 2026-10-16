/**
 * EmDash v1.5.0 §26.2: site reports for the OS dashboard (capability `reports`): redirect ledger, top 404s, latest
 * crawl. Read-only: the OS never applies redirects or starts a crawl. Pulled by the daily (leader-only) sync and on an
 * explicit refresh; the latest of each kind is stored in CmsSiteReport.
 */
import { prisma } from './prisma.js';
import { loadEmdashConnection } from './cmsStore.js';
import { CmsBridgeError, emdashRoutes, INTERACTIVE_RETRY_DELAYS_MS } from './siteAdapters/emdash.js';

export const REPORT_KINDS = Object.freeze(['redirect-ledger', 'misses-summary', 'crawl-latest']);

export function hasReports(project) {
  const caps = project?.cmsCapabilities && typeof project.cmsCapabilities === 'object' ? project.cmsCapabilities : {};
  return caps.reports === true;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

export function sanitizeReport(kind, res) {
  if (kind === 'redirect-ledger') {
    return {
      items: (Array.isArray(res?.items) ? res.items : []).slice(0, 500).map((r) => ({
        source: str(r.source, 500),
        destination: str(r.destination, 500),
        type: [301, 302, 410].includes(r.type) ? r.type : null,
        origin: str(r.origin, 32),
        state: str(r.state, 16),
        page_id: str(r.page_id, 32),
        created_at: str(r.created_at, 40),
        updated_at: str(r.updated_at, 40),
      })),
      more: !!res?.next,
    };
  }
  if (kind === 'misses-summary') {
    return {
      days: Number.isInteger(res?.days) ? res.days : 30,
      total: Number.isInteger(res?.total) ? res.total : 0,
      items: (Array.isArray(res?.items) ? res.items : []).slice(0, 100).map((m) => ({
        path: str(m.path, 500),
        hits: Number.isInteger(m.hits) ? m.hits : 0,
        last_seen: str(m.last_seen, 40),
        top_referrer_host: str(m.top_referrer_host, 253),
        suggested_destination: str(m.suggested_destination, 500),
      })),
    };
  }
  const r = res?.report;
  if (!r || typeof r !== 'object') return { report: null };
  return {
    report: {
      id: str(r.id, 100),
      ran_at: str(r.ran_at, 40),
      trigger: str(r.trigger, 32),
      pages: Number.isInteger(r.pages) ? r.pages : 0,
      must_fix: Number.isInteger(r.must_fix) ? r.must_fix : 0,
      should_fix: Number.isInteger(r.should_fix) ? r.should_fix : 0,
      items: (Array.isArray(r.items) ? r.items : []).slice(0, 200).map((i) => ({
        severity: str(i.severity, 16),
        kind: str(i.kind, 40),
        url: str(i.url, 500),
        detail: str(i.detail, 500),
        fix: str(i.fix, 500),
      })),
    },
  };
}

/** Pull the three reports (bounded: first ledger page ≤ 500, top 100 misses over 30 days, latest crawl) and store them. */
export async function pullSiteReports(projectId, { interactive = false, log } = {}) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { cmsType: true, cmsCapabilities: true, cmsRepairNeededAt: true } });
  if (!project || project.cmsType !== 'EMDASH') throw new CmsBridgeError({ status: 400, code: 'VALIDATION', message: 'EmDash sites only.' });
  if (!hasReports(project)) throw new CmsBridgeError({ status: 409, code: 'NOT_IMPLEMENTED', message: 'This site does not share reports with Agency OS yet.' });
  if (project.cmsRepairNeededAt) throw new CmsBridgeError({ status: 503, code: 'NOT_PAIRED', message: 'The website connection needs to be renewed first.' });
  const { conn } = await loadEmdashConnection(projectId);
  const opts = interactive ? { retryDelays: INTERACTIVE_RETRY_DELAYS_MS } : {};
  const calls = {
    'redirect-ledger': () => emdashRoutes.redirectLedger(conn, { limit: 500 }, opts),
    'misses-summary': () => emdashRoutes.missesSummary(conn, { days: 30, limit: 100 }, opts),
    'crawl-latest': () => emdashRoutes.crawlLatest(conn, {}, opts),
  };
  const out = {};
  for (const kind of REPORT_KINDS) {
    try {
      const data = sanitizeReport(kind, await calls[kind]());
      await prisma.cmsSiteReport.upsert({
        where: { projectId_kind: { projectId, kind } },
        update: { data, fetchedAt: new Date() },
        create: { projectId, kind, data },
      });
      out[kind] = 'ok';
    } catch (err) {
      out[kind] = err?.code || 'ERROR';
      log?.warn?.({ projectId, kind, code: err?.code }, 'EmDash report pull failed');
    }
  }
  return out;
}

export async function listSiteReports(projectId) {
  const rows = await prisma.cmsSiteReport.findMany({ where: { projectId } });
  return Object.fromEntries(rows.map((r) => [r.kind, { data: r.data, fetchedAt: r.fetchedAt }]));
}
