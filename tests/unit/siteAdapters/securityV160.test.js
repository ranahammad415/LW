/**
 * Contract v1.6.0 §36 (security status, backup status, logs) on the OS side: the redact.mjs port against the shared
 * vectors, ingest validation / bounds / redaction, event dispatch, storage (transitions, evidence only for non-ok,
 * daily points, backup runs), pulls (429 / 501 / 503 handling), alert routing (§5.6 matrix, dedupe, Slack guard),
 * retention, and the client view allow-list. Prisma, notify and the site are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
const site = vi.hoisted(() => ({ handler: null, routes: [] }));
const notes = vi.hoisted(() => ({ sent: [] }));

vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany' || method === 'groupBy') return [];
          if (method === 'count') return 0;
          if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
          if (method === 'create' || method === 'update' || method === 'upsert') return { id: 'row-1', ...(args?.data || args?.create || {}) };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/notificationService.js', () => ({
  notify: async (args) => {
    notes.sent.push(args);
  },
}));
vi.mock('../../../src/lib/cmsStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadEmdashConnection: async () => ({ conn: { siteId: 'site_9f3c2a7b41d0', siteUrl: 'https://s.example' } }),
}));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (importOriginal) => {
  const orig = await importOriginal();
  const call = (route) => async (_c, a, b) => {
    site.routes.push({ route, body: a, opts: b });
    return site.handler(route, a, b);
  };
  return {
    ...orig,
    emdashRoutes: {
      ...orig.emdashRoutes,
      securityStatus: call('security-status'),
      securityHistory: call('security-history'),
      backupStatus: async (c, opts) => call('backup-status')(c, {}, opts),
      logsPull: call('logs-pull'),
      securityConfigGet: async (c, opts) => call('security-config-get')(c, {}, opts),
    },
  };
});

import { redact, redactString, boundEvidence } from '../../../src/lib/siteAdapters/redact.js';
import {
  sanitizeStatus,
  sanitizeCheck,
  sanitizeBackups,
  sanitizeHistory,
  sanitizeRun,
  sanitizeSecurityEventData,
  validateSecurityEvent,
  SECURITY_LIMITS,
} from '../../../src/lib/siteAdapters/security.js';
import { validateEvent, processEventBatch } from '../../../src/routes/webhooks/emdash.js';
import { applySecurityEvent, recordStatusPull, recordBackupStatus, purgeSecurityHistory, streakId } from '../../../src/lib/security/securityStore.js';
import { alertForTransition, checkBackupFailures, sendSecuritySlack, claimAlert, runSecurityDigest, escapeHtml } from '../../../src/lib/security/securityAlerts.js';
import { pullSecurity, probeSecurityLogs, detectMissedBackups } from '../../../src/lib/security/securitySync.js';
import { buildClientSecurityView, CLIENT_SENTENCES } from '../../../src/lib/security/securityViews.js';
import { CmsBridgeError, MUTATION_ROUTES } from '../../../src/lib/siteAdapters/emdash.js';
import { CONTRACT_REVISION, ERROR_CODES } from '../../../src/lib/siteAdapters/signing.js';
import { checkApiTokenRoute } from '../../../src/lib/apiTokens.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (dir, n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract', dir, `${n}.json`), 'utf8'));
const ex = (n) => fx('examples', n);
const calls = (key) => db.calls.filter((c) => c.key === key);
const PROJECT = { id: 'p1', name: 'Oasis', leadPmId: 'pm1', clientId: 'c1', cmsType: 'EMDASH', cmsSiteId: 'site_9f3c2a7b41d0', wpUrl: 'https://oasispoolspas.com', cmsCapabilities: { security: true, backups: true, logs: false } };
const secEvents = () => ex('events.request--security').events;

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  site.routes = [];
  site.handler = null;
  notes.sent = [];
});

describe('redact.js port (vectors/redact.json, §36.5)', () => {
  const v = fx('vectors', 'redact');
  it.each(v.strings.map((s) => [s.name, s]))('string: %s', (_n, s) => {
    expect(redactString(s.input)).toBe(s.output);
  });
  it.each(v.objects.map((o) => [o.name, o]))('object: %s', (_n, o) => {
    expect(redact(o.input)).toEqual(o.output);
  });
  it('evidence bound: ≤ maxBytes, marked truncated', () => {
    const out = boundEvidence(v.evidenceBound.input, v.evidenceBound.maxBytes);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(v.evidenceBound.maxBytes);
    if (v.evidenceBound.output) expect(out).toEqual(v.evidenceBound.output);
    else expect(out.truncated).toBe(true);
  });
});

describe('ingest validation, bounds and redaction', () => {
  it('the full status example sanitizes; summary drops evidence; contract revision and error codes', () => {
    const full = sanitizeStatus(ex('security-status.response--full').status);
    expect(full.detail).toBe('full');
    expect(full.overall).toMatchObject({ state: 'warn', score: 93 });
    expect(full.checks.length).toBe(ex('security-status.response--full').status.checks.length);
    expect(full.checks[0].evidence).toBeTruthy();
    expect(full.backups.client[0].label).toBe('Office NAS');
    const summary = sanitizeStatus(ex('security-status.response').status);
    for (const c of summary.checks) expect(c.evidence).toBeUndefined();
    expect(CONTRACT_REVISION).toBe('1.7.0');
    expect(ERROR_CODES.UNKNOWN_CHECK.status).toBe(422);
    for (const r of ['security-config-set', 'security-run', 'security-ack']) expect(MUTATION_ROUTES.has(r)).toBe(true);
    for (const r of ['security-status', 'security-history', 'backup-status', 'logs-pull', 'security-config-get']) expect(MUTATION_ROUTES.has(r)).toBe(false);
  });

  it('out-of-bounds items are dropped, the rest kept; long text cut; secrets / PII redacted', () => {
    const base = ex('security-status.response--full').status.checks[0];
    const many = Array.from({ length: 205 }, (_, i) => ({ ...base, id: `edge.check_${i}` }));
    const st = sanitizeStatus({ ...ex('security-status.response--full').status, checks: [{ ...base, id: 'NOT VALID' }, ...many] });
    expect(st.checks.length).toBe(SECURITY_LIMITS.checks - 1); // first 200 items considered, the invalid one dropped
    const c = sanitizeCheck({ ...base, summary: 'x'.repeat(400) + ' admin@example.com', clientSummary: 'Call 414-555-0123', remediation: 'token aosk1_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', evidence: { big: 'y'.repeat(20000), email: 'a@b.co' } });
    expect(c.summary.length).toBe(300);
    expect(c.clientSummary).toBe('Call [phone]');
    expect(c.remediation).toContain('[secret]');
    expect(Buffer.byteLength(JSON.stringify(c.evidence))).toBeLessThanOrEqual(8192);
    expect(JSON.stringify(c.evidence)).not.toContain('a@b.co');
    expect(sanitizeCheck({ ...base, state: 'green' })).toBeNull();
    const b = sanitizeBackups({ agency: { db: { lastOkAt: '2026-11-03T08:30:40Z', lastError: 'S3 says: AccessDenied for bucket x' }, files: { lastOkAt: null } }, client: [{ destinationId: 'dst_1', type: 'sftp', label: 'NAS of bob@example.com ' + 'z'.repeat(100), db: { lastOkAt: null } }, { destinationId: 'bad id!', type: 'sftp' }] });
    expect(b.agency.db.lastError).toBe('INTERNAL');
    expect(b.client).toHaveLength(1);
    expect(b.client[0].label.length).toBeLessThanOrEqual(80);
    expect(b.client[0].label).toContain('[email]');
    expect(sanitizeRun({ runId: 'r1', kind: 'db', owner: 'agency', startedAt: '2026-11-03T08:30:01Z', result: 'weird' })).toBeNull();
    expect(sanitizeHistory([{ date: '2026-11-01', overallState: 'ok', score: 98, checks: { 'edge.hsts': 'ok', BAD: 'ok', 'edge.csp_mode': 'green' } }, { date: 'x', overallState: 'ok', score: 1 }])).toEqual([
      { date: '2026-11-01', overallState: 'ok', score: 98, checks: { 'edge.hsts': 'ok' } },
    ]);
  });

  it('every example event validates; missing data / snapshotText / bad severity are final VALIDATION rejects', () => {
    for (const ev of secEvents()) expect(validateEvent(ev)).toBeNull();
    for (const ev of ex('events.request--security-config').events) expect(validateEvent(ev)).toBeNull();
    const failed = secEvents()[0];
    expect(validateEvent({ ...failed, data: undefined })).toMatch(/data is required/);
    expect(validateEvent({ ...failed, snapshotText: 'x' })).toMatch(/snapshotText/);
    expect(validateSecurityEvent({ ...failed, data: { ...failed.data, severity: 'medium' } })).toMatch(/critical or high/);
    // changes > 50 → truncated, not rejected
    const sc = secEvents()[1];
    const d = sanitizeSecurityEventData(sc.type, { ...sc.data, changes: Array.from({ length: 60 }, () => sc.data.changes[0]) }).data;
    expect(d.changes).toHaveLength(50);
    expect(d.truncated).toBe(true);
  });

  it('processEventBatch dispatches security.* / backup.* to the store and accepts them', async () => {
    const applied = [];
    const store = {
      claimReceipt: async () => 'claimed',
      finalizeReceipt: async () => {},
      releaseReceipt: async () => {},
      applySecurityEvent: async (_p, ev) => {
        applied.push(ev.type);
        return 'applied';
      },
    };
    const out = await processEventBatch({ store, project: PROJECT, events: secEvents() });
    expect(out.rejected).toEqual([]);
    expect(out.accepted).toHaveLength(secEvents().length);
    expect(applied).toEqual(secEvents().map((e) => e.type));
  });
});

describe('storage (§5.4): transitions, evidence only for non-ok, daily points, runs', () => {
  it('security.check_failed: transition + check state with bounded evidence; critical alerts on-call + owners + Slack', async () => {
    db.overrides['agencySetting.findFirst'] = async () => ({ securityOnCallUserIds: ['oncall1'] });
    db.overrides['user.findMany'] = async (a) => (a.where.role === 'OWNER' ? [{ id: 'owner1' }] : [{ id: 'oncall1' }]);
    db.overrides['securityAlertLog.findUnique'] = async () => null;
    delete process.env.SECURITY_SLACK_WEBHOOK_URL; // Slack itself is covered below with an injected fetch
    expect(await applySecurityEvent(PROJECT, secEvents()[0])).toBe('applied');
    const t = calls('securityTransition.create')[0].args.data;
    expect(t).toMatchObject({ projectId: 'p1', checkId: 'data.db_integrity', toState: 'fail', severity: 'critical', origin: 'event' });
    const st = calls('securityCheckState.create')[0].args.data;
    expect(st.state).toBe('fail');
    expect(st.evidence).toBeTruthy();
    expect(notes.sent[0]).toMatchObject({ slug: 'security_alert' });
    expect(new Set(notes.sent[0].recipientIds)).toEqual(new Set(['oncall1', 'owner1']));
  });

  it('status_changed: one transition per change; an ok change clears the evidence; overall updated', async () => {
    db.overrides['securityCheckState.findUnique'] = async (a) => (a.where.projectId_checkId.checkId === 'edge.hsts' ? { id: 'h1', state: 'unknown', evidence: { x: 1 }, lastChangedAt: null } : null);
    await applySecurityEvent(PROJECT, secEvents()[1]);
    expect(calls('securityTransition.create')).toHaveLength(2);
    const hsts = calls('securityCheckState.update').find((c) => c.args.where.id === 'h1').args.data;
    expect(hsts.state).toBe('ok');
    expect(hsts.evidence).not.toBeNull(); // Prisma.DbNull, not a value
    expect(String(hsts.evidence)).toMatch(/DbNull/);
    expect(calls('securitySiteStatus.upsert')[0].args.update).toMatchObject({ overallState: 'fail', score: 68 });
  });

  it('a change older than the stored lastChangedAt never rolls the state back', async () => {
    db.overrides['securityCheckState.findUnique'] = async () => ({ id: 'h1', state: 'fail', lastChangedAt: new Date('2030-01-01T00:00:00Z') });
    await applySecurityEvent(PROJECT, secEvents()[1]);
    expect(calls('securityCheckState.update')).toHaveLength(0);
  });

  it('scan_completed, incident (read-only row + owners), backup.* runs', async () => {
    db.overrides['user.findMany'] = async () => [{ id: 'owner1' }];
    await applySecurityEvent(PROJECT, secEvents()[2]);
    expect(calls('securitySiteStatus.upsert')[0].args.create.lastScan).toMatchObject({ scanId: '01JB2SCAN00000000000000001', kind: 'scheduled' });
    await applySecurityEvent(PROJECT, secEvents()[3]);
    expect(calls('securityIncident.create')[0].args.data).toMatchObject({ incidentId: '01JB2INC000000000000000001', phase: 'detected' });
    await applySecurityEvent(PROJECT, secEvents()[4]);
    expect(calls('securityBackupRun.create')[0].args.data).toMatchObject({ runId: 'run_01JB0000000000000000000002', result: 'ok', destinationId: 'agency-db', bytes: 17825792n });
    await applySecurityEvent(PROJECT, secEvents()[5]);
    expect(calls('securityBackupRun.create')[1].args.data).toMatchObject({ result: 'failed', errorCode: 'TIMEOUT', destinationId: 'dst_01JB0000000000000000000001', destinationLabel: 'Office NAS' });
    expect(streakId('agency', 'files', 'agency_r2')).toBe('agency-files');
  });

  it('status pull: transitions vs stored, evidence only for non-ok, missing check → unknown, daily point', async () => {
    db.overrides['securityCheckState.findMany'] = async () => [
      { id: 's1', checkId: 'edge.hsts', state: 'ok', severity: 'high' },
      { id: 's2', checkId: 'edge.removed_check', state: 'fail', severity: 'low' },
    ];
    const now = new Date('2026-11-03T09:00:00Z');
    const rec = await recordStatusPull('p1', ex('security-status.response--full').status, { now });
    expect(rec.ok).toBe(true);
    const ids = rec.transitions.map((t) => `${t.checkId}:${t.to}`);
    expect(ids).toContain('edge.removed_check:unknown');
    expect(ids).not.toContain('edge.hsts:ok');
    const hsts = calls('securityCheckState.update').find((c) => c.args.where.id === 's1').args.data;
    expect(String(hsts.evidence)).toMatch(/DbNull/); // ok → no evidence kept
    const csp = calls('securityCheckState.create').find((c) => c.args.data.checkId === 'edge.csp_mode').args.data;
    expect(csp.evidence).toMatchObject({ mode: 'report-only' });
    expect(calls('securityDailyPoint.upsert')[0].args.where.projectId_date).toEqual({ projectId: 'p1', date: '2026-11-03' });
  });

  it('backup-status: runs stored, new failures reported', async () => {
    const rec = await recordBackupStatus('p1', ex('backup-status.response'));
    expect(calls('securityBackupRun.create')).toHaveLength(2);
    expect(rec.newFailures).toEqual([{ id: 'dst_01JB0000000000000000000001', type: 'sftp', label: 'Office NAS', owner: 'client' }]);
    const unknown = await recordBackupStatus('p1', ex('backup-status.response--unknown'));
    expect(unknown.backups).toBeNull();
  });

  it('retention purge: batched deletes before the cutoff (admin setting, default 400 days)', async () => {
    db.overrides['agencySetting.findFirst'] = async () => ({ securityRetentionDays: 400 });
    db.overrides['securityTransition.findMany'] = async (a) => {
      expect(a.take).toBe(5000);
      expect(a.where.at.lt.toISOString().slice(0, 10)).toBe('2025-09-29');
      return [{ id: 't1' }];
    };
    db.overrides['securityTransition.deleteMany'] = async () => ({ count: 1 });
    const out = await purgeSecurityHistory({ now: new Date('2026-11-03T00:00:00Z') });
    expect(out.transitions).toBe(1);
    expect(calls('securityDailyPoint.findMany')[0].args.where.date.lt).toBe('2025-09-29');
    expect(calls('securityMonthlyReport.deleteMany')).toHaveLength(0);
    expect(calls('securityIncident.deleteMany')).toHaveLength(0);
  });
});

describe('alert routing (§5.6)', () => {
  beforeEach(() => {
    db.overrides['securityAlertLog.findUnique'] = async () => null;
    db.overrides['user.findMany'] = async (a) => (a.where.role === 'OWNER' ? [{ id: 'owner1' }] : []);
  });

  it('high → on-call (owners when nobody is on call); medium / warn → digest; ok → nothing', async () => {
    const t = { checkId: 'edge.hsts', from: 'ok', to: 'fail', severity: 'high', summary: 'HSTS <missing>' };
    expect((await alertForTransition(PROJECT, t)).recipients).toEqual(['owner1']);
    expect(notes.sent[0].variables.details).toBe('HSTS &lt;missing&gt;');
    expect((await alertForTransition(PROJECT, { ...t, severity: 'medium' })).routed).toBe('digest');
    expect((await alertForTransition(PROJECT, { ...t, to: 'warn' })).routed).toBe('digest_or_none');
    expect(notes.sent).toHaveLength(1);
  });

  it('24 h dedupe per check per state (existing recent claim), acknowledged checks are muted (v1.6.1)', async () => {
    db.overrides['securityAlertLog.findUnique'] = async () => ({ id: 'a', sentAt: new Date() });
    expect((await alertForTransition(PROJECT, { checkId: 'x.y', to: 'fail', severity: 'critical' })).routed).toBe('deduped');
    db.overrides['securityCheckState.findUnique'] = async () => ({ acknowledged: { state: 'fail', until: new Date(Date.now() + 86400_000).toISOString(), active: true } });
    expect((await alertForTransition(PROJECT, { checkId: 'x.y', to: 'fail', severity: 'critical' })).routed).toBe('acknowledged');
    expect(notes.sent).toHaveLength(0);
  });

  it('claimAlert: an old row is re-claimed atomically; a fresh row blocks', async () => {
    db.overrides['securityAlertLog.updateMany'] = async (a) => {
      expect(a.where.sentAt.lt).toBeInstanceOf(Date);
      return { count: 1 };
    };
    expect(await claimAlert('p1', 'k')).toBe(true);
  });

  it('backup streak: 2 failures → PM; 3 on a client destination → client users (security_backup_failed)', async () => {
    db.overrides['securityBackupRun.findMany'] = async () => [{ result: 'failed', owner: 'client' }, { result: 'missed', owner: 'client' }, { result: 'ok', owner: 'client' }];
    let out = await checkBackupFailures(PROJECT, { id: 'dst_1', label: 'Office NAS', owner: 'client' });
    expect(out).toMatchObject({ streak: 2, pm: true, client: false });
    expect(notes.sent[0]).toMatchObject({ slug: 'security_alert', recipientIds: ['pm1'] });
    notes.sent = [];
    db.overrides['securityBackupRun.findMany'] = async () => [{ result: 'failed', owner: 'client' }, { result: 'failed', owner: 'client' }, { result: 'failed', owner: 'client' }];
    db.overrides['project.findUnique'] = async () => ({ clientId: 'c1' });
    db.overrides['clientUser.findMany'] = async () => [{ userId: 'cu1' }];
    out = await checkBackupFailures(PROJECT, { id: 'dst_1', label: 'Office <NAS>', owner: 'client' });
    expect(out.client).toBe(true);
    const client = notes.sent.find((n) => n.slug === 'security_backup_failed');
    expect(client.recipientIds).toEqual(['cu1']);
    expect(client.variables.destination).toBe('Office &lt;NAS&gt;');
    // an agency destination never e-mails the client
    notes.sent = [];
    out = await checkBackupFailures(PROJECT, { id: 'agency-db', owner: 'agency' });
    expect(out.client).toBe(false);
  });

  it('Slack: unset → nothing; http / credentials refused; https posted with no redirects', async () => {
    expect((await sendSecuritySlack('x', { env: {} })).reason).toBe('not_configured');
    expect((await sendSecuritySlack('x', { env: { SECURITY_SLACK_WEBHOOK_URL: 'http://hooks.slack.com/x' } })).reason).toBe('https_only');
    expect((await sendSecuritySlack('x', { env: { SECURITY_SLACK_WEBHOOK_URL: 'https://u:p@hooks.slack.com/x' } })).reason).toBe('https_only');
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    expect((await sendSecuritySlack('hello', { env: { SECURITY_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' }, fetchImpl })).sent).toBe(true);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'manual' });
    const redirect = vi.fn(async () => ({ ok: false, status: 302 }));
    expect((await sendSecuritySlack('x', { env: { SECURITY_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' }, fetchImpl: redirect })).reason).toBe('redirect');
  });

  it('daily digest: medium/low fails + warns still open and not acknowledged → PM, once per day', async () => {
    db.overrides['securityTransition.findMany'] = async () => [
      { projectId: 'p1', checkId: 'edge.csp_mode', toState: 'warn', severity: 'medium', summary: 'CSP report-only' },
      { projectId: 'p1', checkId: 'edge.fixed', toState: 'warn', severity: 'low', summary: 'gone' },
    ];
    db.overrides['securityCheckState.findMany'] = async () => [{ checkId: 'edge.csp_mode', state: 'warn', acknowledged: null }, { checkId: 'edge.fixed', state: 'ok' }];
    db.overrides['project.findUnique'] = async () => ({ id: 'p1', name: 'Oasis', leadPmId: 'pm1', clientId: 'c1', status: 'ACTIVE' });
    const out = await runSecurityDigest({ now: new Date('2026-11-03T08:00:00Z') });
    expect(out.sent).toBe(1);
    expect(notes.sent[0]).toMatchObject({ slug: 'security_digest', recipientIds: ['pm1'], variables: { count: '1' } });
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  });
});

describe('pulls (§36.1): 429 / 501 / 503 handled gracefully, no retries', () => {
  beforeEach(() => {
    db.overrides['project.findUnique'] = async () => ({ ...PROJECT, cmsRepairNeededAt: null, status: 'ACTIVE' });
  });

  it('happy path: full status, 90-day history on the first pull, backup-status; no retries', async () => {
    site.handler = (route) => {
      if (route === 'security-status') return ex('security-status.response--full');
      if (route === 'security-history') return ex('security-history.response');
      return ex('backup-status.response');
    };
    const out = await pullSecurity('p1', { now: new Date('2026-11-03T09:00:00Z') });
    expect(out).toMatchObject({ status: 'ok', history: 3, backups: 'ok' });
    expect(site.routes.map((r) => r.route)).toEqual(['security-status', 'security-history', 'backup-status']);
    expect(site.routes[0].body).toEqual({ detail: 'full' });
    expect(site.routes[1].body).toEqual({ days: 90 });
    for (const r of site.routes) expect(r.opts).toEqual({ retryDelays: [] });
  });

  it('429 RATE_LIMITED stores retryAfterUntil and stops; the next run waits; interactive answers 429', async () => {
    site.handler = () => {
      throw new CmsBridgeError({ status: 429, code: 'RATE_LIMITED', retryable: true, details: { retryAfterSec: 42 } });
    };
    const now = new Date('2026-11-03T09:00:00Z');
    const out = await pullSecurity('p1', { now });
    expect(out.status).toBe('RATE_LIMITED');
    expect(site.routes).toHaveLength(1);
    const until = calls('securitySiteStatus.upsert')[0].args.update.retryAfterUntil;
    expect(until.toISOString()).toBe('2026-11-03T09:00:42.000Z');
    db.overrides['securitySiteStatus.findUnique'] = async () => ({ retryAfterUntil: until });
    expect(await pullSecurity('p1', { now })).toMatchObject({ skipped: 'rate_limited' });
    await expect(pullSecurity('p1', { now, interactive: true })).rejects.toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSec: 42 } });
  });

  it('501 / 503 are recorded per call and the run continues', async () => {
    site.handler = (route) => {
      if (route === 'security-status') throw new CmsBridgeError({ status: 501, code: 'NOT_IMPLEMENTED' });
      if (route === 'security-history') throw new CmsBridgeError({ status: 503, code: 'UPSTREAM_UNAVAILABLE', retryable: true });
      return ex('backup-status.response--unknown');
    };
    const out = await pullSecurity('p1');
    expect(out).toMatchObject({ status: 'NOT_IMPLEMENTED', history: 'UPSTREAM_UNAVAILABLE', backups: 'NO_RECORD' });
  });

  it('logs-pull (Phase 3): capability off → not called; a 501 → supported false; nothing stored', async () => {
    db.overrides['project.findUnique'] = async () => ({ cmsType: 'EMDASH', cmsCapabilities: { logs: false } });
    expect(await probeSecurityLogs('p1')).toEqual({ supported: false, reason: 'capability_off' });
    db.overrides['project.findUnique'] = async () => ({ cmsType: 'EMDASH', cmsCapabilities: { logs: true } });
    site.handler = () => {
      throw new CmsBridgeError({ status: 501, code: 'NOT_IMPLEMENTED', details: ex('error.response--logs-not-implemented').error.details });
    };
    expect(await probeSecurityLogs('p1')).toEqual({ supported: false, reason: 'not_implemented' });
    expect(db.calls.filter((c) => /create|upsert/.test(c.key))).toHaveLength(0);
  });

  it('missed backups from nextExpectedAt + grace (OS-side backup.missed)', async () => {
    const backups = sanitizeBackups(ex('backup-status.response').backups);
    const n = await detectMissedBackups(PROJECT, backups, { now: new Date('2026-11-03T12:00:00Z') });
    // agency files due 08:30 (last ok the day before) and the client files archive due 07:05: missed
    expect(n).toBe(2);
    expect(calls('securityBackupRun.create').map((c) => c.args.data.destinationId).sort()).toEqual(['agency-files', 'dst_01JB0000000000000000000001']);
  });
});

describe('client view allow-list (O-4)', () => {
  const FORBIDDEN = ['id', 'checkId', 'score', 'evidence', 'remediation', 'summary', 'severity', 'version', 'versions', 'siteUrl', 'host', 'destinationId', 'type', 'acknowledged', 'note', 'pmNote', 'catalogueVersion', 'refs'];
  const keysDeep = (v, out = new Set()) => {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
    return out;
  };

  it('only overall state, a fixed sentence, tiles and clientSummary items with the PM note', () => {
    const full = sanitizeStatus(ex('security-status.response--full').status);
    const checks = full.checks.map((c) => ({ ...c, checkId: c.id, pmNote: c.id === 'backup.primary_fresh' ? 'Re-running tonight' : null, pmNoteEta: null, acknowledged: { note: 'secret' } }));
    const view = buildClientSecurityView({ status: { overallState: 'warn', score: 93, backups: full.backups, scansLastFullAt: new Date(), statusAt: new Date() }, checks });
    const keys = keysDeep(view);
    for (const k of FORBIDDEN) expect(keys.has(k)).toBe(false);
    expect(view.sentence).toBe(CLIENT_SENTENCES.warn_one);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toEqual({ text: expect.stringContaining('photos and files'), state: 'watch', since: expect.any(String), agencyNote: 'Re-running tonight', eta: null });
    expect(view.tiles.backup.destinations[0]).toEqual({ label: 'Office NAS', lastOkAt: expect.any(String), ok: false });
    expect(JSON.stringify(view)).not.toMatch(/93|evidence|edge\.|oasispoolspas|cd08cc1|0\.1\.0/);
  });

  it('API tokens never reach the staff security routes or the agency security settings', () => {
    expect(checkApiTokenRoute({ scopes: [] }, 'GET', '/api/pm/security/fleet').ok).toBe(false);
    expect(checkApiTokenRoute({ scopes: [] }, 'POST', '/api/pm/security/projects/:projectId/ack').ok).toBe(false);
    expect(checkApiTokenRoute({ scopes: [] }, 'PATCH', '/api/admin/security-settings').ok).toBe(false);
  });
});
