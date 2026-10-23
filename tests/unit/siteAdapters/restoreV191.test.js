/**
 * Contract v1.9.1 §41 (restore from the site admin) on the OS side (restore architecture §7.3): fixtures against the
 * schemas, ingest validation, SiteRestore storage keyed on restoreId (idempotent per restoreId and phase), data gap,
 * orphaned_by_restore (leads, entries), alerts per phase, backup-status `backups.restore` (and its absence below
 * 1.9.1), the client tile allow-list, the uptime maintenance window, COUNTER_REGRESSION logging, the monthly report
 * line and the Health v2 marker. Prisma is the in-memory fake (every call shape-checked against the schema).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainst, schemaErrors } from '../../helpers/miniSchema.js';
import { takeShapeViolations } from '../../helpers/prismaShape.js';

const spies = vi.hoisted(() => ({ notify: [], slack: [], inventory: null }));

vi.mock('../../../src/lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../signals/fakePrisma.js');
  return { prisma: createFakePrisma() };
});
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: async (args) => spies.notify.push(args) }));
vi.mock('../../../src/lib/contentMapSync.js', () => ({ reconcileProjectMapsSafe: () => {} }));
vi.mock('../../../src/lib/cmsStore.js', async (orig) => ({
  ...(await orig()),
  loadEmdashConnection: async (projectId) => ({ project: { id: projectId, wpUrl: 'https://s.example' }, conn: { siteId: 'site_9f3c2a7b41d0', siteUrl: 'https://s.example' } }),
}));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (orig) => {
  const o = await orig();
  return {
    ...o,
    emdashRoutes: {
      ...o.emdashRoutes,
      siteInfo: async () => {
        throw new Error('not in this test');
      },
      inventory: async () => spies.inventory(),
    },
  };
});

import { prisma } from '../../../src/lib/prisma.js';
import {
  sanitizeRestoreState,
  sanitizeRestoreEventData,
  sanitizeBackups,
  validateSecurityEvent,
  BACKUP_RESTORE_EVENT_TYPES,
  RESTORE_SCOPES,
  RESTORE_RESULTS,
  RESTORE_SOURCE_OWNERS,
  RESTORE_PHASES,
  OS_CAPABILITY_BACKUP_RESTORE_EVENTS,
} from '../../../src/lib/siteAdapters/security.js';
import { validateEvent, processEventBatch, logCounterRegression } from '../../../src/routes/webhooks/emdash.js';
import { prismaCmsStore } from '../../../src/lib/cmsStore.js';
import { recordBackupStatus } from '../../../src/lib/security/securityStore.js';
import {
  applyRestoreEvent,
  dataGapOf,
  nextResult,
  clientRestoreTile,
  restoreDataGaps,
  restoreMaintenanceWindow,
  findRecentRestore,
  staffRestoreView,
} from '../../../src/lib/security/restoreStore.js';
import { RESTORE_ALERT_SEVERITY, restoreAlertText } from '../../../src/lib/security/securityAlerts.js';
import { buildClientSecurityView, siteSecurityView } from '../../../src/lib/security/securityViews.js';
import { restoreLines } from '../../../src/lib/security/securityReport.js';
import { probeStatusEndpoint, probeProject, applyIncidentLogic, computeDailyRollup, MAINTENANCE, _resetUptimeState } from '../../../src/lib/uptime.js';
import { staffHealthView } from '../../../src/lib/health/healthViews.js';
import { syncEmdashInventory } from '../../../src/lib/emdashSync.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, '../../fixtures/cms-contract');
const ex = (name) => JSON.parse(readFileSync(path.join(FIX, 'examples', `${name}.json`), 'utf8'));
const SITE = 'site_9f3c2a7b41d0';
const PROJECT = { id: 'p1', name: 'Oasis', cmsType: 'EMDASH', cmsSiteId: SITE, leadPmId: 'pm-1', clientId: 'c1', cmsCapabilities: { security: true, backups: true } };
const RID = 'rst_mvl2k1a0f3e4d5c6b7a8091a2b';
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const flush = () => new Promise((r) => setTimeout(r, 10));
const restoreEvents = () => ex('events.request--backup-restore').events;
const evOf = (type) => restoreEvents().find((e) => e.type === type);
const rows = () => prisma._rows('siteRestore');

async function seedPeople() {
  await prisma.user.create({ data: { id: 'owner-1', role: 'OWNER', isActive: true, isAgent: false, email: 'o@x', name: 'Owner', passwordHash: 'x' } });
  await prisma.user.create({ data: { id: 'oncall-1', role: 'PM', isActive: true, isAgent: false, email: 'p@x', name: 'On call', passwordHash: 'x' } });
  await prisma.agencySetting.create({ data: { id: 'as1', securityOnCallUserIds: ['oncall-1'] } });
}

beforeEach(async () => {
  prisma._reset();
  spies.notify.length = 0;
  await seedPeople();
});
afterEach(() => {
  expect(takeShapeViolations()).toEqual([]);
});

describe('fixtures (oasis-astro 66d1ab3) against the schemas', () => {
  it('backup-status.response--restore, events.request--backup-restore and handshake.response--backup-restore-events are valid', () => {
    expect(validateAgainst('backup-status.response.json', ex('backup-status.response--restore'))).toEqual([]);
    expect(validateAgainst('events.request.json', ex('events.request--backup-restore'))).toEqual([]);
    expect(validateAgainst('handshake.response.json', ex('handshake.response--backup-restore-events'))).toEqual([]);
  });
  it('each restore event data matches its $def and the allOf rule rejects a wrong data shape', () => {
    const defs = { 'backup.restore_started': 'backupRestoreStartedData', 'backup.restore_completed': 'backupRestoreCompletedData', 'backup.restore_failed': 'backupRestoreFailedData', 'backup.restore_rolled_back': 'backupRestoreRolledBackData' };
    for (const [type, def] of Object.entries(defs)) {
      expect(schemaErrors(evOf(type).data, { $ref: `common.json#/$defs/${def}` })).toEqual([]);
    }
    const bad = ex('events.request--backup-restore');
    delete bad.events[2].data.rollbackPoint;
    expect(validateAgainst('events.request.json', bad).length).toBeGreaterThan(0);
  });
  it('the OS constants equal the contract constants', () => {
    expect(BACKUP_RESTORE_EVENT_TYPES).toEqual(['backup.restore_started', 'backup.restore_completed', 'backup.restore_failed', 'backup.restore_rolled_back']);
    expect(RESTORE_SCOPES).toEqual(['db', 'files', 'files-subset', 'full']);
    expect(RESTORE_RESULTS).toEqual(['ok', 'failed', 'rolled_back']);
    expect(RESTORE_SOURCE_OWNERS).toEqual(['agency', 'client', 'host']);
    expect(RESTORE_PHASES).toEqual(['locate', 'download', 'stage', 'check', 'sandbox', 'await_confirm', 'pre_export', 'stage_files', 'commit', 'restarting', 'plan', 'done']);
    expect(OS_CAPABILITY_BACKUP_RESTORE_EVENTS).toBe('backupRestoreEvents');
  });
});

describe('ingest validation', () => {
  it('every event of the example passes validateEvent (incl. the oasis-backup plugin actor on backup.completed / verified)', () => {
    for (const e of restoreEvents()) expect(validateEvent(e)).toBeNull();
    expect(evOf('backup.completed').actor).toMatchObject({ kind: 'plugin', source: 'plugin', plugin: 'oasis-backup' });
  });
  it('a missing required field is a final VALIDATION reject; unknown codes become INTERNAL; no extra keys pass', () => {
    const e = structuredClone(evOf('backup.restore_failed'));
    delete e.data.phase;
    expect(validateSecurityEvent(e)).toMatch(/phase/);
    const f = sanitizeRestoreEventData('backup.restore_failed', { ...evOf('backup.restore_failed').data, errorCode: 'S3_BUCKET_GONE' });
    expect(f.data.errorCode).toBe('INTERNAL');
    const s = sanitizeRestoreEventData('backup.restore_started', { ...evOf('backup.restore_started').data, source: { owner: 'agency', type: 's3', host: 'bucket.example', path: '/x' } });
    expect(s.data.source).toEqual({ owner: 'agency', destinationId: null, type: 's3' });
    expect(sanitizeRestoreEventData('backup.restore_started', { ...evOf('backup.restore_started').data, scope: 'everything' }).error).toBeTruthy();
    expect(sanitizeRestoreEventData('backup.restore_rolled_back', { restoreId: 'bad id!', rollbackId: 'rbk_1', at: '2026-11-05T07:40:00Z', byRole: 'owner' }).error).toBeTruthy();
  });
  it('backups.restore is sanitized when present and left out when absent (sites below 1.9.1)', () => {
    const withIt = sanitizeBackups(ex('backup-status.response--restore').backups);
    expect(withIt.restore.lastRestore).toMatchObject({ restoreId: RID, scope: 'full', result: 'ok', byRole: 'owner', rollbackAvailableUntil: '2026-11-10T09:14:20.000Z' });
    expect(withIt.restore.active).toBeNull();
    const old = ex('backup-status.response--restore').backups;
    delete old.restore;
    expect(sanitizeBackups(old)).not.toHaveProperty('restore');
    expect(sanitizeRestoreState({ lastRestore: { restoreId: RID, at: 'nope' }, active: { restoreId: 'r1', phase: 'teleport', startedAt: '2026-11-03T09:12:02Z', scope: 'db' } })).toEqual({ lastRestore: null, active: null });
  });
});

describe('storage, idempotency per restoreId and phase, alerts', () => {
  it('the whole example batch through processEventBatch: accepted; the restore ends rolled_back with one alert per phase', async () => {
    await prisma.cmsLead.create({ data: { projectId: 'p1', leadId: 'lead_new', siteCreatedAt: new Date('2026-11-02T12:00:00Z') } });
    await prisma.cmsLead.create({ data: { projectId: 'p1', leadId: 'lead_old', siteCreatedAt: new Date('2026-11-01T12:00:00Z') } });
    const out = await processEventBatch({ store: prismaCmsStore, project: PROJECT, events: restoreEvents(), log: log() });
    await flush();
    expect(out.rejected).toEqual([]);
    expect(out.accepted).toHaveLength(6);
    const r = rows().find((x) => x.restoreId === RID);
    expect(r).toMatchObject({ scope: 'full', result: 'rolled_back', sourceOwner: 'agency', sourceType: 's3', byRole: 'owner', rollbackPoint: true, preExport: true, durationMs: 138000, countersRaised: true, rollbackId: 'rbk_mvl4c3d2e1f0a9b8c7d6e5f4a3', rolledBackByRole: 'owner', origin: 'event' });
    const failed = rows().find((x) => x.restoreId === 'rst_mvl3b2c1d0e9f8a7b6c5d4e3f2');
    expect(failed).toMatchObject({ result: 'failed', phase: 'check', errorCode: 'INTEGRITY', retryable: false, scope: 'db' });
    // started info, completed info, failed critical, rolled_back high (the backup.completed / verified raise none here)
    const sev = spies.notify.filter((n) => n.metadata.kind === 'site_restore').map((n) => `${n.metadata.phase}:${n.variables.severity}`);
    expect(sev).toEqual(['started:info', 'completed:info', 'failed:critical', 'rolled_back:high']);
    // the rollback brought the pre-restore database back: the lead created after the point in time is not orphaned
    expect(prisma._rows('cmsLead').find((l) => l.leadId === 'lead_new').orphanedByRestoreId).toBeNull();
    // backup.completed from the plugin actor is stored as an agency run
    expect(prisma._rows('securityBackupRun').map((x) => x.runId)).toContain('run_mvl1z8q0a1b2c3d4e5f6a7b8c9');
  });

  it('restore_started re-sent with a NEW eventId (same restoreId) is stale: filled only, never alerted twice', async () => {
    const started = evOf('backup.restore_started');
    expect(await applyRestoreEvent(PROJECT, started.type, sanitizeRestoreEventData(started.type, started.data).data, started, { log: log() })).toBe('applied');
    const again = { ...started, eventId: '01JB2RS00000000000000000ZZ', at: '2026-11-03T09:16:00Z' };
    expect(await applyRestoreEvent(PROJECT, again.type, sanitizeRestoreEventData(again.type, again.data).data, again, { log: log() })).toBe('stale');
    await flush();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].startedAt.toISOString()).toBe('2026-11-03T09:12:02.000Z');
    expect(spies.notify.filter((n) => n.metadata.phase === 'started')).toHaveLength(1);
  });

  it('completion first (started lost with the old database): row created, startedAt derived, a late started fills it but does not alert "started"', async () => {
    const done = evOf('backup.restore_completed');
    await applyRestoreEvent(PROJECT, done.type, sanitizeRestoreEventData(done.type, done.data).data, done, { log: log() });
    expect(rows()[0]).toMatchObject({ result: 'ok', startedAt: new Date(Date.parse('2026-11-03T09:14:20Z') - 138000) });
    const started = evOf('backup.restore_started');
    expect(await applyRestoreEvent(PROJECT, started.type, sanitizeRestoreEventData(started.type, started.data).data, started, { log: log() })).toBe('applied');
    await flush();
    expect(rows()[0]).toMatchObject({ result: 'ok', byRole: 'owner', rollbackPoint: true, startedAt: new Date('2026-11-03T09:12:02Z') });
    expect(spies.notify.map((n) => n.metadata.phase)).toEqual(['completed']);
  });

  it('completed db restore: data gap pointInTime → completed.at and site leads created after the point in time are orphaned (not deleted)', async () => {
    await prisma.cmsLead.create({ data: { projectId: 'p1', leadId: 'a', siteCreatedAt: new Date('2026-11-02T10:00:00Z') } });
    await prisma.cmsLead.create({ data: { projectId: 'p1', leadId: 'b', siteCreatedAt: new Date('2026-11-01T10:00:00Z') } });
    await prisma.cmsLead.create({ data: { projectId: 'p1', leadId: 'g', provider: 'ghl', siteCreatedAt: new Date('2026-11-02T10:00:00Z') } });
    const done = evOf('backup.restore_completed');
    await applyRestoreEvent(PROJECT, done.type, sanitizeRestoreEventData(done.type, done.data).data, done, { log: log() });
    const r = rows()[0];
    expect(r.dataGapFrom.toISOString()).toBe('2026-11-02T08:30:00.000Z');
    expect(r.dataGapTo.toISOString()).toBe('2026-11-03T09:14:20.000Z');
    expect(r.orphanedLeads).toBe(1);
    const leads = Object.fromEntries(prisma._rows('cmsLead').map((l) => [l.leadId, l.orphanedByRestoreId]));
    expect(leads).toEqual({ a: RID, b: null, g: null });
    expect(prisma._rows('cmsLead')).toHaveLength(3);
    expect(await restoreDataGaps('p1')).toEqual([{ kind: 'data_gap', reason: 'site_restore', from: '2026-11-02T08:30:00.000Z', to: '2026-11-03T09:14:20.000Z', restoreId: RID }]);
  });

  it('a files-only restore has no data gap and orphans nothing; countersRaised=false is logged as a warning', async () => {
    await prisma.cmsLead.create({ data: { projectId: 'p1', leadId: 'a', siteCreatedAt: new Date('2026-11-02T10:00:00Z') } });
    const done = structuredClone(evOf('backup.restore_completed'));
    done.data.scope = 'files';
    const l = log();
    await applyRestoreEvent(PROJECT, done.type, sanitizeRestoreEventData(done.type, done.data).data, done, { log: l });
    expect(rows()[0].dataGapFrom).toBeNull();
    expect(prisma._rows('cmsLead')[0].orphanedByRestoreId).toBeNull();
    const db = structuredClone(evOf('backup.restore_completed'));
    db.data.restoreId = 'rst_other';
    db.data.bridge.countersRaised = false;
    await applyRestoreEvent(PROJECT, db.type, sanitizeRestoreEventData(db.type, db.data).data, db, { log: l });
    expect(l.warn.mock.calls.some(([, msg]) => /WITHOUT raised counters/.test(msg))).toBe(true);
  });

  it('pure rules: result transitions, data gap of a rollback, severities and alert wording', () => {
    expect(nextResult(undefined, 'started')).toBe('running');
    expect(nextResult('running', 'completed')).toBe('ok');
    expect(nextResult('ok', 'failed')).toBe('ok');
    expect(nextResult('rolled_back', 'completed')).toBe('rolled_back');
    expect(dataGapOf({ scope: 'db', result: 'rolled_back', startedAt: new Date('2026-11-03T09:12:02Z'), rolledBackAt: new Date('2026-11-05T07:40:00Z') })).toEqual({ from: new Date('2026-11-03T09:12:02Z'), to: new Date('2026-11-05T07:40:00Z') });
    expect(dataGapOf({ scope: 'files-subset', result: 'ok', completedAt: new Date() })).toBeNull();
    expect(RESTORE_ALERT_SEVERITY).toEqual({ started: 'info', completed: 'info', failed: 'critical', rolled_back: 'high' });
    expect(restoreAlertText('failed', { scope: 'db', phase: 'check', errorCode: 'INTEGRITY', retryable: false }).title).toBe('Site restore FAILED (database, phase check, INTEGRITY)');
  });

  it('failed is critical to on-call + OWNERs; started goes to on-call only', async () => {
    const f = evOf('backup.restore_failed');
    await applyRestoreEvent(PROJECT, f.type, sanitizeRestoreEventData(f.type, f.data).data, f, { log: log() });
    const s = evOf('backup.restore_started');
    await applyRestoreEvent(PROJECT, s.type, sanitizeRestoreEventData(s.type, s.data).data, s, { log: log() });
    await flush();
    const byPhase = Object.fromEntries(spies.notify.map((n) => [n.metadata.phase, n]));
    expect(byPhase.failed.recipientIds.sort()).toEqual(['oncall-1', 'owner-1']);
    expect(byPhase.failed.slug).toBe('security_alert');
    expect(byPhase.started.recipientIds).toEqual(['oncall-1']);
  });
});

describe('backup-status backups.restore (pull)', () => {
  it('creates the restore from the pull (origin pull), keeps rollbackAvailableUntil, marks the gap; never alerts', async () => {
    await recordBackupStatus('p1', ex('backup-status.response--restore'), { now: new Date('2026-11-03T10:00:00Z') });
    await flush();
    expect(rows()[0]).toMatchObject({ restoreId: RID, origin: 'pull', result: 'ok', scope: 'full', rollbackAvailableUntil: new Date('2026-11-10T09:14:20Z'), completedAt: new Date('2026-11-03T09:14:20Z') });
    expect(rows()[0].dataGapFrom.toISOString()).toBe('2026-11-02T08:30:00.000Z');
    expect(spies.notify).toEqual([]);
  });
  it('an event-made row is not downgraded by a pull and an active restore is recorded as running', async () => {
    const rb = evOf('backup.restore_rolled_back');
    await applyRestoreEvent(PROJECT, rb.type, sanitizeRestoreEventData(rb.type, rb.data).data, rb, { log: log(), alert: false });
    const res = ex('backup-status.response--restore');
    res.backups.restore.active = { restoreId: 'rst_active1', phase: 'commit', startedAt: '2026-11-06T10:00:00Z', scope: 'db' };
    await recordBackupStatus('p1', res, { now: new Date('2026-11-06T10:01:00Z') });
    expect(rows().find((r) => r.restoreId === RID).result).toBe('rolled_back');
    expect(rows().find((r) => r.restoreId === 'rst_active1')).toMatchObject({ result: 'running', phase: 'commit', scope: 'db' });
    expect(await restoreMaintenanceWindow('p1', new Date('2026-11-06T10:05:00Z'))).toMatchObject({ restoreId: 'rst_active1' });
    expect(await restoreMaintenanceWindow('p1', new Date('2026-11-06T11:00:00Z'))).toBeNull();
  });
  it('a site below 1.9.1 (no backups.restore) stores no restore', async () => {
    const res = ex('backup-status.response--restore');
    delete res.backups.restore;
    await recordBackupStatus('p1', res);
    expect(rows()).toEqual([]);
  });
});

describe('views and report', () => {
  const FORBIDDEN = ['restoreId', 'rollbackId', 'destinationId', 'sourceDestinationId', 'sourceType', 'byRole', 'errorCode', 'counts', 'durationMs', 'cost', 'phase'];
  const keys = (o, out = []) => {
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) (out.push(k), keys(v, out));
    return out;
  };
  it('client tile: "restored" with point in time, content flag; allow-list only; gone after 30 days', () => {
    const row = { restoreId: RID, scope: 'full', result: 'ok', pointInTime: new Date('2026-11-02T08:30:00Z'), completedAt: new Date('2026-11-03T09:14:20Z'), sourceDestinationId: 'dst_1', byRole: 'owner', errorCode: null, durationMs: 1 };
    const now = Date.parse('2026-11-04T00:00:00Z');
    const view = buildClientSecurityView({ status: { overallState: 'ok' }, checks: [], restores: [row] }, { now });
    expect(view.tiles.restore).toEqual({ state: 'restored', pointInTime: '2026-11-02T08:30:00.000Z', at: '2026-11-03T09:14:20.000Z', content: true });
    for (const k of FORBIDDEN) expect(keys(view)).not.toContain(k);
    expect(clientRestoreTile([row], { now: Date.parse('2026-12-10T00:00:00Z') })).toBeNull();
    expect(clientRestoreTile([{ ...row, result: 'rolled_back', rolledBackAt: new Date('2026-11-05T07:40:00Z') }], { now }).state).toBe('undone');
    expect(clientRestoreTile([{ ...row, result: 'failed' }], { now })).toBeNull();
  });
  it('staff view carries scope, source (with the destination label), byRole, duration, rollback window, gap', async () => {
    await prisma.securitySiteStatus.create({ data: { projectId: 'p1', backups: { client: [{ destinationId: 'dst_1', label: 'Office NAS' }], restore: { lastRestore: null, active: null } } } });
    const done = structuredClone(evOf('backup.restore_completed'));
    done.data.source = { owner: 'client', destinationId: 'dst_1', type: 'sftp' };
    await applyRestoreEvent(PROJECT, done.type, sanitizeRestoreEventData(done.type, done.data).data, done, { log: log(), alert: false });
    const v = await siteSecurityView(PROJECT);
    expect(v.restores[0]).toMatchObject({ restoreId: RID, scope: 'full', result: 'ok', durationMs: 138000, source: { owner: 'client', type: 'sftp', destinationId: 'dst_1', label: 'Office NAS' }, dataGap: { from: '2026-11-02T08:30:00.000Z' } });
    expect(v.restoreActive).toBeNull();
    expect(staffRestoreView({ restoreId: 'r', result: 'ok', rollbackAvailableUntil: new Date(Date.now() + 86400_000) }).rollbackOpen).toBe(true);
  });
  it('monthly report: a client line without ids; the agency line with details', () => {
    const r = { restoreId: RID, scope: 'db', result: 'ok', pointInTime: new Date('2026-11-02T08:30:00Z'), completedAt: new Date('2026-11-03T09:14:20Z'), sourceOwner: 'agency', sourceType: 's3', byRole: 'owner', durationMs: 138000, orphanedLeads: 2 };
    const client = restoreLines([r, { ...r, restoreId: 'x', result: 'failed', failedAt: new Date() }], false);
    expect(client).toContain('Site restored to 2026-11-02 08:30 UTC');
    expect(client).not.toContain(RID);
    expect(client).not.toContain('failed');
    const admin = restoreLines([r], true);
    expect(admin).toContain(RID);
    expect(admin).toContain('took 138 s');
    expect(admin).toContain('2 lead(s) orphaned');
    expect(restoreLines([], true)).toBe('');
  });
  it('Health v2 staff view passes the data_gap markers', () => {
    const markers = [{ kind: 'data_gap', from: 'a', to: 'b' }];
    expect(staffHealthView(null, { cfg: { version: 2 }, markers }).markers).toEqual(markers);
  });
});

describe('uptime: a restore maintenance window never pages', () => {
  const jsonRes = (status, obj) => ({ status, location: null, cert: null, body: Buffer.from(JSON.stringify(obj)) });
  it('/_agency/status state maintenance → errorClass maintenance', async () => {
    const s = await probeStatusEndpoint('https://s.example', { request: async () => jsonRes(200, { state: 'maintenance', maintenance: { reason: 'restore', since: 'x' }, uptime: { db: 'ok' } }) });
    expect(s).toMatchObject({ ok: false, errorClass: MAINTENANCE, maintenance: true });
  });
  it('home 503 during maintenance: recorded as maintenance, no incident, no alert; failed probes around it do not open DOWN', async () => {
    _resetUptimeState();
    const project = { id: 'p1', name: 'Oasis', wpUrl: 'https://s.example', cmsType: 'EMDASH' };
    const request = async (url) => (url.endsWith('/_agency/status') ? jsonRes(200, { state: 'maintenance', uptime: { db: 'ok' } }) : { status: 503, location: null, cert: null, body: Buffer.alloc(0) });
    const now = new Date('2026-11-03T09:13:00Z');
    const out = await probeProject(project, { now, request, sleep: async () => {} });
    expect(out).toMatchObject({ incident: 'maintenance', errorClass: MAINTENANCE });
    const second = await probeProject(project, { now: new Date('2026-11-03T09:15:00Z'), request, sleep: async () => {} });
    expect(second.incident).toBe('maintenance');
    // a real failure right after: the previous probe was maintenance, so no DOWN yet
    const failing = await applyIncidentLogic(project, { ok: false, errorClass: 'http_5xx', httpStatus: 500 }, { now: new Date('2026-11-03T09:17:00Z') });
    expect(failing).toBe('failing');
    expect(prisma._rows('uptimeIncident')).toEqual([]);
    expect(spies.notify).toEqual([]);
  });
  it('status endpoint unreachable (restart) but the OS saw restore_started: still no incident', async () => {
    _resetUptimeState();
    const s = evOf('backup.restore_started');
    await applyRestoreEvent(PROJECT, s.type, sanitizeRestoreEventData(s.type, s.data).data, s, { log: log(), alert: false });
    const project = { id: 'p1', name: 'Oasis', wpUrl: 'https://s.example', cmsType: 'EMDASH' };
    const request = async () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    };
    const out = await probeProject(project, { now: new Date('2026-11-03T09:14:00Z'), request, sleep: async () => {} });
    expect(out.incident).toBe('maintenance');
    // 40 minutes later the window is over: a failure counts again
    const later = await probeProject(project, { now: new Date('2026-11-03T09:55:00Z'), request, sleep: async () => {} });
    expect(later.incident).toBe('failing');
  });
  it('the daily rollup leaves maintenance probes out of the availability', () => {
    const day = new Date('2026-11-03T00:00:00Z');
    const r = computeDailyRollup([{ ok: true, ms: 100 }, { ok: false, errorClass: MAINTENANCE }, { ok: false, errorClass: MAINTENANCE }], [], day, new Date('2026-11-04T00:00:00Z'));
    expect(r).toMatchObject({ checks: 1, okChecks: 1, availabilityPct: 100 });
  });
});

describe('COUNTER_REGRESSION after a restore is logged loudly (never hidden)', () => {
  it('error with the restore within 48 h; the usual warning otherwise', async () => {
    const l = log();
    expect(await logCounterRegression({ store: prismaCmsStore, projectId: 'p1', regression: 'cursor 4 already belongs to another event', log: l })).toBe('plain');
    expect(l.warn).toHaveBeenCalled();
    const done = evOf('backup.restore_completed');
    await applyRestoreEvent(PROJECT, done.type, sanitizeRestoreEventData(done.type, done.data).data, done, { log: log(), alert: false });
    const now = new Date('2026-11-03T12:00:00Z');
    expect(await findRecentRestore('p1', now)).toMatchObject({ restoreId: RID, countersRaised: true });
    expect(await logCounterRegression({ store: prismaCmsStore, projectId: 'p1', regression: 'x', log: l, now })).toBe('after_restore');
    expect(l.error.mock.calls[0][1]).toMatch(/AFTER A SITE RESTORE/);
  });
});

describe('inventory: entries missing after a database restore are orphaned_by_restore, not deleted', () => {
  it('marks the entries last seen before the swap (row and status kept)', async () => {
    process.env.CMS_KEY_ENCRYPTION_KEY = process.env.CMS_KEY_ENCRYPTION_KEY || 'k'.repeat(40);
    const synced = new Date('2026-11-02T00:00:00Z');
    await prisma.wpPage.create({ data: { projectId: 'p1', wpPostId: 1, title: 'Kept', slug: 'kept', status: 'publish', postType: 'pages', url: 'https://s.example/kept', content: '', contentHash: 'h1', cmsEntryId: 'e1', syncedAt: synced } });
    await prisma.wpPage.create({ data: { projectId: 'p1', wpPostId: 2, title: 'Gone', slug: 'gone', status: 'publish', postType: 'pages', url: 'https://s.example/gone', content: '', contentHash: 'h2', cmsEntryId: 'e2', syncedAt: synced } });
    const done = evOf('backup.restore_completed');
    await applyRestoreEvent(PROJECT, done.type, sanitizeRestoreEventData(done.type, done.data).data, done, { log: log(), alert: false });
    spies.inventory = async () => ({ items: [], next: null });
    const out = await syncEmdashInventory('p1');
    expect(out.orphaned).toBe(2);
    expect(out.deleted).toBe(0);
    const pages = prisma._rows('wpPage');
    expect(pages.every((p) => p.orphanedByRestoreId === RID && p.status === 'publish')).toBe(true);
  });
});
