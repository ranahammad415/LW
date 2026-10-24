/**
 * One backup (plan c.5): snapshot dump → tmp/<id>.partial → fsync → full verify → rename into backups/ → signed
 * manifest (tmp + rename) → catalog row READY. A failed verify deletes the partial and fails the backup.
 * `data` = dbConn.dataAdapter (the snapshot connection), `db` = store adapter for the preserved tables (or null when
 * the CLI runs without them).
 */
import fs from 'fs';
import path from 'path';
import { BACKEND_ROOT, PRESERVED_TABLES, decryptKeys } from './config.js';
import { beginSnapshot, dumpDatabase, serverFacts } from './dumpNode.js';
import { createPayloadWriter } from './payload.js';
import { verifyBackupFile } from './verify.js';
import { appFacts, backupFileName, buildManifest, manifestNameFor, signManifest, writeJsonAtomic } from './manifest.js';
import { ensureDirs } from './jobs.js';
import { sanitizeError } from './dbConn.js';
import * as store from './store.js';

export async function snapshotMigrations(data) {
  try {
    const rows = await data.rows('SELECT `migration_name` AS name FROM `_prisma_migrations` WHERE `finished_at` IS NOT NULL AND `rolled_back_at` IS NULL ORDER BY `migration_name`');
    return rows.map((r) => String(r.name));
  } catch {
    return [];
  }
}

export async function runBackup({ cfg, data, db, kind = 'MANUAL', createdBy = null, safetyForJobId = null, onProgress = () => {}, shouldAbort = () => false, now = () => new Date() }) {
  const l = ensureDirs(cfg.dir);
  const id = store.newId();
  const startedAt = now();
  const fileName = backupFileName(kind, startedAt, id);
  const partial = path.join(l.tmp, `${id}.partial`);
  const finalPath = path.join(l.backups, fileName);
  const deadline = Date.now() + cfg.maxMinutes * 60_000;
  if (db) {
    await store.insertBackup(db, {
      id,
      fileName,
      kind,
      status: 'RUNNING',
      engine: 'node',
      startedAt,
      createdById: createdBy?.id || null,
      createdByEmail: createdBy?.email || null,
      safetyForJobId,
    });
  }
  let writer = null;
  let inTx = false;
  let lastProgress = 0;
  const progress = (p) => {
    const t = Date.now();
    if (t - lastProgress < 2000 && p.phase === 'DUMP') return;
    lastProgress = t;
    onProgress({ ...p, kind });
  };
  try {
    const facts = await serverFacts(data);
    await beginSnapshot(data);
    inTx = true;
    const migrations = await snapshotMigrations(data);
    writer = createPayloadWriter(partial, cfg.master);
    const dump = await dumpDatabase(data, (r) => writer.write(r), {
      database: facts.database,
      server: facts,
      pageRows: cfg.pageRows,
      pageDelayMs: cfg.pageDelayMs,
      excludeData: cfg.excludeDataTables,
      deadline,
      onProgress: progress,
      shouldAbort,
    });
    await data.exec('COMMIT').catch(() => {});
    inTx = false;
    const hashes = await writer.finish();
    writer = null;
    progress({ phase: 'VERIFY', table: null, rows: dump.totalRows, bytes: hashes.fileBytes });

    const expect = { tables: dump.tables, sha256Plain: hashes.sha256Plain, sha256File: hashes.sha256File };
    const v = await verifyBackupFile(partial, decryptKeys(cfg), expect);
    if (!v.ok) {
      const e = new Error(`Verify failed: ${v.error}`);
      e.code = 'VERIFY_FAILED';
      e.safe = true;
      throw e;
    }
    await fs.promises.rename(partial, finalPath);
    const finishedAt = now();
    const manifest = signManifest(
      buildManifest({
        id,
        fileName,
        kind,
        database: facts.database,
        server: facts,
        startedAt,
        finishedAt,
        app: appFacts(BACKEND_ROOT),
        migrations: { count: migrations.length, latest: migrations[migrations.length - 1] || null, names: migrations },
        dump,
        excludedData: cfg.excludeDataTables,
        preserved: [...PRESERVED_TABLES],
        totals: { tables: dump.tables.length, rows: dump.totalRows, plainBytes: hashes.plainBytes, fileBytes: hashes.fileBytes },
        sha256Plain: hashes.sha256Plain,
        sha256File: hashes.sha256File,
        master: cfg.master,
        verify: { status: 'OK', at: finishedAt.toISOString(), durationMs: v.durationMs },
      }),
      cfg.master
    );
    await writeJsonAtomic(path.join(l.backups, manifestNameFor(fileName)), manifest);
    if (db) await store.updateBackup(db, id, rowFromManifest(manifest, { status: 'READY' }));
    return { id, fileName, file: finalPath, manifest };
  } catch (err) {
    if (writer) writer.abort();
    if (inTx) await data.exec('ROLLBACK').catch(() => {});
    await fs.promises.unlink(partial).catch(() => {});
    if (db) {
      await store
        .updateBackup(db, id, { status: 'FAILED', finishedAt: now(), durationMs: now().getTime() - startedAt.getTime(), error: sanitizeError(err), verifyStatus: err?.code === 'VERIFY_FAILED' ? 'FAILED' : 'PENDING', verifyError: err?.code === 'VERIFY_FAILED' ? sanitizeError(err) : null })
        .catch(() => {});
    }
    err.backupId = id;
    throw err;
  }
}

/** Catalog row fields from a signed manifest (used on publish and by reconcile). */
export function rowFromManifest(m, extra = {}) {
  return {
    fileName: m.fileName,
    kind: m.kind,
    engine: m.engine || 'node',
    startedAt: new Date(m.startedAt),
    finishedAt: new Date(m.finishedAt),
    durationMs: m.durationMs,
    sizeBytes: m.totals?.fileBytes ?? null,
    plainBytes: m.totals?.plainBytes ?? null,
    tableCount: m.totals?.tables ?? null,
    totalRows: m.totals?.rows ?? null,
    rowCounts: Object.fromEntries((m.tables || []).map((t) => [t.name, t.rows])),
    sha256File: m.sha256File || null,
    latestMigration: m.migrations?.latest || null,
    migrationCount: m.migrations?.count ?? null,
    appVersion: m.app?.version || null,
    verifyStatus: m.verify?.status === 'OK' ? 'OK' : 'PENDING',
    verifiedAt: m.verify?.at ? new Date(m.verify.at) : null,
    ...extra,
  };
}
