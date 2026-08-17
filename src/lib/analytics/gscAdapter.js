/**
 * Search Console helpers that use agency OAuth (preferred) or service-account fallback.
 */
import { google } from 'googleapis';
import { getGscAuth, hasAnyGoogleAuth, markAgencyGoogleError } from './googleAuth.js';

let cachedClient = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

function isInvalidGrant(err) {
  const msg = err?.message || String(err || '');
  const code = err?.response?.data?.error || err?.code;
  return /invalid_grant/i.test(msg) || code === 'invalid_grant';
}

export function clearGscClientCache() {
  cachedClient = null;
  cachedAt = 0;
}

async function getSearchConsole({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedClient && now - cachedAt < CACHE_MS) return cachedClient;
  const auth = await getGscAuth();
  cachedClient = google.searchconsole({ version: 'v1', auth });
  cachedAt = now;
  return cachedClient;
}

export async function isGscAuthAvailable() {
  return hasAnyGoogleAuth();
}

async function withAuthRetry(fn) {
  try {
    const sc = await getSearchConsole();
    return await fn(sc);
  } catch (err) {
    if (!isInvalidGrant(err)) throw err;
    await markAgencyGoogleError(err?.message || 'invalid_grant');
    clearGscClientCache();
    // Rebuild auth (may fall back to service account) and retry once.
    const sc = await getSearchConsole({ forceRefresh: true });
    return fn(sc);
  }
}

export async function fetchSearchAnalytics(siteUrl, startDate, endDate, dimensions = ['query']) {
  return withAuthRetry(async (sc) => {
    const res = await sc.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions,
        rowLimit: 5000,
        // Match Search Console UI (includes fresh/unfinalized days, not only "final").
        dataState: 'all',
      },
    });
    return res.data.rows ?? [];
  });
}

export async function fetchDailySearchAnalytics(siteUrl, startDate, endDate) {
  return fetchSearchAnalytics(siteUrl, startDate, endDate, ['date']);
}

export async function verifySiteAccess(siteUrl) {
  try {
    await withAuthRetry(async (sc) => {
      await sc.sites.get({ siteUrl });
    });
    return true;
  } catch {
    return false;
  }
}

export async function listGscSites() {
  return withAuthRetry(async (sc) => {
    const res = await sc.sites.list();
    return res.data.siteEntry || [];
  });
}
