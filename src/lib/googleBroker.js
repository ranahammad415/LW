/**
 * Google bindings export (OS-15) and short-lived access-token broker (OS-16) for the SEO Engine.
 *
 * Bindings: the project's GSC site URL, GA4 property and Business Profile location as bound by the OWNER in
 * Admin → Integrations (or the PM GSC picker), plus a link status derived from the binding and its last sync.
 *
 * Broker: mints a fresh access token from the agency Google connection (AgencyGoogleConnection, refresh token
 * encrypted with GOOGLE_TOKEN_ENCRYPTION_KEY) with a refresh request narrowed to ONE read-only scope:
 *   gsc → webmasters.readonly, ga4 → analytics.readonly. Business Profile is never brokered (its only scope,
 *   business.manage, can write). Google access tokens cannot be bound to one property: the OS binds the issuance
 *   (who, which project, which property) and audits it; the token reads whatever that scope can read for the agency
 *   account for its ~1 h lifetime. The refresh token never leaves this module and no token is ever logged or stored.
 */
import { prisma } from './prisma.js';
import { decryptSecret } from './analytics/tokenCrypto.js';
import { markAgencyGoogleError } from './analytics/googleAuth.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const BROKER_PRODUCTS = {
  gsc: { scope: 'https://www.googleapis.com/auth/webmasters.readonly', field: 'gscSiteUrl' },
  ga4: { scope: 'https://www.googleapis.com/auth/analytics.readonly', field: 'ga4PropertyId' },
};
export const BROKER_MAX_PER_HOUR = 30;

export class BrokerError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function isGoogleBrokerEnabled(env = process.env) {
  return env.ENGINE_GOOGLE_TOKEN_BROKER_ENABLED === '1';
}

function linkStatus(id, lastSyncedAt) {
  if (!id) return 'NOT_LINKED';
  return lastSyncedAt ? 'LINKED' : 'LINKED_NOT_SYNCED';
}

/** OS-15 payload for one project row (select GOOGLE_BINDING_SELECT). */
export const GOOGLE_BINDING_SELECT = {
  id: true,
  name: true,
  clientId: true,
  leadPmId: true,
  gscSiteUrl: true,
  gscLastSyncedAt: true,
  ga4PropertyId: true,
  ga4PropertyName: true,
  ga4LastSyncedAt: true,
  gmbAccountId: true,
  gmbLocationId: true,
  gmbLocationName: true,
  gmbLastSyncedAt: true,
};

export function serializeGoogleBindings(project, agency) {
  const gsc = linkStatus(project.gscSiteUrl, project.gscLastSyncedAt);
  const ga4 = linkStatus(project.ga4PropertyId, project.ga4LastSyncedAt);
  const gbp = linkStatus(project.gmbLocationId, project.gmbLastSyncedAt);
  return {
    projectId: project.id,
    projectName: project.name,
    clientId: project.clientId,
    gscSiteUrl: project.gscSiteUrl ?? null,
    ga4PropertyId: project.ga4PropertyId ?? null,
    ga4PropertyName: project.ga4PropertyName ?? null,
    gbpLocationId: project.gmbLocationId ?? null,
    gbpAccountId: project.gmbAccountId ?? null,
    gbpLocationName: project.gmbLocationName ?? null,
    linkStatus: { gsc, ga4, gbp },
    lastSyncedAt: { gsc: project.gscLastSyncedAt ?? null, ga4: project.ga4LastSyncedAt ?? null, gbp: project.gmbLastSyncedAt ?? null },
    agencyGoogle: { connected: !!agency?.connected, hasError: !!agency?.lastError },
    // Engine hint: a project with GSC or GA4 data already flowing is a running project (Track 2).
    suggestedTrack: gsc === 'LINKED' || ga4 === 'LINKED' ? 'running' : 'cold_start',
  };
}

export async function agencyGoogleSummary() {
  const row = await prisma.agencyGoogleConnection.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { connectedAt: 'desc' },
    select: { id: true, lastError: true },
  });
  return { connected: !!row, lastError: row?.lastError ?? null };
}

const windows = new Map();
/** In-memory per-token sliding window (per PM2 instance; the audit table is the durable record). */
export function takeBrokerSlot(apiTokenId, now = Date.now(), max = BROKER_MAX_PER_HOUR) {
  const since = now - 3_600_000;
  const list = (windows.get(apiTokenId) || []).filter((t) => t > since);
  if (list.length >= max) {
    windows.set(apiTokenId, list);
    return false;
  }
  list.push(now);
  windows.set(apiTokenId, list);
  if (windows.size > 2000) windows.clear();
  return true;
}

/**
 * Refresh-token grant narrowed to one scope. Returns { accessToken, expiresAt, scope }.
 * Throws BrokerError (never includes Google's response body or any token in the message).
 */
export async function mintDownscopedAccessToken(scope, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new BrokerError('GOOGLE_NOT_CONFIGURED', 'Google OAuth is not configured on this OS', 503);
  const row = await prisma.agencyGoogleConnection.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { connectedAt: 'desc' },
    select: { refreshTokenEnc: true },
  });
  if (!row) throw new BrokerError('GOOGLE_NOT_CONNECTED', 'The agency Google account is not connected', 503);
  let refreshToken;
  try {
    refreshToken = decryptSecret(row.refreshTokenEnc);
  } catch {
    throw new BrokerError('GOOGLE_NOT_CONNECTED', 'The agency Google connection cannot be read; reconnect it', 503);
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope,
  });
  let res;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new BrokerError('GOOGLE_UPSTREAM', 'Google token endpoint unreachable', 502);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json?.access_token) {
    const code = typeof json?.error === 'string' ? json.error.slice(0, 40) : `http_${res.status}`;
    if (code === 'invalid_grant') await markAgencyGoogleError('invalid_grant (token broker)').catch(() => {});
    throw new BrokerError('GOOGLE_UPSTREAM', `Google refused the token request (${code})`, 502);
  }
  const granted = String(json.scope || scope).split(/\s+/).filter(Boolean);
  if (granted.length !== 1 || granted[0] !== scope) {
    // Never hand out a token broader than the one scope asked for.
    throw new BrokerError('GOOGLE_SCOPE_MISMATCH', 'Google returned a token with unexpected scopes; not issued', 502);
  }
  const expiresIn = Math.max(0, Math.min(Number(json.expires_in) || 0, 3600));
  return { accessToken: json.access_token, expiresAt: new Date(now() + expiresIn * 1000), scope };
}

/** 365-day retention for the audit rows (hourly leader purge). */
export async function purgeGoogleTokenIssuances(now = new Date()) {
  const res = await prisma.googleTokenIssuance.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 365 * 86_400_000) } } });
  return res.count;
}
