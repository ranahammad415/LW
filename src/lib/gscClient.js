/**
 * Google Search Console API client wrapper.
 * Uses a Service Account for authentication.
 * The service account must be added as a user in each GSC property.
 */
import { google } from 'googleapis';

const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

let searchConsole = null;
let gscEnabled = false;

/**
 * Initialize the GSC client. Call once at startup.
 * Silently skips if GOOGLE_SERVICE_ACCOUNT_KEY is not configured.
 */
export async function initGscClient() {
  if (!keyFile) {
    return false;
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
    console.error('Failed to initialize GSC client:', err.message);
    return false;
  }
}

/**
 * Check if GSC integration is available.
 */
export function isGscEnabled() {
  return gscEnabled;
}

/**
 * Fetch search analytics data from GSC.
 * @param {string} siteUrl - The GSC property URL (e.g. "sc-domain:example.com" or "https://example.com/")
 * @param {string} startDate - Start date in YYYY-MM-DD format
 * @param {string} endDate - End date in YYYY-MM-DD format
 * @returns {Array<{keys: string[], clicks: number, impressions: number, ctr: number, position: number}>}
 */
export async function fetchSearchAnalytics(siteUrl, startDate, endDate) {
  if (!searchConsole) {
    throw new Error('GSC client not initialized');
  }

  const res = await searchConsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['query'],
      rowLimit: 5000,
    },
  });

  return res.data.rows ?? [];
}

/**
 * Verify that the service account has access to a given GSC property.
 * @param {string} siteUrl - The GSC property URL
 * @returns {boolean}
 */
export async function verifySiteAccess(siteUrl) {
  if (!searchConsole) return false;

  try {
    await searchConsole.sites.get({ siteUrl });
    return true;
  } catch {
    return false;
  }
}
