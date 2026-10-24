/**
 * OS Backups routes (docs/ledger/features/os-backups.md, plan h), prefix /api/admin. Every route is HUMAN_ONLY:
 * request.viaMcp → 403, API tokens / agents / non-owners → 403 (guards.js), and the whole prefix is on the API-token
 * denylist and (once the MCP branch merges) the MCP BLOCKED list. State-changing routes also check Origin.
 * The restore status and maintenance/clear routes use the watch token (no session: the user table is in flux) and are
 * exempt from the maintenance gate. Downloads stream the ENCRYPTED .lwbk only, behind password + OTP + ticket.
 */
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { loadConfig, decryptKeys, featureProblem } from '../../lib/osBackup/config.js';
import * as store from '../../lib/osBackup/store.js';
import { humanOnly, requireHumanOwner, requireSameOrigin, denyViaMcp } from '../../lib/osBackup/guards.js';
import { lockHeld } from '../../lib/osBackup/lock.js';
import { layout, readJobFile, writeJobFile, appendJournal, spawnWorker, assertJobId, readJournal } from '../../lib/osBackup/jobs.js';
import { manifestNameFor, readManifest, verifyManifestHmac, isBackupFileName } from '../../lib/osBackup/manifest.js';
import { compareSchema, listCodeMigrations, dbHasAllMigrations } from '../../lib/osBackup/compat.js';
import { statDir, dirUsage, diskView, checkDiskSpace } from '../../lib/osBackup/disk.js';
import { isMaintenance, readMaintenance, clearMaintenance, setMaintenanceDir } from '../../lib/osBackup/maintenance.js';
import { startJob } from '../../lib/osBackup/scheduler.js';
import { createChallenge, verifyChallenge, resendChallenge, attemptsLeft, mintWatchToken, verifyWatchToken, OtpError, newTicket, ticketHash, TICKET_TTL_MS, OTP_TTL_MS, RESEND_GAP_MS } from '../../lib/osBackup/otp.js';
import { sendTemplate, osBackupsUrl } from '../../lib/osBackup/emails.js';

export const MAX_LOSS_TEXT = 'Up to 4 hours of changes can be lost. Backups are stored only on this server; download an encrypted copy to keep one elsewhere.';
const SERVER_ONLY_TEXT =
  'Backups are stored only on this server. If the server, the hosting account or its disk is lost, compromised or deleted, every backup is lost with it. Encryption protects downloaded or copied files, not a compromised server, because the key sits on the same server in .env.';

/** Next run for the simple cron shapes we use (minute + hour list, every-n-hours or every hour; day fields "*"). Server local time. */
export function nextRunFromCron(expr, now = new Date()) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5 || f[2] !== '*' || f[3] !== '*' || f[4] !== '*' || !/^\d+$/.test(f[0])) return null;
  const minute = Number(f[0]);
  let hours;
  if (f[1] === '*') hours = Array.from({ length: 24 }, (_, i) => i);
  else if (/^\*\/\d+$/.test(f[1])) {
    const s = Number(f[1].slice(2));
    hours = Array.from({ length: 24 }, (_, i) => i).filter((h) => h % s === 0);
  } else if (/^\d+(,\d+)*$/.test(f[1])) hours = f[1].split(',').map(Number);
  else return null;
  for (let d = 0; d < 2; d += 1) {
    for (const h of [...hours].sort((a, b) => a - b)) {
      const t = new Date(now);
      t.setDate(t.getDate() + d);
      t.setHours(h, minute, 0, 0);
      if (t > now) return t;
    }
  }
  return null;
}

const passwordBody = z.object({ password: z.string().min(1).max(200) });
const confirmBody = z.object({
  challengeId: z.string().min(1).max(64),
  code: z.string().regex(/^\d{6}$/),
  confirmText: z.string(),
  acknowledgeOlderSchema: z.boolean().optional(),
  carryForwardCredentials: z.boolean().optional(),
});
const downloadBody = z.object({ challengeId: z.string().min(1).max(64), code: z.string().regex(/^\d{6}$/) });
const scheduleBody = z.object({ paused: z.boolean() });

export async function adminOsBackupRoutes(app, opts = {}) {
  const deps = {
    cfg: () => opts.cfg || loadConfig(),
    db: opts.db || store.prismaSql(prisma),
    spawn: opts.spawn || spawnWorker,
    send: opts.send,
    checkPassword:
      opts.checkPassword ||
      (async (userId, password) => {
        const u = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
        return !!u?.passwordHash && (await bcrypt.compare(password, u.passwordHash));
      }),
    owners: opts.owners || (() => store.activeOwners(deps.db)),
    codeMigrations: opts.codeMigrations || (() => listCodeMigrations()),
    dbMigrations: opts.dbMigrations || (() => store.appliedMigrations(deps.db)),
    now: opts.now || (() => new Date()),
  };
  const { db } = deps;
  setMaintenanceDir(deps.cfg().dir);
  const owner = { onRequest: [humanOnly, app.verifyJwt, requireHumanOwner] };
  const ownerWrite = { onRequest: [humanOnly, app.verifyJwt, requireHumanOwner, requireSameOrigin] };
  const limit = (max, timeWindow) => ({ config: { rateLimit: { max, timeWindow } } });
  const mail = (name, data, to) => sendTemplate(name, data, to, deps.send ? { send: deps.send } : {}).catch(() => 0);

  const manifestCache = new Map();
  async function manifestFor(cfg, b) {
    if (!b?.fileName || !isBackupFileName(b.fileName)) return null;
    if (manifestCache.has(b.fileName)) return manifestCache.get(b.fileName);
    try {
      const m = await readManifest(path.join(layout(cfg.dir).backups, manifestNameFor(b.fileName)));
      const ok = verifyManifestHmac(m, decryptKeys(cfg));
      const v = ok ? m : { invalid: true };
      manifestCache.set(b.fileName, v);
      return v;
    } catch {
      return null;
    }
  }
  const fileOf = (cfg, b) => path.join(layout(cfg.dir).backups, b.fileName);

  function serializeBackup(cfg, b, m, code) {
    const compat = m && !m.invalid ? compareSchema(m.migrations?.names || [], code) : { status: 'UNKNOWN', missingMigrations: [], unknownMigrations: [] };
    return {
      id: b.id,
      fileName: b.fileName,
      kind: b.kind,
      status: b.status,
      engine: b.engine,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      durationMs: b.durationMs,
      sizeBytes: b.sizeBytes,
      plainBytes: b.plainBytes,
      tableCount: b.tableCount,
      totalRows: b.totalRows,
      rowCounts: b.rowCounts || {},
      verifyStatus: m?.invalid ? 'FAILED' : b.verifyStatus,
      verifiedAt: b.verifiedAt,
      verifyError: m?.invalid ? 'Manifest signature does not match' : b.verifyError,
      latestMigration: b.latestMigration,
      migrationCount: b.migrationCount,
      createdByEmail: b.createdByEmail,
      error: b.error,
      compat: { status: compat.status, missingMigrations: compat.missingMigrations.length, unknownMigrations: compat.unknownMigrations.length },
      fileOnDisk: b.status === 'READY' ? fs.existsSync(fileOf(cfg, b)) : false,
      warnings: m && !m.invalid ? m.warnings || [] : [],
    };
  }

  async function loadReadyBackup(cfg, backupId) {
    const b = await store.getBackup(db, backupId);
    if (!b || b.status !== 'READY') return { error: [404, 'Backup not found or not ready'] };
    if (b.verifyStatus !== 'OK') return { error: [409, 'This backup has not been verified'] };
    if (!fs.existsSync(fileOf(cfg, b))) return { error: [409, 'The backup file is missing on disk'] };
    const m = await manifestFor(cfg, b);
    if (!m || m.invalid) return { error: [409, 'The backup manifest is missing or its signature does not match'] };
    return { backup: b, manifest: m };
  }

  const clientIp = (request) => String(request.ip || '').slice(0, 64);
  const ua = (request) => String(request.headers['user-agent'] || '').slice(0, 255);
  const otpFail = (reply, err) => {
    if (err instanceof OtpError) return reply.status(err.status).send({ code: err.code, message: err.message });
    throw err;
  };

  // ── list + status card ──
  app.get('/os-backups', owner, async () => {
    const cfg = deps.cfg();
    const state = await store.getState(db);
    const rows = await store.listBackups(db, { limit: 200 });
    const code = deps.codeMigrations();
    const backups = [];
    for (const b of rows) backups.push(serializeBackup(cfg, b, b.status === 'READY' ? await manifestFor(cfg, b) : null, code));
    const stat = await statDir(cfg.dir);
    const usedBytes = await dirUsage(cfg.dir);
    const ready = rows.filter((b) => b.status === 'READY');
    const disk = diskView({ stat, usedBytes, readySizes: ready.map((b) => Number(b.sizeBytes) || 0), retentionDays: cfg.retentionDays });
    const diskCheck = checkDiskSpace({ freeBytes: stat.freeBytes, lastFileBytes: Number(ready[0]?.sizeBytes) || 0, minFreeMb: cfg.minFreeMb, quotaMb: cfg.quotaMb, usedBytes });
    const now = deps.now();
    const newestReady = ready[0] ? new Date(ready[0].startedAt) : null;
    const active = (await store.activeJobs(db))[0] || null;
    const detect = state.detectJson || null;
    return {
      status: {
        enabled: cfg.enabled,
        keyOk: cfg.keyOk,
        keyError: cfg.keyOk ? null : cfg.keyError,
        problem: featureProblem(cfg),
        dir: cfg.dir,
        engine: cfg.engine,
        engineRequested: cfg.engineRequested,
        cron: cfg.cron,
        nextRunAt: cfg.enabled && !state.schedulePaused ? nextRunFromCron(cfg.cron, now) : null,
        retentionDays: cfg.retentionDays,
        schedulePaused: !!state.schedulePaused,
        pausedAt: state.pausedAt,
        lastSuccessAt: state.lastSuccessAt,
        lastFailureAt: state.lastFailureAt,
        lastError: state.lastError,
        consecutiveFailures: state.consecutiveFailures || 0,
        maintenance: readMaintenance(cfg.dir),
        locked: lockHeld(state, now),
        activeJob: active ? { id: active.id, type: active.type, status: active.status, phase: active.phase, progress: active.progress, createdAt: active.createdAt } : null,
        detect: detect
          ? {
              at: detect.at,
              exec: detect.binaries?.exec,
              mysqldump: detect.binaries?.mysqldump?.ok ? detect.binaries.mysqldump.version : null,
              server: detect.server ? { version: detect.server.version, maxAllowedPacket: detect.server.maxAllowedPacket, getLock: detect.server.getLock, tableCount: detect.server.tableCount, totalBytes: detect.server.totalBytes, nonInnoDb: detect.server.nonInnoDb } : null,
              dirProblems: detect.dir?.problems || [],
            }
          : null,
        disk,
        diskOk: diskCheck.ok,
        stale: !newestReady || now - newestReady > cfg.staleHours * 3_600_000,
        maxLossText: MAX_LOSS_TEXT,
        serverOnlyText: SERVER_ONLY_TEXT,
        codeMigrations: { count: code.length, latest: code[code.length - 1] || null },
      },
      backups,
      journal: readJournal(cfg.dir, 20),
    };
  });

  app.get('/os-backups/jobs/:jobId', owner, async (request, reply) => {
    const job = await store.getJob(db, String(request.params.jobId));
    if (!job) return reply.status(404).send({ message: 'Job not found' });
    return { id: job.id, type: job.type, trigger: job.trigger, status: job.status, phase: job.phase, progress: job.progress, backupId: job.backupId, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt, createdAt: job.createdAt };
  });

  app.post('/os-backups/run', { ...ownerWrite, ...limit(3, '10 minutes') }, async (request, reply) => {
    const cfg = deps.cfg();
    const problem = featureProblem(cfg);
    if (problem) return reply.status(409).send({ code: 'DISABLED', message: problem });
    if (isMaintenance()) return reply.status(409).send({ code: 'MAINTENANCE', message: 'Maintenance is on' });
    const state = await store.getState(db);
    if (lockHeld(state, deps.now()) || (await store.activeJobs(db)).length) return reply.status(409).send({ code: 'LOCKED', message: 'A backup or restore is already running' });
    const job = await startJob({ db, cfg, type: 'BACKUP', trigger: 'MANUAL', user: request.user, spawn: deps.spawn });
    return reply.status(202).send({ jobId: job.id });
  });

  app.post('/os-backups/schedule', ownerWrite, async (request, reply) => {
    const parsed = scheduleBody.safeParse(request.body || {});
    if (!parsed.success) return reply.status(400).send({ message: 'Validation failed', errors: parsed.error.flatten() });
    const cfg = deps.cfg();
    const now = deps.now();
    const { paused } = parsed.data;
    await store.updateState(db, { schedulePaused: paused, pausedById: paused ? request.user.id : null, pausedAt: paused ? now : null });
    appendJournal(cfg.dir, { event: paused ? 'schedule.paused' : 'schedule.resumed', actorId: request.user.id, actorEmail: request.user.email, paused });
    const others = (await deps.owners()).filter((o) => o.id !== request.user.id);
    await mail('scheduleChanged', { paused, actorEmail: request.user.email, at: now, actionUrl: osBackupsUrl() }, others);
    return { schedulePaused: paused };
  });

  // ── restore: request (password) → OTP email → confirm (code + RESTORE) → job + watch token ──
  app.post('/os-backups/:backupId/restore/request', { ...ownerWrite, ...limit(5, '15 minutes') }, async (request, reply) => {
    const cfg = deps.cfg();
    const problem = featureProblem(cfg);
    if (problem) return reply.status(409).send({ code: 'DISABLED', message: problem });
    const parsed = passwordBody.safeParse(request.body || {});
    if (!parsed.success) return reply.status(400).send({ message: 'Validation failed', errors: parsed.error.flatten() });
    if (!(await deps.checkPassword(request.user.id, parsed.data.password))) return reply.status(400).send({ code: 'BAD_PASSWORD', message: 'Current password is incorrect' });
    const r = await loadReadyBackup(cfg, String(request.params.backupId));
    if (r.error) return reply.status(r.error[0]).send({ message: r.error[1] });
    const compat = compareSchema(r.manifest.migrations?.names || [], deps.codeMigrations());
    if (compat.status === 'NEWER') return reply.status(409).send({ code: 'SCHEMA_NEWER', message: 'This backup was made by newer code. Deploy that code first.', compat });
    const stat = await statDir(cfg.dir);
    const disk = checkDiskSpace({ freeBytes: stat.freeBytes, nextFileBytes: Number(r.backup.sizeBytes) || 0, minFreeMb: cfg.minFreeMb, quotaMb: cfg.quotaMb, usedBytes: cfg.quotaMb ? await dirUsage(cfg.dir) : 0 });
    if (!disk.ok) return reply.status(409).send({ code: 'DISK_LOW', message: 'Not enough disk space for the safety backup' });
    const now = deps.now();
    let out;
    try {
      out = await createChallenge(db, { master: cfg.master, userId: request.user.id, email: request.user.email, action: 'RESTORE', backupId: r.backup.id, ip: clientIp(request), userAgent: ua(request), now });
    } catch (err) {
      return otpFail(reply, err);
    }
    await mail('restoreOtp', { code: out.code, backupAt: r.backup.startedAt, backupBytes: r.backup.sizeBytes, now }, [{ email: request.user.email, name: request.user.name }]);
    const others = (await deps.owners()).filter((o) => o.id !== request.user.id);
    await mail('restoreRequested', { actorEmail: request.user.email, actorName: request.user.name, backupAt: r.backup.startedAt, at: now, ip: clientIp(request), userAgent: ua(request), actionUrl: osBackupsUrl() }, others);
    appendJournal(cfg.dir, { event: 'restore.requested', backupId: r.backup.id, actorId: request.user.id, actorEmail: request.user.email, ip: clientIp(request), compat: compat.status });
    const backupMs = Number(r.backup.durationMs) || 60_000;
    return {
      challengeId: out.challenge.id,
      expiresAt: out.challenge.expiresAt,
      resendAfter: new Date(now.getTime() + RESEND_GAP_MS),
      attemptsLeft: 5,
      compat: { status: compat.status, missingMigrations: compat.missingMigrations },
      backup: { id: r.backup.id, startedAt: r.backup.startedAt, sizeBytes: r.backup.sizeBytes, tableCount: r.backup.tableCount, totalRows: r.backup.totalRows },
      // drain 15 s + safety backup (≈ one backup) + drop/load/verify (≈ 2 backups)
      estimatedMinutes: Math.max(1, Math.ceil((15_000 + backupMs * 3) / 60_000)),
    };
  });

  app.post('/os-backups/challenges/:id/resend', { ...ownerWrite, ...limit(5, '15 minutes') }, async (request, reply) => {
    const cfg = deps.cfg();
    if (!cfg.keyOk) return reply.status(409).send({ code: 'DISABLED', message: 'OS_BACKUP_ENCRYPTION_KEY is invalid' });
    let out;
    try {
      out = await resendChallenge(db, { master: cfg.master, id: String(request.params.id), userId: request.user.id, now: deps.now() });
    } catch (err) {
      return otpFail(reply, err);
    }
    const b = await store.getBackup(db, out.challenge.backupId);
    await mail(out.challenge.action === 'DOWNLOAD' ? 'downloadOtp' : 'restoreOtp', { code: out.code, backupAt: b?.startedAt, backupBytes: b?.sizeBytes, now: deps.now() }, [{ email: request.user.email, name: request.user.name }]);
    return { challengeId: out.challenge.id, expiresAt: new Date(deps.now().getTime() + OTP_TTL_MS), resendAfter: new Date(deps.now().getTime() + RESEND_GAP_MS), sendsLeft: Math.max(0, 3 - out.challenge.sendCount), attemptsLeft: attemptsLeft(out.challenge) };
  });

  app.post('/os-backups/:backupId/restore/confirm', { ...ownerWrite, ...limit(10, '15 minutes') }, async (request, reply) => {
    const cfg = deps.cfg();
    const problem = featureProblem(cfg);
    if (problem) return reply.status(409).send({ code: 'DISABLED', message: problem });
    const parsed = confirmBody.safeParse(request.body || {});
    if (!parsed.success) return reply.status(400).send({ message: 'Validation failed', errors: parsed.error.flatten() });
    const body = parsed.data;
    if (body.confirmText !== 'RESTORE') return reply.status(400).send({ code: 'CONFIRM_TEXT', message: 'Type RESTORE to confirm' });
    const r = await loadReadyBackup(cfg, String(request.params.backupId));
    if (r.error) return reply.status(r.error[0]).send({ message: r.error[1] });
    const compat = compareSchema(r.manifest.migrations?.names || [], deps.codeMigrations());
    if (compat.status === 'NEWER') return reply.status(409).send({ code: 'SCHEMA_NEWER', message: 'This backup was made by newer code. Deploy that code first.' });
    if (compat.status === 'OLDER' && body.acknowledgeOlderSchema !== true) return reply.status(400).send({ code: 'ACK_REQUIRED', message: 'This backup is older than the code: acknowledge the migration warning' });
    if (isMaintenance()) return reply.status(409).send({ code: 'MAINTENANCE', message: 'Maintenance is already on' });
    const state = await store.getState(db);
    if (lockHeld(state, deps.now()) || (await store.activeJobs(db)).length) return reply.status(409).send({ code: 'LOCKED', message: 'A backup or restore is already running' });
    try {
      await verifyChallenge(db, { master: cfg.master, id: body.challengeId, userId: request.user.id, action: 'RESTORE', backupId: r.backup.id, code: body.code, now: deps.now() });
    } catch (err) {
      const row = await store.getChallenge(db, body.challengeId).catch(() => null);
      if (err instanceof OtpError) return reply.status(400).send({ code: err.code, message: err.message, attemptsLeft: row && row.userId === request.user.id ? attemptsLeft(row) : 0 });
      throw err;
    }
    const job = await startJob({
      db,
      cfg,
      type: 'RESTORE',
      trigger: 'MANUAL',
      backupId: r.backup.id,
      user: request.user,
      options: { acknowledgeOlderSchema: body.acknowledgeOlderSchema === true, carryForwardCredentials: body.carryForwardCredentials !== false },
      spawn: deps.spawn,
      file: { backup: { id: r.backup.id, startedAt: r.backup.startedAt, fileName: r.backup.fileName, sizeBytes: r.backup.sizeBytes }, compat: { status: compat.status, missingMigrations: compat.missingMigrations } },
    });
    appendJournal(cfg.dir, { event: 'restore.confirmed', jobId: job.id, backupId: r.backup.id, actorId: request.user.id, actorEmail: request.user.email, ip: clientIp(request), compat: compat.status });
    return reply.status(202).send({ jobId: job.id, watchToken: mintWatchToken(cfg.master, { userId: request.user.id, jobId: job.id }) });
  });

  // ── watch-token routes (no session; maintenance-exempt; read the job file only) ──
  app.get('/os-backups/restore/:jobId/status', async (request, reply) => {
    if (denyViaMcp(request, reply)) return reply;
    const cfg = deps.cfg();
    let jobId;
    try {
      jobId = assertJobId(request.params.jobId);
    } catch {
      return reply.status(404).send({ message: 'Not found' });
    }
    if (!verifyWatchToken(cfg.master, request.headers['x-restore-watch'], jobId)) return reply.status(401).send({ message: 'Invalid or expired watch token' });
    const f = readJobFile(cfg.dir, jobId);
    if (!f) return reply.status(404).send({ message: 'Not found' });
    reply.header('Cache-Control', 'no-store');
    return {
      jobId,
      status: f.status,
      phase: f.phase,
      progress: f.progress ? { table: f.progress.table || null, i: f.progress.i ?? f.progress.tableIndex ?? null, n: f.progress.n ?? f.progress.tableCount ?? null, rows: f.progress.rows ?? null, bytes: f.progress.bytes ?? null, totalBytes: f.progress.totalBytes ?? null, phase: f.progress.phase || null, kind: f.progress.kind || null } : null,
      startedAt: f.startedAt || f.createdAt || null,
      finishedAt: f.finishedAt || null,
      heartbeatAt: f.heartbeatAt || null,
      backup: f.backup || null,
      safetyBackup: f.safetyBackup || null,
      compat: f.compat || null,
      missingMigrations: f.missingMigrations || f.compat?.missingMigrations || [],
      error: f.error || null,
      maintenance: !!readMaintenance(cfg.dir),
    };
  });

  app.post('/os-backups/maintenance/clear', async (request, reply) => {
    if (denyViaMcp(request, reply)) return reply;
    const cfg = deps.cfg();
    const m = readMaintenance(cfg.dir);
    if (!m) return { cleared: false, message: 'Maintenance is not on' };
    if (m.phase !== 'NEEDS_MIGRATION' || !m.jobId) return reply.status(409).send({ code: 'NOT_NEEDS_MIGRATION', message: 'Maintenance can only be cleared here after a restore that needs a migration' });
    const tokenJob = String(request.body?.jobId || '');
    if (tokenJob !== m.jobId || !verifyWatchToken(cfg.master, request.headers['x-restore-watch'], m.jobId)) return reply.status(401).send({ message: 'Invalid or expired watch token' });
    const check = dbHasAllMigrations(await deps.dbMigrations(), deps.codeMigrations());
    if (!check.ok) return reply.status(409).send({ code: 'MIGRATIONS_MISSING', message: `Run "cd ~/LW && npx prisma migrate deploy" first: ${check.missing.length} migration(s) are not applied`, missing: check.missing });
    clearMaintenance(cfg.dir);
    await store.updateState(db, { maintenanceJobId: null });
    await store.updateJob(db, m.jobId, { phase: 'DONE' }).catch(() => {});
    writeJobFile(cfg.dir, m.jobId, { phase: 'DONE', migrationConfirmedAt: new Date().toISOString() });
    appendJournal(cfg.dir, { event: 'maintenance.cleared_after_migration', jobId: m.jobId });
    return { cleared: true };
  });

  // ── download: password → OTP → ticket (60 s, single use) → encrypted file stream ──
  app.post('/os-backups/:backupId/download/request', { ...ownerWrite, ...limit(5, '15 minutes') }, async (request, reply) => {
    const cfg = deps.cfg();
    if (!cfg.keyOk) return reply.status(409).send({ code: 'DISABLED', message: 'OS_BACKUP_ENCRYPTION_KEY is invalid' });
    const parsed = passwordBody.safeParse(request.body || {});
    if (!parsed.success) return reply.status(400).send({ message: 'Validation failed', errors: parsed.error.flatten() });
    if (!(await deps.checkPassword(request.user.id, parsed.data.password))) return reply.status(400).send({ code: 'BAD_PASSWORD', message: 'Current password is incorrect' });
    const r = await loadReadyBackup(cfg, String(request.params.backupId));
    if (r.error) return reply.status(r.error[0]).send({ message: r.error[1] });
    let out;
    try {
      out = await createChallenge(db, { master: cfg.master, userId: request.user.id, email: request.user.email, action: 'DOWNLOAD', backupId: r.backup.id, ip: clientIp(request), userAgent: ua(request), now: deps.now() });
    } catch (err) {
      return otpFail(reply, err);
    }
    await mail('downloadOtp', { code: out.code, backupAt: r.backup.startedAt, backupBytes: r.backup.sizeBytes }, [{ email: request.user.email, name: request.user.name }]);
    appendJournal(cfg.dir, { event: 'download.requested', backupId: r.backup.id, actorId: request.user.id, actorEmail: request.user.email, ip: clientIp(request) });
    return { challengeId: out.challenge.id, expiresAt: out.challenge.expiresAt, resendAfter: new Date(deps.now().getTime() + RESEND_GAP_MS), attemptsLeft: 5 };
  });

  app.post('/os-backups/:backupId/download', { ...ownerWrite, ...limit(10, '15 minutes') }, async (request, reply) => {
    const cfg = deps.cfg();
    if (!cfg.keyOk) return reply.status(409).send({ code: 'DISABLED', message: 'OS_BACKUP_ENCRYPTION_KEY is invalid' });
    const parsed = downloadBody.safeParse(request.body || {});
    if (!parsed.success) return reply.status(400).send({ message: 'Validation failed', errors: parsed.error.flatten() });
    const r = await loadReadyBackup(cfg, String(request.params.backupId));
    if (r.error) return reply.status(r.error[0]).send({ message: r.error[1] });
    const now = deps.now();
    try {
      await verifyChallenge(db, { master: cfg.master, id: parsed.data.challengeId, userId: request.user.id, action: 'DOWNLOAD', backupId: r.backup.id, code: parsed.data.code, now });
    } catch (err) {
      const row = await store.getChallenge(db, parsed.data.challengeId).catch(() => null);
      if (err instanceof OtpError) return reply.status(400).send({ code: err.code, message: err.message, attemptsLeft: row && row.userId === request.user.id ? attemptsLeft(row) : 0 });
      throw err;
    }
    const ticket = newTicket();
    await store.setDownloadTicket(db, parsed.data.challengeId, ticketHash(ticket), new Date(now.getTime() + TICKET_TTL_MS));
    appendJournal(cfg.dir, { event: 'download.ticket', backupId: r.backup.id, actorId: request.user.id, actorEmail: request.user.email, ip: clientIp(request) });
    const others = (await deps.owners()).filter((o) => o.id !== request.user.id);
    await mail('downloadAlert', { actorEmail: request.user.email, backupAt: r.backup.startedAt, backupBytes: r.backup.sizeBytes, at: now, ip: clientIp(request), actionUrl: osBackupsUrl() }, others);
    return { ticket, expiresAt: new Date(now.getTime() + TICKET_TTL_MS), fileName: r.backup.fileName };
  });

  app.get('/os-backups/download/:ticket', async (request, reply) => {
    if (denyViaMcp(request, reply)) return reply;
    const cfg = deps.cfg();
    const t = String(request.params.ticket || '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(t)) return reply.status(404).send({ message: 'Not found' });
    const h = ticketHash(t);
    const ch = await store.findTicket(db, h);
    if (!ch || (await store.consumeTicket(db, h, deps.now())) !== 1) return reply.status(404).send({ message: 'Download link expired. Request a new code.' });
    const b = await store.getBackup(db, ch.backupId);
    if (!b || b.status !== 'READY' || !isBackupFileName(b.fileName)) return reply.status(404).send({ message: 'Not found' });
    const file = fileOf(cfg, b);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return reply.status(404).send({ message: 'Not found' });
    }
    appendJournal(cfg.dir, { event: 'download.streamed', backupId: b.id, actorId: ch.userId, actorEmail: ch.email, ip: clientIp(request), bytes: size });
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${b.fileName}"`)
      .header('Content-Length', String(size))
      .header('Cache-Control', 'no-store');
    return reply.send(fs.createReadStream(file));
  });
}
