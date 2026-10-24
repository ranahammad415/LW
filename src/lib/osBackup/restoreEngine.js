/**
 * In-place restore (plan f step 7–9) on ONE data connection, FOREIGN_KEY_CHECKS=0:
 *   drop every trigger and view, DROP TABLE every base table except the four preserved ones (also tables missing
 *   from the backup), then stream-decrypt the file (each frame is authenticated before its statements run) and run
 *   table DDL → INSERTs (COMMIT every 20 statements and at each tableEnd) → views → triggers.
 * postRestore: TRUNCATE the purge-after-restore tables; verifyRestore: COUNT(*) per table == manifest,
 * _prisma_migrations == manifest names, preserved tables still present.
 * Statements and values are never logged; errors carry the table name and the driver code only.
 */
import { PRESERVED_TABLES, PURGE_AFTER_RESTORE } from './config.js';
import { readPayload } from './payload.js';
import { quoteId } from './sqlWriter.js';
import { LwosError } from './dbConn.js';

const COMMIT_EVERY = 20;

export async function sessionSetup(db) {
  for (const s of [
    'SET SESSION FOREIGN_KEY_CHECKS = 0',
    'SET SESSION UNIQUE_CHECKS = 0',
    "SET SESSION SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO'",
    "SET SESSION time_zone = '+00:00'",
    'SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci',
    'SET autocommit = 0',
  ]) {
    await db.exec(s);
  }
}

export async function sessionReset(db) {
  for (const s of ['COMMIT', 'SET autocommit = 1', 'SET SESSION FOREIGN_KEY_CHECKS = 1', 'SET SESSION UNIQUE_CHECKS = 1']) await db.exec(s).catch(() => {});
}

/** Drop triggers, views and every base table except the preserved four. Returns the dropped table names. */
export async function dropAll(db, { onProgress = () => {} } = {}) {
  const trig = await db.rows('SHOW TRIGGERS');
  for (const t of trig) await db.exec(`DROP TRIGGER IF EXISTS ${quoteId(String(t.Trigger ?? Object.values(t)[0]))}`);
  const full = await db.rows('SHOW FULL TABLES');
  const items = full.map((r) => {
    const v = Object.values(r);
    return { name: String(v[0]), type: String(v[1] || 'BASE TABLE').toUpperCase() };
  });
  for (const v of items.filter((i) => i.type === 'VIEW')) await db.exec(`DROP VIEW IF EXISTS ${quoteId(v.name)}`);
  const tables = items.filter((i) => i.type === 'BASE TABLE' && !PRESERVED_TABLES.includes(i.name)).map((i) => i.name);
  for (let i = 0; i < tables.length; i += 1) {
    await db.exec(`DROP TABLE IF EXISTS ${quoteId(tables[i])}`);
    onProgress({ phase: 'DROP', table: tables[i], i: i + 1, n: tables.length });
  }
  return tables;
}

function failAfter() {
  // Test hook only (plan k: failure injection); ignored outside the test runner.
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') return Infinity;
  const n = Number(process.env.LWOS_TEST_FAIL_AFTER_STATEMENTS);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

/** Load a backup file into the (dropped) database. */
export async function loadFile(db, file, keys, { onProgress = () => {}, totalTables = 0, fileBytes = 0, failAfterStatements = failAfter() } = {}) {
  let statements = 0;
  let sinceCommit = 0;
  let table = null;
  let tableIndex = 0;
  let rows = 0;
  let lastReport = 0;
  const views = [];
  const triggers = [];
  const run = async (sql) => {
    statements += 1;
    if (statements > failAfterStatements) throw new LwosError('TEST_FAILURE', `Injected failure after ${failAfterStatements} statements`);
    try {
      await db.exec(sql);
    } catch (err) {
      err.lwosTable = table;
      throw err;
    }
  };
  const hashes = await readPayload(file, keys, async (r) => {
    switch (r.k) {
      case 'table':
        table = r.t;
        tableIndex += 1;
        await run(String(r.ddl));
        break;
      case 'rows':
        await run(String(r.sql));
        rows += Number(r.n) || 0;
        sinceCommit += 1;
        if (sinceCommit >= COMMIT_EVERY) {
          await db.exec('COMMIT');
          sinceCommit = 0;
        }
        break;
      case 'tableEnd':
        await db.exec('COMMIT');
        sinceCommit = 0;
        break;
      case 'view':
        views.push(r);
        break;
      case 'trigger':
        triggers.push(r);
        break;
      default:
        break;
    }
    const t = Date.now();
    if (t - lastReport > 1000) {
      lastReport = t;
      onProgress({ phase: 'LOAD', table, i: tableIndex, n: totalTables, rows, totalBytes: fileBytes });
    }
  });
  await db.exec('COMMIT');
  // Views can reference each other: retry the ones that fail until no progress.
  let pending = views;
  for (let pass = 0; pending.length && pass < 5; pass += 1) {
    const failed = [];
    for (const v of pending) {
      try {
        table = v.name;
        await run(String(v.ddl));
      } catch (err) {
        failed.push({ v, err });
      }
    }
    if (failed.length === pending.length) throw failed[0].err;
    pending = failed.map((f) => f.v);
  }
  for (const tr of triggers) {
    table = tr.table || tr.name;
    await run(String(tr.ddl));
  }
  await db.exec('COMMIT');
  return { statements, rows, views: views.length, triggers: triggers.length, ...hashes };
}

export async function postRestore(db, { extraPurge = [] } = {}) {
  const purged = [];
  for (const t of [...PURGE_AFTER_RESTORE, ...extraPurge]) {
    const rows = await db.rows('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]);
    if (Number(rows?.[0]?.n) > 0) {
      await db.exec(`DELETE FROM ${quoteId(t)}`);
      purged.push(t);
    }
  }
  await db.exec('COMMIT');
  return purged;
}

/** COUNT(*) per manifest table, migrations equal, preserved tables present. Returns problems (empty = ok). */
export async function verifyRestore(db, manifest, { purged = [], requirePreserved = true } = {}) {
  const problems = [];
  for (const t of manifest.tables || []) {
    const [r] = await db.rows(`SELECT COUNT(*) AS n FROM ${quoteId(t.name)}`);
    const want = purged.includes(t.name) ? 0 : Number(t.rows);
    if (Number(r?.n) !== want) problems.push(`Table ${t.name}: ${Number(r?.n)} rows after restore, expected ${want}`);
    if (problems.length >= 5) break;
  }
  const names = manifest.migrations?.names || [];
  if ((manifest.tables || []).some((t) => t.name === '_prisma_migrations')) {
    const rows = await db.rows('SELECT `migration_name` AS name FROM `_prisma_migrations` WHERE `finished_at` IS NOT NULL AND `rolled_back_at` IS NULL ORDER BY `migration_name`');
    const got = rows.map((r) => String(r.name)).sort(); // compare in JS order on both sides (MySQL collation order may differ)
    if (got.join('|') !== [...names].sort().join('|')) problems.push('_prisma_migrations differs from the backup');
  }
  const present = await db.rows(`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${PRESERVED_TABLES.map(() => '?').join(',')})`, [...PRESERVED_TABLES]);
  if (requirePreserved && present.length !== PRESERVED_TABLES.length) problems.push('A preserved OS Backups table is missing');
  return problems;
}

/** drop + load + purge (no carry-forward, no verify): the shared core of restore, rollback and the CLI. */
export async function restoreDatabase(db, file, keys, manifest, { onProgress = () => {}, failAfterStatements } = {}) {
  await sessionSetup(db);
  try {
    await dropAll(db, { onProgress });
    const loaded = await loadFile(db, file, keys, { onProgress, totalTables: manifest?.tables?.length || 0, fileBytes: manifest?.totals?.fileBytes || 0, ...(failAfterStatements ? { failAfterStatements } : {}) });
    const purged = await postRestore(db);
    return { ...loaded, purged };
  } finally {
    await sessionReset(db);
  }
}
