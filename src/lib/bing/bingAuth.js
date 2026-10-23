/**
 * Agency Bing Webmaster connection (features/bing-webmaster.md), mirroring lib/analytics/googleAuth.js.
 * One ACTIVE AgencyBingConnection row. Phase 1: API-key mode only (OAuth is Phase 3). The key is stored AES-256-GCM
 * encrypted (tokenCrypto purpose 'bing'), decrypted only to build a request, and never returned, logged or echoed.
 */
import { prisma } from '../prisma.js';
import { encryptSecret, decryptSecret } from '../analytics/tokenCrypto.js';
import { BingNotConnectedError } from './client.js';

/** Master switch: BING_WEBMASTER_ENABLED=false stops the cron and manual syncs (stored data stays readable). */
export function isBingEnabled(env = process.env) {
  return String(env.BING_WEBMASTER_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/** Plausible API key: 16–128 chars of letters, digits, '-' and '_' (Bing keys are 32 hex chars). Pure. */
export function isPlausibleApiKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(key.trim());
}

const STATUS_SELECT = {
  id: true,
  authType: true,
  accountLabel: true,
  status: true,
  connectedAt: true,
  updatedAt: true,
  lastOkAt: true,
  lastError: true,
  connectedById: true,
};

async function activeRow(select) {
  return prisma.agencyBingConnection.findFirst({ where: { status: 'ACTIVE' }, orderBy: { connectedAt: 'desc' }, ...(select ? { select } : {}) });
}

/** Status for the admin card: never the key (not even a hint). */
export async function getBingConnectionStatus() {
  const row = await activeRow(STATUS_SELECT);
  return { enabled: isBingEnabled(), connected: !!row, connection: row || null };
}

/** Upsert the single ACTIVE row with a (validated) API key. */
export async function saveBingConnection({ apiKey, accountLabel = null, connectedById = null, now = new Date() }) {
  const apiKeyEnc = encryptSecret(String(apiKey).trim(), { purpose: 'bing' });
  const label = accountLabel ? String(accountLabel).trim().slice(0, 255) || null : null;
  const existing = await activeRow({ id: true });
  const data = { authType: 'api_key', apiKeyEnc, accountLabel: label, connectedById, connectedAt: now, status: 'ACTIVE', lastOkAt: now, lastError: null };
  const row = existing
    ? await prisma.agencyBingConnection.update({ where: { id: existing.id }, data, select: STATUS_SELECT })
    : await prisma.agencyBingConnection.create({ data, select: STATUS_SELECT });
  return row;
}

/** Wipe the credential (status DISCONNECTED). Stored Bing metrics are kept. → number of rows changed. */
export async function disconnectBing() {
  const r = await prisma.agencyBingConnection.updateMany({
    where: { status: 'ACTIVE' },
    data: { status: 'DISCONNECTED', apiKeyEnc: null, refreshTokenEnc: null, accessTokenEnc: null, accessTokenExpiresAt: null },
  });
  return r?.count ?? 0;
}

/** → { mode: 'api_key', apiKey } for the client. Throws BingNotConnectedError when there is no usable credential. */
export async function getBingCredential() {
  const row = await activeRow({ id: true, authType: true, apiKeyEnc: true });
  if (!row || row.authType !== 'api_key' || !row.apiKeyEnc) throw new BingNotConnectedError();
  let apiKey;
  try {
    apiKey = decryptSecret(row.apiKeyEnc, { purpose: 'bing' });
  } catch {
    await markBingError('The stored Bing key cannot be decrypted (encryption key changed). Connect the key again.');
    throw new BingNotConnectedError('The stored Bing key cannot be decrypted; reconnect it');
  }
  return { mode: 'api_key', apiKey };
}

/** Persist a connection-level failure (auth error, undecryptable key) so the admin card prompts a reconnect. */
export async function markBingError(message) {
  const row = await activeRow({ id: true });
  if (!row) return;
  await prisma.agencyBingConnection.update({ where: { id: row.id }, data: { lastError: String(message || 'Bing error').slice(0, 500) } });
}

export async function markBingOk(now = new Date()) {
  const row = await activeRow({ id: true });
  if (!row) return;
  await prisma.agencyBingConnection.update({ where: { id: row.id }, data: { lastOkAt: now, lastError: null } });
}
