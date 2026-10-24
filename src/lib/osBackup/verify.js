/**
 * Full verify pass (plan c.5): decrypt every frame, gunzip, parse every line and check the structure:
 * begin first, every frame tag, the `end` record, per table sum(n) == tableEnd.rows, per-table sha256 of the INSERT
 * strings, and (with a manifest) the manifest's row counts, table hashes, sha256Plain and sha256File.
 * Returns { ok, error?, ... }: never throws for a bad file. Errors name tables and counts only.
 */
import crypto from 'crypto';
import { readPayload } from './payload.js';
import { PAYLOAD_FORMAT } from './config.js';

export function createRecordChecker() {
  const tables = [];
  let cur = null;
  let begun = false;
  let ended = null;
  let totalRows = 0;
  const fail = (msg) => {
    const e = new Error(msg);
    e.code = 'VERIFY_FAILED';
    e.safe = true;
    throw e;
  };
  return {
    onRecord(r) {
      if (!begun) {
        if (r.k !== 'begin' || r.format !== PAYLOAD_FORMAT) fail('Payload does not start with a begin record');
        begun = true;
        return;
      }
      if (ended) fail('Records after the end record');
      switch (r.k) {
        case 'table':
          if (cur) fail(`Table ${cur.name} has no tableEnd record`);
          cur = { name: r.t, rows: 0, sha: crypto.createHash('sha256') };
          break;
        case 'rows':
          if (!cur || r.t !== cur.name) fail(`Rows for ${r.t} outside its table`);
          cur.rows += Number(r.n) || 0;
          cur.sha.update(String(r.sql)).update('\n');
          break;
        case 'tableEnd': {
          if (!cur || r.t !== cur.name) fail(`tableEnd for ${r.t} without its table`);
          const sha = cur.sha.digest('hex');
          if (cur.rows !== Number(r.rows)) fail(`Table ${cur.name}: ${cur.rows} rows in the file, tableEnd says ${r.rows}`);
          if (sha !== r.sha256) fail(`Table ${cur.name}: content hash mismatch`);
          tables.push({ name: cur.name, rows: cur.rows, sha256: sha });
          totalRows += cur.rows;
          cur = null;
          break;
        }
        case 'view':
        case 'trigger':
          if (cur) fail(`Table ${cur.name} has no tableEnd record`);
          break;
        case 'end':
          if (cur) fail(`Table ${cur.name} has no tableEnd record`);
          if (Number(r.tables) !== tables.length || Number(r.rows) !== totalRows) fail('End record totals do not match the file');
          ended = r;
          break;
        default:
          fail('Unknown record kind');
      }
    },
    result() {
      if (!begun) fail('Empty payload');
      if (!ended) fail('Payload has no end record (truncated)');
      return { tables, totalRows };
    },
  };
}

export function compareWithManifest(found, manifest) {
  const problems = [];
  const want = new Map((manifest.tables || []).map((t) => [t.name, t]));
  if (want.size !== found.tables.length) problems.push(`Manifest lists ${want.size} tables, file has ${found.tables.length}`);
  for (const t of found.tables) {
    const m = want.get(t.name);
    if (!m) problems.push(`Table ${t.name} is not in the manifest`);
    else if (Number(m.rows) !== t.rows) problems.push(`Table ${t.name}: manifest ${m.rows} rows, file ${t.rows}`);
    else if (m.sha256 && m.sha256 !== t.sha256) problems.push(`Table ${t.name}: hash differs from the manifest`);
  }
  if (manifest.sha256Plain && found.sha256Plain && manifest.sha256Plain !== found.sha256Plain) problems.push('Plaintext hash differs from the manifest');
  if (manifest.sha256File && found.sha256File && manifest.sha256File !== found.sha256File) problems.push('File hash differs from the manifest');
  return problems;
}

export async function verifyBackupFile(file, keys, manifest = null) {
  const started = Date.now();
  const checker = createRecordChecker();
  try {
    const hashes = await readPayload(file, keys, (r) => checker.onRecord(r));
    const found = { ...checker.result(), ...hashes };
    const problems = manifest ? compareWithManifest(found, manifest) : [];
    if (problems.length) return { ok: false, error: problems.slice(0, 3).join('; '), durationMs: Date.now() - started, ...found };
    return { ok: true, durationMs: Date.now() - started, ...found };
  } catch (err) {
    const msg = err?.safe ? err.message : err?.code === 'Z_BUF_ERROR' || /unexpected end/i.test(String(err?.message)) ? 'Compressed payload is truncated' : err instanceof SyntaxError ? 'A payload line is not valid JSON' : `Verify failed (${err?.code || 'ERROR'})`;
    return { ok: false, error: msg, durationMs: Date.now() - started };
  }
}
