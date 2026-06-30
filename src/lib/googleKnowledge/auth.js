/**
 * Google API authentication: service account key file and/or OAuth refresh token.
 */
import fs from 'fs/promises';
import { google } from 'googleapis';
import { GOOGLE_SCOPES } from './constants.js';

function getOAuthRefreshToken() {
  return process.env.GOOGLE_WORKSPACE_REFRESH_TOKEN || process.env.GOOGLE_REFRESH_TOKEN;
}

/**
 * @returns {boolean}
 */
export function isWorkspaceAuthConfigured() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return true;
  const refreshToken = getOAuthRefreshToken();
  return Boolean(
    refreshToken && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
  );
}

/**
 * @returns {Promise<string|null>}
 */
export async function getServiceAccountEmail() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyFile) return null;
  try {
    const raw = await fs.readFile(keyFile, 'utf8');
    const json = JSON.parse(raw);
    return json.client_email || null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<import('google-auth-library').OAuth2Client | import('google-auth-library').JWT>}
 */
export async function createGoogleAuth() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const refreshToken = getOAuthRefreshToken();
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (keyFile) {
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: GOOGLE_SCOPES,
    });
    return auth.getClient();
  }

  if (refreshToken && clientId && clientSecret) {
    const redirectUri =
      process.env.GOOGLE_WORKSPACE_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI;
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return oauth2;
  }

  throw new Error(
    'Google credentials missing: set GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_WORKSPACE_REFRESH_TOKEN / GOOGLE_REFRESH_TOKEN with GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
  );
}

/**
 * @param {import('google-auth-library').OAuth2Client | import('google-auth-library').JWT} auth
 */
export function createGoogleClients(auth) {
  return {
    drive: google.drive({ version: 'v3', auth }),
    docs: google.docs({ version: 'v1', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
  };
}

export async function getAuthenticatedClients() {
  const auth = await createGoogleAuth();
  return { auth, ...createGoogleClients(auth) };
}