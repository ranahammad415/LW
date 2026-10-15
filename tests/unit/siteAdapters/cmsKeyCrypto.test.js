import { describe, it, expect, afterEach } from 'vitest';
import {
  encryptCmsSecret,
  decryptCmsSecret,
  isCmsKeyCryptoConfigured,
  tryDecryptCmsSecret,
  CmsKeyConfigError,
  cmsAad,
} from '../../../src/lib/cmsKeyCrypto.js';

const ORIGINAL = process.env.CMS_KEY_ENCRYPTION_KEY;
const AAD = cmsAad('project-1', 'inbound');
const ORIGINAL_JWT = process.env.JWT_ACCESS_SECRET;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CMS_KEY_ENCRYPTION_KEY;
  else process.env.CMS_KEY_ENCRYPTION_KEY = ORIGINAL;
  if (ORIGINAL_JWT === undefined) delete process.env.JWT_ACCESS_SECRET;
  else process.env.JWT_ACCESS_SECRET = ORIGINAL_JWT;
});

describe('cmsKeyCrypto (AES-256-GCM, CMS_KEY_ENCRYPTION_KEY)', () => {
  it('binds ciphertexts to project + purpose (AAD) and requires a 16-byte tag (review S10)', () => {
    process.env.CMS_KEY_ENCRYPTION_KEY = 'test-cms-key-0123456789-abcdefghijklmnop';
    const enc = encryptCmsSecret('k', AAD);
    expect(() => decryptCmsSecret(enc, cmsAad('project-2', 'inbound'))).toThrow();
    expect(() => decryptCmsSecret(enc, cmsAad('project-1', 'outbound'))).toThrow();
    expect(() => encryptCmsSecret('k')).toThrow(/associated data/);
    expect(() => decryptCmsSecret(enc)).toThrow(/associated data/);
    const [iv, tag, data] = enc.split('.');
    const shortTag = Buffer.from(tag, 'base64').subarray(0, 8).toString('base64');
    expect(() => decryptCmsSecret(`${iv}.${shortTag}.${data}`, AAD)).toThrow(/Invalid/);
  });

  it('round-trips a key and uses a fresh IV each time', () => {
    process.env.CMS_KEY_ENCRYPTION_KEY = 'test-cms-key-0123456789-abcdefghijklmnop';
    const secret = 'aosk1_fp_X5pa6uAaNxcPnJsvZkCaJQv4tX5T0j3UoZzndQLE';
    const a = encryptCmsSecret(secret, AAD);
    const b = encryptCmsSecret(secret, AAD);
    expect(a).not.toBe(b);
    expect(a).not.toContain(secret);
    expect(a.split('.')).toHaveLength(3);
    expect(decryptCmsSecret(a, AAD)).toBe(secret);
    expect(decryptCmsSecret(b, AAD)).toBe(secret);
  });

  it('fails closed without the key and never falls back to JWT secrets', () => {
    delete process.env.CMS_KEY_ENCRYPTION_KEY;
    process.env.JWT_ACCESS_SECRET = 'a-very-long-jwt-access-secret-that-must-not-be-used';
    expect(isCmsKeyCryptoConfigured()).toBe(false);
    expect(() => encryptCmsSecret('x', AAD)).toThrow(CmsKeyConfigError);
    expect(() => decryptCmsSecret('a.b.c', AAD)).toThrow(CmsKeyConfigError);
  });

  it('rejects short keys', () => {
    process.env.CMS_KEY_ENCRYPTION_KEY = 'too-short';
    expect(isCmsKeyCryptoConfigured()).toBe(false);
    expect(() => encryptCmsSecret('x', AAD)).toThrow(/CMS_KEY_ENCRYPTION_KEY/);
  });

  it('detects tampering and a different key', () => {
    process.env.CMS_KEY_ENCRYPTION_KEY = 'test-cms-key-0123456789-abcdefghijklmnop';
    const enc = encryptCmsSecret('hello', AAD);
    const [iv, tag, data] = enc.split('.');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 1;
    expect(() => decryptCmsSecret(`${iv}.${tag}.${flipped.toString('base64')}`, AAD)).toThrow();
    process.env.CMS_KEY_ENCRYPTION_KEY = 'another-cms-key-0123456789-abcdefghijklmn';
    expect(() => decryptCmsSecret(enc, AAD)).toThrow();
    expect(tryDecryptCmsSecret(enc, AAD)).toBeNull();
    expect(tryDecryptCmsSecret(null)).toBeNull();
  });
});
