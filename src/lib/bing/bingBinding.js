/**
 * Bing site binding (features/bing-webmaster.md): the site list (GetUserSites, cached 10 min per instance) and
 * auto-bind by registrable domain. Project.bingSiteUrl must be the exact `Url` string Bing lists (Bing matches exactly).
 */
import { prisma } from '../prisma.js';
import { registrableDomain } from '../analytics/domainMatch.js';
import { getUserSites } from './client.js';
import { getBingCredential } from './bingAuth.js';

export const SITES_CACHE_MS = 10 * 60_000;
let cache = null; // { at, sites }

export function invalidateBingSitesCache() {
  cache = null;
}

/** → { sites: [{ siteUrl, verified }], cached }. Throws BingApiError / BingNotConnectedError. */
export async function listBingSites({ force = false, now = Date.now(), fetchImpl, sleep, stats } = {}) {
  if (!force && cache && now - cache.at < SITES_CACHE_MS) return { sites: cache.sites, cached: true };
  const credential = await getBingCredential();
  const sites = await getUserSites({ credential, fetchImpl, sleep, stats });
  cache = { at: now, sites };
  return { sites, cached: false };
}

/** Prime the cache with a list fetched elsewhere (connect, nightly run). */
export function primeBingSitesCache(sites, now = Date.now()) {
  cache = { at: now, sites };
}

/** Exact host (lowercase, keeps www.) and protocol of a URL; null when unusable. Pure. */
function urlParts(raw) {
  const s = String(raw || '').trim();
  if (!s || /^sc-domain:/i.test(s)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    return { host: u.hostname.toLowerCase().replace(/\.$/, ''), protocol: u.protocol };
  } catch {
    return null;
  }
}

/** Registrable domain of the project's site: dataforseoDomain → gscSiteUrl → wpUrl → client websiteUrl. Pure. */
export function projectBingDomain(project) {
  const gsc = String(project?.gscSiteUrl || '').replace(/^sc-domain:/i, '');
  return (
    registrableDomain(project?.dataforseoDomain) ||
    registrableDomain(gsc) ||
    registrableDomain(project?.wpUrl) ||
    registrableDomain(project?.client?.websiteUrl) ||
    ''
  );
}

/**
 * Pick the verified Bing site for a project. → { site } | { ambiguous: [siteUrl…] } | { none: reason }. Pure.
 * Several verified variants (www / non-www, http / https) are narrowed by the exact host + protocol of the GSC
 * URL-prefix property, then the WordPress / EmDash URL, then the client website.
 */
export function pickBingSite(project, sites) {
  const domain = projectBingDomain(project);
  if (!domain) return { none: 'NO_DOMAIN' };
  const candidates = (sites || []).filter((s) => s?.verified && registrableDomain(s.siteUrl) === domain);
  if (!candidates.length) {
    const unverified = (sites || []).some((s) => !s?.verified && registrableDomain(s?.siteUrl) === domain);
    return { none: unverified ? 'NOT_VERIFIED' : 'NO_SITE' };
  }
  if (candidates.length === 1) return { site: candidates[0].siteUrl };
  for (const ref of [project?.gscSiteUrl, project?.wpUrl, project?.client?.websiteUrl]) {
    const want = urlParts(ref);
    if (!want) continue;
    const exact = candidates.filter((c) => {
      const p = urlParts(c.siteUrl);
      return p && p.host === want.host && p.protocol === want.protocol;
    });
    if (exact.length === 1) return { site: exact[0].siteUrl };
    const sameHost = candidates.filter((c) => urlParts(c.siteUrl)?.host === want.host);
    if (sameHost.length === 1) return { site: sameHost[0].siteUrl };
  }
  return { ambiguous: candidates.map((c) => c.siteUrl) };
}

/**
 * Auto-bind plan for projects WITHOUT a binding (an existing binding is never overwritten). A site already bound to
 * another project is not bound a second time (reported as ambiguous). Pure.
 * → { bound: [{projectId, siteUrl}], ambiguous: [{projectId, candidates}], unmatched: [{projectId, reason}] }
 */
export function planAutoBind(projects, sites) {
  const taken = new Set((projects || []).filter((p) => p.bingSiteUrl).map((p) => p.bingSiteUrl));
  const out = { bound: [], ambiguous: [], unmatched: [] };
  for (const p of projects || []) {
    if (p.bingSiteUrl) continue;
    const pick = pickBingSite(p, sites);
    if (pick.site) {
      if (taken.has(pick.site)) {
        out.ambiguous.push({ projectId: p.id, name: p.name, candidates: [pick.site], reason: 'ALREADY_BOUND' });
        continue;
      }
      taken.add(pick.site);
      out.bound.push({ projectId: p.id, name: p.name, siteUrl: pick.site });
    } else if (pick.ambiguous) {
      out.ambiguous.push({ projectId: p.id, name: p.name, candidates: pick.ambiguous, reason: 'SEVERAL_VARIANTS' });
    } else {
      out.unmatched.push({ projectId: p.id, name: p.name, reason: pick.none });
    }
  }
  return out;
}

export const BIND_PROJECT_SELECT = Object.freeze({
  id: true,
  name: true,
  clientId: true,
  bingSiteUrl: true,
  gscSiteUrl: true,
  wpUrl: true,
  dataforseoDomain: true,
  client: { select: { websiteUrl: true, agencyName: true } },
});

/** Apply the auto-bind plan (only projects still unbound at write time). */
export async function runAutoBind({ sites } = {}) {
  const projects = await prisma.project.findMany({ where: { client: { isActive: true } }, select: BIND_PROJECT_SELECT });
  const plan = planAutoBind(projects, sites);
  const bound = [];
  for (const b of plan.bound) {
    const r = await prisma.project.updateMany({ where: { id: b.projectId, bingSiteUrl: null }, data: { bingSiteUrl: b.siteUrl, bingSyncError: null } });
    if (r?.count) bound.push(b);
  }
  return { ...plan, bound };
}

/** True when `siteUrl` is one of the listed VERIFIED sites (exact string). Pure. */
export function isListedVerifiedSite(siteUrl, sites) {
  return (sites || []).some((s) => s.verified && s.siteUrl === siteUrl);
}
