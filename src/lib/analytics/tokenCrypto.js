/**
 * Lightweight AES-256-GCM helpers for storing OAuth refresh tokens at rest.
 * Key derived from GOOGLE_TOKEN_ENCRYPTION_KEY or JWT_ACCESS_SECRET.
 */
import crypto from 'crypto';

function getKey() {
  const raw = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || process.env.JWT_ACCESS_SECRET || '';
  if (!raw || raw.length < 16) {
    throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY or JWT_ACCESS_SECRET (16+ chars) required to store Google tokens');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

/** @param {string} plaintext */
export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

/** @param {string} payload */
export function decryptSecret(payload) {
  const [ivB64, tagB64, dataB64] = String(payload).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted token payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}
