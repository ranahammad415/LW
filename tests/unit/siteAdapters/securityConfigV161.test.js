/**
 * Contract v1.6.1 §37 on the OS side: config-get mirror, config-set (OS-side validation, baseRev CAS, rejected[],
 * 409 CONFLICT_REV replaces the mirror, 422 UNKNOWN_CHECK), security-run (pending marker until the same scanId's
 * scan_completed), security-ack (7 / 30 / critical 7 day bounds), and the config_changed mirror rule (rev order; a gap
 * or truncated → security-config-get). Prisma and the site are stubbed; the mirror lives in memory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const db = vi.hoisted(() => ({ calls: [], overrides: {}, mirror: null }));
const site = vi.hoisted(() => ({ handler: null, routes: [] }));

vi.mock('../../../src/lib/prisma.js', () => {
  const mirrorModel = {
    findUnique: async () => db.mirror,
    upsert: async (a) => {
      db.calls.push({ key: 'securityConfigMirror.upsert', args: a });
      db.mirror = { projectId: 'p1', ...(db.mirror ? a.update : a.create) };
      return db.mirror;
    },
    update: async (a) => {
      db.calls.push({ key: 'securityConfigMirror.update', args: a });
      db.mirror = { ...db.mirror, ...a.data };
      return db.mirror;
    },
    updateMany: async (a) => {
      db.calls.push({ key: 'securityConfigMirror.updateMany', args: a });
      if (!db.mirror || db.mirror.rev !== a.where.rev) return { count: 0 };
      db.mirror = { ...db.mirror, ...a.data };
      return { count: 1 };
    },
  };
  const model = (name) =>
    name === 'securityConfigMirror'
      ? mirrorModel
      : new Proxy({}, {
          get(_, method) {
            const key = `${name}.${String(method)}`;
            return async (args) => {
              db.calls.push({ key, args });
              if (db.overrides[key]) return db.overrides[key](args);
              if (method === 'findMany') return [];
              if (method === 'updateMany') return { count: 1 };
              if (method === 'create' || method === 'update' || method === 'upsert') return { id: 'row', ...(args?.data || args?.create || {}) };
              return null;
            };
          },
        });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/cmsStore.js', async (orig) => ({
  ...(await orig()),
  loadEmdashConnection: async () => ({ conn: { siteId: 'site_9f3c2a7b41d0', siteUrl: 'https://s.example' } }),
}));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (orig) => {
  const o = await orig();
  const call = (route) => async (_c, a, b) => {
    const body = route === 'security-config-get' ? {} : a;
    const opts = route === 'security-config-get' ? a : b;
    site.routes.push({ route, body, opts });
    return site.handler(route, body, opts);
  };
  return {
    ...o,
    emdashRoutes: { ...o.emdashRoutes, securityConfigGet: call('security-config-get'), securityConfigSet: call('security-config-set'), securityRun: call('security-run'), securityAck: call('security-ack') },
  };
});

import {
  pullSecurityConfig,
  setSecurityConfig,
  runSecurityScan,
  ackSecurityCheck,
  applySecurityConfigEvent,
  buildConfigSetBody,
  ackBounds,
  configView,
  completePendingScan,
} from '../../../src/lib/security/securityConfig.js';
import { applySecurityEvent } from '../../../src/lib/security/securityStore.js';
import { CmsBridgeError } from '../../../src/lib/siteAdapters/emdash.js';
import { sanitizeConfig } from '../../../src/lib/siteAdapters/security.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${n}.json`), 'utf8'));
const OWNER = { id: '0f1e2d3c-4b5a-4968-8776-655443322110', role: 'OWNER', name: 'Olivia Owner' };
const PROJECT = { id: 'p1', cmsType: 'EMDASH', cmsCapabilities: { security: true, securityConfig: true } };
const cfgEvents = () => ex('events.request--security-config').events;

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  db.mirror = null;
  site.routes = [];
  site.handler = (route) => {
    if (route === 'security-config-get') return ex('security-config-get.response');
    throw new Error(`unexpected ${route}`);
  };
});

describe('mirror', () => {
  it('security-config-get → mirror (sanitized; no addresses / keys); acknowledgements copied to check states', async () => {
    const cfg = await pullSecurityConfig('p1');
    expect(cfg.rev).toBe(1);
    expect(cfg.checks.map((c) => c.id)).toContain('data.db_integrity');
    expect(JSON.stringify(cfg)).not.toMatch(/@/);
    expect(site.routes[0].opts).toEqual({ retryDelays: [] });
    expect(db.calls.filter((c) => c.key === 'securityCheckState.updateMany')).toHaveLength(cfg.checks.length);
  });

  it('config_changed in rev order patches the mirror; stale rev ignored; gap / truncated → pull', async () => {
    await pullSecurityConfig('p1'); // rev 1
    const pulls = [];
    const schedulePull = (id) => pulls.push(id);
    const [ev1, ev2] = cfgEvents();
    expect(await applySecurityConfigEvent(PROJECT, ev1, { schedulePull })).toBe('stale'); // rev 1 already mirrored
    expect(await applySecurityConfigEvent(PROJECT, ev2, { schedulePull })).toBe('applied');
    expect(db.mirror.rev).toBe(2);
    const hsts = db.mirror.config.checks.find((c) => c.id === 'edge.hsts');
    expect(hsts).toMatchObject({ schedule: '6h', frequency: '6h' });
    expect(db.mirror.config.checks.find((c) => c.id === 'email.dkim').enabled).toBe(false);
    expect(db.mirror.config.alerts.dedupeHours).toBe(ev2.data.changes.find((c) => c.id === 'alerts').to);
    expect(db.mirror.config.lastChange).toMatchObject({ rev: 2, source: 'os' });
    expect(pulls).toEqual([]);
    // a gap (rev 4 after 2) → mark stale and pull
    expect(await applySecurityConfigEvent(PROJECT, { ...ev2, data: { ...ev2.data, rev: 4 } }, { schedulePull })).toBe('applied');
    expect(db.mirror.stale).toBe(true);
    expect(pulls).toEqual(['p1']);
    // truncated → pull even when consecutive
    db.mirror.stale = false;
    await applySecurityConfigEvent(PROJECT, { ...ev2, data: { ...ev2.data, rev: 3, truncated: true } }, { schedulePull });
    expect(pulls).toEqual(['p1', 'p1']);
  });

  it('no mirror yet: the first event triggers a pull (pairing / first sync)', async () => {
    const pulls = [];
    expect(await applySecurityConfigEvent(PROJECT, cfgEvents()[1], { schedulePull: (id) => pulls.push(id) })).toBe('applied');
    expect(pulls).toEqual(['p1']);
  });

  it('security.acknowledged: stored on the check state (mutes alerts) and in the mirror; the view names our user', async () => {
    await pullSecurityConfig('p1');
    const ackEv = cfgEvents().find((e) => e.type === 'security.acknowledged');
    expect(await applySecurityEvent(PROJECT, ackEv)).toBe('applied');
    const upd = db.calls.filter((c) => c.key === 'securityCheckState.updateMany').pop();
    expect(upd.args).toMatchObject({ where: { projectId: 'p1', checkId: ackEv.data.checkId }, data: { acknowledged: { state: ackEv.data.state, until: new Date(ackEv.data.until).toISOString() } } });
    db.overrides['user.findMany'] = async () => [{ id: OWNER.id, name: 'Olivia Owner' }];
    const view = await configView('p1');
    const c = view.checks.find((x) => x.id === ackEv.data.checkId);
    expect(c.acknowledged.byName).toBeTruthy();
  });
});

describe('writes', () => {
  beforeEach(async () => {
    await pullSecurityConfig('p1');
    site.routes = [];
  });

  it('OS-side validation before any call', () => {
    expect(() => buildConfigSetBody({ changes: [{ id: 'edge.hsts', enabled: true }] }, OWNER)).toThrow(/baseRev/);
    expect(() => buildConfigSetBody({ baseRev: 1, changes: [{ id: 'BAD', enabled: true }] }, OWNER)).toThrow(/check id/);
    expect(() => buildConfigSetBody({ baseRev: 1, changes: Array.from({ length: 51 }, () => ({ id: 'edge.hsts', enabled: true })) }, OWNER)).toThrow(/50/);
    expect(() => buildConfigSetBody({ baseRev: 1, alerts: { dedupeHours: 200 } }, OWNER)).toThrow(/1–168/);
    expect(() => buildConfigSetBody({ baseRev: 1 }, OWNER)).toThrow(/Nothing/);
    const b = buildConfigSetBody({ baseRev: 1, changes: [{ id: 'edge.hsts', schedule: '6h', note: '  x  ' }], alerts: { recipientsMode: 'os' } }, OWNER);
    expect(b).toMatchObject({ baseRev: 1, changes: [{ id: 'edge.hsts', schedule: '6h', note: 'x' }], alerts: { recipientsMode: 'os' }, actor: { kind: 'human', osUserId: OWNER.id, role: 'OWNER' } });
  });

  it('config-set: idempotency key per action, baseRev, applied / rejected, mirror replaced', async () => {
    site.handler = () => ({ ...ex('security-config-set.response'), rejected: [{ id: 'data.db_integrity', field: 'severityOverride', reason: 'not_adjustable', message: 'Critical checks keep their severity.' }] });
    const out = await setSecurityConfig('p1', OWNER, { baseRev: 1, changes: [{ id: 'edge.hsts', schedule: '6h' }, { id: 'data.db_integrity', severityOverride: 'high' }] }, { idempotencyKey: 'click-abc-123' });
    expect(site.routes[0].opts).toEqual({ retryDelays: [], idempotencyKey: 'click-abc-123' });
    expect(site.routes[0].body.baseRev).toBe(1);
    expect(out.rejected).toEqual([{ id: 'data.db_integrity', field: 'severityOverride', reason: 'not_adjustable', message: 'Critical checks keep their severity.' }]);
    expect(db.mirror.rev).toBe(2);
    expect(db.calls.find((c) => c.key === 'securityConfigAction.create').args.data).toMatchObject({ action: 'config-set', idempotencyKey: 'click-abc-123', status: 'ok' });
  });

  it('409 CONFLICT_REV: the mirror becomes details.config and the error carries it; 422 UNKNOWN_CHECK passes through', async () => {
    const conflict = ex('error.response--security-config-conflict').error;
    site.handler = () => {
      throw new CmsBridgeError({ status: 409, code: 'CONFLICT_REV', message: conflict.message, details: conflict.details });
    };
    await expect(setSecurityConfig('p1', OWNER, { baseRev: 1, changes: [{ id: 'edge.hsts', enabled: false }] })).rejects.toMatchObject({ code: 'CONFLICT_REV', details: { currentRev: 2 } });
    expect(db.mirror.rev).toBe(2);
    const unknown = ex('error.response--unknown-check').error;
    site.handler = () => {
      throw new CmsBridgeError({ status: 422, code: 'UNKNOWN_CHECK', message: unknown.message, details: unknown.details });
    };
    await expect(setSecurityConfig('p1', OWNER, { baseRev: 2, changes: [{ id: 'edge.nope', enabled: false }] })).rejects.toMatchObject({ code: 'UNKNOWN_CHECK' });
  });

  it('security-run: reason required, 1–50 ids or all; pending until scan_completed with the same scanId', async () => {
    await expect(runSecurityScan('p1', OWNER, { all: true, reason: '' })).rejects.toThrow(/reason/);
    await expect(runSecurityScan('p1', OWNER, { checkIds: [], reason: 'x' })).rejects.toThrow(/1–50/);
    site.handler = () => ex('security-run.response');
    const out = await runSecurityScan('p1', OWNER, { checkIds: ['email.spf', 'email.dkim'], reason: 'DNS changed' });
    expect(out).toMatchObject({ scanId: '01M6G8F2T0PCNAM6K0SF2Y38WR', queued: true, skipped: [{ id: 'email.dkim', reason: 'disabled' }] });
    expect(db.mirror.config.pendingScans.map((s) => s.scanId)).toEqual(['01M6G8F2T0PCNAM6K0SF2Y38WR']);
    expect(await completePendingScan('p1', 'other')).toBe(false);
    await applySecurityEvent(PROJECT, { type: 'security.scan_completed', at: '2026-11-03T09:00:00Z', data: { scanId: '01M6G8F2T0PCNAM6K0SF2Y38WR', kind: 'manual', source: 'os', partial: true, durationMs: 10, counts: { ok: 1, warn: 0, fail: 0, unknown: 0 } } });
    expect(db.mirror.config.pendingScans).toEqual([]);
    site.handler = () => {
      throw new CmsBridgeError({ status: 409, code: 'INVALID_TRANSITION', details: { skipped: [{ id: 'host.file_perms', reason: 'no_runner' }] } });
    };
    await expect(runSecurityScan('p1', OWNER, { checkIds: ['host.file_perms'], reason: 'x' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION', message: expect.stringMatching(/Nothing to run/) });
  });

  it('security-ack: note required; critical ≤ 7 days, others ≤ 30 (checked before the call); site ack_too_long passes maxUntil', async () => {
    const now = Date.now();
    expect(ackBounds('critical', { ackCriticalMaxDays: 7, ackMaxDays: 30, ackDefaultDays: 7 }, now).maxDays).toBe(7);
    expect(ackBounds('medium', { ackCriticalMaxDays: 7, ackMaxDays: 30, ackDefaultDays: 7 }, now).maxDays).toBe(30);
    await expect(ackSecurityCheck('p1', OWNER, { checkId: 'data.db_integrity', note: '' })).rejects.toThrow(/note/);
    await expect(ackSecurityCheck('p1', OWNER, { checkId: 'data.db_integrity', note: 'Restoring', until: new Date(now + 10 * 86400_000).toISOString() })).rejects.toMatchObject({ details: { reason: 'ack_too_long', maxDays: 7 } });
    expect(site.routes).toEqual([]);
    site.handler = () => ex('security-ack.response');
    db.overrides['user.findMany'] = async () => [{ id: OWNER.id, name: 'Olivia Owner' }];
    const out = await ackSecurityCheck('p1', OWNER, { checkId: 'data.db_integrity', note: 'Restoring' });
    expect(site.routes[0].body).toMatchObject({ checkId: 'data.db_integrity', note: 'Restoring', actor: { kind: 'human', role: 'OWNER' } });
    expect(site.routes[0].body.until).toBeUndefined(); // site default (7 days)
    expect(out.acknowledged).toMatchObject({ checkId: 'data.db_integrity', byName: 'Olivia Owner' });
    site.handler = () => {
      throw new CmsBridgeError({ status: 400, code: 'VALIDATION', details: { reason: 'ack_too_long', maxDays: 7, maxUntil: '2026-11-10T08:30:00Z' } });
    };
    await expect(ackSecurityCheck('p1', OWNER, { checkId: 'data.db_integrity', note: 'x' })).rejects.toMatchObject({ details: { maxUntil: '2026-11-10T08:30:00.000Z' } });
  });

  it('sanitizeConfig keeps adjustable lists to known values and drops invalid checks', () => {
    const raw = ex('security-config-get.response').config;
    const cfg = sanitizeConfig({ ...raw, checks: [...raw.checks, { id: 'BAD' }, { ...raw.checks[0], adjustable: { ...raw.checks[0].adjustable, severity: ['high', 'extreme'] } }] });
    expect(cfg.checks).toHaveLength(raw.checks.length); // invalid dropped, duplicate id dropped
    expect(sanitizeConfig({ rev: -1, checks: [] })).toBeNull();
  });
});
