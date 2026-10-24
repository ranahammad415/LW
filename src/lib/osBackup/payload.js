/**
 * Payload pipeline (plan c.2 / c.5): JSON Lines → gzip(6) → AES-GCM frames → file, with sha256 over the plaintext and
 * over the file bytes; and the reverse: file → decrypt (each frame authenticated before its bytes go on) → gunzip →
 * one parsed record per line.
 */
import crypto from 'crypto';
import fs from 'fs';
import zlib from 'zlib';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { StringDecoder } from 'string_decoder';
import { createDecryptStream, createEncryptStream } from './crypto.js';

function tap(onChunk) {
  return new Transform({
    transform(chunk, _e, cb) {
      onChunk(chunk);
      cb(null, chunk);
    },
  });
}

/** Writer: write(record) awaits backpressure; finish() fsyncs and returns the hashes and byte counts. */
export function createPayloadWriter(file, master, { mode = 0o600 } = {}) {
  const plainHash = crypto.createHash('sha256');
  const fileHash = crypto.createHash('sha256');
  let plainBytes = 0;
  let fileBytes = 0;
  const gzip = zlib.createGzip({ level: 6 });
  const enc = createEncryptStream(master);
  const counter = tap((c) => {
    fileHash.update(c);
    fileBytes += c.length;
  });
  const out = fs.createWriteStream(file, { mode, flags: 'wx' });
  const done = pipeline(gzip, enc, counter, out);
  let failed = null;
  done.catch((err) => {
    failed = err;
  });
  return {
    async write(record) {
      if (failed) throw failed;
      const line = `${JSON.stringify(record)}\n`;
      const buf = Buffer.from(line, 'utf8');
      plainHash.update(buf);
      plainBytes += buf.length;
      if (!gzip.write(buf)) {
        await new Promise((resolve, reject) => {
          const onErr = (e) => {
            gzip.off('drain', onDrain);
            reject(e);
          };
          const onDrain = () => {
            gzip.off('error', onErr);
            resolve();
          };
          gzip.once('drain', onDrain);
          gzip.once('error', onErr);
          done.catch(onErr);
        });
      }
    },
    async finish() {
      gzip.end();
      await done;
      const fh = await fs.promises.open(file, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      return { plainBytes, fileBytes, sha256Plain: plainHash.digest('hex'), sha256File: fileHash.digest('hex') };
    },
    abort() {
      const e = new Error('aborted');
      for (const s of [gzip, enc, counter, out]) {
        try {
          s.destroy(e);
        } catch {
          /* ignore */
        }
      }
      done.catch(() => {});
    },
  };
}

/**
 * Reader: calls `onRecord(record)` (awaited) for each line. Resolves with the hashes of the file and the plaintext.
 * Any decrypt / gunzip / JSON error rejects (the caller decides what failing means).
 */
export async function readPayload(file, keys, onRecord) {
  const fileHash = crypto.createHash('sha256');
  const plainHash = crypto.createHash('sha256');
  let fileBytes = 0;
  let plainBytes = 0;
  await pipeline(
    fs.createReadStream(file, { highWaterMark: 1024 * 1024 }),
    tap((c) => {
      fileHash.update(c);
      fileBytes += c.length;
    }),
    createDecryptStream(keys),
    zlib.createGunzip(),
    tap((c) => {
      plainHash.update(c);
      plainBytes += c.length;
    }),
    async function lines(source) {
      const dec = new StringDecoder('utf8');
      let pending = []; // pieces of the current (possibly multi-MB) line; only new text is searched for '\n'
      for await (const chunk of source) {
        const piece = dec.write(chunk);
        let start = 0;
        let idx;
        while ((idx = piece.indexOf('\n', start)) >= 0) {
          pending.push(piece.slice(start, idx));
          const line = pending.length === 1 ? pending[0] : pending.join('');
          pending = [];
          start = idx + 1;
          if (line) await onRecord(JSON.parse(line));
        }
        if (start < piece.length) pending.push(piece.slice(start));
      }
      const tail = pending.join('') + dec.end();
      if (tail.trim()) await onRecord(JSON.parse(tail));
    }
  );
  return { fileBytes, plainBytes, sha256File: fileHash.digest('hex'), sha256Plain: plainHash.digest('hex') };
}
