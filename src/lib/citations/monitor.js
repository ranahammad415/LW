/**
 * Citations / NAP monitor (EmDash contract 1.8.0 §39; leader job `seo.citations`, monthly; staff "Check now").
 * docs/ledger/features/local-seo.md §Citations.
 *
 * Paid and OFF by default: CITATIONS_MONITOR_ENABLED (default 'false'). Per run at most CITATIONS_MAX_PER_RUN
 * projects (default 20), one paid DataForSEO call per project, no retries, the DFS `cost` stored on the run row
 * (SeoCitationCheckRun.costUsd). One scheduled run per project per month (unique projectId + period).
 *
 * 1. Google listing — DataForSEO Business Listings `POST /v3/business_data/business_listings/search/live` (title +
 *    location_coordinate "lat,lng,25" around the stored business coordinates, limit 10). The API covers Google Maps
 *    listings only (docs.dataforseo.com, checked 2026-10-23), so it fills the `business.google.com` citation: the item
 *    with the project's CID, else the best fuzzy name match. Its title / phone / ZIP / hours are compared with the
 *    canonical NAP (lib/citations/nap.js). Not found → listed false, nap_status missing.
 * 2. Other listings — optional free page check, CITATIONS_PAGE_CHECK_ENABLED (default 'false'): for listings with a
 *    URL, one SSRF-guarded GET (netGuard.guardedFetch: https only, public IPs, no redirects, ≤ 1.5 MiB, 8 s), ≤
 *    CITATIONS_PAGE_CHECKS_MAX_PER_RUN pages per run (default 30), ≥ 1.5 s apart. The page text must contain the
 *    business name, else nothing is written (blocked, script-rendered or a different page: unreliable, so unknown);
 *    with the name found, phone / ZIP presence decide correct / wrong. Directories that block robots (Yelp, Facebook)
 *    simply stay unchecked.
 * 3. Results are written back with seo-citations-upsert as actor kind "system" (OS fields only; 409 → mirror replaced,
 *    one retry), so the site and every OS view see the same list.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { dfsPostTask, hasDataForSeoCreds } from '../dataforseo/client.js';
import { guardedFetch } from '../siteAdapters/netGuard.js';
import { projectSiteDomain } from '../analytics/gbpIdentity.js';
import { sameSite } from '../analytics/domainMatch.js';
import { LOCAL_PROJECT_SELECT } from '../localRank.js';
import { compareNap, namesMatch, nameSimilarity, nameTokens, normalizePhone, normalizeZip } from './nap.js';
import {
  SYSTEM_ACTOR,
  hasSeoCitations,
  loadCitationState,
  canonicalNapFor,
  upsertCitations,
  pullCitations,
} from './citations.js';

export const DFS_LISTINGS_SEARCH_PATH = '/v3/business_data/business_listings/search/live';
export const GOOGLE_CITATION_ID = 'business.google.com';
/** Estimated USD per listings search (the DataForSEO docs' sample response shows 0.0109; not verified). */
export const LISTINGS_SEARCH_EST_COST_USD = 0.0109;
export const MANUAL_CHECK_COOLDOWN_MS = 6 * 60 * 60_000;
export const PAGE_FETCH_MAX_BYTES = 1.5 * 1024 * 1024;
export const PAGE_FETCH_TIMEOUT_MS = 8000;
export const PAGE_FETCH_GAP_MS = 1500;
export const PAGE_CHECKS_PER_PROJECT = 10;

const bool = (v) => String(v ?? 'false').toLowerCase() === 'true';
function intEnv(env, name, def, min, max) {
  const n = Number.parseInt(env?.[name] ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}
export const isCitationsMonitorEnabled = (env = process.env) => bool(env.CITATIONS_MONITOR_ENABLED);
export const isPageCheckEnabled = (env = process.env) => bool(env.CITATIONS_PAGE_CHECK_ENABLED);
export const citationsMaxPerRun = (env = process.env) => intEnv(env, 'CITATIONS_MAX_PER_RUN', 20, 1, 500);
export const pageChecksMaxPerRun = (env = process.env) => intEnv(env, 'CITATIONS_PAGE_CHECKS_MAX_PER_RUN', 30, 0, 500);

export const periodOf = (now = new Date()) => now.toISOString().slice(0, 7);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const DAYS = [['monday', 'Mon'], ['tuesday', 'Tue'], ['wednesday', 'Wed'], ['thursday', 'Thu'], ['friday', 'Fri'], ['saturday', 'Sat'], ['sunday', 'Sun']];
const hm = (t) => (t && Number.isInteger(t.hour) ? `${String(t.hour).padStart(2, '0')}:${String(t.minute || 0).padStart(2, '0')}` : null);

/** DataForSEO work_time → "Mon 08:00–18:00; Tue …" (≤ 200 chars) or null. Pure. */
export function hoursFromWorkTime(workTime) {
  const tt = workTime?.work_hours?.timetable;
  if (!tt || typeof tt !== 'object') return null;
  const parts = [];
  for (const [key, label] of DAYS) {
    const slots = Array.isArray(tt[key]) ? tt[key] : null;
    if (!slots) continue;
    const s = slots.map((x) => (hm(x?.open) && hm(x?.close) ? `${hm(x.open)}–${hm(x.close)}` : null)).filter(Boolean);
    parts.push(`${label} ${s.length ? s.join(', ') : 'closed'}`);
  }
  return parts.length ? parts.join('; ').slice(0, 200) : null;
}

/** Pick the business among listing items: CID first, then the best fuzzy name match (≥ threshold). Pure. */
export function pickListing(items, { cid, name }) {
  const list = (items || []).filter((i) => i && typeof i === 'object');
  if (cid) {
    const byCid = list.find((i) => i.cid != null && String(i.cid) === String(cid));
    if (byCid) return { item: byCid, matchedBy: 'cid' };
  }
  let best = null;
  for (const it of list) {
    if (!namesMatch(it.title, name)) continue;
    const s = nameSimilarity(it.title, name);
    if (!best || s > best.s) best = { item: it, s };
  }
  return best ? { item: best.item, matchedBy: 'name' } : null;
}

/** One listings search for the project's Google listing → upsert item (+ cost). Never throws for DFS task errors. */
export async function checkGoogleListing(project, canonical, { post, now = new Date() } = {}) {
  const body = { title: String(canonical.name || '').slice(0, 200), limit: 10 };
  if (typeof project.gmbLat === 'number' && typeof project.gmbLng === 'number') {
    body.location_coordinate = `${project.gmbLat.toFixed(6)},${project.gmbLng.toFixed(6)},25`;
  }
  let parsed;
  try {
    parsed = await dfsPostTask(DFS_LISTINGS_SEARCH_PATH, body, { post });
  } catch (err) {
    return { error: String(err?.code || 'FAILED').slice(0, 40), accountLevel: !!err?.accountLevel, costUsd: err?.costUsd ?? null };
  }
  const items = parsed.state === 'ok' ? parsed.result?.items || [] : [];
  const pick = pickListing(items, { cid: project.gmbCid, name: canonical.name });
  const lastChecked = now.toISOString();
  if (!pick) {
    return {
      costUsd: parsed.costUsd ?? null,
      result: { id: GOOGLE_CITATION_ID, napStatus: 'missing', source: 'dfs', matchedBy: null },
      item: { id: GOOGLE_CITATION_ID, listed: false, nap_status: 'missing', last_checked: lastChecked },
    };
  }
  const it = pick.item;
  const seen = {
    name: it.title ? String(it.title).slice(0, 200) : null,
    phone: it.phone ? String(it.phone).slice(0, 200) : null,
    zip: it.address_info?.zip ? String(it.address_info.zip).slice(0, 200) : null,
    hours: hoursFromWorkTime(it.work_time),
  };
  const site = canonical.website || projectSiteDomain(project);
  const siteLink = it.url || it.domain ? (site ? sameSite(it.url || it.domain, site) : null) : site ? false : null;
  const { checks, napStatus } = compareNap(canonical, { ...seen, siteLink });
  return {
    costUsd: parsed.costUsd ?? null,
    result: { id: GOOGLE_CITATION_ID, napStatus, source: 'dfs', matchedBy: pick.matchedBy, checks },
    item: {
      id: GOOGLE_CITATION_ID,
      listed: true,
      nap_status: napStatus,
      name_seen: seen.name,
      phone_seen: seen.phone,
      zip_seen: seen.zip,
      hours_seen: seen.hours,
      checks,
      last_checked: lastChecked,
    },
  };
}

/** Visible text of an HTML page (scripts / styles dropped, tags removed, entities for & and spaces). Pure. */
export function pageText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 400_000);
}

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

/**
 * NAP presence on a listing page's text. Name absent → null (do not write: blocked / different page). Pure.
 * → { checks, napStatus, phoneSeen } | null
 */
export function pageNapCheck(text, canonical) {
  const tokens = nameTokens(canonical.name).join(' ');
  const hay = nameTokens(text).join(' ');
  if (!tokens || !hay.includes(tokens)) return null;
  const phones = [...new Set((String(text).match(PHONE_RE) || []).map((p) => normalizePhone(p)).filter(Boolean))].slice(0, 10);
  const canonPhone = normalizePhone(canonical.phone);
  const canonZip = normalizeZip(canonical.zip);
  const checks = {
    name: true,
    phone: canonPhone ? phones.includes(canonPhone) : null,
    zip: canonZip ? new RegExp(`\\b${canonZip}\\b`).test(text) : null,
    hours: null,
    areas: null,
    site_link: null,
  };
  const known = Object.values(checks).filter((v) => v !== null);
  const napStatus = known.includes(false) ? 'wrong' : checks.phone === true ? 'correct' : 'unknown';
  const phoneSeen = checks.phone === true ? canonical.phone : phones[0] || null;
  return { checks, napStatus, phoneSeen };
}

/** One SSRF-guarded GET of a listing page → text or null (any failure = null). */
export async function fetchListingPage(url, { fetchImpl = guardedFetch } = {}) {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'user-agent': 'Localwaves-AgencyOS/1.0 (listing check)', accept: 'text/html' },
      maxBytes: PAGE_FETCH_MAX_BYTES,
      signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    });
    if (!res || res.status !== 200) return null;
    const type = String(res.headers?.get?.('content-type') || '');
    if (type && !type.includes('html')) return null;
    return pageText(await res.text());
  } catch {
    return null;
  }
}

/**
 * Check one project (one paid listings search + capped free page fetches) and write the results back as the system
 * actor. `pageBudget` = page fetches still allowed in this run. Records a SeoCitationCheckRun (cost, counts, results).
 * → { status, dfsCalls, pageFetches, costUsd, checked, written, accountLevel?, errorCode? }
 */
export async function checkProjectCitations(project, { trigger = 'scheduled', userId = null, now = new Date(), post, fetchImpl, sleep = sleepMs, pageBudget = 0, env = process.env } = {}) {
  const period = trigger === 'scheduled' ? periodOf(now) : null;
  let run;
  try {
    run = await prisma.seoCitationCheckRun.create({ data: { projectId: project.id, trigger, requestedById: userId, status: 'running', period, startedAt: now } });
  } catch (err) {
    if (err?.code === 'P2002') return { status: 'skipped', reason: 'ALREADY_RAN' };
    throw err;
  }
  const out = { status: 'ok', dfsCalls: 0, pageFetches: 0, costUsd: 0, checked: 0, written: 0, results: [], warnings: [], errorCode: null };
  try {
    let state = await loadCitationState(project.id);
    if (!Number.isInteger(state?.rev)) {
      await pullCitations(project.id);
      state = await loadCitationState(project.id);
    }
    const canonical = canonicalNapFor(project, state);
    if (!canonical.name) throw Object.assign(new Error('no canonical NAP'), { code: 'NO_CANONICAL_NAP' });
    const items = [];
    const g = await checkGoogleListing(project, canonical, { post, now });
    out.dfsCalls += 1;
    if (typeof g.costUsd === 'number') out.costUsd += g.costUsd;
    if (g.error) {
      out.errorCode = g.error;
      out.status = 'partial';
      if (g.accountLevel) out.accountLevel = true;
    } else {
      // A site without a Google row gets one created (name / kind only on create, else FIELD_OWNED_BY_SITE).
      const exists = await prisma.seoCitationMirror.findUnique({
        where: { projectId_siteCitationId: { projectId: project.id, siteCitationId: GOOGLE_CITATION_ID } },
        select: { id: true },
      });
      items.push(exists ? g.item : { ...g.item, name: 'Google Business Profile', kind: 'maps' });
      out.results.push(g.result);
    }
    if (pageBudget > 0 && !out.accountLevel) {
      const rows = await prisma.seoCitationMirror.findMany({
        where: { projectId: project.id, url: { not: null }, NOT: { siteCitationId: GOOGLE_CITATION_ID } },
        select: { siteCitationId: true, url: true },
        orderBy: [{ rank: 'asc' }, { name: 'asc' }],
        take: Math.min(PAGE_CHECKS_PER_PROJECT, pageBudget),
      });
      for (const r of rows) {
        if (out.pageFetches > 0) await sleep(PAGE_FETCH_GAP_MS);
        out.pageFetches += 1;
        const text = await fetchListingPage(r.url, { fetchImpl });
        const res = text ? pageNapCheck(text, canonical) : null;
        if (!res) {
          out.results.push({ id: r.siteCitationId, napStatus: 'unknown', source: 'page', skipped: true });
          continue;
        }
        items.push({ id: r.siteCitationId, listed: true, nap_status: res.napStatus, ...(res.phoneSeen ? { phone_seen: String(res.phoneSeen).slice(0, 200) } : {}), checks: res.checks, last_checked: now.toISOString() });
        out.results.push({ id: r.siteCitationId, napStatus: res.napStatus, source: 'page', checks: res.checks });
      }
    }
    out.checked = items.length;
    if (items.length) {
      const res = await upsertCitations(project.id, items, SYSTEM_ACTOR, { system: true });
      out.written = res.applied.filter((a) => a.fields.length).length;
      out.warnings = res.warnings;
      if (res.rejected.length) out.status = 'partial';
      await prisma.seoCitationMirror.updateMany({ where: { projectId: project.id, siteCitationId: { in: items.map((i) => i.id) } }, data: { lastOsCheckAt: now } });
    }
    await prisma.seoCitationState.updateMany({ where: { projectId: project.id }, data: { lastMonitorAt: now } });
  } catch (err) {
    out.status = 'error';
    out.errorCode = String(err?.code || 'FAILED').slice(0, 40);
  }
  out.costUsd = Number(out.costUsd.toFixed(5));
  await prisma.seoCitationCheckRun.update({
    where: { id: run.id },
    data: {
      status: out.status,
      dfsCalls: out.dfsCalls,
      pageFetches: out.pageFetches,
      costUsd: out.costUsd,
      checked: out.checked,
      written: out.written,
      results: out.results.length ? out.results.slice(0, 200) : Prisma.DbNull,
      warnings: out.warnings.length ? out.warnings : Prisma.DbNull,
      errorCode: out.errorCode,
      finishedAt: new Date(),
    },
  });
  const { results: _r, ...summary } = out;
  return { runId: run.id, ...summary };
}

/** Projects the monitor covers: paired EmDash sites with seoCitations, active, polled (not archived / repair). */
async function monitorProjects() {
  const rows = await prisma.project.findMany({
    where: {
      cmsType: 'EMDASH',
      cmsPairedAt: { not: null },
      cmsRepairNeededAt: null,
      status: { in: ['ACTIVE', 'SETUP'] },
      client: { isActive: true },
    },
    select: { ...LOCAL_PROJECT_SELECT, cmsType: true, cmsCapabilities: true },
  });
  return rows.filter(hasSeoCitations);
}

/**
 * Monthly leader job. Flag off → no query, no call. Projects already run this month are skipped (unique period).
 * Stops at CITATIONS_MAX_PER_RUN projects or at an account-level DataForSEO error.
 */
export async function runCitationsMonitorJob({ now = new Date(), env = process.env, log = console, post, fetchImpl, sleep } = {}) {
  if (!isCitationsMonitorEnabled(env)) return { skipped: 'DISABLED' };
  if (!post && !hasDataForSeoCreds(env)) return { skipped: 'NO_CREDS' };
  const projects = await monitorProjects();
  const max = citationsMaxPerRun(env);
  let pageBudget = isPageCheckEnabled(env) ? pageChecksMaxPerRun(env) : 0;
  const summary = { projects: projects.length, ran: 0, skipped: 0, dfsCalls: 0, pageFetches: 0, costUsd: 0, written: 0, errors: 0, stopped: null };
  for (const p of projects) {
    if (summary.ran >= max) {
      summary.stopped = 'CAP';
      break;
    }
    const r = await checkProjectCitations(p, { trigger: 'scheduled', now, post, fetchImpl, sleep, pageBudget, env });
    if (r.status === 'skipped') {
      summary.skipped++;
      continue;
    }
    summary.ran++;
    summary.dfsCalls += r.dfsCalls;
    summary.pageFetches += r.pageFetches;
    summary.costUsd += r.costUsd;
    summary.written += r.written;
    pageBudget -= r.pageFetches;
    if (r.status === 'error') summary.errors++;
    if (r.accountLevel) {
      summary.stopped = r.errorCode;
      log?.warn?.({ projectId: p.id, code: r.errorCode }, 'Citations monitor stopped on an account-level DataForSEO error');
      break;
    }
  }
  summary.costUsd = Number(summary.costUsd.toFixed(5));
  return summary;
}

/** Staff "Check now" eligibility (flag, creds, capability, cooldown from the DB: cluster-safe). → null | {status, code, message, retryAfterSec?} */
export async function manualCheckBlocker(project, { env = process.env, now = Date.now() } = {}) {
  if (!isCitationsMonitorEnabled(env)) return { status: 409, code: 'DISABLED', message: 'The listing monitor is turned off (CITATIONS_MONITOR_ENABLED=false).' };
  if (!hasDataForSeoCreds(env)) return { status: 409, code: 'NOT_CONFIGURED', message: 'DataForSEO credentials are not configured.' };
  if (!hasSeoCitations(project)) return { status: 409, code: 'NO_CAPABILITY', message: 'The site does not share its citation list (update the site plugins).' };
  const last = await prisma.seoCitationCheckRun.findFirst({ where: { projectId: project.id, trigger: 'manual' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
  const since = last ? now - new Date(last.startedAt).getTime() : Infinity;
  if (since < MANUAL_CHECK_COOLDOWN_MS) {
    return { status: 429, code: 'COOLDOWN', message: 'The listings were checked a moment ago. Try again later.', retryAfterSec: Math.max(1, Math.ceil((MANUAL_CHECK_COOLDOWN_MS - since) / 1000)) };
  }
  return null;
}
