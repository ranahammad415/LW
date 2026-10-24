/**
 * OS Backups routes with Fastify inject: guards (non-owner, API token, agent, viaMcp), request → OTP → confirm,
 * wrong code, older-schema acknowledgement, watch token (and verifyJwt rejecting it), Origin check, download ticket.
 * Store = memStore (vi.mock); no DB, no worker (spawn is faked), no email (send is faked and captures the codes).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Fastify from 'fastify';

if (!process.env.JWT_ACCESS_SECRET || process.env.JWT_ACCESS_SECRET.length < 32) process.env.JWT_ACCESS_SECRET = 'unit-test-access-secret-0123456789abcdef';
process.env.FRONTEND_URL = 'https://app.example.io';

vi.mock('../../../src/lib/osBackup/store.js', async () => (await import('./memStore.js')).makeMemStore());
// No DB at all: the email layout's branding read and verifyJwt's user lookup hit this stub.
vi.mock('../../../src/lib/prisma.js', () => ({ prisma: { agencySetting: { findFirst: async () => null }, user: { findUnique: async () => null } } }));

const store = await import('../../../src/lib/osBackup/store.js');
const { adminOsBackupRoutes } = await import('../../../src/routes/admin/osBackups.js');
const { loadConfig } = await import('../../../src/lib/osBackup/config.js');
const { signManifest } = await import('../../../src/lib/osBackup/manifest.js');
const { setMaintenanceDir, clearMaintenance, writeMaintenance } = await import('../../../src/lib/osBackup/maintenance.js');
const { verifyJwt } = await import('../../../src/lib/verifyJwt.js');

const KEY = crypto.randomBytes(32);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwos-routes-'));
const cfg = loadConfig({ OS_BACKUP_ENABLED: 'true', OS_BACKUP_ENCRYPTION_KEY: KEY.toString('base64'), OS_BACKUP_DIR: dir });
const CODE = ['20261110_ghl_forms', '20261115_os_backups'];
const OWNER = { id: 'owner-1', email: 'o1@x.io', name: 'O1', role: 'OWNER', isAgent: false };
const OTHER = { id: 'owner-2', email: 'o2@x.io', name: 'O2' };
const sent = [];
const spawned = [];
let app;

function addBackup(id, migrations, fileName = `lwos-20261115T085000Z-sched-${id.slice(0, 8)}.lwbk`) {
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backups', fileName), Buffer.from('LWOSBAK1 encrypted bytes'));
  const m = signManifest({ id, fileName, kind: 'SCHEDULED', database: 'lw', startedAt: '2026-11-15T08:50:00.000Z', migrations: { names: migrations, count: migrations.length, latest: migrations.at(-1) }, tables: [], totals: { fileBytes: 24 } }, KEY);
  fs.writeFileSync(path.join(dir, 'backups', fileName.replace(/\.lwbk$/, '.manifest.json')), JSON.stringify(m));
  store.__t.backups.set(id, { id, fileName, kind: 'SCHEDULED', status: 'READY', verifyStatus: 'OK', startedAt: new Date('2026-11-15T08:50:00Z'), sizeBytes: 24, durationMs: 30_000, tableCount: 0, totalRows: 0 });
}

const auth = (over = {}) => ({ 'x-test-auth': JSON.stringify({ user: OWNER, authMethod: 'jwt', ...over }) });
const write = (over = {}) => ({ ...auth(over), origin: 'https://app.example.io' });
const lastCode = (to = OWNER.email) => [...sent].reverse().find((m) => m.to === to && /code/i.test(m.subject))?.text.match(/\b(\d{6})\b/)[1];

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  app.decorate('verifyJwt', async (request, reply) => {
    const raw = request.headers['x-test-auth'];
    if (!raw) return reply.status(401).send({ message: 'Missing or invalid authorization token' });
    const a = JSON.parse(raw);
    request.user = a.user;
    request.authMethod = a.authMethod;
    if (a.apiToken) request.apiToken = a.apiToken;
  });
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-test-mcp']) request.viaMcp = true;
  });
  await app.register(adminOsBackupRoutes, {
    prefix: '/api/admin',
    cfg,
    spawn: (_d, jobId) => (spawned.push(jobId), { pid: 4242 }),
    send: async (m) => (sent.push(m), { success: true }),
    checkPassword: async (_id, pw) => pw === 'correct horse',
    owners: async () => [OWNER, OTHER],
    codeMigrations: () => CODE,
    dbMigrations: async () => CODE,
  });
  // The real verifyJwt on a probe route: a watch token must never pass it.
  app.get('/probe', { onRequest: [verifyJwt] }, async () => ({ ok: true }));
});
afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  setMaintenanceDir(dir);
  clearMaintenance(dir);
  store.__t.jobs.clear();
  store.__t.challenges.clear();
  store.__t.state.lockJobId = null;
});

describe('OS Backups guards', () => {
  it('a human owner passes; non-owner, API token, agent and viaMcp get 403', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/os-backups', headers: auth() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/os-backups', headers: auth({ user: { ...OWNER, role: 'PM' } }) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/os-backups', headers: auth({ authMethod: 'apiToken', apiToken: { id: 't' } }) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/os-backups', headers: auth({ user: { ...OWNER, isAgent: true } }) })).statusCode).toBe(403);
    const mcp = await app.inject({ method: 'GET', url: '/api/admin/os-backups', headers: { ...auth(), 'x-test-mcp': '1' } });
    expect(mcp.statusCode).toBe(403);
    expect(mcp.json().code).toBe('HUMAN_ONLY');
    for (const url of ['/api/admin/os-backups/restore/00000000-0000-0000-0000-000000000000/status', '/api/admin/os-backups/download/' + 'a'.repeat(43)]) {
      const r = await app.inject({ method: 'GET', url, headers: { 'x-test-mcp': '1' } });
      expect(r.json().code).toBe('HUMAN_ONLY');
    }
    expect((await app.inject({ method: 'POST', url: '/api/admin/os-backups/maintenance/clear', headers: { 'x-test-mcp': '1' } })).json().code).toBe('HUMAN_ONLY');
  });

  it('state-changing routes need the app Origin', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/admin/os-backups/schedule', headers: auth(), payload: { paused: true } });
    expect(r.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/os-backups/schedule', headers: { ...auth(), origin: 'https://evil.example' }, payload: { paused: true } })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/admin/os-backups/schedule', headers: write(), payload: { paused: true } });
    expect(ok.json()).toEqual({ schedulePaused: true });
    expect(sent.some((m) => m.to === OTHER.email && /paused/.test(m.subject))).toBe(true);
    await app.inject({ method: 'POST', url: '/api/admin/os-backups/schedule', headers: write(), payload: { paused: false } });
  });
});

describe('OS Backups restore flow', () => {
  it('request (password) → OTP email + alert → confirm → job, worker and watch token', async () => {
    const id = crypto.randomUUID();
    addBackup(id, CODE);
    const bad = await app.inject({ method: 'POST', url: `/api/admin/os-backups/${id}/restore/request`, headers: write(), payload: { password: 'nope' } });
    expect(bad.statusCode).toBe(400);
    const req = await app.inject({ method: 'POST', url: `/api/admin/os-backups/${id}/restore/request`, headers: write(), payload: { password: 'correct horse' } });
    expect(req.statusCode).toBe(200);
    const body = req.json();
    expect(body.compat.status).toBe('SAME');
    expect(body.attemptsLeft).toBe(5);
    const otpMail = sent.find((m) => m.to === OWNER.email && m.subject === 'Your OS restore code');
    expect(otpMail.subject).not.toMatch(/\d{6}/);
    expect(sent.some((m) => m.to === OTHER.email && m.subject === 'An OS restore was requested')).toBe(true);
    const code = lastCode();

    const noText = await app.inject({ method: 'POST', url: `/api/admin/os-backups/${id}/restore/confirm`, headers: write(), payload: { challengeId: body.challengeId, code, confirmText: 'restore' } });
    expect(noText.json().code).toBe('CONFIRM_TEXT');
    const wrong = await app.inject({ method: 'POST', url: `/api/admin/os-backups/${id}/restore/confirm`, headers: write(), payload: { challengeId: body.challengeId, code: code === '000000' ? '111111' : '000000', confirmText: 'RESTORE' } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ message: 'Invalid or expired code', attemptsLeft: 4 });

    const ok = await app.inject({ method: 'POST', url: `/api/admin/os-backups/${id}/restore/confirm`, headers: write(), payload: { challengeId: body.challengeId, code, confirmText: 'RESTORE' } });
    expect(ok.statusCode).toBe(202);
    const { jobId, watchToken } = ok.json();
    expect(spawned).toContain(jobId);
    expect(store.__t.jobs.get(jobId)).toMatchObject({ type: 'RESTORE', backupId: id, requestedById: OWNER.id, progress: { options: { acknowledgeOlderSchema: false, carryForwardCredentials: true } } });
    expect(fs.existsSync(path.join(dir, 'jobs', `${jobId}.json`))).toBe(true);

    const st = await app.inject({ method: 'GET', url: `/api/admin/os-backups/restore/${jobId}/status`, headers: { 'x-restore-watch': watchToken } });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ jobId, status: 'QUEUED', backup: { id } });
    expect(JSON.stringify(st.json())).not.toContain('notify');
    expect((await app.inject({ method: 'GET', url: `/api/admin/os-backups/restore/${jobId}/status` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/admin/os-backups/restore/${crypto.randomUUID()}/status`, headers: { 'x-restore-watch': watchToken } })).statusCode).toBe(401);
    // The watch token is not a session.
    expect((await app.inject({ method: 'GET', url: '/probe', headers: { authorization: `Bearer ${watchToken}` } })).statusCode).toBe(401);
    // The code is single use, and a second restore is refused while one is queued.
    const again = await app.inject({ method: 'POST', url: `/api/admin/os-backups/${id}/restore/confirm`, headers: write(), payload: { challengeId: body.challengeId, code, confirmText: 'RESTORE' } });
    expect(again.statusCode).toBe(409);
  });

  it('older-schema backup needs the acknowledgement; newer is refused', async () => {
    const older = crypto.randomUUID();
    addBackup(older, CODE.slice(0, 1));
    const req = (await app.inject({ method: 'POST', url: `/api/admin/os-backups/${older}/restore/request`, headers: write(), payload: { password: 'correct horse' } })).json();
    expect(req.compat).toEqual({ status: 'OLDER', missingMigrations: ['20261115_os_backups'] });
    const code = lastCode();
    const noAck = await app.inject({ method: 'POST', url: `/api/admin/os-backups/${older}/restore/confirm`, headers: write(), payload: { challengeId: req.challengeId, code, confirmText: 'RESTORE' } });
    expect(noAck.json().code).toBe('ACK_REQUIRED');
    const ack = await app.inject({ method: 'POST', url: `/api/admin/os-backups/${older}/restore/confirm`, headers: write(), payload: { challengeId: req.challengeId, code, confirmText: 'RESTORE', acknowledgeOlderSchema: true } });
    expect(ack.statusCode).toBe(202);

    const newer = crypto.randomUUID();
    addBackup(newer, [...CODE, '20991231_future']);
    const r = await app.inject({ method: 'POST', url: `/api/admin/os-backups/${newer}/restore/request`, headers: write(), payload: { password: 'correct horse' } });
    expect(r.json().code).toBe('SCHEMA_NEWER');
  });

  it('maintenance/clear: only NEEDS_MIGRATION, only with the watch token, only when migrations are applied', async () => {
    const { mintWatchToken } = await import('../../../src/lib/osBackup/otp.js');
    const jobId = crypto.randomUUID();
    writeMaintenance(dir, { jobId, phase: 'RESTORING' });
    const tok = mintWatchToken(KEY, { userId: OWNER.id, jobId });
    expect((await app.inject({ method: 'POST', url: '/api/admin/os-backups/maintenance/clear', headers: { 'x-restore-watch': tok }, payload: { jobId } })).statusCode).toBe(409);
    writeMaintenance(dir, { jobId, phase: 'NEEDS_MIGRATION' });
    expect((await app.inject({ method: 'POST', url: '/api/admin/os-backups/maintenance/clear', payload: { jobId } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/admin/os-backups/maintenance/clear', headers: { 'x-restore-watch': tok }, payload: { jobId } });
    expect(ok.json()).toEqual({ cleared: true });
    expect(fs.existsSync(path.join(dir, 'maintenance.json'))).toBe(false);
  });
});

describe('OS Backups download', () => {
  it('password → OTP → single-use 60 s ticket → encrypted file; the other owners are alerted', async () => {
    const id = crypto.randomUUID();
    addBackup(id, CODE);
    const r1 = (await app.inject({ method: 'POST', url: `/api/admin/os-backups/${id}/download/request`, headers: write(), payload: { password: 'correct horse' } })).json();
    const code = lastCode();
    const r2 = await app.inject({ method: 'POST', url: `/api/admin/os-backups/${id}/download`, headers: write(), payload: { challengeId: r1.challengeId, code } });
    expect(r2.statusCode).toBe(200);
    const { ticket } = r2.json();
    expect(sent.some((m) => m.to === OTHER.email && m.subject === 'An OS backup was downloaded')).toBe(true);
    const f = await app.inject({ method: 'GET', url: `/api/admin/os-backups/download/${ticket}` });
    expect(f.statusCode).toBe(200);
    expect(f.headers['content-type']).toBe('application/octet-stream');
    expect(f.headers['cache-control']).toBe('no-store');
    expect(f.headers['content-disposition']).toMatch(/attachment; filename="lwos-.*\.lwbk"/);
    expect(f.rawPayload.toString()).toContain('LWOSBAK1');
    expect((await app.inject({ method: 'GET', url: `/api/admin/os-backups/download/${ticket}` })).statusCode).toBe(404);
    // A restore code cannot be used for a download.
    const r3 = (await app.inject({ method: 'POST', url: `/api/admin/os-backups/${id}/restore/request`, headers: write(), payload: { password: 'correct horse' } })).json();
    const bad = await app.inject({ method: 'POST', url: `/api/admin/os-backups/${id}/download`, headers: write(), payload: { challengeId: r3.challengeId, code: lastCode() } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('API tokens never reach OS Backups', () => {
  it('every /api/admin/os-backups route is on the denylist', async () => {
    const { checkApiTokenRoute } = await import('../../../src/lib/apiTokens.js');
    for (const [m, u] of [
      ['GET', '/api/admin/os-backups'],
      ['POST', '/api/admin/os-backups/run'],
      ['POST', '/api/admin/os-backups/:backupId/restore/confirm'],
      ['GET', '/api/admin/os-backups/download/:ticket'],
    ]) {
      expect(checkApiTokenRoute({}, m, u)).toMatchObject({ ok: false, status: 403 });
    }
  });
});
