/**
 * release-3 e2e O-R3-2: the site (contract 1.7.0) sent 37 checks, 6 of them `n/a`, and the OS stored 31 (the sanitizer
 * dropped the 6 silently); a known check that turned `n/a` kept its old critical summary ("The agency backup is
 * overdue"). After the merge with §38.9 every n/a check is stored, the old summary / evidence / fix / client text are
 * cleared, it is left out of counts and alerts, and any check the sanitizer still drops is logged with the count.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../signals/fakePrisma.js');
  return { prisma: createFakePrisma() };
});
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}) }));

import { prisma } from '../../../src/lib/prisma.js';
import { recordStatusPull, applySecurityEvent } from '../../../src/lib/security/securityStore.js';
import { alertForTransition } from '../../../src/lib/security/securityAlerts.js';
import { siteSecurityView, buildClientSecurityView } from '../../../src/lib/security/securityViews.js';
import { sanitizeStatus, sanitizeSecurityEventData } from '../../../src/lib/siteAdapters/security.js';
import { takeShapeViolations } from '../../helpers/prismaShape.js';

const rows = (n) => prisma._rows(n);
const NOW = new Date('2026-10-22T07:50:07Z');
const NA_IDS = ['app.signals_collector', 'app.signals_drop_rate', 'app.signals_buffer', 'app.signals_consent_share', 'backup.primary_fresh', 'backup.client_destinations_fresh'];

/** The e2e site: 37 checks, 6 n/a, counts {ok 11, warn 3, fail 2, unknown 15, na 6}. */
function fullStatus({ naState = 'n/a' } = {}) {
  const checks = [];
  const states = [...Array(11).fill('ok'), ...Array(3).fill('warn'), ...Array(2).fill('fail'), ...Array(15).fill('unknown')];
  states.forEach((state, i) =>
    checks.push({ id: `edge.check_${i}`, category: 'edge', severity: 'medium', state, ...(state === 'unknown' ? { reason: 'no_data' } : {}), summary: `Check ${i} is ${state}.` })
  );
  for (const id of NA_IDS) {
    checks.push({ id, category: id.split('.')[0], severity: id.startsWith('backup.') ? 'critical' : 'medium', state: naState, reason: id === 'backup.client_destinations_fresh' ? 'not_configured' : 'disabled', summary: `${id} does not apply here.` });
  }
  return {
    generatedAt: '2026-10-22T07:50:00Z',
    detail: 'full',
    overall: { state: 'fail', score: 23, counts: { ok: 11, warn: 3, fail: 2, unknown: 15, na: 6 } },
    checks,
  };
}

beforeEach(() => prisma._reset());
afterEach(() => expect(takeShapeViolations()).toEqual([]));

describe('37 sent / 31 stored (O-R3-2)', () => {
  it('stores all 37 checks, 6 of them n/a with their reason; nothing dropped, nothing logged', async () => {
    const log = { warn: vi.fn() };
    const rec = await recordStatusPull('p1', fullStatus(), { now: NOW, log });
    expect(rec.ok).toBe(true);
    expect(rec.status).toMatchObject({ sentChecks: 37, droppedChecks: 0 });
    const stored = rows('securityCheckState');
    expect(stored).toHaveLength(37);
    const na = stored.filter((r) => r.state === 'n/a');
    expect(na.map((r) => r.checkId).sort()).toEqual([...NA_IDS].sort());
    expect(na.find((r) => r.checkId === 'backup.client_destinations_fresh').reason).toBe('not_configured');
    expect(na.every((r) => r.evidence == null && r.clientSummary == null && r.remediation == null)).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    expect(rows('securitySiteStatus')[0].counts).toEqual({ ok: 11, warn: 3, fail: 2, unknown: 15, na: 6 });
  });

  it('a check state the OS does not know is still dropped, but the count is logged (37 sent, 31 stored)', async () => {
    const log = { warn: vi.fn() };
    const rec = await recordStatusPull('p1', fullStatus({ naState: 'not-a-state' }), { now: NOW, log });
    expect(rows('securityCheckState')).toHaveLength(31);
    expect(rec.status.droppedChecks).toBe(6);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({ projectId: 'p1', sent: 37, stored: 31, dropped: 6 }, 'Security status: checks dropped by the sanitizer');
  });

  it('sanitizeStatus counts invalid and duplicate checks as dropped', () => {
    const s = fullStatus();
    s.checks.push({ ...s.checks[0] }, { id: 'BAD ID', category: 'edge', severity: 'low', state: 'ok', summary: 'x' });
    expect(sanitizeStatus(s)).toMatchObject({ sentChecks: 39, droppedChecks: 2 });
  });
});

describe('a known check that turns n/a loses its old text (O-R3-2)', () => {
  const overdue = () => ({
    id: 'cs-backup',
    projectId: 'p1',
    checkId: 'backup.primary_fresh',
    category: 'backup',
    severity: 'critical',
    state: 'fail',
    reason: null,
    summary: 'The agency backup is overdue (database 60 h old, files 60 h old; limit 26 h).',
    clientSummary: 'A backup is late',
    remediation: 'Check the backup worker.',
    evidence: { ageHours: 60 },
    evidenceAt: new Date('2026-10-22T07:00:00Z'),
    since: new Date('2026-10-22T07:00:00Z'),
    lastChangedAt: new Date('2026-10-22T07:00:00Z'),
    acknowledged: null,
  });

  it('full pull: fail → n/a stores the n/a text, clears evidence / fix / client text, no alert, out of the counts', async () => {
    rows('securityCheckState').push(overdue());
    const rec = await recordStatusPull('p1', fullStatus(), { now: NOW });
    const row = rows('securityCheckState').find((r) => r.checkId === 'backup.primary_fresh');
    expect(row).toMatchObject({ state: 'n/a', reason: 'disabled', summary: 'backup.primary_fresh does not apply here.', clientSummary: null, remediation: null, evidence: null, evidenceAt: null });
    const t = rec.transitions.find((x) => x.checkId === 'backup.primary_fresh');
    expect(t).toMatchObject({ from: 'fail', to: 'n/a' });
    expect(await alertForTransition({ id: 'p1' }, t, { now: NOW })).toEqual({ routed: 'not_applicable' });

    const view = await siteSecurityView({ id: 'p1', cmsType: 'EMDASH', cmsCapabilities: { security: true } });
    expect(view.status.counts).toMatchObject({ ok: 11, warn: 3, fail: 2, unknown: 15, na: 6 });
    expect(view.checks.find((c) => c.id === 'backup.primary_fresh')).toMatchObject({ notApplicable: true, summary: 'backup.primary_fresh does not apply here.' });
    const client = buildClientSecurityView({ status: { overallState: 'fail', disabled: [] }, checks: rows('securityCheckState') });
    expect(client.items.some((i) => /backup/i.test(JSON.stringify(i)))).toBe(false);
  });

  it('status_changed event fail → n/a: same clearing, reason kept; dropped changes are logged', async () => {
    rows('securityCheckState').push(overdue());
    const log = { warn: vi.fn() };
    const ev = {
      id: 'ev1',
      type: 'security.status_changed',
      at: '2026-10-22T07:55:00Z',
      data: {
        before: { state: 'fail', score: 23 },
        after: { state: 'warn', score: 80 },
        changes: [
          { id: 'backup.primary_fresh', from: 'fail', to: 'n/a', reason: 'not_configured', at: '2026-10-22T07:55:00Z', severity: 'critical', summary: 'No agency backup destination is set up.' },
          { id: 'edge.hsts', from: 'ok', to: 'sideways', severity: 'low', summary: 'x' },
        ],
      },
    };
    expect(sanitizeSecurityEventData(ev.type, ev.data).data).toMatchObject({ droppedChanges: 1 });
    expect(await applySecurityEvent({ id: 'p1' }, ev, { log })).toBe('applied');
    const row = rows('securityCheckState').find((r) => r.checkId === 'backup.primary_fresh');
    expect(row).toMatchObject({ state: 'n/a', reason: 'not_configured', summary: 'No agency backup destination is set up.', clientSummary: null, remediation: null, evidence: null });
    expect(log.warn).toHaveBeenCalledWith({ projectId: 'p1', eventId: 'ev1', sent: 2, dropped: 1 }, 'security.status_changed: changes dropped by the sanitizer');
    expect(rows('securityAlertLog')).toHaveLength(0);
  });

  it('a stored check missing from a full status becomes unknown without its old summary', async () => {
    rows('securityCheckState').push({ ...overdue(), checkId: 'backup.retired_check' });
    await recordStatusPull('p1', fullStatus(), { now: NOW });
    const row = rows('securityCheckState').find((r) => r.checkId === 'backup.retired_check');
    expect(row).toMatchObject({ state: 'unknown', reason: 'not_run', summary: 'No longer reported by the site (not run there).', remediation: null, evidence: null, clientSummary: null });
  });
});
