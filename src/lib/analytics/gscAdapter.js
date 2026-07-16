/**
 * Search Console helpers that use agency OAuth (preferred) or service-account fallback.
 */
import { google } from 'googleapis';
import { getGscAuth, hasAnyGoogleAuth } from './googleAuth.js';

let cachedClient = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

async function getSearchConsole() {
  const now = Date.now();
  if (cachedClient && now - cachedAt < CACHE_MS) return cachedClient;
  const auth = await getGscAuth();
  cachedClient = google.searchconsole({ version: 'v1', auth });
  cachedAt = now;
  return cachedClient;
}

export async function isGscAuthAvailable() {
  return hasAnyGoogleAuth();
}

export async function fetchSearchAnalytics(siteUrl, startDate, endDate, dimensions = ['query']) {
  const sc = await getSearchConsole();
  const res = await sc.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions,
      rowLimit: 5000,
    },
  });
  return res.data.rows ?? [];
}

export async function fetchDailySearchAnalytics(siteUrl, startDate, endDate) {
  return fetchSearchAnalytics(siteUrl, startDate, endDate, ['date']);
}

export async function verifySiteAccess(siteUrl) {
  try {
    const sc = await getSearchConsole();
    await sc.sites.get({ siteUrl });
    return true;
  } catch {
    return false;
  }
}

export async function listGscSites() {
  const sc = await getSearchConsole();
  const res = await sc.sites.list();
  return res.data.siteEntry || [];
}
