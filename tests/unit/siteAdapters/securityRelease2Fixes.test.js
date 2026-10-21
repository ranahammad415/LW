/**
 * Release-2 combined e2e fixes (oasis-astro docs/agency-os/e2e-report-release-2.md, O-R2-1 … O-R2-6):
 *   O-R2-1 an acknowledgement ends on any state change of its check (§37.5), also when the OS never saw the ok in
 *          between (check_failed on a stored fail); the alert for that same event is not muted.
 *   O-R2-2 "Acknowledged by <OS user>" in the staff Security tab (siteSecurityView byName).
 *   O-R2-3 client backup tile: ok also needs nextExpectedAt + 60 min not passed (shared rule with missed detection).
 *   O-R2-4 disabled checks: "disabled", left out of counts and open items (client, staff, fleet, report).
 *   O-R2-5 monthly report: one row per check (first seen, last state, number of changes), counts recomputed.
 *   O-R2-6 check_failed with a `from` / `before` uses it.
 * Prisma is an in-memory stand-in with just the models these paths touch; notify is captured.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = vi.hoisted(() => ({ tables: {}, notes: [], seq: 0 }));

vi.mock('../../../src/lib/prisma.js', async () => {
  const { Prisma } = await import('@prisma/client');
  const clean = (data) => {
    const out = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (v === Prisma.DbNull || v === Prisma.JsonNull) out[k] = null;
      else if (v && typeof v === 'object' && 'increment' in v) out[k] = { __inc: v.increment };
      else out[k] = v;
    }
    return out;
  };
  const apply = (row, data) => {
    for (const [k, v] of Object.entries(clean(data))) row[k] = v && typeof v === 'object' && '__inc' in v ? (row[k] || 0) + v.__inc : v;
    return row;
  };
  const matches = (row, where = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'projectId_checkId') return row.projectId === v.projectId && row.checkId === v.checkId;
      if (k === 'projectId_alertKey') return row.projectId === v.projectId && row.alertKey === v.alertKey;
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(row[k]);
        if ('lt' in v) return row[k] != null && new Date(row[k]) < v.lt;
        if ('not' in v) return row[k] !== v.not;
        return true;
      }
      return row[k] === v;
    });
  const unique = {
    securityTransition: (r) => `${r.projectId}|${r.checkId}|${r.toState}|${new Date(r.at).toISOString()}`,
    securityAlertLog: (r) => `${r.projectId}|${r.alertKey}`,
    securityCheckState: (r) => `${r.projectId}|${r.checkId}`,
  };
  const model = (name) => {
    const rows = () => (mem.tables[name] ||= []);
    return {
      findUnique: async ({ where }) => rows().find((r) => matches(r, where)) ?? null,
      findFirst: async ({ where } = {}) => rows().find((r) => matches(r, where)) ?? null,
      findMany: async ({ where } = {}) => rows().filter((r) => matches(r, where)),
      create: async ({ data }) => {
        const row = apply({ id: `r${++mem.seq}` }, data);
        const u = unique[name];
        if (u && rows().some((r) => u(r) === u(row))) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        rows().push(row);
        return row;
      },
      update: async ({ where, data }) => apply(rows().find((r) => matches(r, where)), data),
      updateMany: async ({ where, data }) => {
        const hit = rows().filter((r) => matches(r, where));
        for (const r of hit) apply(r, data);
        return { count: hit.length };
      },
      upsert: async ({ where, update, create }) => {
        const r = rows().find((x) => matches(x, where));
        if (r) return apply(r, update);
        const row = apply({ id: `r${++mem.seq}` }, create);
        rows().push(row);
        return row;
      },
    };
  };
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/notificationService.js', () => ({
  notify: async (args) => {
    mem.notes.push(args);
  },
}));

import { applySecurityEvent, recordStatusPull } from '../../../src/lib/security/securityStore.js';
import { applySecurityConfigEvent, actorName } from '../../../src/lib/security/securityConfig.js';
import { buildClientSecurityView, siteSecurityView, fleetView } from '../../../src/lib/security/securityViews.js';
import { backupOverdue, detectMissedBackups, BACKUP_MISSED_GRACE_MS } from '../../../src/lib/security/securitySync.js';
import { renderSecurityReport, collapseItems } from '../../../src/lib/security/securityReport.js';
import { ackEndedBy, sanitizeSecurityEventData } from '../../../src/lib/siteAdapters/security.js';

const PM_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const PROJECT = { id: 'p1', name: 'Oasis', leadPmId: 'pm1', clientId: 'c1', cmsType: 'EMDASH', cmsCapabilities: { security: true, backups: true, securityConfig: true } };
const CHECK = 'backup.primary_fresh';
const T = (min) => new Date(Date.parse('2026-10-21T08:00:00Z') + min * 60_000).toISOString();
const table = (n) => (mem.tables[n] ||= []);
const stateOf = (checkId = CHECK) => table('securityCheckState').find((r) => r.checkId === checkId);

const checkFailed = (at, extra = {}) => ({
  type: 'security.check_failed',
  at,
  data: { id: CHECK, severity: 'critical', summary: 'Agency archives are 60 h old', remediation: 'Check the backup job', evidence: { ageHours: 60 }, at, ...extra },
});
const statusChanged = (at, changes) => ({
  type: 'security.status_changed',
  at,
  data: { before: { state: 'fail', score: 60 }, after: { state: changes[changes.length - 1].to, score: 70 }, changes: changes.map((c) => ({ id: CHECK, severity: 'critical', summary: 's', at, ...c })) },
});
const acknowledged = (at, until) => ({
  type: 'security.acknowledged',
  at,
  data: { checkId: CHECK, severity: 'critical', state: 'fail', until, note: 'Looking into it', at, by: { kind: 'human', osUserId: PM_ID, role: 'PM' }, source: 'os', rev: 3 },
});

beforeEach(() => {
  mem.tables = {
    user: [
      { id: 'owner1', name: 'Test Owner', role: 'OWNER', isActive: true, isAgent: false },
      { id: PM_ID, name: 'Test PM', role: 'PM', isActive: true, isAgent: false },
    ],
    agencySetting: [{ id: 'a1', securityOnCallUserIds: [PM_ID] }],
  };
  mem.notes = [];
});

describe('O-R2-1: an acknowledgement ends on a state change, before the alert decision', () => {
  it('ack a fail, then fail → ok → fail: the new failure alerts', async () => {
    expect(await applySecurityEvent(PROJECT, checkFailed(T(0)))).toBe('applied');
    expect(mem.notes).toHaveLength(1); // first failure alerts
    table('securityAlertLog')[0].sentAt = new Date(Date.now() - 25 * 3600_000); // past the 24 h dedupe window
    await applySecurityConfigEvent(PROJECT, acknowledged(T(5), new Date(Date.now() + 5 * 86400_000).toISOString()));
    expect(stateOf().acknowledged).toMatchObject({ active: true, state: 'fail' });

    await applySecurityEvent(PROJECT, statusChanged(T(10), [{ from: 'fail', to: 'ok' }]));
    expect(stateOf().acknowledged).toBeNull();
    await applySecurityEvent(PROJECT, checkFailed(T(12)));
    expect(stateOf().state).toBe('fail');
    expect(mem.notes).toHaveLength(2);
    expect(mem.notes[1]).toMatchObject({ slug: 'security_alert' });
  });

  it('the ok merged away (stored fail, incoming check_failed): the ack still ends and the alert fires', async () => {
    await applySecurityEvent(PROJECT, checkFailed(T(0)));
    table('securityAlertLog')[0].sentAt = new Date(Date.now() - 25 * 3600_000);
    await applySecurityConfigEvent(PROJECT, acknowledged(T(5), new Date(Date.now() + 5 * 86400_000).toISOString()));
    mem.notes = [];
    await applySecurityEvent(PROJECT, checkFailed(T(20)));
    expect(stateOf().acknowledged).toBeNull();
    expect(mem.notes).toHaveLength(1);
  });

  it('a status_changed entry for the check (even fail → fail) ends it; the mirror copy ends too', async () => {
    await applySecurityEvent(PROJECT, checkFailed(T(0)));
    table('securityConfigMirror').push({ id: 'm1', projectId: 'p1', rev: 3, config: { rev: 3, checks: [{ id: CHECK, enabled: true, acknowledged: { at: T(5), state: 'fail', active: true } }] } });
    await applySecurityConfigEvent(PROJECT, acknowledged(T(5), new Date(Date.now() + 5 * 86400_000).toISOString()));
    expect(stateOf().acknowledged.active).toBe(true);
    await applySecurityEvent(PROJECT, statusChanged(T(15), [{ from: 'fail', to: 'fail' }]));
    expect(stateOf().acknowledged).toBeNull();
    expect(table('securityConfigMirror')[0].config.checks[0].acknowledged.active).toBe(false);
  });

  it('an older event (before the ack) does not end it; an ack event older than the last change arrives ended', async () => {
    await applySecurityEvent(PROJECT, checkFailed(T(10)));
    await applySecurityConfigEvent(PROJECT, acknowledged(T(20), new Date(Date.now() + 5 * 86400_000).toISOString()));
    await applySecurityEvent(PROJECT, checkFailed(T(15))); // replay of an older failure
    expect(stateOf().acknowledged).toMatchObject({ active: true });
    await applySecurityEvent(PROJECT, checkFailed(T(30)));
    await applySecurityConfigEvent(PROJECT, acknowledged(T(25), new Date(Date.now() + 5 * 86400_000).toISOString())); // late delivery
    expect(stateOf().acknowledged).toBeNull();
  });

  it('a transition stored by the pull after the ack ends it, whatever the site computed', async () => {
    await applySecurityEvent(PROJECT, checkFailed(T(0)));
    await applySecurityConfigEvent(PROJECT, acknowledged(T(5), new Date(Date.now() + 5 * 86400_000).toISOString()));
    const ack = { at: T(5), until: new Date(Date.now() + 5 * 86400_000).toISOString(), state: 'fail', by: null, source: 'os', note: 'x', active: true };
    const status = (state, since) => ({
      detail: 'full',
      generatedAt: T(40),
      overall: { state, score: 70, counts: { ok: 0, warn: 0, fail: 1, unknown: 0 }, since },
      categories: {},
      catalogueVersion: '1.0.0',
      scans: { lastFullAt: T(40) },
      disabled: [],
      checks: [{ id: CHECK, category: 'backup', severity: 'critical', state, since, lastChangedAt: since, checkedAt: T(40), summary: 's', acknowledged: ack }],
    });
    // same state as stored but a change after the ack (fail → ok → fail between pulls)
    await recordStatusPull('p1', status('fail', T(30)), { now: new Date(T(40)) });
    expect(stateOf().acknowledged).toBeNull();
    // an ack given after the state began stays
    await recordStatusPull('p1', { ...status('fail', T(30)), checks: [{ ...status('fail', T(30)).checks[0], acknowledged: { ...ack, at: T(35) } }] }, { now: new Date(T(41)) });
    expect(stateOf().acknowledged).toMatchObject({ at: T(35) });
  });

  it('ackEndedBy', () => {
    expect(ackEndedBy(null, T(1))).toBe(false);
    expect(ackEndedBy({ at: T(1) }, T(2))).toBe(true);
    expect(ackEndedBy({ at: T(2) }, T(1))).toBe(false);
    expect(ackEndedBy({ at: T(2) }, null)).toBe(false);
  });
});

describe('O-R2-6: check_failed carries its own previous state when the site sends one', () => {
  it('from / before is used; else the stored state', async () => {
    expect(sanitizeSecurityEventData('security.check_failed', checkFailed(T(0), { from: 'ok' }).data).data.from).toBe('ok');
    expect(sanitizeSecurityEventData('security.check_failed', checkFailed(T(0), { before: 'warn' }).data).data.from).toBe('warn');
    expect(sanitizeSecurityEventData('security.check_failed', checkFailed(T(0), { from: 'bogus' }).data).data.from).toBeNull();
    await applySecurityEvent(PROJECT, checkFailed(T(0)));
    await applySecurityEvent(PROJECT, checkFailed(T(10), { from: 'ok' }));
    await applySecurityEvent(PROJECT, checkFailed(T(20)));
    expect(table('securityTransition').map((t) => `${t.fromState}→${t.toState}`)).toEqual(['null→fail', 'ok→fail', 'fail→fail']);
  });
});

describe('O-R2-2: acknowledged by <OS user>', () => {
  it('the staff view names the OS user; fallbacks: role, site admin', async () => {
    await applySecurityEvent(PROJECT, checkFailed(T(0)));
    await applySecurityConfigEvent(PROJECT, acknowledged(T(5), new Date(Date.now() + 5 * 86400_000).toISOString()));
    const v = await siteSecurityView(PROJECT);
    expect(v.checks[0].acknowledged).toMatchObject({ active: true, byName: 'Test PM' });
    expect(actorName({ kind: 'human', osUserId: '11111111-1111-4111-8111-111111111111', role: 'PM' }, 'os', new Map())).toBe('Agency OS PM');
    expect(actorName({ kind: 'human', role: 'admin' }, 'site-admin')).toBe('site admin');
    expect(actorName(null, 'site-admin')).toBe('site admin');
    expect(actorName(null, null)).toBeNull();
  });

  it('a lapsed acknowledgement is not shown as active', async () => {
    await applySecurityEvent(PROJECT, checkFailed(T(0)));
    stateOf().acknowledged = { at: T(5), until: new Date(Date.now() - 1000).toISOString(), state: 'fail', active: true, by: null, source: 'site-admin' };
    const v = await siteSecurityView(PROJECT);
    expect(v.checks[0].acknowledged).toMatchObject({ active: false, byName: 'site admin' });
  });
});

describe('O-R2-3: client backup tile uses the missed-backup rule', () => {
  const now = Date.parse('2026-10-21T09:00:00Z');
  const archive = (lastOkAt, nextExpectedAt) => ({ lastOkAt, nextExpectedAt, lastError: null });
  const status = (db, files, client = []) => ({ overallState: 'ok', backups: { agency: { db, files }, client } });

  it('ok only while nextExpectedAt + 60 min has not passed without a newer success', () => {
    const fresh = archive('2026-10-21T03:00:00Z', '2026-10-22T03:00:00Z');
    const overdue = archive('2026-10-19T03:00:00Z', '2026-10-20T03:00:00Z');
    const inGrace = archive('2026-10-20T08:30:00Z', new Date(now - BACKUP_MISSED_GRACE_MS + 60_000).toISOString());
    expect(buildClientSecurityView({ status: status(fresh, fresh), checks: [] }, { now }).tiles.backup.agency.ok).toBe(true);
    expect(buildClientSecurityView({ status: status(fresh, overdue), checks: [] }, { now }).tiles.backup.agency.ok).toBe(false);
    expect(buildClientSecurityView({ status: status(inGrace, fresh), checks: [] }, { now }).tiles.backup.agency.ok).toBe(true);
    const dest = { destinationId: 'dst_1', type: 'sftp', label: 'Office NAS', db: overdue, files: fresh };
    expect(buildClientSecurityView({ status: status(fresh, fresh, [dest]), checks: [] }, { now }).tiles.backup.destinations[0].ok).toBe(false);
    expect(backupOverdue(overdue, now)).toBe(true);
    expect(backupOverdue(fresh, now)).toBe(false);
  });

  it('the server-side missed detection uses the same rule', async () => {
    const overdue = archive('2026-10-19T03:00:00Z', '2026-10-20T03:00:00Z');
    const fresh = archive('2026-10-21T03:00:00Z', '2026-10-22T03:00:00Z');
    expect(await detectMissedBackups(PROJECT, { agency: { db: overdue, files: fresh }, client: [] }, { now: new Date(now) })).toBe(1);
    expect(table('securityBackupRun').map((r) => r.runId)).toEqual(['missed:agency-db:2026-10-20T03:00:00Z']);
  });
});

describe('O-R2-4: disabled checks', () => {
  const row = (checkId, state, extra = {}) => ({ projectId: 'p1', checkId, state, severity: 'medium', category: checkId.split('.')[0], clientSummary: `${checkId} needs work`, since: new Date(T(0)), ...extra });

  it('client: a disabled check is not an open item', () => {
    const v = buildClientSecurityView({ status: { overallState: 'warn', disabled: ['edge.csp_mode'] }, checks: [row('edge.csp_mode', 'fail'), row('email.spf', 'warn')] });
    expect(v.items.map((i) => i.text)).toEqual(['email.spf needs work']);
    expect(JSON.stringify(v)).not.toMatch(/csp_mode"|checkId/);
  });

  it('staff view: marked disabled, not acknowledged, out of the counts; fleet counts skip it', async () => {
    table('securitySiteStatus').push({ id: 's1', projectId: 'p1', overallState: 'warn', score: 90, counts: { ok: 0, warn: 1, fail: 1, unknown: 0 }, disabled: ['edge.csp_mode'] });
    table('securityCheckState').push({ id: 'c1', ...row('edge.csp_mode', 'unknown') }, { id: 'c2', ...row('email.spf', 'fail') }, { id: 'c3', ...row('edge.hsts', 'ok') });
    const v = await siteSecurityView(PROJECT);
    expect(v.checks.find((c) => c.id === 'edge.csp_mode').disabled).toBe(true);
    expect(v.checks.find((c) => c.id === 'email.spf').disabled).toBe(false);
    expect(v.status.counts).toEqual({ ok: 1, warn: 0, fail: 1, unknown: 0, disabled: 1 });

    table('securityCheckState').find((r) => r.checkId === 'edge.csp_mode').state = 'fail';
    table('project').push({ ...PROJECT, cmsPairedAt: new Date(), status: 'ACTIVE', securitySiteStatus: table('securitySiteStatus')[0] });
    const fleet = await fleetView({ id: 'owner1', role: 'OWNER' });
    expect(fleet[0]).toMatchObject({ failing: 1, warnings: 0 });
  });

  it('a check disabled from the OS (config_changed) updates the disabled list at once', async () => {
    table('securitySiteStatus').push({ id: 's1', projectId: 'p1', disabled: [] });
    table('securityConfigMirror').push({ id: 'm1', projectId: 'p1', rev: 1, config: { rev: 1, alerts: {}, checks: [{ id: 'edge.csp_mode', enabled: true }, { id: 'email.spf', enabled: true }] } });
    const ev = {
      type: 'security.config_changed',
      at: T(1),
      data: { rev: 2, at: T(1), source: 'os', by: { kind: 'human', osUserId: PM_ID, role: 'PM' }, changes: [{ id: 'edge.csp_mode', field: 'enabled', from: true, to: false }] },
    };
    expect(await applySecurityConfigEvent(PROJECT, ev)).toBe('applied');
    expect(table('securitySiteStatus')[0].disabled).toEqual(['edge.csp_mode']);
  });
});

describe('O-R2-5: monthly report items are per check', () => {
  const tr = (checkId, from, to, min, clientSummary = 'Backups are not running') => ({ checkId, fromState: from, toState: to, at: new Date(T(min)), severity: 'critical', clientSummary, summary: 's' });

  it('one row per check with first seen, last state and number of changes; counts recomputed', () => {
    const transitions = [
      tr(CHECK, 'ok', 'fail', 0),
      tr(CHECK, 'fail', 'ok', 30, null),
      tr(CHECK, 'ok', 'fail', 60),
      tr('email.spf', null, 'warn', 10, 'Email sender check'),
      tr('email.spf', 'warn', 'ok', 90, null),
    ];
    const byId = new Map([[CHECK, { checkId: CHECK, clientSummary: 'Backups are not running' }], ['email.spf', { checkId: 'email.spf', clientSummary: 'Email sender check' }]]);
    const items = collapseItems(transitions, byId);
    const backup = items.find((i) => i.checkId === CHECK);
    expect(backup).toMatchObject({ opened: true, changes: 3, lastState: 'fail', resolved: false });
    expect(new Date(backup.firstAt).toISOString()).toBe(T(0));
    expect(items.find((i) => i.checkId === 'email.spf')).toMatchObject({ opened: true, resolved: true, changes: 2 });

    const { clientHtml, adminHtml } = renderSecurityReport({
      project: { name: 'Oasis' },
      status: { overallState: 'fail', disabled: [] },
      points: [],
      transitions,
      runs: [],
      checks: [{ checkId: CHECK, state: 'fail', severity: 'critical', clientSummary: 'Backups are not running' }, { checkId: 'email.spf', state: 'ok', severity: 'medium', clientSummary: 'Email sender check' }],
      incidents: [],
      month: '2026-10',
      days: 31,
    });
    expect(clientHtml).toContain('2 items needed attention this month, 1 was resolved and 1 is still open.');
    const section7 = clientHtml.slice(clientHtml.indexOf('7. Items'), clientHtml.indexOf('8. Next month'));
    expect(section7.match(/Backups are not running/g)).toHaveLength(2); // needed attention + still open, once each
    expect(section7).toContain('changed 3 times');
    expect(section7).not.toContain(CHECK);
    expect(adminHtml).toContain(`[${CHECK}]`);
  });
});
