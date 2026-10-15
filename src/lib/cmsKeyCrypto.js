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

const TAG_BYTES = 16;

/**
 * Associated data binding a ciphertext to its project and purpose ('inbound' | 'outbound' | 'pairing'),
 * so a value copied to another project or purpose does not decrypt (review S10). Purpose, not column:
 * a key pair moves pending → current → prev between columns during rotation.
 */
export function cmsAad(projectId, purpose) {
  if (!projectId || !purpose) throw new Error('cmsAad needs projectId and purpose');
  return `agency-os-cms:v1:${projectId}:${purpose}`;
}

/**
 * @param {string} plaintext
 * @param {string} aad  from cmsAad(projectId, purpose)
 */
export function encryptCmsSecret(plaintext, aad) {
  if (!aad) throw new Error('encryptCmsSecret needs associated data (cmsAad)');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

/**
 * @param {string} payload
 * @param {string} aad  the same cmsAad used to encrypt
 */
export function decryptCmsSecret(payload, aad) {
  if (!aad) throw new Error('decryptCmsSecret needs associated data (cmsAad)');
  const [ivB64, tagB64, dataB64] = String(payload || '').split('.');
  if (!ivB64 || !tagB64 || dataB64 === undefined) throw new Error('Invalid encrypted CMS secret payload');
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== 12 || tag.length !== TAG_BYTES) throw new Error('Invalid encrypted CMS secret payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

/** Decrypt or return null (missing / undecryptable value). Never logs the value. */
export function tryDecryptCmsSecret(payload, aad) {
  if (!payload) return null;
  try {
    return decryptCmsSecret(payload, aad);
  } catch (err) {
    if (err instanceof CmsKeyConfigError) throw err;
    return null;
  }
}
