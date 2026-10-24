import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as M from '../../../src/lib/osBackup/maintenance.js';
import { makeGatedCron } from '../../../src/lib/osBackup/cronGate.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwos-maint-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function app() {
  const a = Fastify({ logger: false });
  await a.register(cors, { origin: ['https://app.example.io'], credentials: true });
  a.addHook('onRequest', M.maintenanceGate);
  a.get('/health', async () => ({ status: 'ok' }));
  a.get('/api/projects', async () => ({ ok: true }));
  a.post('/api/auth/login', async () => ({ ok: true }));
  a.get('/api/admin/os-backups/restore/:jobId/status', async () => ({ ok: true }));
  a.post('/api/admin/os-backups/maintenance/clear', async () => ({ ok: true }));
  a.post('/api/webhooks/emdash/x', async () => ({ ok: true }));
  return a;
}

beforeEach(() => {
  M.setMaintenanceDir(dir);
  M.clearMaintenance(dir);
});

describe('osBackup maintenance gate', () => {
  it('fails open: no file → requests pass', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(200);
    M.setMaintenanceDir(path.join(dir, 'does-not-exist'));
    expect((await a.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(200);
  });

  it('503 MAINTENANCE with Retry-After, no-store and the CORS header', async () => {
    M.writeMaintenance(dir, { jobId: 'j1', phase: 'RESTORING', startedAt: '2026-11-15T10:00:00Z' });
    const a = await app();
    const r = await a.inject({ method: 'GET', url: '/api/projects', headers: { origin: 'https://app.example.io' } });
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('120');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['access-control-allow-origin']).toBe('https://app.example.io');
    expect(r.json()).toMatchObject({ code: 'MAINTENANCE', retryAfter: 120, startedAt: '2026-11-15T10:00:00Z' });
    expect((await a.inject({ method: 'POST', url: '/api/webhooks/emdash/x' })).statusCode).toBe(503);
  });

  it('exempt: OPTIONS, the restore status route, maintenance/clear; /health is 503 maintenance', async () => {
    M.writeMaintenance(dir, { jobId: 'j1', phase: 'RESTORING' });
    const a = await app();
    const pre = await a.inject({ method: 'OPTIONS', url: '/api/projects', headers: { origin: 'https://app.example.io', 'access-control-request-method': 'GET' } });
    expect(pre.statusCode).toBe(204);
    expect((await a.inject({ method: 'GET', url: '/api/admin/os-backups/restore/abc/status' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'POST', url: '/api/admin/os-backups/maintenance/clear' })).statusCode).toBe(200);
    const h = await a.inject({ method: 'GET', url: '/health' });
    expect(h.statusCode).toBe(503);
    expect(h.json().status).toBe('maintenance');
  });

  it('login passes only while NEEDS_MIGRATION', async () => {
    M.writeMaintenance(dir, { jobId: 'j1', phase: 'RESTORING' });
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/api/auth/login' })).statusCode).toBe(503);
    M.updateMaintenancePhase(dir, 'NEEDS_MIGRATION');
    expect(M.isExempt('POST', '/api/auth/login', M.readMaintenance(dir))).toBe(true);
    expect((await a.inject({ method: 'POST', url: '/api/auth/login' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(503);
  });

  it('1 s cache: at most one stat per second', () => {
    const spy = vi.spyOn(fs, 'statSync');
    const t = 5_000_000_000_000;
    M.isMaintenance(t);
    const n = spy.mock.calls.length;
    M.isMaintenance(t + 10);
    M.isMaintenance(t + 999);
    expect(spy.mock.calls.length).toBe(n);
    M.isMaintenance(t + 1000);
    expect(spy.mock.calls.length).toBe(n + 1);
    spy.mockRestore();
  });

  it('end of maintenance runs the handlers and bumps the generation', () => {
    const seen = [];
    M.onMaintenanceEnded((e) => seen.push(e));
    let t = 6_000_000_000_000;
    M.isMaintenance(t);
    const g0 = M.maintenanceGeneration(t);
    M.writeMaintenance(dir, { jobId: 'j2', phase: 'RESTORING' });
    t += 2000;
    expect(M.isMaintenance(t)).toBe(true);
    const g1 = M.maintenanceGeneration(t);
    expect(g1).toBeGreaterThan(g0);
    M.clearMaintenance(dir);
    t += 2000;
    expect(M.isMaintenance(t)).toBe(false);
    expect(seen.at(-1)).toMatchObject({ nextEpoch: null });
    expect(M.maintenanceGeneration(t)).toBeGreaterThan(g1);
  });

  it('recycles a PM2 worker after maintenance ends (opt-out)', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const timer = M.startMaintenanceWatcher(null, { env: { pm_id: '3', NODE_APP_INSTANCE: '1' }, exit });
    M.writeMaintenance(dir, { jobId: 'j3', phase: 'RESTORING' });
    vi.advanceTimersByTime(1100);
    M.clearMaintenance(dir);
    vi.advanceTimersByTime(1100);
    vi.advanceTimersByTime(5100);
    expect(exit).toHaveBeenCalledWith(0);
    clearInterval(timer);
    vi.useRealTimers();
  });
});

describe('osBackup cron gate', () => {
  it('skips ticks during maintenance, runs otherwise, keeps the node-cron API', () => {
    const calls = [];
    const base = { schedule: (expr, fn, opts) => ({ expr, fn, opts }), validate: () => true };
    let on = false;
    const c = makeGatedCron(base, () => on);
    const task = c.schedule('* * * * *', () => calls.push(1), { name: 'x' });
    expect(task.expr).toBe('* * * * *');
    expect(task.opts).toEqual({ name: 'x' });
    task.fn();
    on = true;
    task.fn();
    expect(calls).toEqual([1]);
    expect(c.validate('* * * * *')).toBe(true);
  });
});
