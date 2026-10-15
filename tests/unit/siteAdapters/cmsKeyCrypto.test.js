import { describe, it, expect, afterEach } from 'vitest';
import {
  encryptCmsSecret,
  decryptCmsSecret,
  isCmsKeyCryptoConfigured,
  tryDecryptCmsSecret,
  CmsKeyConfigError,
} from '../../../src/lib/cmsKeyCrypto.js';

const ORIGINAL = process.env.CMS_KEY_ENCRYPTION_KEY;
const ORIGINAL_JWT = process.env.JWT_ACCESS_SECRET;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CMS_KEY_ENCRYPTION_KEY;
  else process.env.CMS_KEY_ENCRYPTION_KEY = ORIGINAL;
  if (ORIGINAL_JWT === undefined) delete process.env.JWT_ACCESS_SECRET;
  else process.env.JWT_ACCESS_SECRET = ORIGINAL_JWT;
});

describe('cmsKeyCrypto (AES-256-GCM, CMS_KEY_ENCRYPTION_KEY)', () => {
  it('round-trips a key and uses a fresh IV each time', () => {
    process.env.CMS_KEY_ENCRYPTION_KEY = 'test-cms-key-0123456789-abcdefghijklmnop';
    const secret = 'aosk1_fp_X5pa6uAaNxcPnJsvZkCaJQv4tX5T0j3UoZzndQLE';
    const a = encryptCmsSecret(secret);
    const b = encryptCmsSecret(secret);
    expect(a).not.toBe(b);
    expect(a).not.toContain(secret);
    expect(a.split('.')).toHaveLength(3);
    expect(decryptCmsSecret(a)).toBe(secret);
    expect(decryptCmsSecret(b)).toBe(secret);
  });

  it('fails closed without the key and never falls back to JWT secrets', () => {
    delete process.env.CMS_KEY_ENCRYPTION_KEY;
    process.env.JWT_ACCESS_SECRET = 'a-very-long-jwt-access-secret-that-must-not-be-used';
    expect(isCmsKeyCryptoConfigured()).toBe(false);
    expect(() => encryptCmsSecret('x')).toThrow(CmsKeyConfigError);
    expect(() => decryptCmsSecret('a.b.c')).toThrow(CmsKeyConfigError);
  });

  it('rejects short keys', () => {
    process.env.CMS_KEY_ENCRYPTION_KEY = 'too-short';
    expect(isCmsKeyCryptoConfigured()).toBe(false);
    expect(() => encryptCmsSecret('x')).toThrow(/CMS_KEY_ENCRYPTION_KEY/);
  });

  it('detects tampering and a different key', () => {
    process.env.CMS_KEY_ENCRYPTION_KEY = 'test-cms-key-0123456789-abcdefghijklmnop';
    const enc = encryptCmsSecret('hello');
    const [iv, tag, data] = enc.split('.');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 1;
    expect(() => decryptCmsSecret(`${iv}.${tag}.${flipped.toString('base64')}`)).toThrow();
    process.env.CMS_KEY_ENCRYPTION_KEY = 'another-cms-key-0123456789-abcdefghijklmn';
    expect(() => decryptCmsSecret(enc)).toThrow();
    expect(tryDecryptCmsSecret(enc)).toBeNull();
    expect(tryDecryptCmsSecret(null)).toBeNull();
  });
});
