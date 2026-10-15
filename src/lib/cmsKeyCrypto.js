/**
 * AES-256-GCM helpers for EmDash bridge secrets at rest (HMAC keys in CmsCredential,
 * pairing signing keys in CmsPairingCode). Same envelope as lib/analytics/tokenCrypto.js
 * (`iv.tag.ciphertext`, base64) but with its own key and NO fallback to the JWT
 * secrets: EmDash features fail closed when CMS_KEY_ENCRYPTION_KEY is missing.
 * WordPress projects never touch this module.
 */
import crypto from 'crypto';

export class CmsKeyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CmsKeyConfigError';
    this.code = 'CMS_KEY_ENCRYPTION_KEY_MISSING';
  }
}

const MIN_KEY_CHARS = 32;

/** True when CMS_KEY_ENCRYPTION_KEY is set and long enough. */
export function isCmsKeyCryptoConfigured(env = process.env) {
  const raw = env.CMS_KEY_ENCRYPTION_KEY || '';
  return raw.length >= MIN_KEY_CHARS;
}

function getKey(env = process.env) {
  const raw = env.CMS_KEY_ENCRYPTION_KEY || '';
  if (raw.length < MIN_KEY_CHARS) {
    throw new CmsKeyConfigError(
      `CMS_KEY_ENCRYPTION_KEY (${MIN_KEY_CHARS}+ chars) is required for EmDash site connections. ` +
        'Set it in apps/backend/.env and restart; WordPress projects are not affected.'
    );
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

/** @param {string} plaintext */
export function encryptCmsSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

/** @param {string} payload */
export function decryptCmsSecret(payload) {
  const [ivB64, tagB64, dataB64] = String(payload || '').split('.');
  if (!ivB64 || !tagB64 || dataB64 === undefined) throw new Error('Invalid encrypted CMS secret payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

/** Decrypt or return null (missing / undecryptable value). Never logs the value. */
export function tryDecryptCmsSecret(payload) {
  if (!payload) return null;
  try {
    return decryptCmsSecret(payload);
  } catch (err) {
    if (err instanceof CmsKeyConfigError) throw err;
    return null;
  }
}
