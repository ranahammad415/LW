/**
 * Backup manifest (plan c.4): plaintext JSON next to the .lwbk, HMAC-SHA256 signed with HKDF(master, 'lwos-manifest')
 * over the canonical JSON without the `hmac` field. It holds no personal data: table names, counts, hashes, times.
 */
import fs from 'fs';
import path from 'path';
import { canonicalJson, deriveKey, hmacHex, keyIdOf, safeEqualHex } from './crypto.js';
import { KINDS, MANIFEST_FORMAT } from './config.js';

export function manifestKey(master) {
  return deriveKey(master, 'lwos-manifest');
}

export function signManifest(manifest, master) {
  const { hmac, ...rest } = manifest;
  return { ...rest, hmac: hmacHex(manifestKey(master), canonicalJson(rest)) };
}

/** True when the HMAC matches under one of the keys (current, previous). */
export function verifyManifestHmac(manifest, keys) {
  if (!manifest || typeof manifest.hmac !== 'string') return false;
  const { hmac, ...rest } = manifest;
  const text = canonicalJson(rest);
  return (keys || []).filter(Boolean).some((k) => safeEqualHex(hmacHex(manifestKey(k), text), hmac));
}

/** "20261115T085000Z" */
export function stamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function backupFileName(kind, startedAt, id) {
  const k = KINDS[kind] || 'manual';
  return `lwos-${stamp(startedAt)}-${k}-${String(id).replace(/-/g, '').slice(0, 8)}.lwbk`;
}

export function manifestNameFor(fileName) {
  return fileName.replace(/\.lwbk$/, '.manifest.json');
}

const FILE_RE = /^lwos-\d{8}T\d{6}Z-(sched|manual|safety)-[0-9a-f]{8}\.lwbk$/;
export function isBackupFileName(name) {
  return FILE_RE.test(String(name || ''));
}

export function buildManifest({
  id,
  fileName,
  kind,
  database,
  server,
  startedAt,
  finishedAt,
  app,
  migrations,
  dump,
  excludedData,
  preserved,
  totals,
  sha256Plain,
  sha256File,
  master,
  verify,
}) {
  return {
    format: MANIFEST_FORMAT,
    payloadFormat: 'lwos-jsonl/1',
    id,
    fileName,
    kind,
    engine: 'node',
    database,
    server: { version: server?.version || '' },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    app,
    migrations,
    tables: dump.tables,
    views: dump.views,
    triggers: dump.triggers,
    excludedData,
    preserved,
    totals,
    sha256Plain,
    sha256File,
    keyId: keyIdOf(master).toString('hex'),
    warnings: dump.warnings,
    verify: verify || { status: 'PENDING' },
  };
}

export async function writeJsonAtomic(file, value, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), { mode });
  await fs.promises.rename(tmp, file);
}

export function writeJsonAtomicSync(file, value, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode });
  fs.renameSync(tmp, file);
}

export async function readManifest(file) {
  return JSON.parse(await fs.promises.readFile(file, 'utf8'));
}

export function readManifestSync(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** App facts for the manifest: package version + git commit read from .git/HEAD as files (no exec). */
export function appFacts(backendRoot) {
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8')).version || version;
  } catch {
    /* ignore */
  }
  let gitCommit = null;
  try {
    const head = fs.readFileSync(path.join(backendRoot, '.git', 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) gitCommit = head;
    else if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      const p = path.join(backendRoot, '.git', ...ref.split('/'));
      if (fs.existsSync(p)) gitCommit = fs.readFileSync(p, 'utf8').trim().slice(0, 40);
    }
  } catch {
    /* not a git checkout */
  }
  return { version, gitCommit };
}
