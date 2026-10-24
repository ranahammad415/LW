import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createPayloadWriter } from '../../../src/lib/osBackup/payload.js';
import { verifyBackupFile } from '../../../src/lib/osBackup/verify.js';
import { runBackup } from '../../../src/lib/osBackup/backup.js';
import { loadConfig } from '../../../src/lib/osBackup/config.js';
import { verifyManifestHmac, readManifest } from '../../../src/lib/osBackup/manifest.js';
import { fakeDataDb } from './fakeDb.js';

const KEY = crypto.randomBytes(32);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lwos-verify-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sha = (...s) => {
  const h = crypto.createHash('sha256');
  for (const x of s) h.update(x).update('\n');
  return h.digest('hex');
};

async function writeFile(name, records) {
  const file = path.join(tmp, name);
  const w = createPayloadWriter(file, KEY);
  for (const r of records) await w.write(r);
  return { file, ...(await w.finish()) };
}

const good = () => [
  { k: 'begin', format: 'lwos-jsonl/1', db: 'x' },
  { k: 'table', t: 'a', ddl: 'CREATE TABLE a (x int)', cols: ['x'] },
  { k: 'rows', t: 'a', n: 2, sql: 'INSERT INTO `a` (`x`) VALUES (1),(2)' },
  { k: 'tableEnd', t: 'a', rows: 2, sha256: sha('INSERT INTO `a` (`x`) VALUES (1),(2)') },
  { k: 'end', tables: 1, rows: 2 },
];

describe('osBackup verify', () => {
  it('a good file verifies, with manifest hashes', async () => {
    const f = await writeFile('good.lwbk', good());
    const v = await verifyBackupFile(f.file, [KEY], { tables: [{ name: 'a', rows: 2, sha256: sha('INSERT INTO `a` (`x`) VALUES (1),(2)') }], sha256Plain: f.sha256Plain, sha256File: f.sha256File });
    expect(v).toMatchObject({ ok: true, totalRows: 2 });
  });

  it('count mismatch fails', async () => {
    const r = good();
    r[3] = { ...r[3], rows: 3 };
    const f = await writeFile('count.lwbk', r);
    expect((await verifyBackupFile(f.file, [KEY])).error).toMatch(/2 rows in the file, tableEnd says 3/);
    const f2 = await writeFile('count2.lwbk', good());
    expect((await verifyBackupFile(f2.file, [KEY], { tables: [{ name: 'a', rows: 5 }] })).ok).toBe(false);
  });

  it('missing end record fails', async () => {
    const f = await writeFile('noend.lwbk', good().slice(0, -1));
    expect((await verifyBackupFile(f.file, [KEY])).error).toMatch(/no end record/);
  });

  it('sha mismatch fails', async () => {
    const r = good();
    r[3] = { ...r[3], sha256: sha('something else') };
    const f = await writeFile('sha.lwbk', r);
    expect((await verifyBackupFile(f.file, [KEY])).error).toMatch(/hash mismatch/);
    const f2 = await writeFile('sha2.lwbk', good());
    expect((await verifyBackupFile(f2.file, [KEY], { tables: [{ name: 'a', rows: 2 }], sha256File: 'f'.repeat(64) })).error).toMatch(/File hash/);
  });

  it('a tampered or truncated file fails without throwing', async () => {
    const f = await writeFile('tamper.lwbk', good());
    const buf = fs.readFileSync(f.file);
    buf[buf.length - 20] ^= 0xff;
    fs.writeFileSync(f.file, buf);
    expect((await verifyBackupFile(f.file, [KEY])).ok).toBe(false);
    fs.writeFileSync(f.file, buf.subarray(0, 60));
    expect((await verifyBackupFile(f.file, [KEY])).ok).toBe(false);
  });

  it('runBackup end to end on a fake DB: partial → verify → published file + signed manifest', async () => {
    const dir = path.join(tmp, 'osb');
    const cfg = { ...loadConfig({ OS_BACKUP_ENCRYPTION_KEY: KEY.toString('base64'), OS_BACKUP_DIR: dir, OS_BACKUP_PAGE_DELAY_MS: '0' }) };
    const data = fakeDataDb({
      tables: {
        user: { cols: [{ name: 'id', dataType: 'varchar' }, { name: 'bio', dataType: 'longtext' }, { name: 'meta', dataType: 'json' }, { name: 'pic', dataType: 'blob' }], indexes: { PRIMARY: { unique: true, cols: ['id'] } }, rows: [{ id: 'a', bio: 'emoji 😀\nline', meta: '{"z":1,"a":2}', pic: Buffer.from([1, 2]) }, { id: 'b', bio: null, meta: null, pic: null }] },
      _prisma_migrations: { cols: [{ name: 'migration_name', dataType: 'varchar' }], indexes: { PRIMARY: { unique: true, cols: ['migration_name'] } }, rows: [{ migration_name: '20261115_os_backups' }] },
    },
    });
    const out = await runBackup({ cfg, data, db: null, kind: 'MANUAL' });
    expect(fs.existsSync(out.file)).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([]);
    const m = await readManifest(out.file.replace(/\.lwbk$/, '.manifest.json'));
    expect(verifyManifestHmac(m, [KEY])).toBe(true);
    expect(m.tables.find((t) => t.name === 'user').rows).toBe(2);
    expect(m.migrations.latest).toBe('20261115_os_backups');
    expect(m.verify.status).toBe('OK');
    expect(JSON.stringify(m)).not.toContain('emoji');
    expect((await verifyBackupFile(out.file, [KEY], m)).ok).toBe(true);
    expect(data.log).toContain('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    expect(data.log).toContain('COMMIT');
  });
});
