/**
 * Raw SQL over the four preserved tables (osbackup, osbackupjob, osbackupchallenge, osbackupstate).
 * One code path for the app (Prisma raw: prismaSql) and the detached worker / CLI (mysql2: mysqlSql), so the worker
 * never needs the pooled Prisma client during a restore. Times are written as UTC (UTC_TIMESTAMP(3) / JS Dates),
 * like every Prisma DateTime. Column names are whitelisted; values always go in as parameters.
 */
import crypto from 'crypto';

export function prismaSql(prisma) {
  return {
    q: (sql, params = []) => prisma.$queryRawUnsafe(sql, ...params),
    x: async (sql, params = []) => Number(await prisma.$executeRawUnsafe(sql, ...params)),
  };
}

export function mysqlSql(conn) {
  return {
    q: async (sql, params = []) => (await conn.query(sql, params))[0],
    x: async (sql, params = []) => Number((await conn.query(sql, params))[0]?.affectedRows ?? 0),
  };
}

const COLS = {
  osbackup: ['id', 'fileName', 'kind', 'status', 'engine', 'startedAt', 'finishedAt', 'durationMs', 'sizeBytes', 'plainBytes', 'tableCount', 'totalRows', 'rowCounts', 'sha256File', 'latestMigration', 'migrationCount', 'appVersion', 'verifyStatus', 'verifiedAt', 'verifyError', 'error', 'createdById', 'createdByEmail', 'safetyForJobId', 'prunedAt', 'createdAt'],
  osbackupjob: ['id', 'type', 'trigger', 'status', 'phase', 'progress', 'backupId', 'safetyBackupId', 'requestedById', 'requestedByEmail', 'workerPid', 'workerHost', 'heartbeatAt', 'startedAt', 'finishedAt', 'error', 'createdAt'],
  osbackupchallenge: ['id', 'userId', 'email', 'action', 'backupId', 'codeHash', 'expiresAt', 'attempts', 'sendCount', 'lastSentAt', 'consumedAt', 'invalidatedAt', 'ip', 'userAgent', 'downloadTicketHash', 'ticketExpiresAt', 'createdAt'],
  osbackupstate: ['id', 'schedulePaused', 'pausedById', 'pausedAt', 'lockJobId', 'lockedAt', 'heartbeatAt', 'consecutiveFailures', 'lastSuccessAt', 'lastFailureAt', 'lastError', 'lastFailureAlertAt', 'lastDiskAlertAt', 'lastStaleAlertAt', 'maintenanceJobId', 'detectJson', 'detectedAt', 'updatedAt'],
};
const JSON_COLS = new Set(['rowCounts', 'progress', 'detectJson']);
const BOOL_COLS = new Set(['schedulePaused']);
const NUM_COLS = new Set(['sizeBytes', 'plainBytes', 'totalRows', 'durationMs', 'tableCount', 'migrationCount', 'workerPid', 'attempts', 'sendCount', 'consecutiveFailures', 'id_int']);

const q = (c) => `\`${c}\``;

function toDb(col, v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (JSON_COLS.has(col)) return JSON.stringify(v);
  if (BOOL_COLS.has(col)) return v ? 1 : 0;
  if (typeof v === 'bigint') return v.toString();
  return v;
}

export function fromDb(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) out[k] = null;
    else if (JSON_COLS.has(k)) out[k] = typeof v === 'string' ? safeParse(v) : Buffer.isBuffer(v) ? safeParse(v.toString('utf8')) : v;
    else if (BOOL_COLS.has(k)) out[k] = v === true || Number(v) === 1;
    else if (typeof v === 'bigint') out[k] = Number(v);
    else if (NUM_COLS.has(k) && typeof v === 'string') out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function setClause(table, fields) {
  const cols = Object.keys(fields).filter((c) => fields[c] !== undefined);
  for (const c of cols) if (!COLS[table].includes(c)) throw new Error(`Unknown column ${table}.${c}`);
  return { sql: cols.map((c) => `${q(c)} = ?`).join(', '), params: cols.map((c) => toDb(c, fields[c])) };
}

async function insert(db, table, row) {
  const cols = Object.keys(row).filter((c) => row[c] !== undefined);
  for (const c of cols) if (!COLS[table].includes(c)) throw new Error(`Unknown column ${table}.${c}`);
  await db.x(`INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => toDb(c, row[c])));
}

export const newId = () => crypto.randomUUID();

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function getState(db) {
  const rows = await db.q('SELECT * FROM `osbackupstate` WHERE `id` = 1');
  if (rows?.[0]) return fromDb(rows[0]);
  await db.x('INSERT IGNORE INTO `osbackupstate` (`id`, `schedulePaused`, `consecutiveFailures`, `updatedAt`) VALUES (1, 0, 0, UTC_TIMESTAMP(3))');
  return fromDb((await db.q('SELECT * FROM `osbackupstate` WHERE `id` = 1'))[0]);
}

export async function updateState(db, fields) {
  const { sql, params } = setClause('osbackupstate', fields);
  if (!sql) return 0;
  return db.x(`UPDATE \`osbackupstate\` SET ${sql}, \`updatedAt\` = UTC_TIMESTAMP(3) WHERE \`id\` = 1`, params);
}

/** Lock row CAS (plan e.2): free, or the holder's heartbeat is older than `staleMinutes`. */
export async function acquireLockRow(db, jobId, staleMinutes = 10) {
  await getState(db);
  return db.x(
    `UPDATE \`osbackupstate\` SET \`lockJobId\` = ?, \`lockedAt\` = UTC_TIMESTAMP(3), \`heartbeatAt\` = UTC_TIMESTAMP(3), \`updatedAt\` = UTC_TIMESTAMP(3)
     WHERE \`id\` = 1 AND (\`lockJobId\` IS NULL OR \`lockJobId\` = ? OR \`heartbeatAt\` IS NULL OR \`heartbeatAt\` < UTC_TIMESTAMP(3) - INTERVAL ${Number(staleMinutes) | 0} MINUTE)`,
    [jobId, jobId]
  );
}
export async function heartbeatLockRow(db, jobId) {
  return db.x('UPDATE `osbackupstate` SET `heartbeatAt` = UTC_TIMESTAMP(3) WHERE `id` = 1 AND `lockJobId` = ?', [jobId]);
}
export async function releaseLockRow(db, jobId) {
  return db.x('UPDATE `osbackupstate` SET `lockJobId` = NULL, `lockedAt` = NULL, `updatedAt` = UTC_TIMESTAMP(3) WHERE `id` = 1 AND `lockJobId` = ?', [jobId]);
}
export async function forceReleaseLockRow(db) {
  return db.x('UPDATE `osbackupstate` SET `lockJobId` = NULL, `lockedAt` = NULL, `updatedAt` = UTC_TIMESTAMP(3) WHERE `id` = 1');
}

// ── jobs ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function insertJob(db, job) {
  const row = { id: job.id || newId(), status: 'QUEUED', createdAt: new Date(), ...job };
  await insert(db, 'osbackupjob', row);
  return row;
}
export async function updateJob(db, id, fields) {
  const { sql, params } = setClause('osbackupjob', fields);
  if (!sql) return 0;
  return db.x(`UPDATE \`osbackupjob\` SET ${sql} WHERE \`id\` = ?`, [...params, id]);
}
export async function getJob(db, id) {
  return fromDb((await db.q('SELECT * FROM `osbackupjob` WHERE `id` = ?', [id]))[0]);
}
export async function activeJobs(db) {
  return (await db.q("SELECT * FROM `osbackupjob` WHERE `status` IN ('QUEUED', 'RUNNING') ORDER BY `createdAt` DESC LIMIT 20")).map(fromDb);
}
export async function recentJobs(db, limit = 20) {
  return (await db.q(`SELECT * FROM \`osbackupjob\` ORDER BY \`createdAt\` DESC LIMIT ${Number(limit) | 0}`)).map(fromDb);
}

// ── catalog ──────────────────────────────────────────────────────────────────────────────────────────────────────
export async function insertBackup(db, row) {
  const r = { id: row.id || newId(), createdAt: new Date(), ...row };
  await insert(db, 'osbackup', r);
  return r;
}
export async function updateBackup(db, id, fields) {
  const { sql, params } = setClause('osbackup', fields);
  if (!sql) return 0;
  return db.x(`UPDATE \`osbackup\` SET ${sql} WHERE \`id\` = ?`, [...params, id]);
}
export async function getBackup(db, id) {
  return fromDb((await db.q('SELECT * FROM `osbackup` WHERE `id` = ?', [id]))[0]);
}
export async function getBackupByFile(db, fileName) {
  return fromDb((await db.q('SELECT * FROM `osbackup` WHERE `fileName` = ?', [fileName]))[0]);
}
export async function listBackups(db, { includePruned = false, limit = 200 } = {}) {
  const where = includePruned ? '' : "WHERE `status` <> 'PRUNED'";
  return (await db.q(`SELECT * FROM \`osbackup\` ${where} ORDER BY \`startedAt\` DESC LIMIT ${Number(limit) | 0}`)).map(fromDb);
}
export async function deleteOldBackupRows(db, before) {
  return db.x("DELETE FROM `osbackup` WHERE `status` IN ('PRUNED', 'FAILED', 'MISSING') AND `createdAt` < ? LIMIT 1000", [before]);
}
export async function deleteOldJobRows(db, before) {
  return db.x("DELETE FROM `osbackupjob` WHERE `status` NOT IN ('QUEUED', 'RUNNING') AND `createdAt` < ? LIMIT 1000", [before]);
}

// ── challenges (OTP) ─────────────────────────────────────────────────────────────────────────────────────────────
export async function insertChallenge(db, row) {
  await insert(db, 'osbackupchallenge', row);
  return row;
}
export async function getChallenge(db, id) {
  return fromDb((await db.q('SELECT * FROM `osbackupchallenge` WHERE `id` = ?', [id]))[0]);
}
export async function countChallengesSince(db, userId, since) {
  const r = await db.q('SELECT COUNT(*) AS n FROM `osbackupchallenge` WHERE `userId` = ? AND `createdAt` >= ?', [userId, since]);
  return Number(r?.[0]?.n) || 0;
}
export async function invalidateOpenChallenges(db, userId, action, now) {
  return db.x('UPDATE `osbackupchallenge` SET `invalidatedAt` = ? WHERE `userId` = ? AND `action` = ? AND `consumedAt` IS NULL AND `invalidatedAt` IS NULL', [now, userId, action]);
}
/** Step 1 of verify: count the attempt only while the challenge is open, bound and under 5 attempts. */
export async function bumpChallengeAttempt(db, { id, userId, action, backupId, now, maxAttempts }) {
  return db.x(
    'UPDATE `osbackupchallenge` SET `attempts` = `attempts` + 1 WHERE `id` = ? AND `userId` = ? AND `action` = ? AND `backupId` = ? AND `consumedAt` IS NULL AND `invalidatedAt` IS NULL AND `expiresAt` > ? AND `attempts` < ?',
    [id, userId, action, backupId, now, maxAttempts]
  );
}
export async function consumeChallenge(db, id, now) {
  return db.x('UPDATE `osbackupchallenge` SET `consumedAt` = ? WHERE `id` = ? AND `consumedAt` IS NULL AND `invalidatedAt` IS NULL', [now, id]);
}
export async function resendChallengeRow(db, { id, userId, codeHash, now, expiresAt, maxSends, minGapMs }) {
  return db.x(
    'UPDATE `osbackupchallenge` SET `codeHash` = ?, `sendCount` = `sendCount` + 1, `lastSentAt` = ?, `expiresAt` = ? WHERE `id` = ? AND `userId` = ? AND `consumedAt` IS NULL AND `invalidatedAt` IS NULL AND `sendCount` < ? AND `lastSentAt` <= ? AND `attempts` < 5',
    [codeHash, now, expiresAt, id, userId, maxSends, new Date(now.getTime() - minGapMs)]
  );
}
export async function setDownloadTicket(db, id, ticketHash, expiresAt) {
  return db.x('UPDATE `osbackupchallenge` SET `downloadTicketHash` = ?, `ticketExpiresAt` = ? WHERE `id` = ? AND `action` = \'DOWNLOAD\' AND `consumedAt` IS NOT NULL', [ticketHash, expiresAt, id]);
}
export async function findTicket(db, ticketHash) {
  return fromDb((await db.q("SELECT * FROM `osbackupchallenge` WHERE `downloadTicketHash` = ? AND `action` = 'DOWNLOAD' LIMIT 1", [ticketHash]))[0]);
}
/** Single use: clears the hash only while it is still valid. */
export async function consumeTicket(db, ticketHash, now) {
  return db.x("UPDATE `osbackupchallenge` SET `downloadTicketHash` = NULL WHERE `downloadTicketHash` = ? AND `action` = 'DOWNLOAD' AND `ticketExpiresAt` > ?", [ticketHash, now]);
}
export async function purgeOldChallenges(db, before) {
  return db.x('DELETE FROM `osbackupchallenge` WHERE `createdAt` < ? LIMIT 1000', [before]);
}

// ── other tables read by the feature (only while the DB is whole) ───────────────────────────────────────────────────
export async function activeOwners(db) {
  const rows = await db.q("SELECT `id`, `email`, `name` FROM `user` WHERE `role` = 'OWNER' AND `isActive` = 1 AND `isAgent` = 0");
  return rows.map((r) => ({ id: String(r.id), email: String(r.email), name: r.name ? String(r.name) : '' }));
}
export async function agencyBranding(db) {
  try {
    const rows = await db.q('SELECT `agencyName`, `logoUrl`, `emailPrimaryColor`, `emailHeaderHtml`, `emailFooterHtml`, `emailFooterText`, `copyrightText`, `address` FROM `agency_setting` LIMIT 1');
    return rows?.[0] ? { ...rows[0] } : null;
  } catch {
    return null;
  }
}
export async function appliedMigrations(db) {
  const rows = await db.q('SELECT `migration_name` AS name FROM `_prisma_migrations` WHERE `finished_at` IS NOT NULL AND `rolled_back_at` IS NULL ORDER BY `migration_name`');
  return rows.map((r) => String(r.name));
}
