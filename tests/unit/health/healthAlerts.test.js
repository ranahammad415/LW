import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ rows: [], logs: new Map(), notified: [], users: [], deleted: [], oncall: [] }));

vi.mock('../../../src/lib/notificationService.js', () => ({ notify: async (n) => { db.notified.push(n); } }));
vi.mock('../../../src/lib/prisma.js', async () => {
  const { shapeChecked } = await import('../../helpers/prismaShape.js');
  return {
  prisma: shapeChecked({
    clientHealthDaily: { findMany: async ({ where }) => db.rows.filter((r) => where.date.in.includes(r.date)) },
    healthAlertLog: {
      updateMany: async ({ where, data }) => {
        const k = `${where.clientId}|${where.alertKey}`;
        const row = db.logs.get(k);
        if (row && row.sentAt < where.sentAt.lt) {
          db.logs.set(k, { ...row, sentAt: data.sentAt });
          return { count: 1 };
        }
        return { count: 0 };
      },
      findUnique: async ({ where }) => db.logs.get(`${where.clientId_alertKey.clientId}|${where.clientId_alertKey.alertKey}`) || null,
      create: async ({ data }) => { db.logs.set(`${data.clientId}|${data.alertKey}`, data); return data; },
      deleteMany: async ({ where }) => {
        let count = 0;
        for (const k of [...db.logs.keys()]) {
          const [c, key] = k.split('|');
          if (c === where.clientId && key.startsWith(where.alertKey.startsWith)) { db.logs.delete(k); count += 1; }
        }
        db.deleted.push(where);
        return { count };
      },
    },
    clientAccount: { findUnique: async ({ select }) => (select.agencyName ? { agencyName: 'Harbor <Dental>' } : { leadPmId: 'pmLead', secondaryPmId: 'pmSecond' }) },
    project: { findMany: async () => [{ leadPmId: 'pmProject' }, { leadPmId: 'clientUser' }] },
    healthScoreDaily: {
      findMany: async () => [{ factors: [{ key: 'S1', pillar: 'site', score: 25, raw: { cur: 'fail' }, reason: 'ok' }, { key: 'L1', pillar: 'leads', score: 17, raw: { cur: 28, prev: 35 }, reason: 'ok' }] }],
    },
    user: {
      findMany: async ({ where }) => {
        if (where.role === 'OWNER') return [{ id: 'owner1' }];
        if (where.id?.in && where.role?.in) {
          return where.id.in.filter((id) => !['clientUser'].includes(id) && (where.role.in.includes('PM'))).map((id) => ({ id }));
        }
        return db.oncall.map((id) => ({ id }));
      },
    },
    agencySetting: { findFirst: async () => ({ securityOnCallUserIds: db.oncall }) },
  }),
  };
});

import { evaluateHealthAlerts, decideAlert, claimHealthAlert, largestDrop } from '../../../src/lib/health/healthAlerts.js';
import { DEFAULT_CONFIG_V1 } from '../../../src/lib/health/defaultConfig.js';

const CFG = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1));
const D = '2026-10-22';
const row = (date, score, extra = {}) => ({ clientId: 'c1', date, score, coverage: 90, pillars: { site: { score: 90 }, leads: { score: 50 } }, ...extra });
const map = (rows) => new Map(rows.map((r) => [r.date, r]));
const NOW = new Date('2026-10-22T07:00:00Z');

beforeEach(() => {
  db.rows = [];
  db.logs = new Map();
  db.notified = [];
  db.deleted = [];
  db.oncall = [];
});

describe('decideAlert', () => {
  it('rule A: band fell (healthy → at risk) with enough coverage', () => {
    expect(decideAlert(map([row(D, 55), row('2026-10-21', 62)]), D, CFG)).toMatchObject({ rule: 'band', band: 'at_risk', delta: -7 });
    expect(decideAlert(map([row(D, 55, { coverage: 50 }), row('2026-10-21', 62)]), D, CFG).rule).toBeNull();
  });
  it('rule B needs two consecutive runs of a 10-point 7-day drop', () => {
    const once = [row(D, 70), row('2026-10-15', 82), row('2026-10-21', 75), row('2026-10-14', 80)];
    expect(decideAlert(map(once), D, CFG).rule).toBeNull();
    const twice = [row(D, 70), row('2026-10-15', 82), row('2026-10-21', 70), row('2026-10-14', 81)];
    expect(decideAlert(map(twice), D, CFG)).toMatchObject({ rule: 'drop', delta: -12 });
  });
  it('a rise into a higher band is flagged', () => {
    expect(decideAlert(map([row(D, 81), row('2026-10-21', 70)]), D, CFG).rise).toBe(true);
  });
  it('largest pillar drop', () => {
    expect(largestDrop({ pillars: { site: { score: 40 }, leads: { score: 45 } } }, { pillars: { site: { score: 90 }, leads: { score: 50 } } })).toBe('site');
  });
});

describe('evaluateHealthAlerts', () => {
  it('notifies staff only, slug health_score_drop, escaped name and words-only reasons', async () => {
    db.rows = [row(D, 55, { pillars: { site: { score: 40 }, leads: { score: 50 } } }), row('2026-10-21', 62)];
    const out = await evaluateHealthAlerts(D, CFG, { now: NOW });
    expect(out).toMatchObject({ evaluated: 1, sent: 1 });
    const n = db.notified[0];
    expect(n.slug).toBe('health_score_drop');
    expect(n.recipientIds.sort()).toEqual(['owner1', 'pmLead', 'pmProject', 'pmSecond']);
    expect(n.recipientIds).not.toContain('clientUser');
    expect(n.variables).toMatchObject({ clientName: 'Harbor &lt;Dental&gt;', score: '55', band: 'At risk', delta: '-7' });
    expect(n.variables.reasons).toContain('Your website security needs attention');
    expect(n.actionUrl).toBe('/portal/admin/clients/c1?tab=health');
    expect(n.metadata).toEqual({ clientId: 'c1', score: 55, rule: 'band' });
  });

  it('on-call users only when the site pillar fell the most', async () => {
    db.oncall = ['oncall1'];
    db.rows = [row(D, 55, { pillars: { site: { score: 85 }, leads: { score: 10 } } }), row('2026-10-21', 62)];
    await evaluateHealthAlerts(D, CFG, { now: NOW });
    expect(db.notified[0].recipientIds).not.toContain('oncall1');
    db.logs = new Map();
    db.notified = [];
    db.rows = [row(D, 55, { pillars: { site: { score: 20 }, leads: { score: 50 } } }), row('2026-10-21', 62)];
    await evaluateHealthAlerts(D, CFG, { now: NOW });
    expect(db.notified[0].recipientIds).toContain('oncall1');
  });

  it('dedupes per key for dedupeDays; a band rise clears band:* keys', async () => {
    db.rows = [row(D, 55), row('2026-10-21', 62)];
    await evaluateHealthAlerts(D, CFG, { now: NOW });
    const second = await evaluateHealthAlerts(D, CFG, { now: new Date(NOW.getTime() + 3600_000) });
    expect(second).toMatchObject({ sent: 0, deduped: 1 });
    db.rows = [row('2026-10-23', 70), row(D, 55)];
    const rise = await evaluateHealthAlerts('2026-10-23', CFG, { now: NOW });
    expect(rise.resets).toBe(1);
    expect(db.logs.size).toBe(0);
  });

  it('claimHealthAlert re-arms after the window', async () => {
    expect(await claimHealthAlert('c1', 'drop7', { now: NOW })).toBe(true);
    expect(await claimHealthAlert('c1', 'drop7', { now: new Date(NOW.getTime() + 86400_000) })).toBe(false);
    expect(await claimHealthAlert('c1', 'drop7', { now: new Date(NOW.getTime() + 8 * 86400_000) })).toBe(true);
  });
});
