/** Restore engine against a fake connection, with a real encrypted backup file made by runBackup on the fake DB. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runBackup } from '../../../src/lib/osBackup/backup.js';
import { loadConfig } from '../../../src/lib/osBackup/config.js';
import { restoreDatabase, verifyRestore, dropAll } from '../../../src/lib/osBackup/restoreEngine.js';
import { fakeDataDb } from './fakeDb.js';

const KEY = crypto.randomBytes(32);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lwos-restore-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let backup;

beforeAll(async () => {
  const cfg = loadConfig({ OS_BACKUP_ENCRYPTION_KEY: KEY.toString('base64'), OS_BACKUP_DIR: tmp, OS_BACKUP_PAGE_DELAY_MS: '0' });
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: `u${String(i).padStart(4, '0')}`, bio: 'x'.repeat(900) + ' 😀' }));
  const src = fakeDataDb({
    maxAllowedPacket: 64 * 1024,
    tables: {
      user: { ddl: 'CREATE TABLE `user` (`id` varchar(191) NOT NULL, `bio` longtext, PRIMARY KEY (`id`))', cols: [{ name: 'id', dataType: 'varchar' }, { name: 'bio', dataType: 'longtext' }], indexes: { PRIMARY: { unique: true, cols: ['id'] } }, rows },
      password_reset_token: { cols: [{ name: 'id', dataType: 'varchar' }], indexes: { PRIMARY: { unique: true, cols: ['id'] } }, rows: [{ id: 'r1' }] },
    },
    views: { v_users: 'CREATE ALGORITHM=UNDEFINED DEFINER=`a`@`%` SQL SECURITY DEFINER VIEW `v_users` AS select `id` from `user`' },
    triggers: [{ name: 'trg_user', table: 'user', ddl: 'CREATE DEFINER=`a`@`%` TRIGGER `trg_user` BEFORE INSERT ON `user` FOR EACH ROW SET NEW.bio = NEW.bio' }],
  });
  backup = await runBackup({ cfg, data: src, db: null, kind: 'MANUAL' });
});

function target({ counts = {} } = {}) {
  const exec = [];
  const db = {
    exec: async (sql) => (exec.push(sql), {}),
    rows: async (sql, params) => {
      if (sql === 'SHOW TRIGGERS') return [{ Trigger: 'old_trg', Table: 'user' }];
      if (sql === 'SHOW FULL TABLES') return ['user', 'extra_table', 'osbackup', 'osbackupjob', 'osbackupchallenge', 'osbackupstate'].map((t) => ({ Tables_in_db: t, Table_type: 'BASE TABLE' })).concat([{ Tables_in_db: 'v_old', Table_type: 'VIEW' }]);
      if (sql.includes('information_schema.TABLES') && sql.includes('TABLE_NAME = ?')) return [{ n: params[0] === 'password_reset_token' ? 1 : 0 }];
      if (sql.includes('TABLE_NAME IN')) return params.map((name) => ({ name }));
      const m = sql.match(/^SELECT COUNT\(\*\) AS n FROM `(.+)`$/);
      if (m) return [{ n: counts[m[1]] ?? 0 }];
      throw new Error(`unexpected ${sql}`);
    },
  };
  return { db, exec };
}

describe('osBackup restore engine (fake connection)', () => {
  it('drops triggers, views and every table except the preserved four', async () => {
    const { db, exec } = target();
    const dropped = await dropAll(db);
    expect(dropped).toEqual(['user', 'extra_table']);
    expect(exec).toEqual(['DROP TRIGGER IF EXISTS `old_trg`', 'DROP VIEW IF EXISTS `v_old`', 'DROP TABLE IF EXISTS `user`', 'DROP TABLE IF EXISTS `extra_table`']);
  });

  it('loads DDL → rows (COMMIT every 20 statements) → views → triggers, then purges', async () => {
    const { db, exec } = target();
    const out = await restoreDatabase(db, backup.file, [KEY], backup.manifest);
    expect(exec.slice(0, 6)).toEqual(['SET SESSION FOREIGN_KEY_CHECKS = 0', 'SET SESSION UNIQUE_CHECKS = 0', "SET SESSION SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO'", "SET SESSION time_zone = '+00:00'", 'SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci', 'SET autocommit = 0']);
    const inserts = exec.filter((s) => s.startsWith('INSERT INTO `user`'));
    expect(inserts.length).toBeGreaterThan(20);
    expect(out.rows).toBe(401);
    const firstInsert = exec.findIndex((s) => s.startsWith('INSERT INTO `user`'));
    expect(exec.findIndex((s) => s.startsWith('CREATE TABLE `user`'))).toBeLessThan(firstInsert);
    // commit cadence inside the user table: at least one COMMIT per 20 inserts
    const span = exec.slice(firstInsert, exec.lastIndexOf(inserts.at(-1)) + 1);
    expect(span.filter((s) => s === 'COMMIT').length).toBeGreaterThanOrEqual(Math.floor(inserts.length / 20));
    const view = exec.findIndex((s) => s.includes('VIEW `v_users`'));
    const trig = exec.findIndex((s) => s.includes('TRIGGER `trg_user`'));
    expect(view).toBeGreaterThan(exec.lastIndexOf(inserts.at(-1)));
    expect(trig).toBeGreaterThan(view);
    expect(exec[view]).toContain('SQL SECURITY INVOKER');
    expect(exec[view]).not.toContain('DEFINER=');
    expect(exec).toContain('DELETE FROM `password_reset_token`');
    expect(out.purged).toEqual(['password_reset_token']);
    expect(exec.slice(-3)).toEqual(['SET autocommit = 1', 'SET SESSION FOREIGN_KEY_CHECKS = 1', 'SET SESSION UNIQUE_CHECKS = 1']);
  });

  it('failure injection stops the load (the caller rolls back)', async () => {
    const { db } = target();
    await expect(restoreDatabase(db, backup.file, [KEY], backup.manifest, { failAfterStatements: 5 })).rejects.toMatchObject({ code: 'TEST_FAILURE' });
  });

  it('a tampered file stops the load before its bad frame runs', async () => {
    const bad = path.join(tmp, 'tampered.lwbk');
    const buf = fs.readFileSync(backup.file);
    buf[buf.length - 30] ^= 0xff;
    fs.writeFileSync(bad, buf);
    const { db, exec } = target();
    await expect(restoreDatabase(db, bad, [KEY], backup.manifest)).rejects.toThrow();
    expect(exec.some((s) => s.includes('TRIGGER `trg_user`'))).toBe(false);
  });

  it('verify: counts equal the manifest (purged tables = 0), preserved tables present', async () => {
    const good = target({ counts: { user: 400, password_reset_token: 0 } });
    expect(await verifyRestore(good.db, backup.manifest, { purged: ['password_reset_token'] })).toEqual([]);
    const off = target({ counts: { user: 399, password_reset_token: 0 } });
    expect((await verifyRestore(off.db, backup.manifest, { purged: ['password_reset_token'] }))[0]).toMatch(/user: 399 rows after restore, expected 400/);
  });
});
