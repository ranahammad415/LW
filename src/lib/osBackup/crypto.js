/**
 * Backup file encryption (plan c.3): AES-256-GCM in 1 MiB frames, Node crypto only.
 *
 * Header (54 bytes): "LWOSBAK1" | version u8 (1) | flags u8 | keyId (8) | salt (32) | chunkSize u32 BE
 * File key: HKDF-SHA256(master, salt, 'lwos-file v1', 32). Frame i: u32 BE ciphertextLen | ciphertext | tag (16),
 * nonce = 00000000 || u64BE(i), AAD = header || u64BE(i) || u8(final). The last frame has final = 1 (may be empty).
 * Decryption fails on a wrong tag (tamper / wrong key), reordered frames, a missing final frame (truncation) and bytes
 * after the final frame. The decryptor holds one frame back: a frame is final only when the stream ends right after it.
 */
import crypto from 'crypto';
import { Transform } from 'stream';

export const MAGIC = Buffer.from('LWOSBAK1', 'ascii');
export const VERSION = 1;
export const HEADER_LEN = 54;
export const CHUNK_SIZE = 1024 * 1024;
const TAG_LEN = 16;

export class LwosCryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.safe = true;
  }
}

/** HKDF-SHA256 with an empty salt, for the derived secrets ('lwos-manifest', 'lwos-otp', 'lwos-watch', ...). */
export function deriveKey(master, info, salt = Buffer.alloc(0)) {
  return Buffer.from(crypto.hkdfSync('sha256', master, salt, Buffer.from(info, 'utf8'), 32));
}

export function keyIdOf(master) {
  return crypto.createHash('sha256').update(deriveKey(master, 'lwos keyid')).digest().subarray(0, 8);
}

function u64(i) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(i));
  return b;
}
function nonceFor(i) {
  return Buffer.concat([Buffer.alloc(4), u64(i)]);
}
function aadFor(header, i, final) {
  return Buffer.concat([header, u64(i), Buffer.from([final ? 1 : 0])]);
}

export function buildHeader(master, { salt = crypto.randomBytes(32), chunkSize = CHUNK_SIZE } = {}) {
  const h = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(h, 0);
  h.writeUInt8(VERSION, 8);
  h.writeUInt8(0, 9);
  keyIdOf(master).copy(h, 10);
  salt.copy(h, 18);
  h.writeUInt32BE(chunkSize, 50);
  return h;
}

export function parseHeader(h) {
  if (!h || h.length < HEADER_LEN || !h.subarray(0, 8).equals(MAGIC)) throw new LwosCryptoError('BAD_HEADER', 'Not an OS backup file');
  const version = h.readUInt8(8);
  if (version !== VERSION) throw new LwosCryptoError('BAD_HEADER', `Unsupported backup file version ${version}`);
  const chunkSize = h.readUInt32BE(50);
  if (chunkSize < 1024 || chunkSize > 64 * 1024 * 1024) throw new LwosCryptoError('BAD_HEADER', 'Bad chunk size');
  return { version, flags: h.readUInt8(9), keyId: Buffer.from(h.subarray(10, 18)), salt: Buffer.from(h.subarray(18, 50)), chunkSize };
}

function fileKey(master, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', master, salt, Buffer.from('lwos-file v1', 'utf8'), 32));
}

function sealFrame(key, header, i, plain, final) {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonceFor(i));
  c.setAAD(aadFor(header, i, final));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(ct.length);
  return Buffer.concat([len, ct, c.getAuthTag()]);
}

/** Transform: plaintext in, encrypted file bytes out. */
export function createEncryptStream(master, opts = {}) {
  if (!Buffer.isBuffer(master) || master.length !== 32) throw new LwosCryptoError('BAD_KEY', 'Encryption key must be 32 bytes');
  const header = buildHeader(master, opts);
  const { salt, chunkSize } = parseHeader(header);
  const key = fileKey(master, salt);
  let index = 0;
  let parts = [];
  let size = 0;
  let headerSent = false;
  const take = (n) => {
    const all = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    parts = rest.length ? [rest] : [];
    size = rest.length;
    return out;
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        if (!headerSent) {
          this.push(header);
          headerSent = true;
        }
        parts.push(chunk);
        size += chunk.length;
        // Only seal a full frame when more bytes follow it: the last frame must carry final = 1.
        while (size > chunkSize) this.push(sealFrame(key, header, index++, take(chunkSize), false));
        cb();
      } catch (err) {
        cb(err);
      }
    },
    flush(cb) {
      try {
        if (!headerSent) this.push(header);
        this.push(sealFrame(key, header, index++, size ? take(size) : Buffer.alloc(0), true));
        cb();
      } catch (err) {
        cb(err);
      }
    },
  });
}

/** Transform: encrypted file bytes in, authenticated plaintext out. `keys` = [current, previous?]. */
export function createDecryptStream(keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => Buffer.isBuffer(k) && k.length === 32);
  let header = null;
  let key = null;
  let chunkSize = 0;
  let parts = [];
  let size = 0;
  let need = HEADER_LEN; // bytes needed before the next parse step (avoids re-concatenating on every small chunk)
  let index = 0;
  let held = null; // { ct, tag } of the last complete frame, not yet known to be final
  const open = (frame, final) => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(index));
    d.setAAD(aadFor(header, index, final));
    d.setAuthTag(frame.tag);
    try {
      const out = Buffer.concat([d.update(frame.ct), d.final()]);
      index += 1;
      return out;
    } catch {
      throw new LwosCryptoError('TAMPERED', 'Backup file failed authentication (tampered, truncated, reordered or wrong key)');
    }
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        parts.push(chunk);
        size += chunk.length;
        if (size < need) return cb();
        let buf = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
        parts = [];
        size = 0;
        if (!header) {
          header = Buffer.from(buf.subarray(0, HEADER_LEN));
          const h = parseHeader(header);
          chunkSize = h.chunkSize;
          const match = list.find((k) => keyIdOf(k).equals(h.keyId));
          if (!match) throw new LwosCryptoError('UNKNOWN_KEY', 'Backup file was encrypted with a key that is not configured');
          key = fileKey(match, h.salt);
          buf = buf.subarray(HEADER_LEN);
        }
        need = 4;
        for (;;) {
          if (buf.length < 4) break;
          const len = buf.readUInt32BE(0);
          if (len > chunkSize) throw new LwosCryptoError('TAMPERED', 'Backup file frame is too large');
          if (buf.length < 4 + len + TAG_LEN) {
            need = 4 + len + TAG_LEN;
            break;
          }
          const frame = { ct: Buffer.from(buf.subarray(4, 4 + len)), tag: Buffer.from(buf.subarray(4 + len, 4 + len + TAG_LEN)) };
          buf = buf.subarray(4 + len + TAG_LEN);
          if (held) this.push(open(held, false));
          held = frame;
        }
        if (buf.length) {
          parts = [Buffer.from(buf)];
          size = buf.length;
        }
        cb();
      } catch (err) {
        cb(err);
      }
    },
    flush(cb) {
      try {
        if (!header) throw new LwosCryptoError('TRUNCATED', 'Backup file is truncated (no header)');
        if (size) throw new LwosCryptoError('TRUNCATED', 'Backup file is truncated or has trailing bytes');
        if (!held) throw new LwosCryptoError('TRUNCATED', 'Backup file is truncated (no final frame)');
        this.push(open(held, true));
        held = null;
        cb();
      } catch (err) {
        cb(err);
      }
    },
  });
}

/** Read only the header of a file buffer / stream start and report its keyId (hex). */
export function headerKeyIdHex(headerBuf) {
  return parseHeader(headerBuf).keyId.toString('hex');
}

/** Canonical JSON (sorted keys, recursively) for signing. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function hmacHex(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]*$/i.test(a + b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
