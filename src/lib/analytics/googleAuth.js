/**
 * Agency-wide Google OAuth for analytics property listing + sync.
 * Falls back to GOOGLE_SERVICE_ACCOUNT_KEY for GSC-only when no agency connection exists.
 */
import { google } from 'googleapis';
import { prisma } from '../prisma.js';
import { encryptSecret, decryptSecret } from './tokenCrypto.js';

export const AGENCY_GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/business.manage',
];

function oauthClient(redirectUri) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getAgencyRedirectUri() {
  return (
    process.env.GOOGLE_AGENCY_REDIRECT_URI ||
    `${process.env.API_PUBLIC_URL || 'http://localhost:3000'}/api/admin/integrations/google/callback`
  );
}

export function isAgencyGoogleOAuthConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function buildAgencyConnectUrl({ state }) {
  const client = oauthClient(getAgencyRedirectUri());
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: AGENCY_GOOGLE_SCOPES,
    state,
  });
}

export async function exchangeAgencyCode(code) {
  const client = oauthClient(getAgencyRedirectUri());
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    // May happen if consent was previously granted without prompt=consent
    throw new Error(
      'No refresh token returned. Disconnect the app from Google Account permissions and reconnect with consent.'
    );
  }
  client.setCredentials(tokens);
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  return {
    refreshToken: tokens.refresh_token,
    googleEmail: payload?.email || '',
    scopes: (tokens.scope || AGENCY_GOOGLE_SCOPES.join(' ')).toString(),
  };
}

/** Upsert the single ACTIVE agency Google connection. */
export async function saveAgencyConnection({ refreshToken, googleEmail, scopes, connectedById }) {
  const enc = encryptSecret(refreshToken);
  const existing = await prisma.agencyGoogleConnection.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { connectedAt: 'desc' },
  });
  if (existing) {
    return prisma.agencyGoogleConnection.update({
      where: { id: existing.id },
      data: {
        refreshTokenEnc: enc,
        googleEmail,
        scopes,
        connectedById,
        connectedAt: new Date(),
        status: 'ACTIVE',
        lastError: null,
      },
    });
  }
  return prisma.agencyGoogleConnection.create({
    data: {
      refreshTokenEnc: enc,
      googleEmail,
      scopes,
      connectedById,
      status: 'ACTIVE',
    },
  });
}

export async function getAgencyConnectionStatus() {
  const row = await prisma.agencyGoogleConnection.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { connectedAt: 'desc' },
    select: {
      id: true,
      googleEmail: true,
      scopes: true,
      connectedAt: true,
      updatedAt: true,
      lastError: true,
      connectedById: true,
    },
  });
  return {
    configured: isAgencyGoogleOAuthConfigured(),
    connected: !!row,
    connection: row,
    serviceAccountFallback: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
  };
}

export async function disconnectAgencyConnection() {
  await prisma.agencyGoogleConnection.updateMany({
    where: { status: 'ACTIVE' },
    data: { status: 'DISCONNECTED' },
  });
}

/**
 * OAuth2 client authenticated with the agency refresh token.
 * @returns {Promise<import('google-auth-library').OAuth2Client>}
 */
export async function getAgencyOAuth2Client() {
  const row = await prisma.agencyGoogleConnection.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { connectedAt: 'desc' },
  });
  if (!row) throw new Error('Agency Google account is not connected');
  const refreshToken = decryptSecret(row.refreshTokenEnc);
  const client = oauthClient(getAgencyRedirectUri());
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

/**
 * Preferred auth for GSC: agency OAuth first, then service account.
 */
export async function getGscAuth() {
  const row = await prisma.agencyGoogleConnection.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { connectedAt: 'desc' },
  });
  if (row) {
    return getAgencyOAuth2Client();
  }
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyFile) throw new Error('No agency Google connection or GOOGLE_SERVICE_ACCOUNT_KEY');
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  return auth.getClient();
}

export async function hasAnyGoogleAuth() {
  const status = await getAgencyConnectionStatus();
  return status.connected || status.serviceAccountFallback;
}
