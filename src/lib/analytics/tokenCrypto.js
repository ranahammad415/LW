/**
 * Lightweight AES-256-GCM helpers for storing OAuth refresh tokens and API keys at rest.
 * Key derived from GOOGLE_TOKEN_ENCRYPTION_KEY or JWT_ACCESS_SECRET.
 * Purpose 'bing' (agency Bing Webmaster API key, features/bing-webmaster.md) tries BING_TOKEN_ENCRYPTION_KEY first, then
 * the same chain. Setting or changing a key later makes existing ciphertext unreadable (reconnect needed).
 */
import crypto from 'crypto';

const KEY_CHAINS = {
  google: ['GOOGLE_TOKEN_ENCRYPTION_KEY', 'JWT_ACCESS_SECRET'],
  bing: ['BING_TOKEN_ENCRYPTION_KEY', 'GOOGLE_TOKEN_ENCRYPTION_KEY', 'JWT_ACCESS_SECRET'],
};

function getKey(purpose = 'google') {
  const chain = KEY_CHAINS[purpose] || KEY_CHAINS.google;
  const raw = chain.map((name) => process.env[name]).find((v) => !!v) || '';
  if (!raw || raw.length < 16) {
    throw new Error(`${chain.join(' or ')} (16+ chars) required to store ${purpose === 'bing' ? 'the Bing credential' : 'Google tokens'}`);
  }
  return crypto.createHash('sha256').update(raw).digest();
}

/** @param {string} plaintext @param {{ purpose?: 'google'|'bing' }} [opts] */
export function encryptSecret(plaintext, { purpose = 'google' } = {}) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(purpose), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

/** @param {string} payload @param {{ purpose?: 'google'|'bing' }} [opts] */
export function decryptSecret(payload, { purpose = 'google' } = {}) {
  const [ivB64, tagB64, dataB64] = String(payload).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted token payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(purpose), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}
