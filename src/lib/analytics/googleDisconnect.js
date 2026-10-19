/**
 * Agency-wide Google disconnect (SEO Engine OS-18), adapted from the Engine's `localwaves-google-disconnect` package
 * (disconnect.mjs). Installed parts:
 *   - real refresh-token revocation at Google's fixed revoke endpoint (HTTP 200 = confirmed; anything else, a
 *     timeout or a decrypt failure = unconfirmed); the provider response body is never read or logged;
 *   - local credential wipe of every connection row that still holds ciphertext (incl. rows left DISCONNECTED by the
 *     old status-only disconnect): refreshTokenEnc/googleEmail/scopes cleared, connectedById nulled,
 *     status DISCONNECTED (confirmed) or REVOKE_UNKNOWN (unconfirmed; the owner must revoke in the Google account);
 *   - explicit OWNER confirmation of the agency-wide scope; stale-consent guard for OAuth callbacks
 *     (isConsentStale) so a consent started before a disconnect cannot reconnect.
 * NOT installed (see engine-agents.md OS-18): the package's MySQL row-lock work lease / AsyncLocalStorage Prisma proxy
 * that serialises every Google job. In-flight syncs on other PM2 instances can therefore finish their current Google
 * call; they fail on the next token refresh once Google has applied the revocation. The GOOGLE_SERVICE_ACCOUNT_KEY
 * GSC fallback is unchanged (separate credential, controlled by the server env).
 * This is agency-wide. An Engine project purge must never call it.
 */
import { prisma } from '../prisma.js';
import { decryptSecret } from './tokenCrypto.js';
import { clearGscClientCache } from './gscAdapter.js';

export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const DISCONNECT_SCOPE = 'entire-agency-google';

export class DisconnectError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function revokeGoogleRefreshToken(token, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (typeof token !== 'string' || !token || token.length > 32768) return { confirmed: false, code: 'TOKEN_UNAVAILABLE' };
  try {
    const response = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    // Never consume/log the provider body (it may echo the credential).
    await response.body?.cancel?.().catch?.(() => {});
    return response.status === 200 ? { confirmed: true, code: 'REVOKED' } : { confirmed: false, code: 'REVOCATION_UNCONFIRMED' };
  } catch {
    return { confirmed: false, code: 'REVOCATION_UNCONFIRMED' };
  }
}

export async function disconnectAgencyGoogle({ actor, scope, confirmAgencyWide } = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (actor?.role !== 'OWNER' || typeof actor.id !== 'string' || !actor.id || scope !== DISCONNECT_SCOPE || confirmAgencyWide !== true) {
    throw new DisconnectError('CONFIRMATION_REQUIRED', 'An Owner must explicitly confirm the agency-wide Google disconnect.', 403);
  }
  // Fence first: no row stays ACTIVE while we revoke.
  const rows = await prisma.$transaction(async (tx) => {
    const found = await tx.agencyGoogleConnection.findMany({
      where: { OR: [{ status: 'ACTIVE' }, { NOT: { refreshTokenEnc: '' } }] },
      select: { id: true, refreshTokenEnc: true, status: true },
    });
    if (found.length) {
      await tx.agencyGoogleConnection.updateMany({
        where: { id: { in: found.map((r) => r.id) } },
        data: { status: 'DISCONNECTING', lastError: 'GOOGLE_DISCONNECT_IN_PROGRESS' },
      });
    }
    return found;
  });
  clearGscClientCache();

  let revokedCredentials = 0;
  let unconfirmedCredentials = 0;
  for (const row of rows) {
    let token;
    try {
      token = row.refreshTokenEnc ? decryptSecret(row.refreshTokenEnc) : undefined;
    } catch {
      token = undefined;
    }
    const result = token ? await revokeGoogleRefreshToken(token, { fetchImpl }) : { confirmed: !row.refreshTokenEnc };
    token = undefined;
    if (result.confirmed) revokedCredentials += row.refreshTokenEnc ? 1 : 0;
    else unconfirmedCredentials += 1;
    // Wipe local ciphertext even when remote revocation is unconfirmed; that outcome stays REVOKE_UNKNOWN.
    await prisma.agencyGoogleConnection.update({
      where: { id: row.id },
      data: {
        status: result.confirmed ? 'DISCONNECTED' : 'REVOKE_UNKNOWN',
        refreshTokenEnc: '',
        googleEmail: '',
        scopes: '',
        connectedById: null,
        lastError: result.confirmed ? null : 'GOOGLE_REVOCATION_UNCONFIRMED',
      },
    });
  }
  const remoteRevocationConfirmed = unconfirmedCredentials === 0;
  return {
    success: true,
    status: remoteRevocationConfirmed ? 'disconnected' : 'disconnected_revocation_unconfirmed',
    scope: DISCONNECT_SCOPE,
    localCredentialsRemoved: true,
    remoteRevocationConfirmed,
    revokedCredentials,
    unconfirmedCredentials,
    manualGoogleAccountRevocationRequired: !remoteRevocationConfirmed,
    serviceAccountFallbackUnchanged: true,
    retainedAnalyticsDeleted: false,
    backupsDeleted: false,
  };
}

/**
 * OAuth callback guard: a consent whose signed state was issued before the most recent disconnect is stale.
 * `issuedAtSec` is the state JWT's `iat`.
 */
export async function isConsentStale(issuedAtSec) {
  if (!Number.isFinite(issuedAtSec)) return true;
  const last = await prisma.agencyGoogleConnection.findFirst({
    where: { status: { in: ['DISCONNECTED', 'REVOKE_UNKNOWN', 'DISCONNECTING'] } },
    orderBy: { updatedAt: 'desc' },
    select: { updatedAt: true },
  });
  return !!last && new Date(last.updatedAt).getTime() > issuedAtSec * 1000;
}
