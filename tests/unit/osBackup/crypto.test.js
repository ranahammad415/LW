import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { createEncryptStream, createDecryptStream, HEADER_LEN, CHUNK_SIZE, keyIdOf, deriveKey } from '../../../src/lib/osBackup/crypto.js';
import { signManifest, verifyManifestHmac } from '../../../src/lib/osBackup/manifest.js';
import { parseKey } from '../../../src/lib/osBackup/config.js';

const K1 = crypto.randomBytes(32);
const K2 = crypto.randomBytes(32);

async function run(input, transform, piece = 64 * 1024) {
  const chunks = [];
  for (let i = 0; i < input.length; i += piece) chunks.push(input.subarray(i, i + piece));
  const out = [];
  await pipeline(Readable.from(chunks.length ? chunks : []), transform, new Writable({ write(c, _e, cb) { out.push(c); cb(); } }));
  return Buffer.concat(out);
}
const enc = (buf, key = K1) => run(buf, createEncryptStream(key));
const dec = (buf, keys = [K1], piece) => run(buf, createDecryptStream(keys), piece);

/** Split an encrypted file into header + frames. */
function frames(file) {
  const header = file.subarray(0, HEADER_LEN);
  const list = [];
  let p = HEADER_LEN;
  while (p < file.length) {
    const len = file.readUInt32BE(p);
    list.push(file.subarray(p, p + 4 + len + 16));
    p += 4 + len + 16;
  }
  return { header, list };
}

describe('osBackup crypto (AES-256-GCM frames)', () => {
  for (const size of [0, 1, CHUNK_SIZE, 5 * CHUNK_SIZE + 1]) {
    it(`round-trips ${size} bytes`, async () => {
      const plain = crypto.randomBytes(size);
      const file = await enc(plain);
      expect(file.subarray(0, 8).toString()).toBe('LWOSBAK1');
      expect(file.length).toBeGreaterThanOrEqual(HEADER_LEN + 20);
      const back = await dec(file, [K1], 7777);
      expect(back.equals(plain)).toBe(true);
    });
  }

  it('exactly 1 MiB is a single final frame; 5 MiB + 1 is six frames', async () => {
    expect(frames(await enc(Buffer.alloc(CHUNK_SIZE))).list).toHaveLength(1);
    expect(frames(await enc(Buffer.alloc(5 * CHUNK_SIZE + 1))).list).toHaveLength(6);
    expect(frames(await enc(Buffer.alloc(0))).list).toHaveLength(1);
  });

  it('a flipped bit in a frame fails', async () => {
    const file = Buffer.from(await enc(crypto.randomBytes(3000)));
    file[HEADER_LEN + 10] ^= 1;
    await expect(dec(file)).rejects.toMatchObject({ code: 'TAMPERED' });
  });

  it('a flipped bit in the header (salt) fails', async () => {
    const file = Buffer.from(await enc(crypto.randomBytes(3000)));
    file[30] ^= 1;
    await expect(dec(file)).rejects.toThrow();
  });

  it('swapped frames fail', async () => {
    const { header, list } = frames(await enc(crypto.randomBytes(3 * CHUNK_SIZE + 10)));
    const swapped = Buffer.concat([header, list[1], list[0], ...list.slice(2)]);
    await expect(dec(swapped)).rejects.toMatchObject({ code: 'TAMPERED' });
  });

  it('truncation (final frame dropped) fails', async () => {
    const { header, list } = frames(await enc(crypto.randomBytes(2 * CHUNK_SIZE + 10)));
    await expect(dec(Buffer.concat([header, ...list.slice(0, -1)]))).rejects.toMatchObject({ code: 'TAMPERED' });
    await expect(dec(Buffer.concat([header, list[0].subarray(0, 100)]))).rejects.toMatchObject({ code: 'TRUNCATED' });
    await expect(dec(header.subarray(0, 20))).rejects.toMatchObject({ code: 'TRUNCATED' });
  });

  it('trailing bytes after the final frame fail', async () => {
    const file = await enc(crypto.randomBytes(500));
    await expect(dec(Buffer.concat([file, Buffer.from('junk')]))).rejects.toThrow();
    const { list } = frames(file);
    await expect(dec(Buffer.concat([file, list[0]]))).rejects.toMatchObject({ code: 'TAMPERED' });
  });

  it('a wrong key fails; the previous key decrypts', async () => {
    const plain = crypto.randomBytes(4000);
    const file = await enc(plain, K2);
    await expect(dec(file, [K1])).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
    expect((await dec(file, [K1, K2])).equals(plain)).toBe(true);
    // same keyId but different key material: authentication fails
    expect(keyIdOf(K1).equals(keyIdOf(K2))).toBe(false);
  });

  it('derived keys differ per purpose', () => {
    expect(deriveKey(K1, 'lwos-otp').equals(deriveKey(K1, 'lwos-watch'))).toBe(false);
  });

  it('manifest HMAC: valid, tampered, previous key', () => {
    const m = signManifest({ id: 'a', tables: [{ name: 'user', rows: 3 }], totals: { rows: 3 } }, K1);
    expect(verifyManifestHmac(m, [K1])).toBe(true);
    expect(verifyManifestHmac({ ...m, totals: { rows: 4 } }, [K1])).toBe(false);
    expect(verifyManifestHmac({ ...m, tables: [{ name: 'user', rows: 2 }] }, [K1])).toBe(false);
    expect(verifyManifestHmac(m, [K2])).toBe(false);
    expect(verifyManifestHmac(m, [K2, K1])).toBe(true);
    // key order in JSON does not matter (canonical form)
    const reordered = JSON.parse(JSON.stringify({ totals: m.totals, hmac: m.hmac, tables: m.tables, id: m.id }));
    expect(verifyManifestHmac(reordered, [K1])).toBe(true);
  });

  it('key parsing: exactly 32 bytes of base64', () => {
    expect(parseKey(K1.toString('base64')).key.equals(K1)).toBe(true);
    expect(parseKey('').error).toBe('missing');
    expect(parseKey(crypto.randomBytes(16).toString('base64')).error).toMatch(/16 bytes/);
    expect(parseKey('not base64!!').error).toBe('not base64');
  });
});
