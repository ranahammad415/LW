/**
 * Dependency-free image sniffing: the real type from the bytes (never the file name or a client header) and the
 * pixel size from the header. Used before media-import (contract v1.2 §22.3: the site sniffs too and never
 * re-encodes, so the OS refuses what the site would refuse). SVG is never an image here.
 * @returns {{ contentType: string, width: number|null, height: number|null } | null}
 */
export function probeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width/height at 16/20
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { contentType: 'image/png', width: buf.length >= 24 ? buf.readUInt32BE(16) : null, height: buf.length >= 24 ? buf.readUInt32BE(20) : null };
  }
  // JPEG: FF D8 FF, size in the first SOFn marker
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { contentType: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      if (len < 2) break;
      i += 2 + len;
    }
    return { contentType: 'image/jpeg', width: null, height: null };
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.length >= 30) {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30) return { contentType: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { contentType: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { contentType: 'image/webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    return { contentType: 'image/webp', width: null, height: null };
  }
  // AVIF: ISO-BMFF ftyp with an avif/avis brand; size from the first 'ispe' box
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brands = buf.toString('ascii', 8, Math.min(buf.length, 8 + buf.readUInt32BE(0)));
    if (/avif|avis/.test(brands)) {
      const at = buf.indexOf('ispe');
      if (at > 0 && at + 16 <= buf.length) return { contentType: 'image/avif', width: buf.readUInt32BE(at + 8), height: buf.readUInt32BE(at + 12) };
      return { contentType: 'image/avif', width: null, height: null };
    }
  }
  // GIF (not a contract media type; reported so the caller can refuse it by type)
  if (buf.toString('ascii', 0, 3) === 'GIF') return { contentType: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  return null;
}
