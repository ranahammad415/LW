/**
 * Google Search Console API client wrapper.
 * Prefers agency OAuth (via analytics/gscAdapter); falls back to service account.
 */
import { google } from 'googleapis';
import * as gscAdapter from './analytics/gscAdapter.js';
import { hasAnyGoogleAuth } from './analytics/googleAuth.js';

const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

let searchConsole = null;
let gscEnabled = false;

export async function initGscClient() {
  // Agency OAuth or SA — either is enough to enable sync.
  if (await hasAnyGoogleAuth()) {
    gscEnabled = true;
  }

  if (!keyFile) {
    return gscEnabled;
  }

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
    searchConsole = google.searchconsole({ version: 'v1', auth });
    gscEnabled = true;
    return true;
  } catch (err) {
    console.error('Failed to initialize GSC service-account client:', err.message);
    return gscEnabled;
  }
}

export function isGscEnabled() {
  // Prefer live check so connecting agency Google after boot still enables sync.
  // Sync paths also use gscAdapter which resolves auth dynamically.
  return gscEnabled;
}

/** Async check used by cron/sync — reflects OAuth connected after boot. */
export async function isGscAvailable() {
  if (gscEnabled) return true;
  try {
    return await hasAnyGoogleAuth();
  } catch {
    return false;
  }
}

export async function fetchSearchAnalytics(siteUrl, startDate, endDate) {
  try {
    return await gscAdapter.fetchSearchAnalytics(siteUrl, startDate, endDate, ['query']);
  } catch (err) {
    if (!searchConsole) throw err;
    const res = await searchConsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query'],
        rowLimit: 5000,
        dataState: 'all',
      },
    });
    return res.data.rows ?? [];
  }
}

export async function fetchDailySearchAnalytics(siteUrl, startDate, endDate) {
  try {
    return await gscAdapter.fetchDailySearchAnalytics(siteUrl, startDate, endDate);
  } catch (err) {
    if (!searchConsole) throw err;
    const res = await searchConsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['date'],
        rowLimit: 1000,
        dataState: 'all',
      },
    });
    return res.data.rows ?? [];
  }
}

export async function verifySiteAccess(siteUrl) {
  try {
    return await gscAdapter.verifySiteAccess(siteUrl);
  } catch {
    if (!searchConsole) return false;
    try {
      await searchConsole.sites.get({ siteUrl });
      return true;
    } catch {
      return false;
    }
  }
}
