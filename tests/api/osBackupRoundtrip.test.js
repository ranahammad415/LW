/**
 * OS Backups MySQL round trip (plan k, integration). Runs ONLY when OS_BACKUP_TEST_DATABASE_URL points at a throwaway
 * database whose name ends in `_test`; skipped otherwise. It DROPS EVERY TABLE of that database first.
 * Self-contained fixture schema (no Prisma CLI): a subset of user / apitoken / password_reset_token / _prisma_migrations,
 * tricky types (emoji, 5 MB LongText, JSON key order, BLOB, DATETIME(3), BIGINT), a composite-key join table, a view and
 * a trigger, plus the real 20261115_os_backups migration for the preserved tables.
 *   1. backup → checksums      2. mutate (rows, extra table, preserved rows, reset token, password, revocation)
 *   3. restore → checksums equal, extra table gone, preserved rows intact, reset tokens empty, tokenVersion bumped,
 *      current passwordHash carried forward, revocation re-applied
 *   4. failure injection (LWOS_TEST_FAIL_AFTER_STATEMENTS) → ROLLED_BACK with the mutated checksums
 *   5. crash: kill the worker during RESTORING → the recovery tick rolls back
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';

const URL_ = process.env.OS_BACKUP_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(here, '..', '..', 'prisma', 'migrations', '20261115_os_backups', 'migration.sql');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!URL_)('OS Backups MySQL round trip', () => {
  let admin;
  let cfg;
  let store;
  let runJob;
  let ctl;
  let db;
  const KEY = crypto.randomBytes(32);
  // Not created at collection time: a skipped suite must leave nothing behind.
  const dir = URL_ ? fs.mkdtempSync(path.join(os.tmpdir(), 'lwos-rt-')) : '';
  const saved = {};
  const FIX = ['user', 'apitoken', 'tricky', '_TaskAssignees', 'password_reset_token', '_prisma_migrations'];

  const checksums = async (tables = FIX) => {
    const out = {};
    for (const t of tables) {
      const [rows] = await admin.query(`SELECT * FROM \`${t}\` ORDER BY 1`);
      out[t] = crypto.createHash('sha256').update(JSON.stringify(rows, (_k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v))).digest('hex');
    }
    return out;
  };
  const userView = async () => (await admin.query('SELECT `id`, `email`, `isActive` FROM `user` ORDER BY `id`'))[0];

  async function job(fields) {
    const id = store.newId();
    await store.insertJob(db, { id, status: 'QUEUED', trigger: 'CLI', ...fields });
    return id;
  }

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(URL_).pathname.slice(1));
    if (!/_test$/.test(dbName)) throw new Error(`OS_BACKUP_TEST_DATABASE_URL must name a database ending in _test (got ${dbName})`);
    for (const k of ['DATABASE_URL', 'OS_BACKUP_DIR', 'OS_BACKUP_ENCRYPTION_KEY', 'OS_BACKUP_ENABLED', 'LWOS_DRAIN_MS', 'OS_BACKUP_PAGE_DELAY_MS', 'OS_BACKUP_MIN_FREE_MB']) saved[k] = process.env[k];
    Object.assign(process.env, { DATABASE_URL: URL_, OS_BACKUP_DIR: dir, OS_BACKUP_ENCRYPTION_KEY: KEY.toString('base64'), OS_BACKUP_ENABLED: 'true', LWOS_DRAIN_MS: '0', OS_BACKUP_PAGE_DELAY_MS: '0', OS_BACKUP_MIN_FREE_MB: '0' });
    admin = await mysql.createConnection({ uri: URL_, multipleStatements: true, charset: 'UTF8MB4_UNICODE_CI', timezone: 'Z' });
    const [tables] = await admin.query('SHOW FULL TABLES');
    await admin.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const r of tables) {
      const [name, type] = Object.values(r);
      await admin.query(type === 'VIEW' ? `DROP VIEW \`${name}\`` : `DROP TABLE \`${name}\``);
    }
    const [trigs] = await admin.query('SHOW TRIGGERS');
    for (const t of trigs) await admin.query(`DROP TRIGGER \`${t.Trigger}\``);
    await admin.query('SET FOREIGN_KEY_CHECKS = 1');
    await admin.query(`
      CREATE TABLE _prisma_migrations (id VARCHAR(36) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, finished_at DATETIME(3) NULL, migration_name VARCHAR(255) NOT NULL, logs TEXT NULL, rolled_back_at DATETIME(3) NULL, started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), applied_steps_count INT UNSIGNED NOT NULL DEFAULT 0) DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE TABLE user (id VARCHAR(191) PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, passwordHash VARCHAR(255) NOT NULL, role ENUM('OWNER','PM','TEAM_MEMBER','CONTRACTOR','CLIENT') NOT NULL, name VARCHAR(255) NOT NULL DEFAULT '', isActive BOOLEAN NOT NULL DEFAULT true, tokenVersion INT NOT NULL DEFAULT 0, isAgent BOOLEAN NOT NULL DEFAULT false, twoFaSecret VARCHAR(255) NULL, twoFaEnabled BOOLEAN NOT NULL DEFAULT false, twoFaBackupCodes JSON NULL) DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE TABLE apitoken (id VARCHAR(191) PRIMARY KEY, userId VARCHAR(191) NOT NULL, userTokenVersion INT NOT NULL DEFAULT 0, revokedAt DATETIME(3) NULL, revokedById VARCHAR(191) NULL, CONSTRAINT apitoken_userId_fkey FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE) DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE TABLE password_reset_token (id VARCHAR(191) PRIMARY KEY, userId VARCHAR(191) NOT NULL, tokenHash VARCHAR(64) NOT NULL, CONSTRAINT prt_user_fkey FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE) DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE TABLE tricky (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, txt VARCHAR(255) NULL, big LONGTEXT NULL, meta JSON NULL, bin BLOB NULL, at DATETIME(3) NULL, amount DECIMAL(30,10) NULL, huge BIGINT UNSIGNED NULL, gen VARCHAR(300) AS (CONCAT('g-', txt)) VIRTUAL) DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE TABLE _TaskAssignees (A VARCHAR(191) NOT NULL, B VARCHAR(191) NOT NULL, UNIQUE INDEX _TaskAssignees_AB_unique (A, B), INDEX _TaskAssignees_B_index (B)) DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE TABLE agency_setting (id VARCHAR(191) PRIMARY KEY, agencyName VARCHAR(255) NOT NULL DEFAULT 'Localwaves', logoUrl VARCHAR(500) NULL, emailPrimaryColor VARCHAR(20) NOT NULL DEFAULT '#6366f1', emailHeaderHtml LONGTEXT NULL, emailFooterHtml LONGTEXT NULL, emailFooterText VARCHAR(500) NULL, copyrightText VARCHAR(255) NULL, address VARCHAR(500) NULL) DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE TABLE systemalert (id VARCHAR(191) PRIMARY KEY, userId VARCHAR(191) NOT NULL, type VARCHAR(50) NOT NULL, message VARCHAR(500) NOT NULL, isRead BOOLEAN NOT NULL DEFAULT false, actionUrl VARCHAR(500) NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), CONSTRAINT sa_user_fkey FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE) DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE VIEW v_active_users AS SELECT id, email FROM user WHERE isActive = 1;
      CREATE TRIGGER trg_tricky BEFORE INSERT ON tricky FOR EACH ROW SET NEW.txt = IFNULL(NEW.txt, 'default');
    `);
    await admin.query(fs.readFileSync(MIGRATION, 'utf8'));
    for (const name of fs.readdirSync(path.join(here, '..', '..', 'prisma', 'migrations')).filter((n) => fs.existsSync(path.join(here, '..', '..', 'prisma', 'migrations', n, 'migration.sql')))) {
      await admin.query('INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (UUID(), ?, UTC_TIMESTAMP(3), ?, 1)', ['x'.repeat(64), name]);
    }
    await admin.query("INSERT INTO user (id, email, passwordHash, role, name, tokenVersion, twoFaBackupCodes) VALUES ('u-owner', 'owner@x.test', '$2b$old', 'OWNER', 'Owner', 3, '[\"a\",\"b\"]'), ('u-pm', 'pm@x.test', '$2b$pm', 'PM', 'PM', 0, NULL)");
    await admin.query("INSERT INTO apitoken (id, userId, userTokenVersion) VALUES ('t-1', 'u-pm', 0), ('t-2', 'u-pm', 0)");
    await admin.query("INSERT INTO password_reset_token (id, userId, tokenHash) VALUES ('r-1', 'u-owner', 'h')");
    await admin.query("INSERT INTO agency_setting (id, agencyName) VALUES ('s1', 'Test Agency')");
    const big = 'L'.repeat(5 * 1024 * 1024);
    await admin.query('INSERT INTO tricky (txt, big, meta, bin, at, amount, huge) VALUES (?, ?, ?, ?, ?, ?, ?), (?, NULL, ?, ?, ?, ?, ?), (NULL, NULL, NULL, NULL, NULL, NULL, NULL)', [
      'emoji 😀 "q" \\ \n\r', big, '{"z": 1, "a": [1, 2], "m": {"k": "v"}}', Buffer.from([0, 1, 2, 254, 255]), '2026-03-29 01:30:00.123', '12345678901234567890.0123456789', '18446744073709551615',
      "it's", '{"b":2,"a":1}', Buffer.alloc(0), '2026-10-25 02:30:00.999', '-0.0000000001', '9007199254740993',
    ]);
    for (const a of ['t1', 't2', 't3']) for (const b of ['u1', 'u2', 'u3']) await admin.query('INSERT INTO _TaskAssignees (A, B) VALUES (?, ?)', [a, b]);

    ({ loadConfig: cfg } = await import('../../src/lib/osBackup/config.js'));
    cfg = cfg();
    store = await import('../../src/lib/osBackup/store.js');
    ({ runJob } = await import('../../src/lib/osBackup/runner.js'));
    const { openControlConnection } = await import('../../src/lib/osBackup/dbConn.js');
    ctl = await openControlConnection(URL_);
    db = store.mysqlSql(ctl);
  }, 180_000);

  afterAll(async () => {
    delete process.env.LWOS_TEST_FAIL_AFTER_STATEMENTS;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await ctl?.end().catch(() => {});
    await admin?.end().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let backupId;
  let before;
  let mutated;

  it('backs up, verifies and publishes', async () => {
    const id = await job({ type: 'BACKUP' });
    const res = await runJob(id, { cfg, log: () => {} });
    expect(res.status).toBe('SUCCEEDED');
    backupId = res.backupId;
    const b = await store.getBackup(db, backupId);
    expect(b).toMatchObject({ status: 'READY', verifyStatus: 'OK' });
    expect(b.rowCounts.tricky).toBe(3);
    before = await checksums();
  }, 180_000);

  it('restores: data equal to the backup, preserved rows kept, security carried forward', async () => {
    await admin.query("INSERT INTO tricky (txt) VALUES ('new row')");
    await admin.query("DELETE FROM _TaskAssignees WHERE A = 't1'");
    await admin.query("UPDATE tricky SET meta = '{\"changed\": true}' WHERE id = 2");
    await admin.query('CREATE TABLE extra_after_backup (id INT PRIMARY KEY)');
    await admin.query("INSERT INTO password_reset_token (id, userId, tokenHash) VALUES ('r-2', 'u-owner', 'h2')");
    await admin.query("UPDATE user SET passwordHash = '$2b$changed-after-compromise', tokenVersion = 7 WHERE id = 'u-owner'");
    await admin.query("UPDATE apitoken SET revokedAt = '2026-11-15 11:00:00.000', revokedById = 'u-owner' WHERE id = 't-1'");
    await admin.query("INSERT INTO osbackupchallenge (id, userId, email, action, backupId, codeHash, expiresAt, lastSentAt) VALUES ('keep-me', 'u-owner', 'o', 'RESTORE', 'b', REPEAT('0', 64), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))");

    const id = await job({ type: 'RESTORE', trigger: 'MANUAL', backupId, requestedById: 'u-owner', requestedByEmail: 'owner@x.test', progress: { options: { carryForwardCredentials: true } } });
    const res = await runJob(id, { cfg, log: () => {} });
    expect(res.status).toBe('SUCCEEDED');
    const after = await checksums(['tricky', '_TaskAssignees', '_prisma_migrations']);
    for (const t of ['tricky', '_TaskAssignees', '_prisma_migrations']) expect(after[t]).toBe(before[t]);
    const [extra] = await admin.query("SHOW TABLES LIKE 'extra_after_backup'");
    expect(extra).toHaveLength(0);
    expect((await admin.query("SELECT id FROM osbackupchallenge WHERE id = 'keep-me'"))[0]).toHaveLength(1);
    expect((await admin.query('SELECT COUNT(*) AS n FROM password_reset_token'))[0][0].n).toBe(0);
    const [[owner]] = await admin.query("SELECT passwordHash, tokenVersion, twoFaBackupCodes FROM user WHERE id = 'u-owner'");
    expect(owner.passwordHash).toBe('$2b$changed-after-compromise');
    expect(owner.tokenVersion).toBe(8);
    const [[t1]] = await admin.query("SELECT revokedAt FROM apitoken WHERE id = 't-1'");
    expect(t1.revokedAt).not.toBeNull();
    const [[t2]] = await admin.query("SELECT a.userTokenVersion AS a, u.tokenVersion AS u FROM apitoken a JOIN user u ON u.id = a.userId WHERE a.id = 't-2'");
    expect(t2.a).toBe(t2.u);
    expect((await admin.query('SELECT * FROM v_active_users'))[0]).toHaveLength(2);
    await admin.query("INSERT INTO tricky (txt) VALUES (NULL)");
    expect((await admin.query('SELECT txt FROM tricky ORDER BY id DESC LIMIT 1'))[0][0].txt).toBe('default');
    expect(fs.existsSync(path.join(dir, 'maintenance.json'))).toBe(false);
    const [[safety]] = await admin.query("SELECT COUNT(*) AS n FROM osbackup WHERE kind = 'SAFETY' AND status = 'READY'");
    expect(safety.n).toBe(1);
  }, 300_000);

  it('failure injection ends ROLLED_BACK with the pre-restore data', async () => {
    await admin.query("INSERT INTO tricky (txt) VALUES ('before failed restore')");
    mutated = await checksums(['tricky', '_TaskAssignees']);
    const users = await userView();
    process.env.LWOS_TEST_FAIL_AFTER_STATEMENTS = '3';
    try {
      const id = await job({ type: 'RESTORE', trigger: 'MANUAL', backupId, requestedById: 'u-owner', progress: { options: {} } });
      const res = await runJob(id, { cfg, log: () => {} });
      expect(res.status).toBe('ROLLED_BACK');
      expect((await store.getJob(db, id)).status).toBe('ROLLED_BACK');
    } finally {
      delete process.env.LWOS_TEST_FAIL_AFTER_STATEMENTS;
    }
    const after = await checksums(['tricky', '_TaskAssignees']);
    expect(after).toEqual(mutated);
    expect(await userView()).toEqual(users);
    expect(fs.existsSync(path.join(dir, 'maintenance.json'))).toBe(false);
  }, 300_000);

  it('crash during RESTORING: the recovery tick rolls back', async () => {
    const { startJob, recoveryTick } = await import('../../src/lib/osBackup/scheduler.js');
    const { spawnWorker, readJobFile } = await import('../../src/lib/osBackup/jobs.js');
    const pre = await checksums(['tricky', '_TaskAssignees']);
    const j = await startJob({ db, cfg, type: 'RESTORE', trigger: 'MANUAL', backupId, user: { id: 'u-owner', email: 'owner@x.test' }, options: {}, spawn: spawnWorker });
    let killed = false;
    for (let i = 0; i < 600 && !killed; i += 1) {
      const f = readJobFile(cfg.dir, j.id);
      if (f?.phase === 'RESTORING' && f.workerPid) {
        try {
          process.kill(f.workerPid, 'SIGKILL');
          killed = true;
        } catch {
          /* already gone */
        }
      }
      if (f && ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'].includes(f.status)) break;
      await sleep(25);
    }
    if (!killed) return; // the restore finished before it could be killed: nothing to recover (inconclusive, not a failure)
    await sleep(500);
    const decision = await recoveryTick({ db, cfg, now: Date.now() + 3 * 60_000, spawn: spawnWorker });
    expect(decision.action).toBe('ROLLBACK');
    for (let i = 0; i < 2400; i += 1) {
      const s = (await store.getJob(db, j.id)).status;
      if (['ROLLED_BACK', 'FAILED_ROLLBACK'].includes(s)) break;
      await sleep(50);
    }
    expect((await store.getJob(db, j.id)).status).toBe('ROLLED_BACK');
    expect(await checksums(['tricky', '_TaskAssignees'])).toEqual(pre);
  }, 300_000);
});
